import Anthropic from "@anthropic-ai/sdk";
import { EmptyProviderResponseError } from "./openai.js";
import type {
  AgentMessage,
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from "../types.js";

interface AnthropicResponseShape {
  id?: string;
  content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicStreamEvent {
  type: string;
  delta?: { type?: string; text?: string; partial_json?: string };
}

interface AnthropicMessageStream extends AsyncIterable<AnthropicStreamEvent> {
  finalMessage(): Promise<AnthropicResponseShape>;
}

interface AnthropicClient {
  messages: {
    create(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AnthropicResponseShape>;
    stream?(
      input: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): AnthropicMessageStream;
  };
}

export class AnthropicMessagesProvider implements ModelProvider {
  constructor(private readonly client: AnthropicClient) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.messages.create(
      createAnthropicInput(request),
      { signal: request.signal },
    );
    return mapAnthropicResponse(response);
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    if (!this.client.messages.stream) throw new Error("Anthropic client does not support streaming");
    const stream = this.client.messages.stream(
      createAnthropicInput(request),
      { signal: request.signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        yield { type: "text.delta", delta: event.delta.text };
      }
    }
    yield { type: "response.completed", response: mapAnthropicResponse(await stream.finalMessage()) };
  }
}

function createAnthropicInput(request: ProviderRequest): Record<string, unknown> {
  return {
    model: request.model,
    max_tokens: 8192,
    system: request.systemPrompt,
    messages: request.messages.map(mapAnthropicMessage),
    tools: request.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
  };
}

function mapAnthropicResponse(response: AnthropicResponseShape): ProviderResponse {
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    const toolCalls = response.content.flatMap((block) => {
      if (block.type !== "tool_use" || !block.id || !block.name || !block.input) return [];
      return [{ id: block.id, name: block.name, arguments: block.input }];
    });
    if (!text && toolCalls.length === 0) throw new EmptyProviderResponseError("Anthropic");
    const inputTokens = response.usage?.input_tokens;
    const outputTokens = response.usage?.output_tokens;
    return {
      text,
      toolCalls,
      providerResponseId: response.id,
      usage: response.usage ? {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined,
      } : undefined,
    };
}

function mapAnthropicMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        is_error: message.isError,
      }],
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...message.toolCalls.map((toolCall) => ({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments,
        })),
      ],
    };
  }
  return { role: message.role, content: message.content };
}

export function createAnthropicProvider(apiKey: string, baseUrl?: string | null): AnthropicMessagesProvider {
  const client = new Anthropic({ apiKey, baseURL: baseUrl ?? undefined });
  return new AnthropicMessagesProvider(client as unknown as AnthropicClient);
}
