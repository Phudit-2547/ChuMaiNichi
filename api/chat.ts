import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { checkAuth } from "../src/api/auth.js";
import { loadConfig } from "../src/api/config.js";
import { createClient, defaultModel } from "../src/api/chat/client.js";
import { loadSongs } from "../src/api/chat/songs-cache.js";
import {
  getMaimaiMaxConstant,
  runSlashCommand,
} from "../src/api/chat/slash-commands.js";
import { buildSystemPrompt } from "../src/api/chat/system-prompt.js";
import {
  QUERY_TOOL,
  SUGGEST_SONGS_TOOL,
  executeTool,
} from "../src/api/chat/tools.js";

// Force query_database on round 0 when the user's message looks like a data
// lookup, so the model can't skip the tool and answer from priors. Three-tier
// heuristic over the last user message:
//   1. STRONG_DATA_SIGNAL → force (possessives, "show me", "how many", any digit)
//   2. KNOWLEDGE_INTENT   → leave auto ("how does X work?", "explain", "formula")
//   3. DATA_INTENT        → force (game / score / rating / date keywords)
// False-force costs one cheap SELECT; missed-force is just baseline behavior,
// so the heuristic can't regress on today's quality.
const STRONG_DATA_SIGNAL =
  /\b(my|mine|our|ours|show me|list|give me|pull up|how many|how often|count of)\b|\d/i;
const KNOWLEDGE_INTENT =
  /\b(how (do|does|is|are)|what (is|are|does|do)|explain|why|formula|mean(ing|s)?|difference between|describe|tell me about|walk me through|break down)\b/i;
const DATA_INTENT =
  /\b(play(ed|s|ing)?|score(s|d)?|rating(s)?|rank(s|ed)?|song(s)?|chart(s)?|day(s)?|week(s|ly)?|month(s|ly)?|year(s)?|today|yesterday|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember|t)?|oct(ober)?|nov(ember)?|dec(ember)?|best|top|worst|most|more|fewer|less|avg|average|total|sum|count|streak|maimai|chunithm|sss\+?|ss\+?|aaa?)\b/i;

function shouldForceQuery(text: string): boolean {
  if (STRONG_DATA_SIGNAL.test(text)) return true;
  if (KNOWLEDGE_INTENT.test(text)) return false;
  return DATA_INTENT.test(text);
}

// --- Handler ---

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    console.error("Failed to load config.json:", err);
    return res.status(500).json({ error: "Server config missing" });
  }

  let lastUserText = "";
  for (let i = userMessages.length - 1; i >= 0; i--) {
    const m = userMessages[i];
    if (m?.role === "user" && typeof m.content === "string") {
      lastUserText = m.content;
      break;
    }
  }

  const slashCommandResult = runSlashCommand(lastUserText, config.games, {
    maimaiMaxConstant: config.games.includes("maimai")
      ? getMaimaiMaxConstant(loadSongs())
      : null,
  });
  if (slashCommandResult != null) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(
      `data: ${JSON.stringify({ type: "content", content: slashCommandResult })}\n\n`,
    );
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    return res.end();
  }

  let client: OpenAI;
  try {
    client = createClient();
  } catch {
    return res.status(500).json({ error: "AI provider not configured" });
  }

  const model = requestModel || defaultModel();
  const tools: ChatCompletionTool[] = [QUERY_TOOL];
  if (config.games.includes("maimai")) {
    tools.push(SUGGEST_SONGS_TOOL);
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(config) },
    ...userMessages,
  ];

  const forceQuery = shouldForceQuery(lastUserText);

  // SSE streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const MAX_ROUNDS = 5;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const completionOpts: ChatCompletionCreateParamsStreaming = {
        model,
        messages,
        tools,
        stream: true,
      };
      if (round === 0 && forceQuery) {
        completionOpts.tool_choice = {
          type: "function",
          function: { name: "query_database" },
        };
      }
      // Gemini 2.5 Flash thinks by default. Unbounded thinking can starve
      // the output stream, but disabling it entirely also breaks tool
      // reasoning. Use the minimum non-zero budget ("low") and pair with a
      // large max_tokens so thinking + output both fit. Other providers
      // (e.g. MiniMax) cap output around 8K and 400 on larger values.
      if (process.env.GEMINI_API_KEY) {
        completionOpts.reasoning_effort = "low";
        completionOpts.max_tokens = 32768;
      }
      const stream = await client.chat.completions.create(completionOpts);

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
            // OpenAI emits fragmented tool_calls with an explicit index;
            // Gemini's OpenAI-compat layer emits each tool call whole in a
            // single chunk and omits index. Fall back to the running length.
            const idx = tc.index ?? toolCalls.length;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: "",
                function: { name: "", arguments: "" },
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name)
              toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments)
              toolCalls[idx].function.arguments += tc.function.arguments;
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
      `data: ${JSON.stringify({ type: "error", error: toUserError(e) })}\n\n`,
    );
    return res.end();
  }
}

function toUserError(e: unknown): string {
  const err = e as {
    status?: number;
    message?: string;
    error?: { type?: string; message?: string };
  };
  const status = err?.status;
  const providerType = err?.error?.type;
  const providerMsg = err?.error?.message;

  if (status === 401) return "AI provider auth failed — check your API key.";
  if (status === 429) return "Rate limited by AI provider — wait a moment and retry.";
  if (status === 529 || providerType === "overloaded_error") {
    return "AI provider is overloaded — retry in a moment or switch provider.";
  }
  if (status && status >= 500) {
    return `AI provider error (${status}) — retry in a moment.`;
  }
  if (providerMsg) return providerMsg.slice(0, 200);
  if (err?.message) return err.message.slice(0, 200);
  return "Chat request failed";
}
