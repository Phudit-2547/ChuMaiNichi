import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => {
  class MockCodexOAuthError extends Error {
    constructor(
      readonly code: string,
      readonly statusCode: number,
      message: string,
    ) {
      super(message);
      this.name = "CodexOAuthError";
    }
  }

  return {
    MockCodexOAuthError,
    resolveCodexOAuthCredentials: vi.fn(),
    runCodexResponsesRound: vi.fn(),
    appendFunctionCallResultInput: vi.fn(),
    createClient: vi.fn(),
    defaultModel: vi.fn(() => "fallback-model"),
    executeTool: vi.fn(),
  };
});

vi.mock("../src/api/chat/codex-auth.js", () => ({
  CodexOAuthError: mocks.MockCodexOAuthError,
  resolveCodexOAuthCredentials: mocks.resolveCodexOAuthCredentials,
}));

vi.mock("../src/api/chat/codex-responses.js", () => ({
  runCodexResponsesRound: mocks.runCodexResponsesRound,
  appendFunctionCallResultInput: mocks.appendFunctionCallResultInput,
}));

vi.mock("../src/api/chat/client.js", () => ({
  createClient: mocks.createClient,
  defaultModel: mocks.defaultModel,
}));

vi.mock("../src/api/chat/tools.js", () => ({
  getChatTools: () => [],
  executeTool: mocks.executeTool,
}));

vi.mock("../src/api/config.js", () => ({
  loadConfig: () => ({ games: ["maimai"], currency_per_play: 40 }),
}));

vi.mock("../src/api/chat/songs-cache.js", () => ({
  loadSongs: () => [],
}));

vi.mock("../src/api/chat/slash-commands.js", () => ({
  getMaimaiMaxConstant: () => null,
  runSlashCommandForRegion: () => null,
}));

vi.mock("../src/api/chat/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
}));

import handler, { projectToolResultForClient } from "./chat";

const originalEnv = { ...process.env };

function request(): VercelRequest {
  return Object.assign(new EventEmitter(), {
    method: "POST",
    headers: {},
    query: {},
    body: {
      messages: [{ role: "user", content: "Show me my scores" }],
      region: "international",
    },
    aborted: false,
  }) as unknown as VercelRequest;
}

function response() {
  const writes: string[] = [];
  const emitter = new EventEmitter();
  let writableEnded = false;
  let destroyed = false;
  const res = Object.assign(emitter, {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      writableEnded = true;
      return emitter;
    }),
  }) as unknown as VercelResponse;
  Object.defineProperties(res, {
    writableEnded: { get: () => writableEnded },
    destroyed: { get: () => destroyed },
  });
  return {
    res,
    writes,
    disconnect: () => {
      destroyed = true;
      emitter.emit("close");
    },
  };
}

