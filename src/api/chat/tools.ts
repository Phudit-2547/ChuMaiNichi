import { neon } from "@neondatabase/serverless";
import { suggestSongs } from "../../global/lib/maimai-suggest.js";
import type { PlayerData } from "../../global/lib/maimai-rating.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { DataRegion } from "../../global/lib/regions.js";
import { loadSongs } from "./songs-cache.js";

export const QUERY_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "query_database",
    description:
      "Execute a read-only SQL SELECT query against the International database tables.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A SELECT SQL query" },
        params: {
          type: "array",
          items: {},
          description: "Query parameters ($1, $2, ...)",
        },
      },
      required: ["sql"],
    },
  },
};

export const JAPAN_ACTIVITY_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "query_japan_activity",
    description:
      "Read Japan Journal activity rows. Optionally filter the inclusive play_date range. ONGEKI values are tracks, not plays.",
    parameters: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description: "Optional inclusive start date in YYYY-MM-DD format.",
        },
        end_date: {
          type: "string",
          description: "Optional inclusive end date in YYYY-MM-DD format.",
        },
      },
      additionalProperties: false,
    },
  },
};

export const SUGGEST_SONGS_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "maimai_suggest_songs",
    description:
      "Suggest maimai songs to improve the player's maimai DX rating. Use when the player asks for maimai song recommendations, how to raise their maimai rating, or what maimai chart to play next. This tool is maimai-only and has no chunithm equivalent.",
    parameters: {
      type: "object",
      properties: {
        target_rating: {
          type: "integer",
          description:
            "Target rating to reach (optional, triggers target mode)",
        },
        mode: {
          type: "string",
          enum: ["auto", "target", "best_effort"],
          description:
            "auto = target mode if target_rating given, else best_effort",
        },
        max_suggestions: {
          type: "integer",
          description: "Maximum suggestions per category (default 5)",
        },
      },
    },
  },
};

const FORBIDDEN_SQL =
  /;|--|\/\*|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|CALL|COPY|INTO)\b/i;
const GAME_LITERAL = /\bgame\s*=\s*'([^']+)'/gi;
const VALID_GAMES = new Set(["maimai", "chunithm"]);
const JAPAN_TABLE = /\b(?:public\s*\.\s*)?japan_daily_play\b/i;
const UNICODE_ESCAPED_IDENTIFIER = /\bU\s*&\s*"/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const JAPAN_ACTIVITY_SQL = `
SELECT
  play_date,
  maimai_play_count,
  chunithm_play_count,
  ongeki_track_count,
  maimai_cumulative,
  chunithm_cumulative,
  ongeki_cumulative_tracks,
  inferred_games,
  source,
  source_paths,
  source_hashes
FROM public.japan_daily_play
WHERE ($1::date IS NULL OR play_date >= $1::date)
  AND ($2::date IS NULL OR play_date <= $2::date)
ORDER BY play_date ASC`.trim();

export function getChatTools(
  region: DataRegion,
  enabledGames: readonly string[],
): ChatCompletionTool[] {
  if (region === "japan") return [JAPAN_ACTIVITY_TOOL];
  return enabledGames.includes("maimai")
    ? [QUERY_TOOL, SUGGEST_SONGS_TOOL]
    : [QUERY_TOOL];
}

function readOptionalIsoDate(
  args: Record<string, unknown>,
  key: "start_date" | "end_date",
): { value: string | null; error?: string } {
  const value = args[key];
  if (value === undefined) return { value: null };
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    return { value: null, error: `${key} must use YYYY-MM-DD format.` };
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    value.startsWith("0000-") ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return { value: null, error: `${key} must be a valid calendar date.` };
  }
  return { value };
}

async function queryJapanActivity(
  args: Record<string, unknown>,
  region: DataRegion,
): Promise<unknown> {
  if (region !== "japan") {
    return {
      error:
        "query_japan_activity is available only in the Japan Journal view.",
    };
  }

  const start = readOptionalIsoDate(args, "start_date");
  if (start.error) return { error: start.error };
  const end = readOptionalIsoDate(args, "end_date");
  if (end.error) return { error: end.error };
  if (start.value && end.value && start.value > end.value) {
    return { error: "start_date must be on or before end_date." };
  }

  try {
    const db = neon(process.env.DATABASE_URL!);
    const rows = await db.query(JAPAN_ACTIVITY_SQL, [start.value, end.value]);
    return {
      start_date: start.value,
      end_date: end.value,
      rows,
      rowCount: rows.length,
    };
  } catch {
    return { error: "Japan activity query failed" };
  }
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  region: DataRegion = "international",
): Promise<unknown> {
  if (name === "query_japan_activity") {
    return queryJapanActivity(args, region);
  }

  if (name === "query_database") {
    if (region === "japan") {
      return {
        error:
          "Free-form SQL is unavailable in the Japan Journal view. Use query_japan_activity.",
      };
    }

    const sql = args.sql as string;
    const normalized = sql.trim().replace(/\s*;+\s*$/, "");
    const upper = normalized.toUpperCase();
    if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
      return { error: "Only SELECT or WITH (CTE) statements are allowed", sql };
    }
    if (FORBIDDEN_SQL.test(normalized)) {
      return {
        error:
          "Forbidden SQL pattern detected (DML/DDL keyword, inline comment, or extra semicolon). Submit a single SELECT statement.",
        sql,
      };
    }
    if (UNICODE_ESCAPED_IDENTIFIER.test(normalized)) {
      return {
        error:
          "Unicode-escaped identifiers are unavailable in dashboard queries.",
        sql,
      };
    }
    if (JAPAN_TABLE.test(normalized)) {
      return {
        error: "The International dashboard cannot query Japan Journal data.",
        sql,
      };
    }
    const badGame = [...normalized.matchAll(GAME_LITERAL)]
      .map((match) => match[1])
      .find((literal) => !VALID_GAMES.has(literal));
    if (badGame !== undefined) {
      return {
        error: `Invalid game literal '${badGame}'. user_scores.game stores 'maimai' or 'chunithm' (lowercase, case-sensitive). Retry with the correct literal.`,
        sql,
      };
    }
    try {
      const db = neon(process.env.DATABASE_URL!);
      const rows = await db.query(normalized, (args.params as unknown[]) ?? []);
      return { sql: normalized, rows, rowCount: rows.length };
    } catch {
      return { error: "Query execution failed", sql };
    }
  }

  if (name === "maimai_suggest_songs") {
    if (region === "japan") {
      return {
        error:
          "Song suggestions are unavailable in the Japan Journal view because it contains play counts only, not per-song score data.",
      };
    }
    try {
      const db = neon(process.env.DATABASE_URL!);
      const rows = await db.query(
        `SELECT data FROM user_scores WHERE game = 'maimai' ORDER BY scraped_at DESC LIMIT 1`,
      );
      if (rows.length === 0) {
        return {
          error:
            "No maimai player data found. Run the user data scraper first.",
        };
      }
      const playerData = rows[0].data as PlayerData;
      const allSongs = loadSongs();
      if (allSongs.length === 0) {
        return {
          error:
            "No songs data available. maimai-songs.json is missing or empty.",
        };
      }
      return suggestSongs(playerData, allSongs, {
        targetRating: (args.target_rating as number) || null,
        mode: (args.mode as "auto" | "target" | "best_effort") || "auto",
        maxSuggestions: (args.max_suggestions as number) || 5,
      });
    } catch {
      return { error: "Song suggestion failed" };
    }
  }

  return { error: `Unknown tool: ${name}` };
}
