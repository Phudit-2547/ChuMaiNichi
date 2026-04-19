import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { checkAuth } from "../src/api/auth.js";
import { loadConfig } from "../src/api/config.js";
import { createClient, defaultModel } from "../src/api/chat/client.js";
import { buildSystemPrompt } from "../src/api/chat/system-prompt.js";
import {
  QUERY_TOOL,
  SUGGEST_SONGS_TOOL,
  executeTool,
} from "../src/api/chat/tools.js";

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
      const completionOpts: Record<string, unknown> = {
        model,
        messages,
        tools,
        stream: true,
      };
      // Gemini 2.5 Flash thinks by default. Unbounded thinking can starve
      // the output stream, but disabling it entirely also breaks tool
      // reasoning. Use the minimum non-zero budget ("low") and pair with a
      // large max_tokens so thinking + output both fit. Other providers
      // (e.g. MiniMax) cap output around 8K and 400 on larger values.
      if (process.env.GEMINI_API_KEY) {
        completionOpts.reasoning_effort = "low";
        completionOpts.max_tokens = 32768;
      }
      const stream = await client.chat.completions.create(
        completionOpts as Parameters<typeof client.chat.completions.create>[0],
      );

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
      `data: ${JSON.stringify({ type: "error", error: "Chat request failed" })}\n\n`,
    );
    return res.end();
  }
}