function events(writes: string[]): Array<Record<string, unknown>> {
  return writes.flatMap((chunk) =>
    chunk
      .split("\n\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line.replace(/^data: /, ""))),
  );
}

describe("api/chat provider selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.GEMINI_API_KEY;
    mocks.appendFunctionCallResultInput.mockImplementation(
      (input, callId, result) => [
        ...input,
        { type: "function_call_output", call_id: callId, output: result },
      ],
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses connected Codex credentials and preserves the local tool SSE loop", async () => {
    mocks.resolveCodexOAuthCredentials.mockResolvedValue({
      accessToken: "access-token",
      accountId: "account-id",
      model: "gpt-5.6-luna",
    });
    const fullToolResult = {
      sql: "SELECT 1",
      rows: [{ score: 1_005_000 }],
      rowCount: 1,
    };
    mocks.executeTool.mockResolvedValue(fullToolResult);
    mocks.runCodexResponsesRound
      .mockImplementationOnce(async (options) => {
        options.onTextDelta?.("Checking scores…");
        return {
          text: "Checking scores…",
          functionCalls: [
            {
              type: "function_call",
              call_id: "call-1",
              name: "query_database",
              arguments: '{"sql":"SELECT 1"}',
            },
          ],
          outputItems: [],
          nextInput: [{ role: "user", content: "Show me my scores" }],
        };
      })
      .mockImplementationOnce(async (options) => {
        options.onTextDelta?.("Your score is ready.");
        return {
          text: "Your score is ready.",
          functionCalls: [],
          outputItems: [],
          nextInput: [],
        };
      });

    const { res, writes } = response();
    const req = request();
    req.body.model = "gpt-5.6-sol";
    await handler(req, res);

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.runCodexResponsesRound).toHaveBeenCalledTimes(2);
    expect(mocks.runCodexResponsesRound.mock.calls[0]?.[0]).toMatchObject({
      accessToken: "access-token",
      accountId: "account-id",
      model: "gpt-5.6-luna",
      instructions: "system prompt",
      toolChoice: {
        type: "function",
        function: { name: "query_database" },
      },
    });
    expect(mocks.executeTool).toHaveBeenCalledWith(
      "query_database",
      { sql: "SELECT 1" },
      "international",
    );
    expect(mocks.appendFunctionCallResultInput).toHaveBeenCalledWith(
      expect.any(Array),
      "call-1",
      fullToolResult,
    );
    expect(events(writes)).toEqual([
      { type: "content", content: "Checking scores…" },
      {
        type: "tool",
        name: "query_database",
        result: { sql: "SELECT 1", rowCount: 1 },
      },
      { type: "content", content: "Your score is ready." },
      { type: "done" },
    ]);
  });

  it("projects data-tool SSE results to non-sensitive client metadata", () => {
    expect(
      projectToolResultForClient("query_japan_activity", {
        view: "totals",
        metrics: ["ongeki_tracks"],
        has_data: true,
        totals: { ongeki_tracks: 543 },
        rows: [{ source_paths: ["private/journal.md"] }],
        rowCount: 60,
      }),
    ).toEqual({
      view: "totals",
      metrics: ["ongeki_tracks"],
      has_data: true,
      rowCount: 60,
    });

    expect(
      projectToolResultForClient("query_database", {
        sql: "SELECT score FROM user_scores",
        rows: [{ score: 1_005_000 }],
        rowCount: 1,
      }),
    ).toEqual({
      sql: "SELECT score FROM user_scores",
      rowCount: 1,
    });

    const suggestions = { moves: [{ title: "VOLT" }] };
    expect(
      projectToolResultForClient("maimai_suggest_songs", suggestions),
    ).toBe(suggestions);
  });

  it("keeps minimized Japan data for the model while SSE gets metadata only", async () => {
    mocks.resolveCodexOAuthCredentials.mockResolvedValue({
      accessToken: "access-token",
      accountId: "account-id",
      model: "gpt-5.6-terra",
    });
    mocks.executeTool.mockResolvedValue({
      view: "totals",
      metrics: ["ongeki_tracks"],
      has_data: true,
      totals: { ongeki_tracks: 543 },
      source_paths: ["private/journal.md"],
      source_hashes: ["private-hash"],
      ongeki_cumulative_tracks: 543,
    });
    mocks.runCodexResponsesRound
      .mockResolvedValueOnce({
        text: "",
        functionCalls: [
          {
            type: "function_call",
            call_id: "call-japan",
            name: "query_japan_activity",
            arguments:
              '{"view":"totals","metrics":["ongeki_tracks"]}',
          },
        ],
        outputItems: [],
        nextInput: [{ role: "user", content: "Total ONGEKI in 2026" }],
      })
      .mockResolvedValueOnce({
        text: "543 tracks",
        functionCalls: [],
        outputItems: [],
        nextInput: [],
      });
    const req = request();
    req.body.region = "japan";
    const { res, writes } = response();

    await handler(req, res);

    expect(mocks.appendFunctionCallResultInput).toHaveBeenCalledWith(
      expect.any(Array),
      "call-japan",
      {
        view: "totals",
        metrics: ["ongeki_tracks"],
        has_data: true,
        totals: { ongeki_tracks: 543 },
      },
    );
    expect(events(writes)).toContainEqual({
      type: "tool",
      name: "query_japan_activity",
      result: {
        view: "totals",
        metrics: ["ongeki_tracks"],
        has_data: true,
      },
    });
    expect(JSON.stringify(events(writes))).not.toMatch(
      /543|source_paths|source_hashes|cumulative/,
    );
  });

  it("uses the existing OpenAI-compatible provider only when Codex is disconnected", async () => {
    mocks.resolveCodexOAuthCredentials.mockResolvedValue(null);
    async function* legacyStream() {
      yield { choices: [{ delta: { content: "Fallback response" } }] };
    }
    const create = vi.fn().mockResolvedValue(legacyStream());
    mocks.createClient.mockReturnValue({
      chat: { completions: { create } },
    });

    const { res, writes } = response();
    await handler(request(), res);

    expect(mocks.runCodexResponsesRound).not.toHaveBeenCalled();
    expect(mocks.createClient).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "fallback-model", stream: true }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(events(writes)).toEqual([
      { type: "content", content: "Fallback response" },
      { type: "done" },
    ]);
  });

  it("ends a Codex tool loop with a bounded error at the round limit", async () => {
    mocks.resolveCodexOAuthCredentials.mockResolvedValue({
      accessToken: "access-token",
      accountId: "account-id",
      model: "gpt-5.6-terra",
    });
    mocks.executeTool.mockResolvedValue({ rows: [] });
    mocks.runCodexResponsesRound.mockResolvedValue({
      text: "",
      functionCalls: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "query_database",
          arguments: '{"sql":"SELECT 1"}',
        },
      ],
      outputItems: [],
      nextInput: [{ role: "user", content: "Show me my scores" }],
    });

    const { res, writes } = response();
    await handler(request(), res);

    expect(mocks.runCodexResponsesRound).toHaveBeenCalledTimes(5);
    // The fifth call cannot be consumed by another model round, so its tools
    // must not run.
    expect(mocks.executeTool).toHaveBeenCalledTimes(4);
    const streamedEvents = events(writes);
    expect(streamedEvents.at(-1)).toEqual({
      type: "error",
      error: "AI reached the tool-call safety limit — try a narrower request.",
    });
    expect(streamedEvents).not.toContainEqual({ type: "done" });
  });

  it("ends an OpenAI-compatible tool loop with a bounded error at the round limit", async () => {
    mocks.resolveCodexOAuthCredentials.mockResolvedValue(null);
    mocks.executeTool.mockResolvedValue({ rows: [] });
    async function* legacyToolStream() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "query_database",
                    arguments: '{"sql":"SELECT 1"}',
                  },
                },
              ],
            },
          },
        ],
      };
    }
    const create = vi.fn(async () => legacyToolStream());
    mocks.createClient.mockReturnValue({
      chat: { completions: { create } },
    });

    const { res, writes } = response();
    await handler(request(), res);

    expect(create).toHaveBeenCalledTimes(5);
    expect(mocks.executeTool).toHaveBeenCalledTimes(4);
    const streamedEvents = events(writes);
    expect(streamedEvents.at(-1)).toEqual({
      type: "error",
      error: "AI reached the tool-call safety limit — try a narrower request.",
    });
    expect(streamedEvents).not.toContainEqual({ type: "done" });
  });

  it("does not select credentials when the request was already aborted", async () => {
    const req = request();
    req.aborted = true;
    const { res, writes } = response();

    await handler(req, res);

    expect(mocks.resolveCodexOAuthCredentials).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("aborts a Codex Responses request when the incoming request is aborted", async () => {
    mocks.resolveCodexOAuthCredentials.mockResolvedValue({
      accessToken: "access-token",
      accountId: "account-id",
      model: "gpt-5.6-terra",
    });
    let providerSignal: AbortSignal | undefined;
    mocks.runCodexResponsesRound.mockImplementation(async (options) => {
      providerSignal = options.signal;
      if (!providerSignal?.aborted) {
        await new Promise<void>((resolve) =>
          providerSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      }
      throw new Error("aborted provider request");
    });

    const req = request();
    const { res, writes } = response();
    const handling = handler(req, res);
    await vi.waitFor(() =>
      expect(mocks.runCodexResponsesRound).toHaveBeenCalledOnce(),
    );
    req.emit("aborted");
    await handling;

    expect(providerSignal?.aborted).toBe(true);
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("does not treat a normal request-stream close as a client abort", async () => {
    mocks.resolveCodexOAuthCredentials.mockResolvedValue({
      accessToken: "access-token",
      accountId: "account-id",
      model: "gpt-5.6-terra",
    });
    let providerSignal: AbortSignal | undefined;
    let finishRound: ((result: unknown) => void) | undefined;
    mocks.runCodexResponsesRound.mockImplementation(
      (options) =>
        new Promise((resolve) => {
          providerSignal = options.signal;
          finishRound = resolve;
        }),
    );

    const req = request();
    const { res, writes } = response();
    const handling = handler(req, res);
    await vi.waitFor(() =>
      expect(mocks.runCodexResponsesRound).toHaveBeenCalledOnce(),
    );

    req.emit("close");
    expect(providerSignal?.aborted).toBe(false);
    finishRound?.({
      text: "",
      functionCalls: [],
      outputItems: [],
      nextInput: [],
    });
    await handling;

    expect(events(writes)).toEqual([{ type: "done" }]);
  });

  it("does not write or start another round after disconnect during a tool", async () => {
    mocks.resolveCodexOAuthCredentials.mockResolvedValue({
      accessToken: "access-token",
      accountId: "account-id",
      model: "gpt-5.6-terra",
    });
    mocks.runCodexResponsesRound.mockResolvedValue({
      text: "",
      functionCalls: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "query_database",
          arguments: '{"sql":"SELECT 1"}',
        },
      ],
      outputItems: [],
      nextInput: [{ role: "user", content: "Show me my scores" }],
    });
    let finishTool: ((result: unknown) => void) | undefined;
    mocks.executeTool.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishTool = resolve;
        }),
    );

    const { res, writes, disconnect } = response();
    const handling = handler(request(), res);
    await vi.waitFor(() => expect(mocks.executeTool).toHaveBeenCalledOnce());
    disconnect();
    finishTool?.({ rows: [] });
    await handling;

    expect(mocks.runCodexResponsesRound).toHaveBeenCalledOnce();
    expect(mocks.executeTool).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("aborts an OpenAI-compatible stream when the response connection closes", async () => {
    mocks.resolveCodexOAuthCredentials.mockResolvedValue(null);
    let providerSignal: AbortSignal | undefined;
    const create = vi.fn(async (_body, options) => {
      providerSignal = options.signal;
      async function* stalledStream() {
        yield await new Promise<never>((_resolve, reject) => {
          const rejectAsAborted = () =>
            reject(new Error("aborted provider stream"));
          if (providerSignal?.aborted) rejectAsAborted();
          else
            providerSignal?.addEventListener("abort", rejectAsAborted, {
              once: true,
            });
        });
      }
      return stalledStream();
    });
    mocks.createClient.mockReturnValue({
      chat: { completions: { create } },
    });

    const { res, writes, disconnect } = response();
    const handling = handler(request(), res);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    disconnect();
    await handling;

    expect(providerSignal?.aborted).toBe(true);
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("surfaces a connected-session OAuth failure without metered fallback", async () => {
    mocks.resolveCodexOAuthCredentials.mockRejectedValue(
      new mocks.MockCodexOAuthError(
        "codex_auth_reauthentication_required",
        401,
        "Codex authentication must be renewed",
      ),
    );

    const { res, writes } = response();
    await handler(request(), res);

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.runCodexResponsesRound).not.toHaveBeenCalled();
    expect(events(writes)).toEqual([
      {
        type: "error",
        error: "ChatGPT connection expired — reconnect it in Settings.",
      },
    ]);
  });

  it("does not fall back when Disconnect races credential selection", async () => {
    mocks.resolveCodexOAuthCredentials.mockRejectedValue(
      new mocks.MockCodexOAuthError(
        "codex_auth_connection_changed",
        409,
        "ChatGPT connection changed while the request was starting; retry it",
      ),
    );

    const { res, writes } = response();
    await handler(request(), res);

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.runCodexResponsesRound).not.toHaveBeenCalled();
    expect(events(writes)).toEqual([
      {
        type: "error",
        error: "ChatGPT connection changed while the request was starting; retry it",
      },
    ]);
  });
});
