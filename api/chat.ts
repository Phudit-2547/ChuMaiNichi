import type { VercelRequest, VercelResponse } from "@vercel/node";
import { neon } from "@neondatabase/serverless";
import { createHash, timingSafeEqual } from "node:crypto";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { readFileSync } from "fs";
import { join } from "path";
import { suggestSongs } from "../src/lib/maimai-suggest";
import type { PlayerData, SongData } from "../src/lib/maimai-rating";

// --- Provider auto-detection ---

function createClient(): OpenAI {
  if (process.env.GEMINI_API_KEY) {
    return new OpenAI({
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    });
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });
  }
  throw new Error("Set OPENAI_API_KEY or GEMINI_API_KEY");
}

function defaultModel(): string {
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  if (process.env.GEMINI_API_KEY) return "gemini-2.5-flash";
  return "gpt-4o-mini";
}

// --- Config ---

function loadConfig(): { games: string[]; currency_per_play: number } {
  try {
    return JSON.parse(
      readFileSync(join(process.cwd(), "config.json"), "utf-8"),
    );
  } catch {
    return { games: ["maimai", "chunithm"], currency_per_play: 40 };
  }
}

// --- System prompt ---

const SCHEMA_DDL = `
CREATE TABLE daily_play (
  play_date            DATE PRIMARY KEY,
  maimai_play_count    INTEGER DEFAULT 0,
  chunithm_play_count  INTEGER DEFAULT 0,
  maimai_cumulative    INTEGER DEFAULT 0,
  chunithm_cumulative  INTEGER DEFAULT 0,
  maimai_rating        NUMERIC,
  chunithm_rating      NUMERIC,
  scrape_failed        BOOLEAN DEFAULT FALSE,
  failure_reason       TEXT
);

CREATE TABLE user_scores (
  id         SERIAL PRIMARY KEY,
  game       TEXT NOT NULL,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  data       JSONB NOT NULL
);`.trim();

function buildSystemPrompt(config: {
  games: string[];
  currency_per_play: number;
}): string {
  return `You are the ChuMaiNichi assistant for ${config.games.join(" and ")} arcade rhythm game players.

DATABASE SCHEMA:
${SCHEMA_DDL}

RULES:
- daily_play has ONE row per date with columns for BOTH games. Dates use Asia/Bangkok timezone.
- user_scores stores JSONB snapshots from chuumai-tools (one row per scrape per game).
- maimai DX Rating = sum of song ratings from top 35 "old" + top 15 "new" charts.
- Song rating: floor(chart_constant * rank_multiplier * min(achievement, 100.5) / 100)
- Rank multipliers: SSS+(>=1005000)=22.4, SSS(>=1000000)=21.6, SS+(>=995000)=21.1, SS(>=990000)=20.8, S+(>=980000)=20.3
- Currency per play: ${config.currency_per_play} THB

Use query_database to answer questions about play data. Write efficient SELECT queries only.
Use maimai_suggest_songs when the player asks for maimai song recommendations to improve their rating.
Be concise and helpful.

IMPORTANT FORMATTING RULES FOR maimai_suggest_songs:
- Show ALL songs from tool response, do not skip any
- Show score as percentage with 4 decimal places (e.g., 99.5000%, 100.5000%), NEVER show raw numbers like 1005000
- NEVER omit current_rank or current_score - they are REQUIRED fields
- In target mode: 'gain_needed' shows how much rating is needed from that song. 'max_gain' shows the maximum possible gain at SSS+. ALWAYS show BOTH.`;
}

// --- Tool definitions ---

const QUERY_TOOL: ChatCompletionTool = {
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

const SUGGEST_SONGS_TOOL: ChatCompletionTool = {
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
          description: "Target rating to reach (optional, triggers target mode)",
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

// --- Songs data cache ---

let _songsCache: SongData[] | null = null;

function loadSongs(): SongData[] {
  if (_songsCache) return _songsCache;
  try {
    _songsCache = JSON.parse(
      readFileSync(join(process.cwd(), "public", "maimai-songs.json"), "utf-8"),
    );
    return _songsCache!;
  } catch {
    return [];
  }
}

// --- Tool execution ---

const FORBIDDEN_SQL =
  /;|--|\/\*|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|COPY|INTO)\b/i;

async function executeTool(
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
  if (name === "maimai_suggest_songs") {
    try {
      const db = neon(process.env.DATABASE_URL!);
      const rows = await db.query(
        `SELECT data FROM user_scores WHERE game = 'maimai' ORDER BY scraped_at DESC LIMIT 1`,
      );
      if (rows.length === 0) {
        return { error: "No maimai player data found. Run the user data scraper first." };
      }
      const playerData = rows[0].data as PlayerData;
      const allSongs = loadSongs();
      if (allSongs.length === 0) {
        return { error: "No songs data available. maimai-songs.json is missing or empty." };
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

// --- Auth ---

function checkAuth(header: string | undefined, password: string | undefined): boolean {
  if (!password) return true;
  const token = header?.replace("Bearer ", "") ?? "";
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(password).digest();
  return timingSafeEqual(a, b);
}

// --- Handler ---

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!checkAuth(req.headers.authorization, process.env.DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { messages: userMessages, model: requestModel } = req.body ?? {};
  if (!Array.isArray(userMessages) || userMessages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }
  if (userMessages.length > 50) {
    return res.status(400).json({ error: "Too many messages (max 50)" });
  }
  for (const msg of userMessages) {
    if (!msg || typeof msg.role !== "string") {
      return res.status(400).json({ error: "Each message must have a role" });
    }
  }

  let client: OpenAI;
  try {
    client = createClient();
  } catch {
    return res.status(500).json({ error: "AI provider not configured" });
  }

  const model = requestModel || defaultModel();
  const config = loadConfig();
  const tools: ChatCompletionTool[] = [QUERY_TOOL];
  if (config.games.includes("maimai")) {
    tools.push(SUGGEST_SONGS_TOOL);
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(config) },
    ...userMessages,
  ];

  // SSE streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const MAX_ROUNDS = 5;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const stream = await client.chat.completions.create({
        model,
        messages,
        tools,
        stream: true,
      });

      let content = "";
      const toolCalls: {
        id: string;
        function: { name: string; arguments: string };
      }[] = [];

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          res.write(
            `data: ${JSON.stringify({ type: "content", content: delta.content })}\n\n`,
          );
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index === undefined) continue;
            if (!toolCalls[tc.index]) {
              toolCalls[tc.index] = {
                id: "",
                function: { name: "", arguments: "" },
              };
            }
            if (tc.id) toolCalls[tc.index].id = tc.id;
            if (tc.function?.name)
              toolCalls[tc.index].function.name += tc.function.name;
            if (tc.function?.arguments)
              toolCalls[tc.index].function.arguments += tc.function.arguments;
          }
        }
      }

      if (toolCalls.length === 0) {
        res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        return res.end();
      }

      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: content || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: tc.function,
        })),
      });

      // Execute tools, add results
      for (const tc of toolCalls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }
        const result = await executeTool(tc.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
        res.write(
          `data: ${JSON.stringify({ type: "tool", name: tc.function.name, result })}\n\n`,
        );
      }
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    return res.end();
  } catch (e: unknown) {
    console.error("Chat error:", e);
    res.write(
      `data: ${JSON.stringify({ type: "error", error: "Chat request failed" })}\n\n`,
    );
    return res.end();
  }
}
