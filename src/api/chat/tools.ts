import { neon } from "@neondatabase/serverless";
import { suggestSongs } from "../../global/lib/maimai-suggest.js";
import type { PlayerData } from "../../global/lib/maimai-rating.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { DataRegion } from "../../global/lib/regions.js";
import { loadSongs } from "./songs-cache.js";
import { privateSqlBoundaryError } from "../query/security.js";

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
      "Read privacy-minimized Japan Journal activity. Use totals for total/how-many questions and daily only for date-by-date detail or trends. Request only the metrics the user asked for. ONGEKI values are tracks, not plays.",
    parameters: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["totals", "daily"],
          description:
            "totals returns one aggregate object; daily returns date rows for details or trends.",
        },
        metrics: {
          type: "array",
          items: {
            type: "string",
            enum: ["maimai_plays", "chunithm_plays", "ongeki_tracks"],
          },
          minItems: 1,
          uniqueItems: true,
          description:
            "Include only the activity metrics explicitly needed for the user's question.",
        },
        start_date: {
          type: "string",
          description: "Optional inclusive start date in YYYY-MM-DD format.",
        },
        end_date: {
          type: "string",
          description: "Optional inclusive end date in YYYY-MM-DD format.",
        },
      },
      required: ["view", "metrics"],
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
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const JAPAN_METRICS = [
  "maimai_plays",
  "chunithm_plays",
  "ongeki_tracks",
] as const;
type JapanMetric = (typeof JAPAN_METRICS)[number];
type JapanActivityView = "totals" | "daily";
const JAPAN_METRIC_SET = new Set<string>(JAPAN_METRICS);

const JAPAN_DAILY_ACTIVITY_SQL = `
SELECT
  play_date,
  maimai_play_count,
  chunithm_play_count,
  ongeki_track_count,
  inferred_games
FROM public.japan_daily_play
WHERE ($1::date IS NULL OR play_date >= $1::date)
  AND ($2::date IS NULL OR play_date <= $2::date)
ORDER BY play_date ASC`.trim();

const JAPAN_TOTALS_SQL = `
SELECT
  COALESCE(SUM(maimai_play_count), 0)::integer AS maimai_plays,
  COALESCE(SUM(chunithm_play_count), 0)::integer AS chunithm_plays,
  COALESCE(SUM(ongeki_track_count), 0)::integer AS ongeki_tracks,
  COUNT(*)::integer AS recorded_days,
  COALESCE(BOOL_OR('maimai' = ANY(inferred_games)), false) AS maimai_estimated,
  COALESCE(BOOL_OR('chunithm' = ANY(inferred_games)), false) AS chunithm_estimated,
  COALESCE(BOOL_OR('ongeki' = ANY(inferred_games)), false) AS ongeki_estimated
FROM public.japan_daily_play
WHERE ($1::date IS NULL OR play_date >= $1::date)
  AND ($2::date IS NULL OR play_date <= $2::date)`.trim();

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

function readJapanView(
  args: Record<string, unknown>,
): JapanActivityView {
  return args.view === "daily" ? "daily" : "totals";
}

function readJapanMetrics(
  args: Record<string, unknown>,
): { value?: JapanMetric[]; error?: string } {
  const value = args.metrics;
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "metrics must be a non-empty array." };
  }
  if (value.some((metric) => typeof metric !== "string" || !JAPAN_METRIC_SET.has(metric))) {
    return {
      error:
        "metrics may contain only maimai_plays, chunithm_plays, or ongeki_tracks.",
    };
  }
  return { value: [...new Set(value)] as JapanMetric[] };
}

const JAPAN_DAILY_FIELDS: Record<JapanMetric, string> = {
  maimai_plays: "maimai_play_count",
  chunithm_plays: "chunithm_play_count",
  ongeki_tracks: "ongeki_track_count",
};

function selectJapanDailyFields(
  rows: readonly unknown[],
  metrics: readonly JapanMetric[],
): Record<string, unknown>[] {
  const inferredGames = new Set<string>();
  if (metrics.includes("maimai_plays")) inferredGames.add("maimai");
  if (metrics.includes("chunithm_plays")) inferredGames.add("chunithm");

  return rows.map((value) => {
    const row = value as Record<string, unknown>;
    const selected: Record<string, unknown> = { play_date: row.play_date };
    for (const metric of metrics) {
      const field = JAPAN_DAILY_FIELDS[metric];
      selected[field] = row[field];
    }
    if (inferredGames.size > 0) {
      selected.inferred_games = Array.isArray(row.inferred_games)
        ? row.inferred_games.filter(
            (game): game is string =>
              typeof game === "string" && inferredGames.has(game),
          )
        : [];
    }
    return selected;
  });
}

function selectJapanTotals(
  row: Record<string, unknown> | undefined,
  metrics: readonly JapanMetric[],
): Partial<Record<JapanMetric, unknown>> {
  const totals: Partial<Record<JapanMetric, unknown>> = {};
  for (const metric of metrics) totals[metric] = row?.[metric] ?? 0;
  return totals;
}

function japanAggregateHasData(
  row: Record<string, unknown> | undefined,
): boolean {
  const recordedDays = row?.recorded_days;
  return (
    (typeof recordedDays === "number" && recordedDays > 0) ||
    (typeof recordedDays === "string" && Number(recordedDays) > 0)
  );
}

const JAPAN_ESTIMATED_FIELDS: Record<JapanMetric, string> = {
  maimai_plays: "maimai_estimated",
  chunithm_plays: "chunithm_estimated",
  ongeki_tracks: "ongeki_estimated",
};

function selectEstimatedJapanMetrics(
  row: Record<string, unknown> | undefined,
  metrics: readonly JapanMetric[],
): JapanMetric[] {
  return metrics.filter((metric) => row?.[JAPAN_ESTIMATED_FIELDS[metric]] === true);
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

  const view = readJapanView(args);
  const metrics = readJapanMetrics(args);
  if (metrics.error || !metrics.value) return { error: metrics.error };

  const start = readOptionalIsoDate(args, "start_date");
  if (start.error) return { error: start.error };
  const end = readOptionalIsoDate(args, "end_date");
  if (end.error) return { error: end.error };
  if (start.value && end.value && start.value > end.value) {
    return { error: "start_date must be on or before end_date." };
  }
  if (view === "daily" && (!start.value || !end.value)) {
    return {
      error: "The daily view requires both start_date and end_date.",
    };
  }

  try {
    const db = neon(process.env.DATABASE_URL!);
    const sql =
      view === "totals" ? JAPAN_TOTALS_SQL : JAPAN_DAILY_ACTIVITY_SQL;
    const rows = await db.query(sql, [start.value, end.value]);
    if (view === "totals") {
      const aggregateRow = rows[0] as Record<string, unknown> | undefined;
      return {
        view,
        metrics: metrics.value,
        start_date: start.value,
        end_date: end.value,
        has_data: japanAggregateHasData(aggregateRow),
        totals: selectJapanTotals(aggregateRow, metrics.value),
        estimated_metrics: selectEstimatedJapanMetrics(
          aggregateRow,
          metrics.value,
        ),
      };
    }
    const selectedRows = selectJapanDailyFields(rows, metrics.value);
    return {
      view,
      metrics: metrics.value,
      start_date: start.value,
      end_date: end.value,
      has_data: selectedRows.length > 0,
      rows: selectedRows,
      rowCount: selectedRows.length,
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
    const privateBoundaryError = privateSqlBoundaryError(normalized);
    if (privateBoundaryError) {
      return {
        error: privateBoundaryError,
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
