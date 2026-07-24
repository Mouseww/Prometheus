import OpenAI from "openai";
import { EmptyProviderResponseError } from "./openai.js";
import type {
  AgentMessage,
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from "../types.js";
import { parseToolArguments } from "./tool-mapping.js";

interface ChatResponseShape {
  id?: string;
  choices: Array<{ message: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface ChatStreamChunk {
  id?: string;
  choices: Array<{
    index: number;
    delta: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

interface ChatClient {
  chat: {
    completions: {
      create(
        input: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<ChatResponseShape | AsyncIterable<ChatStreamChunk>>;
    };
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly client: ChatClient) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.chat.completions.create(
      createChatInput(request),
      { signal: request.signal },
    );
    if (isAsyncIterable(response)) throw new Error("OpenAI-compatible provider returned an unexpected stream");
    const message = response.choices[0]?.message;
    const text = message?.content?.trim() ?? "";
    const toolCalls = message?.tool_calls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: parseToolArguments(toolCall.function.arguments),
    })) ?? [];
    if (!text && toolCalls.length === 0) throw new EmptyProviderResponseError("OpenAI-compatible provider");
    return {
      text,
      toolCalls,
      providerResponseId: response.id,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const response = await this.client.chat.completions.create(
      {
        ...createChatInput(request),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: request.signal },
    );
    if (!isAsyncIterable(response)) throw new Error("OpenAI-compatible provider did not return a stream");

    let text = "";
    let providerResponseId: string | undefined;
    let usage: ChatStreamChunk["usage"];
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of response) {
      providerResponseId = chunk.id ?? providerResponseId;
      usage = chunk.usage ?? usage;
      for (const choice of chunk.choices) {
        const delta = choice.delta.content ?? "";
        if (delta) {
          text += delta;
          yield { type: "text.delta", delta };
        }
        for (const toolCall of choice.delta.tool_calls ?? []) {
          const current = pendingToolCalls.get(toolCall.index) ?? { id: "", name: "", arguments: "" };
          if (toolCall.id) current.id = toolCall.id;
          if (toolCall.function?.name) current.name += toolCall.function.name;
          if (toolCall.function?.arguments) current.arguments += toolCall.function.arguments;
          pendingToolCalls.set(toolCall.index, current);
        }
      }
    }

    const toolCalls = [...pendingToolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, toolCall]) => toolCall.id && toolCall.name
        ? [{ id: toolCall.id, name: toolCall.name, arguments: parseToolArguments(toolCall.arguments) }]
        : []);
    const finalText = text.trim();
    if (!finalText && toolCalls.length === 0) {
      throw new EmptyProviderResponseError("OpenAI-compatible provider");
    }
    yield {
      type: "response.completed",
      response: {
        text: finalText,
        toolCalls,
        providerResponseId,
        usage: usage ? {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        } : undefined,
      },
    };
  }
}

function createChatInput(request: ProviderRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: [
      { role: "system", content: request.systemPrompt },
      ...request.messages.map(mapChatMessage),
    ],
    tools: request.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ChatStreamChunk> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function mapChatMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      })),
    };
  }
  return { role: message.role, content: message.content };
}


export function createOpenAICompatibleProvider(apiKey: string, baseUrl: string): OpenAICompatibleProvider {
  const client = new OpenAI({ apiKey, baseURL: baseUrl });
  return new OpenAICompatibleProvider(client as unknown as ChatClient);
}
