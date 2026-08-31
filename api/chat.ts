import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import {
  isDataRegion,
  type DataRegion,
} from "../src/global/lib/regions.js";
import { checkAuth } from "../src/api/auth.js";
import { loadConfig } from "../src/api/config.js";
import { createClient, defaultModel } from "../src/api/chat/client.js";
import {
  CodexOAuthError,
  resolveCodexOAuthCredentials,
} from "../src/api/chat/codex-auth.js";
import {
  appendFunctionCallResultInput,
  runCodexResponsesRound,
} from "../src/api/chat/codex-responses.js";
import { loadSongs } from "../src/api/chat/songs-cache.js";
import {
  getMaimaiMaxConstant,
  runSlashCommandForRegion,
} from "../src/api/chat/slash-commands.js";
import { buildSystemPrompt } from "../src/api/chat/system-prompt.js";
import {
  executeTool,
  getChatTools,
} from "../src/api/chat/tools.js";

// Force the region's data tool on round 0 when the user's message looks like a
// data lookup, so the model can't skip the tool and answer from priors. Three-tier
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
  /\b(play(ed|s|ing)?|score(s|d)?|rating(s)?|rank(s|ed)?|song(s)?|chart(s)?|day(s)?|week(s|ly)?|month(s|ly)?|year(s)?|today|yesterday|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember|t)?|oct(ober)?|nov(ember)?|dec(ember)?|best|top|worst|most|more|fewer|less|avg|average|total|sum|count|streak|maimai|chunithm|ongeki|japan|international|sss\+?|ss\+?|aaa?)\b/i;

const MAX_TOOL_ROUNDS = 5;
const TOOL_ROUND_LIMIT_ERROR =
  "AI reached the tool-call safety limit — try a narrower request.";

function shouldForceQuery(text: string): boolean {
  if (STRONG_DATA_SIGNAL.test(text)) return true;
  if (KNOWLEDGE_INTENT.test(text)) return false;
  return DATA_INTENT.test(text);
}

function parseRegion(value: unknown): DataRegion | null {
  if (value == null) return "international";
  return isDataRegion(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function copySafeMetadata(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) return {};
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) projected[key] = record[key];
  }
  return projected;
}

/** Browser-safe projection; tool rows and aggregate values never enter SSE. */
export function projectToolResultForClient(
  name: string,
  result: unknown,
): unknown {
  if (name === "query_japan_activity") {
    return copySafeMetadata(result, [
      "view",
      "metrics",
      "has_data",
      "estimated_metrics",
      "rowCount",
      "error",
    ]);
  }
  if (name === "query_database") {
    return copySafeMetadata(result, ["sql", "rowCount", "error"]);
  }
  return result;
}

function isPrivateJapanResultKey(key: string): boolean {
  return (
    key === "source" ||
    key.startsWith("source_") ||
    key === "provenance" ||
    key.includes("cumulative")
  );
}

function stripPrivateJapanResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPrivateJapanResult);
  const record = asRecord(value);
  if (!record) return value;
  const stripped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (!isPrivateJapanResultKey(key)) {
      stripped[key] = stripPrivateJapanResult(child);
    }
  }
  return stripped;
}

function prepareToolResultForModel(name: string, result: unknown): unknown {
  return name === "query_japan_activity"
    ? stripPrivateJapanResult(result)
    : result;
}

