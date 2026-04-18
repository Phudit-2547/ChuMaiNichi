import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { checkAuth } from "../src/api/auth";
import { loadConfig } from "../src/api/config";
import { createClient, defaultModel } from "../src/api/chat/client";
import { buildSystemPrompt } from "../src/api/chat/system-prompt";
import {
  QUERY_TOOL,
  SUGGEST_SONGS_TOOL,
  executeTool,
} from "../src/api/chat/tools";

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
