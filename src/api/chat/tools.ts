import { neon } from "@neondatabase/serverless";
import { suggestSongs } from "../../global/lib/suggest-songs";
import type { PlayerData } from "../../global/lib/rating";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { loadSongs } from "./songs-cache";

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
    name: "suggest_songs",
    description:
      "Suggest maimai songs to improve player rating. Use when player asks for song recommendations, how to raise rating, or what to play next.",
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
  /;|--|\/\*|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|COPY|INTO)\b/i;

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "query_database") {
    const sql = args.sql as string;
    const trimmed = sql.trim();
    if (!trimmed.toUpperCase().startsWith("SELECT")) {
      return { error: "Only SELECT statements are allowed" };
    }
    if (FORBIDDEN_SQL.test(trimmed)) {
      return { error: "Forbidden SQL pattern detected" };
    }
    try {
      const db = neon(process.env.DATABASE_URL!);
      const rows = await db.query(sql, (args.params as unknown[]) ?? []);
      return { rows, rowCount: rows.length };
    } catch {
      return { error: "Query execution failed" };
    }
  }
  if (name === "suggest_songs") {
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
          error: "No songs data available. songs.json is missing or empty.",
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