// --- Handler ---

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!checkAuth(req.headers.authorization, process.env.DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const {
    messages: userMessages,
    model: requestModel,
    region: requestedRegion,
  } = req.body ?? {};
  const dataRegion = parseRegion(requestedRegion);
  if (!dataRegion) {
    return res.status(400).json({
      error: "region must be 'international' or 'japan'",
    });
  }
  if (!Array.isArray(userMessages) || userMessages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }
  if (userMessages.length > 50) {
    return res.status(400).json({ error: "Too many messages (max 50)" });
  }
  const normalizedUserMessages: Array<{
    role: "user" | "assistant";
    content: string;
  }> = [];
  for (const msg of userMessages) {
    if (
      !msg ||
      (msg.role !== "user" && msg.role !== "assistant") ||
      typeof msg.content !== "string"
    ) {
      return res.status(400).json({
        error: "Each message must have a user/assistant role and text content",
      });
    }
    if (msg.content.length > 20_000) {
      return res.status(400).json({ error: "Message is too long" });
    }
    normalizedUserMessages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    console.error("Failed to load config.json:", err);
    return res.status(500).json({ error: "Server config missing" });
  }

  let lastUserText = "";
  for (let i = normalizedUserMessages.length - 1; i >= 0; i--) {
    const m = normalizedUserMessages[i];
    if (m?.role === "user" && typeof m.content === "string") {
      lastUserText = m.content;
      break;
    }
  }

  const slashCommandResult = runSlashCommandForRegion(
    lastUserText,
    config.games,
    dataRegion,
    {
      maimaiMaxConstant: config.games.includes("maimai")
        ? getMaimaiMaxConstant(loadSongs())
        : null,
    },
  );
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

  const tools = getChatTools(dataRegion, config.games);
  const dataToolName =
    dataRegion === "japan" ? "query_japan_activity" : "query_database";
  const systemPrompt = buildSystemPrompt(config, dataRegion);

  const forceQuery = shouldForceQuery(lastUserText);

  // SSE streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const abortController = new AbortController();
  const { signal } = abortController;
  const abortRequest = () => abortController.abort();
  const abortOnRequestClose = () => {
    if (req.aborted) abortRequest();
  };
  const abortOnResponseClose = () => {
    if (!res.writableEnded) abortRequest();
  };
  req.on?.("aborted", abortRequest);
  req.on?.("close", abortOnRequestClose);
  res.on?.("close", abortOnResponseClose);
  if (req.aborted || res.destroyed) abortRequest();

  const removeAbortListeners = () => {
    req.off?.("aborted", abortRequest);
    req.off?.("close", abortOnRequestClose);
    res.off?.("close", abortOnResponseClose);
  };
  const canWrite = () =>
    !signal.aborted && !res.destroyed && !res.writableEnded;
  const writeSse = (event: Record<string, unknown>): boolean => {
    if (!canWrite()) {
      abortRequest();
      return false;
    }
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      return true;
    } catch {
      abortRequest();
      return false;
    }
  };
  const endSse = () => {
    if (canWrite()) return res.end();
  };
  const endWithToolLimit = () => {
    if (writeSse({ type: "error", error: TOOL_ROUND_LIMIT_ERROR })) {
      return endSse();
    }
  };

  let usingCodexSubscription = false;
  try {
    if (signal.aborted) return;
    const codexCredentials = await resolveCodexOAuthCredentials();
    if (signal.aborted) return;
    if (codexCredentials) {
      usingCodexSubscription = true;
      let input: ResponseInputItem[] = normalizedUserMessages.map(
        ({ role, content }) => ({ role, content }),
      );

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (signal.aborted) return;
        const response = await runCodexResponsesRound({
          accessToken: codexCredentials.accessToken,
          accountId: codexCredentials.accountId,
          model: codexCredentials.model,
          instructions: systemPrompt,
          input,
          tools,
          toolChoice:
            round === 0 && forceQuery
              ? {
                  type: "function",
                  function: { name: dataToolName },
                }
              : undefined,
          onTextDelta: (content) => {
            writeSse({ type: "content", content });
          },
          signal,
        });
        if (signal.aborted) return;

        if (response.functionCalls.length === 0) {
          if (writeSse({ type: "done" })) return endSse();
          return;
        }
        if (round === MAX_TOOL_ROUNDS - 1) {
          return endWithToolLimit();
        }

        input = response.nextInput;
        for (const call of response.functionCalls) {
          if (signal.aborted) return;
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(call.arguments);
          } catch {
            args = {};
          }
          const result = prepareToolResultForModel(
            call.name,
            await executeTool(call.name, args, dataRegion),
          );
          if (signal.aborted) return;
          input = appendFunctionCallResultInput(input, call.call_id, result);
          writeSse({
            type: "tool",
            name: call.name,
            result: projectToolResultForClient(call.name, result),
          });
        }
      }

      return endWithToolLimit();
    }

    let client: OpenAI;
    try {
      client = createClient();
    } catch {
      throw new Error("AI provider not configured");
    }
    const model =
      typeof requestModel === "string" && requestModel.trim()
        ? requestModel.trim()
        : defaultModel();
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...normalizedUserMessages,
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) return;
      const completionOpts: ChatCompletionCreateParamsStreaming = {
        model,
        messages,
        tools,
        stream: true,
      };
      if (round === 0 && forceQuery) {
        completionOpts.tool_choice = {
          type: "function",
          function: { name: dataToolName },
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
      const stream = await client.chat.completions.create(completionOpts, {
        signal,
      });
      if (signal.aborted) return;

      let content = "";
      const toolCalls: {
        id: string;
        function: { name: string; arguments: string };
      }[] = [];

      for await (const chunk of stream) {
        if (signal.aborted) return;
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          writeSse({ type: "content", content: delta.content });
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

      if (signal.aborted) return;
      if (toolCalls.length === 0) {
        if (writeSse({ type: "done" })) return endSse();
        return;
      }
      if (round === MAX_TOOL_ROUNDS - 1) {
        return endWithToolLimit();
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
        if (signal.aborted) return;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }
        const result = prepareToolResultForModel(
          tc.function.name,
          await executeTool(tc.function.name, args, dataRegion),
        );
        if (signal.aborted) return;
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
        writeSse({
          type: "tool",
          name: tc.function.name,
          result: projectToolResultForClient(tc.function.name, result),
        });
      }
    }

    return endWithToolLimit();
  } catch (e: unknown) {
    if (signal.aborted) return;
    // Avoid logging provider/OAuth error objects because request metadata may
    // contain authorization headers. The user receives a bounded safe error.
    console.error(
      "Chat error:",
      e instanceof CodexOAuthError ? e.code : "provider_request_failed",
    );
    if (
      writeSse({
        type: "error",
        error: toUserError(e, usingCodexSubscription),
      })
    ) {
      return endSse();
    }
  } finally {
    removeAbortListeners();
  }
}

function toUserError(e: unknown, usingCodexSubscription = false): string {
  if (e instanceof CodexOAuthError) {
    if (
      e.code === "codex_auth_reauthentication_required" ||
      e.code === "codex_auth_stored_credentials_invalid"
    ) {
      return "ChatGPT connection expired — reconnect it in Settings.";
    }
    if (e.code === "codex_auth_rate_limited") {
      return "ChatGPT/Codex is rate limited — wait a moment and retry.";
    }
    if (e.code === "codex_auth_storage_unavailable") {
      return "ChatGPT credential storage is unavailable — retry in a moment.";
    }
    return e.message;
  }

  const err = e as {
    status?: number;
    message?: string;
    error?: { type?: string; message?: string };
  };
  const status = err?.status;
  const providerType = err?.error?.type;
  const providerMsg = err?.error?.message;

  if (status === 401 && usingCodexSubscription) {
    return "ChatGPT connection was rejected — reconnect it in Settings.";
  }
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
