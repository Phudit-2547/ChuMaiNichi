import { neon } from "@neondatabase/serverless";
import { suggestSongs } from "../../global/lib/maimai-suggest.js";
import type { PlayerData } from "../../global/lib/maimai-rating.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { loadSongs } from "./songs-cache.js";

export const QUERY_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "query_database",
    description:
      "Execute a read-only SQL SELECT query against the PostgreSQL database.",
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

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "query_database") {
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
    const badGame = [...normalized.matchAll(GAME_LITERAL)]
      .map((m) => m[1])
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
