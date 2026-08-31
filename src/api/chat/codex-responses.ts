/**
 * EXPERIMENTAL: adapter for the private ChatGPT Codex Responses endpoint.
 *
 * This is deliberately isolated from the production chat handler. The endpoint
 * is not the public OpenAI API, and its contract may change without notice.
 */
import OpenAI from "openai";
import type {
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputItem,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from "openai/resources/responses/responses";

export const CODEX_RESPONSES_BASE_URL =
  "https://chatgpt.com/backend-api/codex";
export const CODEX_RESPONSES_ORIGINATOR = "chumainichi";
export const CODEX_RESPONSES_USER_AGENT = "ChuMaiNichi/0.0.0";

export interface CodexResponsesAuth {
  accessToken: string;
  accountId: string;
}

export type CodexResponsesClient = Pick<OpenAI, "responses">;
export type CodexResponsesClientOptions = ConstructorParameters<
  typeof OpenAI
>[0];
export type CodexResponsesClientFactory = (
  options: CodexResponsesClientOptions,
) => CodexResponsesClient;

export interface CodexResponsesRoundOptions extends CodexResponsesAuth {
  model: string;
  instructions: string;
  input: readonly ResponseInputItem[];
  tools?: readonly ChatCompletionTool[];
  toolChoice?: ChatCompletionToolChoiceOption;
  onTextDelta?: (delta: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface CodexResponsesRoundResult {
  text: string;
  functionCalls: ResponseFunctionToolCall[];
  outputItems: ResponseOutputItem[];
  /** Original input followed by every completed response output item. */
  nextInput: ResponseInput;
}

const defaultClientFactory: CodexResponsesClientFactory = (options) =>
  new OpenAI(options);

function requireCredential(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} is required`);
  }
}

export function createCodexResponsesClient(
  auth: CodexResponsesAuth,
  factory: CodexResponsesClientFactory = defaultClientFactory,
): CodexResponsesClient {
  requireCredential(auth.accessToken, "accessToken");
  requireCredential(auth.accountId, "accountId");

  return factory({
    apiKey: auth.accessToken,
    baseURL: CODEX_RESPONSES_BASE_URL,
    defaultHeaders: {
      "ChatGPT-Account-ID": auth.accountId,
      "User-Agent": CODEX_RESPONSES_USER_AGENT,
      originator: CODEX_RESPONSES_ORIGINATOR,
    },
  });
}

/** Convert the dashboard's Chat Completions function schema to Responses. */
export function toResponsesFunctionTools(
  tools: readonly ChatCompletionTool[],
): FunctionTool[] {
  return tools.map((tool) => {
    if (tool.type !== "function") {
      throw new TypeError(
        `Unsupported Chat Completions tool type: ${tool.type}`,
      );
    }

    return {
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters ?? null,
      // Existing dashboard schemas were not authored for strict mode.
      strict: tool.function.strict ?? false,
    };
  });
}

/** Convert Chat Completions tool choice, including a forced function call. */
export function toResponsesToolChoice(
  toolChoice: ChatCompletionToolChoiceOption | undefined,
): ToolChoiceOptions | ToolChoiceFunction | undefined {
  if (toolChoice === undefined) return undefined;
  if (
    toolChoice === "none" ||
    toolChoice === "auto" ||
    toolChoice === "required"
  ) {
    return toolChoice;
  }
  if (toolChoice.type === "function") {
    return { type: "function", name: toolChoice.function.name };
  }
  throw new TypeError(
    `Unsupported Chat Completions tool choice type: ${toolChoice.type}`,
  );
}

/** Append one completed function call when assembling input manually. */
export function appendFunctionCallInput(
  input: readonly ResponseInputItem[],
  call: ResponseFunctionToolCall,
): ResponseInput {
  return [...input, call];
}

/**
 * Append all completed output items before adding tool results. This preserves
 * reasoning (including encrypted content), assistant messages, and calls for a
 * subsequent stateless `store: false` round.
 */
export function appendResponseOutputInput(
  input: readonly ResponseInputItem[],
  outputItems: readonly ResponseOutputItem[],
): ResponseInput {
  // The Responses API requires its prior output items as the next request's
  // input when state is managed manually. The SDK models the wire unions
  // separately even though completed output items are valid replay input.
  return [...input, ...(outputItems as readonly ResponseInputItem[])];
}

/** Append a local function result after the response output that requested it. */
export function appendFunctionCallResultInput(
  input: readonly ResponseInputItem[],
  callId: string,
  result: unknown,
): ResponseInput {
  requireCredential(callId, "callId");
  const output =
    typeof result === "string" ? result : (JSON.stringify(result) ?? "null");
  return [
    ...input,
    { type: "function_call_output", call_id: callId, output },
  ];
}

function isFunctionCall(
  item: ResponseOutputItem,
): item is ResponseFunctionToolCall {
  return item.type === "function_call";
}

/**
 * Run one experimental Codex Responses round.
 *
 * Text is emitted incrementally through `onTextDelta`. The returned `nextInput`
 * carries every completed output item and is ready for function results to be
 * appended before the next round.
 */
export async function runCodexResponsesRound(
  options: CodexResponsesRoundOptions,
  factory: CodexResponsesClientFactory = defaultClientFactory,
): Promise<CodexResponsesRoundResult> {
  requireCredential(options.model, "model");
  const requestInput: ResponseInput = [...options.input];
  const tools = toResponsesFunctionTools(options.tools ?? []);
  const toolChoice = toResponsesToolChoice(options.toolChoice);

  const body: ResponseCreateParamsStreaming = {
    model: options.model,
    instructions: options.instructions,
    input: requestInput,
    include: ["reasoning.encrypted_content"],
    store: false,
    stream: true,
  };
  if (tools.length > 0) body.tools = tools;
  if (toolChoice !== undefined) body.tool_choice = toolChoice;

  const client = createCodexResponsesClient(options, factory);
  const stream = await client.responses.create(body, {
    signal: options.signal,
  });
  const outputByIndex = new Map<number, ResponseOutputItem>();
  const refusalByPart = new Map<string, string>();
  let text = "";
  let completed = false;

  const emitText = async (delta: string) => {
    if (!delta) return;
    text += delta;
    await options.onTextDelta?.(delta);
  };

  for await (const event of stream) {
    switch (event.type) {
      case "response.output_text.delta":
        await emitText(event.delta);
        break;
      case "response.refusal.delta": {
        const key = `${event.item_id}:${event.content_index}`;
        refusalByPart.set(
          key,
          (refusalByPart.get(key) ?? "") + event.delta,
        );
        await emitText(event.delta);
        break;
      }
      case "response.refusal.done": {
        // Some compatible endpoints emit only the final refusal, while others
        // emit deltas first. Append only the suffix that has not been streamed.
        const key = `${event.item_id}:${event.content_index}`;
        const streamed = refusalByPart.get(key) ?? "";
        const suffix = event.refusal.startsWith(streamed)
          ? event.refusal.slice(streamed.length)
          : streamed
            ? ""
            : event.refusal;
        refusalByPart.set(key, event.refusal);
        await emitText(suffix);
        break;
      }
      case "response.output_item.done":
        outputByIndex.set(event.output_index, event.item);
        break;
      case "response.completed":
        // The private Codex endpoint has returned `null` here in some client
        // versions even though `response.output_item.done` events were sent.
        // Treat the terminal payload as an optional summary, never as the only
        // source of streamed output.
        if (Array.isArray(event.response?.output)) {
          event.response.output.forEach((item, index) => {
            outputByIndex.set(index, item);
          });
        }
        completed = true;
        break;
      case "response.incomplete": {
        const reason = event.response.incomplete_details?.reason;
        throw new Error(
          reason === "max_output_tokens"
            ? "Codex response was incomplete because it reached the output limit"
            : reason === "content_filter"
              ? "Codex response was incomplete because content was filtered"
              : "Codex response was incomplete",
        );
      }
      case "error":
        throw new Error(event.message);
      case "response.failed":
        throw new Error(
          event.response.error?.message ?? "Codex response failed",
        );
    }
  }

  if (!completed) {
    throw new Error("Codex response stream ended before completion");
  }

  const outputItems = [...outputByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item);

  return {
    text,
    functionCalls: outputItems.filter(isFunctionCall),
    outputItems,
    nextInput: appendResponseOutputInput(requestInput, outputItems),
  };
}
