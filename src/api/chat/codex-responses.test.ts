import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type {
  ResponseCreateParamsStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  appendFunctionCallInput,
  appendFunctionCallResultInput,
  appendResponseOutputInput,
  CODEX_RESPONSES_BASE_URL,
  CODEX_RESPONSES_ORIGINATOR,
  CODEX_RESPONSES_USER_AGENT,
  createCodexResponsesClient,
  runCodexResponsesRound,
  toResponsesFunctionTools,
  toResponsesToolChoice,
  type CodexResponsesClient,
  type CodexResponsesClientFactory,
} from "./codex-responses";

const QUERY_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "query_database",
    description: "Run a read-only query",
    parameters: {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
    },
  },
};

function mockFactory(events: readonly ResponseStreamEvent[]) {
  const create = vi.fn(
    async (
      body: ResponseCreateParamsStreaming,
      requestOptions?: { signal?: AbortSignal },
    ) => {
      void requestOptions;
      void body;
      async function* stream() {
        for (const event of events) yield event;
      }
      return stream();
    },
  );
  const factory = vi.fn(() => ({
    responses: { create },
  })) as unknown as CodexResponsesClientFactory;
  return { create, factory };
}

describe("experimental Codex Responses adapter", () => {
  it("creates an SDK client for the Codex endpoint with caller credentials", () => {
    const client = { responses: {} } as unknown as CodexResponsesClient;
    const factory = vi.fn(() => client);

    expect(
      createCodexResponsesClient(
        { accessToken: "access-token", accountId: "account-id" },
        factory,
      ),
    ).toBe(client);
    expect(factory).toHaveBeenCalledWith({
      apiKey: "access-token",
      baseURL: CODEX_RESPONSES_BASE_URL,
      defaultHeaders: {
        "ChatGPT-Account-ID": "account-id",
        "User-Agent": CODEX_RESPONSES_USER_AGENT,
        originator: CODEX_RESPONSES_ORIGINATOR,
      },
    });
  });

  it("flattens Chat Completions tools and forced function choice", () => {
    expect(toResponsesFunctionTools([QUERY_TOOL])).toEqual([
      {
        type: "function",
        name: "query_database",
        description: "Run a read-only query",
        parameters: QUERY_TOOL.function.parameters,
        strict: false,
      },
    ]);
    expect(
      toResponsesToolChoice({
        type: "function",
        function: { name: "query_database" },
      }),
    ).toEqual({ type: "function", name: "query_database" });
    expect(toResponsesToolChoice("auto")).toBe("auto");
  });

  it("passes the caller abort signal to the Responses SDK request", async () => {
    const events = [
      {
        type: "response.completed",
        response: { output: [] },
        sequence_number: 1,
      },
    ] as unknown as ResponseStreamEvent[];
    const { create, factory } = mockFactory(events);
    const signal = new AbortController().signal;

    await runCodexResponsesRound(
      {
        accessToken: "access-token",
        accountId: "account-id",
        model: "gpt-5.6-terra",
        instructions: "Answer.",
        input: [{ role: "user", content: "Question" }],
        signal,
      },
      factory,
    );

    expect(create.mock.calls[0]?.[1]).toEqual({ signal });
  });

  it("appends calls, complete response output, and local results immutably", () => {
    const input: ResponseInputItem[] = [{ role: "user", content: "Hello" }];
    const call: ResponseFunctionToolCall = {
      type: "function_call",
      call_id: "call-1",
      name: "query_database",
      arguments: '{"sql":"SELECT 1"}',
    };
    const reasoning: ResponseOutputItem = {
      id: "reasoning-1",
      type: "reasoning",
      summary: [],
      encrypted_content: "encrypted",
      status: "completed",
    };

    expect(appendFunctionCallInput(input, call)).toEqual([input[0], call]);
    const withOutput = appendResponseOutputInput(input, [reasoning, call]);
    const withResult = appendFunctionCallResultInput(withOutput, "call-1", {
      rows: [{ value: 1 }],
    });

    expect(input).toEqual([{ role: "user", content: "Hello" }]);
    expect(withResult).toEqual([
      input[0],
      reasoning,
      call,
      {
        type: "function_call_output",
        call_id: "call-1",
        output: '{"rows":[{"value":1}]}',
      },
    ]);
  });

  it("streams text and returns replayable encrypted reasoning and calls", async () => {
    const reasoning: ResponseOutputItem = {
      id: "reasoning-1",
      type: "reasoning",
      summary: [],
      encrypted_content: "encrypted",
      status: "completed",
    };
    const message: ResponseOutputItem = {
      id: "message-1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Hello",
          annotations: [],
          logprobs: [],
        },
      ],
    };
    const call: ResponseOutputItem = {
      id: "function-1",
      type: "function_call",
      call_id: "call-1",
      name: "query_database",
      arguments: '{"sql":"SELECT 1"}',
      status: "completed",
    };
    const events = [
      {
        type: "response.output_item.done",
        output_index: 2,
        item: call,
        sequence_number: 3,
      },
      {
        type: "response.output_text.delta",
        output_index: 1,
        content_index: 0,
        item_id: "message-1",
        delta: "Hel",
        logprobs: [],
        sequence_number: 4,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: reasoning,
        sequence_number: 1,
      },
      {
        type: "response.output_text.delta",
        output_index: 1,
        content_index: 0,
        item_id: "message-1",
        delta: "lo",
        logprobs: [],
        sequence_number: 5,
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: message,
        sequence_number: 6,
      },
      {
        type: "response.completed",
        response: { output: [reasoning, message, call] },
        sequence_number: 7,
      },
    ] as ResponseStreamEvent[];
    const { create, factory } = mockFactory(events);
    const onTextDelta = vi.fn();
    const input: ResponseInputItem[] = [{ role: "user", content: "Question" }];

    const result = await runCodexResponsesRound(
      {
        accessToken: "access-token",
        accountId: "account-id",
        model: "gpt-5.3-codex",
        instructions: "Use tools for user data.",
        input,
        tools: [QUERY_TOOL],
        toolChoice: {
          type: "function",
          function: { name: "query_database" },
        },
        onTextDelta,
      },
      factory,
    );

    expect(onTextDelta.mock.calls).toEqual([["Hel"], ["lo"]]);
    expect(result).toMatchObject({
      text: "Hello",
      functionCalls: [call],
      outputItems: [reasoning, message, call],
      nextInput: [input[0], reasoning, message, call],
    });
    expect(input).toEqual([{ role: "user", content: "Question" }]);

    expect(create).toHaveBeenCalledOnce();
    const body = create.mock.calls[0]![0];
    expect(body).toMatchObject({
      model: "gpt-5.3-codex",
      instructions: "Use tools for user data.",
      input,
      include: ["reasoning.encrypted_content"],
      store: false,
      stream: true,
      tools: [
        {
          type: "function",
          name: "query_database",
          parameters: QUERY_TOOL.function.parameters,
          strict: false,
        },
      ],
      tool_choice: { type: "function", name: "query_database" },
    });
    expect(body.input).not.toBe(input);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("prompt_cache_retention");
  });

  it("streams refusal text without duplicating the final refusal", async () => {
    const events = [
      {
        type: "response.refusal.delta",
        item_id: "message-1",
        output_index: 0,
        content_index: 0,
        delta: "I can’t ",
        sequence_number: 1,
      },
      {
        type: "response.refusal.delta",
        item_id: "message-1",
        output_index: 0,
        content_index: 0,
        delta: "help with that.",
        sequence_number: 2,
      },
      {
        type: "response.refusal.done",
        item_id: "message-1",
        output_index: 0,
        content_index: 0,
        refusal: "I can’t help with that.",
        sequence_number: 3,
      },
      {
        type: "response.completed",
        response: { output: [] },
        sequence_number: 4,
      },
    ] as ResponseStreamEvent[];
    const { factory } = mockFactory(events);
    const onTextDelta = vi.fn();

    const result = await runCodexResponsesRound(
      {
        accessToken: "access-token",
        accountId: "account-id",
        model: "gpt-5.6-terra",
        instructions: "Be safe.",
        input: [{ role: "user", content: "Question" }],
        onTextDelta,
      },
      factory,
    );

    expect(result.text).toBe("I can’t help with that.");
    expect(onTextDelta.mock.calls).toEqual([
      ["I can’t "],
      ["help with that."],
    ]);
  });

  it("accepts a null terminal response after completed output items", async () => {
    const call: ResponseOutputItem = {
      type: "function_call",
      id: "function-1",
      call_id: "call-1",
      name: "query_database",
      arguments: '{"sql":"SELECT 1"}',
      status: "completed",
    };
    const events = [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: call,
        sequence_number: 1,
      },
      {
        type: "response.completed",
        response: null,
        sequence_number: 2,
      },
    ] as unknown as ResponseStreamEvent[];
    const { factory } = mockFactory(events);

    await expect(
      runCodexResponsesRound(
        {
          accessToken: "access-token",
          accountId: "account-id",
          model: "gpt-5.6-terra",
          instructions: "Use tools.",
          input: [{ role: "user", content: "Question" }],
        },
        factory,
      ),
    ).resolves.toMatchObject({
      functionCalls: [call],
      outputItems: [call],
    });
  });

  it("surfaces an incomplete response instead of treating partial text as done", async () => {
    const events = [
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: "message-1",
        delta: "Partial",
        logprobs: [],
        sequence_number: 1,
      },
      {
        type: "response.incomplete",
        response: {
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
        },
        sequence_number: 2,
      },
    ] as ResponseStreamEvent[];
    const { factory } = mockFactory(events);

    await expect(
      runCodexResponsesRound(
        {
          accessToken: "access-token",
          accountId: "account-id",
          model: "gpt-5.6-terra",
          instructions: "Answer.",
          input: [{ role: "user", content: "Question" }],
        },
        factory,
      ),
    ).rejects.toThrow("reached the output limit");
  });

  it("rejects a clean EOF without a terminal response event", async () => {
    const events = [
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: "message-1",
        delta: "Truncated",
        logprobs: [],
        sequence_number: 1,
      },
    ] as ResponseStreamEvent[];
    const { factory } = mockFactory(events);

    await expect(
      runCodexResponsesRound(
        {
          accessToken: "access-token",
          accountId: "account-id",
          model: "gpt-5.6-terra",
          instructions: "Answer.",
          input: [{ role: "user", content: "Question" }],
        },
        factory,
      ),
    ).rejects.toThrow("ended before completion");
  });
});
