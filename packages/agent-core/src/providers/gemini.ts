import { GoogleGenAI } from "@google/genai";
import { EmptyProviderResponseError } from "./openai.js";
import type {
  AgentMessage,
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ToolCall,
} from "../types.js";

interface GeminiResponseShape {
  responseId?: string;
  text?: string;
  functionCalls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiClient {
  models: {
    generateContent(input: Record<string, unknown>): Promise<GeminiResponseShape>;
    generateContentStream?(input: Record<string, unknown>): Promise<AsyncIterable<GeminiResponseShape>>;
  };
}

export class GeminiProvider implements ModelProvider {
  constructor(private readonly client: GeminiClient) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.models.generateContent(createGeminiInput(request));
    return mapGeminiResponse(response);
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    if (!this.client.models.generateContentStream) throw new Error("Gemini client does not support streaming");
    const stream = await this.client.models.generateContentStream(createGeminiInput(request));
    let text = "";
    let responseId: string | undefined;
    let usageMetadata: GeminiResponseShape["usageMetadata"];
    const toolCalls = new Map<string, ToolCall>();

    for await (const chunk of stream) {
      responseId = chunk.responseId ?? responseId;
      usageMetadata = chunk.usageMetadata ?? usageMetadata;
      const delta = chunk.text ?? "";
      if (delta) {
        text += delta;
        yield { type: "text.delta", delta };
      }
      for (const call of chunk.functionCalls ?? []) {
        if (call.id && call.name && call.args) {
          toolCalls.set(call.id, { id: call.id, name: call.name, arguments: call.args });
        }
      }
    }

    yield {
      type: "response.completed",
      response: mapGeminiResponse({
        responseId,
        text,
        functionCalls: [...toolCalls.values()].map((call) => ({
          id: call.id,
          name: call.name,
          args: call.arguments,
        })),
        usageMetadata,
      }),
    };
  }
}

function createGeminiInput(request: ProviderRequest): Record<string, unknown> {
  return {
      model: request.model,
      contents: request.messages.map(mapGeminiMessage),
      config: {
        systemInstruction: request.systemPrompt,
        abortSignal: request.signal,
        tools: request.tools?.length ? [{
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.inputSchema,
          })),
        }] : undefined,
      },
    };
}

function mapGeminiResponse(response: GeminiResponseShape): ProviderResponse {
    const text = response.text?.trim() ?? "";
    const toolCalls = response.functionCalls?.flatMap((call) => {
      if (!call.id || !call.name || !call.args) return [];
      return [{ id: call.id, name: call.name, arguments: call.args }];
    }) ?? [];
    if (!text && toolCalls.length === 0) throw new EmptyProviderResponseError("Gemini");
    return {
      text,
      toolCalls,
      providerResponseId: response.responseId,
      usage: response.usageMetadata ? {
        inputTokens: response.usageMetadata.promptTokenCount,
        outputTokens: response.usageMetadata.candidatesTokenCount,
        totalTokens: response.usageMetadata.totalTokenCount,
      } : undefined,
    };
}

function mapGeminiMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      parts: [{
        functionResponse: {
          id: message.toolCallId,
          name: message.toolName,
          response: { output: message.content, isError: message.isError },
        },
      }],
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "model",
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...message.toolCalls.map((toolCall) => ({
          functionCall: {
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.arguments,
          },
        })),
      ],
    };
  }
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  };
}

export function createGeminiProvider(apiKey: string): GeminiProvider {
  const client = new GoogleGenAI({ apiKey });
  return new GeminiProvider(client as unknown as GeminiClient);
}
