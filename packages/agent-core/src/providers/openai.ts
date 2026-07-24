import OpenAI from "openai";
import type {
  AgentMessage,
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from "../types.js";
import { parseToolArguments } from "./tool-mapping.js";

interface OpenAIResponseShape {
  id?: string;
  output_text?: string;
  output?: Array<{
    type: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

interface OpenAIStreamEvent {
  type: string;
  delta?: unknown;
  response?: unknown;
}

interface ResponsesClient {
  responses: {
    create(
      input: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<OpenAIResponseShape | AsyncIterable<OpenAIStreamEvent>>;
  };
}

export class OpenAIResponsesProvider implements ModelProvider {
  constructor(private readonly client: ResponsesClient) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.responses.create(
      createResponsesInput(request),
      { signal: request.signal },
    );
    if (isAsyncIterable(response)) throw new Error("OpenAI returned a stream for a non-streaming request");
    return mapOpenAIResponse(response);
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const response = await this.client.responses.create(
      { ...createResponsesInput(request), stream: true },
      { signal: request.signal },
    );
    if (!isAsyncIterable(response)) throw new Error("OpenAI did not return a response stream");

    for await (const event of response) {
      if (event.type === "response.output_text.delta") {
        if (typeof event.delta === "string" && event.delta) {
          yield { type: "text.delta", delta: event.delta };
        }
      } else if (event.type === "response.completed") {
        if (!isOpenAIResponse(event.response)) throw new Error("OpenAI completed event omitted its response");
        yield { type: "response.completed", response: mapOpenAIResponse(event.response) };
      }
    }
  }
}

function createResponsesInput(request: ProviderRequest): Record<string, unknown> {
  return {
    model: request.model,
    instructions: request.systemPrompt,
    input: request.messages.flatMap(mapResponsesInput),
    tools: request.tools?.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    })),
  };
}

function mapOpenAIResponse(response: OpenAIResponseShape): ProviderResponse {
    const text = response.output_text?.trim() ?? "";
    const toolCalls = response.output?.flatMap((item) => {
      if (item.type !== "function_call" || !item.call_id || !item.name || item.arguments === undefined) return [];
      return [{
        id: item.call_id,
        name: item.name,
        arguments: parseToolArguments(item.arguments),
      }];
    }) ?? [];
    if (!text && toolCalls.length === 0) throw new EmptyProviderResponseError("OpenAI");
    return {
      text,
      toolCalls,
      providerResponseId: response.id,
      usage: response.usage ? {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<OpenAIStreamEvent> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function isOpenAIResponse(value: unknown): value is OpenAIResponseShape {
  return typeof value === "object" && value !== null;
}

function mapResponsesInput(message: AgentMessage): Record<string, unknown>[] {
  if (message.role === "tool") {
    return [{
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    }];
  }
  const items: Record<string, unknown>[] = [];
  if (message.content) items.push({ role: message.role, content: message.content });
  if (message.role === "assistant") {
    for (const toolCall of message.toolCalls ?? []) {
      items.push({
        type: "function_call",
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments),
      });
    }
  }
  return items;
}

export function createOpenAIProvider(apiKey: string, baseUrl?: string | null): OpenAIResponsesProvider {
  return new OpenAIResponsesProvider(
    new OpenAI({ apiKey, baseURL: baseUrl ?? undefined }) as unknown as ResponsesClient,
  );
}

export class EmptyProviderResponseError extends Error {
  constructor(provider: string) {
    super(`${provider} returned an empty response`);
  }
}
