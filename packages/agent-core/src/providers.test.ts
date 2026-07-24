import { describe, expect, it, vi } from "vitest";
import type { ProviderRequest } from "./types.js";
import { AnthropicMessagesProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { OpenAIResponsesProvider } from "./providers/openai.js";
import { collectProviderStream } from "./provider-stream.js";

const request = {
  model: "model-id",
  systemPrompt: "Be precise.",
  messages: [{ role: "user" as const, content: "Hello" }],
};

const toolRequest = {
  ...request,
  tools: [{
    name: "read_file",
    description: "Read a text file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  }],
};

const continuationRequest = {
  ...toolRequest,
  messages: [
    { role: "user", content: "Inspect the workspace" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
    },
    {
      role: "tool",
      toolCallId: "call-1",
      toolName: "read_file",
      content: "# Prometheus",
      isError: false,
    },
  ],
} satisfies ProviderRequest;

describe("provider adapters", () => {
  it("maps OpenAI Responses requests and usage", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "resp_1",
      output_text: "Result",
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });
    const provider = new OpenAIResponsesProvider({ responses: { create } });

    await expect(provider.generate(request)).resolves.toMatchObject({ text: "Result", providerResponseId: "resp_1" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "model-id", instructions: "Be precise." }), { signal: undefined });
  });

  it("streams OpenAI Responses text and returns the completed response", async () => {
    const create = vi.fn().mockResolvedValue(asyncEvents(
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
      {
        type: "response.completed",
        response: {
          id: "resp_stream",
          output_text: "Hello",
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
      },
    ));
    const provider = new OpenAIResponsesProvider({ responses: { create } });
    const deltas: string[] = [];

    const response = await collectProviderStream(provider.stream(request), (delta) => {
      deltas.push(delta);
    });

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(response).toMatchObject({ text: "Hello", providerResponseId: "resp_stream", usage: { totalTokens: 3 } });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "model-id", stream: true }),
      { signal: undefined },
    );
  });

  it("maps OpenAI Responses function tools and calls", async () => {
    const create = vi.fn().mockResolvedValue({
      output_text: "",
      output: [{
        type: "function_call",
        call_id: "call-1",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      }],
    });
    const provider = new OpenAIResponsesProvider({ responses: { create } });

    await expect(provider.generate(toolRequest)).resolves.toMatchObject({
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
    });
    expect(create.mock.calls[0]![0].tools).toEqual([{
      type: "function",
      name: "read_file",
      description: "Read a text file",
      parameters: toolRequest.tools[0]!.inputSchema,
      strict: false,
    }]);
  });

  it("maps OpenAI Responses tool results into continuation input", async () => {
    const create = vi.fn().mockResolvedValue({ output_text: "Grounded result" });
    const provider = new OpenAIResponsesProvider({ responses: { create } });
    await provider.generate(continuationRequest);

    expect(create.mock.calls[0]![0].input).toEqual([
      { role: "user", content: "Inspect the workspace" },
      { type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"README.md"}' },
      { type: "function_call_output", call_id: "call-1", output: "# Prometheus" },
    ]);
  });

  it("maps OpenAI-compatible chat requests", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "Compatible result" } }] });
    const provider = new OpenAICompatibleProvider({ chat: { completions: { create } } });
    await expect(provider.generate(request)).resolves.toMatchObject({ text: "Compatible result" });
    expect(create.mock.calls[0]![0].messages[0]).toEqual({ role: "system", content: "Be precise." });
  });

  it("streams OpenAI-compatible text and accumulates incremental tool arguments", async () => {
    const create = vi.fn().mockResolvedValue(asyncEvents(
      {
        id: "chat_stream",
        choices: [{ index: 0, delta: { content: "Checking " }, finish_reason: null }],
      },
      {
        id: "chat_stream",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-1",
              function: { name: "read_file", arguments: '{"path":"' },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "chat_stream",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: 'README.md"}' } }] },
          finish_reason: "tool_calls",
        }],
      },
      {
        id: "chat_stream",
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      },
    ));
    const provider = new OpenAICompatibleProvider({ chat: { completions: { create } } });
    const deltas: string[] = [];

    const response = await collectProviderStream(provider.stream(toolRequest), (delta) => {
      deltas.push(delta);
    });

    expect(deltas).toEqual(["Checking "]);
    expect(response).toMatchObject({
      text: "Checking",
      providerResponseId: "chat_stream",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
      usage: { totalTokens: 7 },
    });
    expect(create.mock.calls[0]![0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("maps OpenAI-compatible tool definitions and tool calls", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"README.md"}' },
          }],
        },
      }],
    });
    const provider = new OpenAICompatibleProvider({ chat: { completions: { create } } });

    await expect(provider.generate(toolRequest)).resolves.toMatchObject({
      text: "",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
    });
    expect(create.mock.calls[0]![0].tools).toEqual([{
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file",
        parameters: toolRequest.tools[0]!.inputSchema,
      },
    }]);
  });

  it("joins Anthropic text blocks", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "One" }, { type: "text", text: " two" }] });
    const provider = new AnthropicMessagesProvider({ messages: { create } });
    await expect(provider.generate(request)).resolves.toMatchObject({ text: "One two" });
  });

  it("streams Anthropic text deltas but finalizes tool calls from finalMessage", async () => {
    const messageStream = Object.assign(asyncEvents(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading " } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path"' } },
      { type: "message_stop" },
    ), {
      finalMessage: vi.fn().mockResolvedValue({
        id: "msg_stream",
        content: [
          { type: "text", text: "Reading" },
          { type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } },
        ],
        usage: { input_tokens: 5, output_tokens: 4 },
      }),
    });
    const stream = vi.fn().mockReturnValue(messageStream);
    const provider = new AnthropicMessagesProvider({ messages: { create: vi.fn(), stream } });
    const deltas: string[] = [];

    const response = await collectProviderStream(provider.stream(toolRequest), (delta) => {
      deltas.push(delta);
    });

    expect(deltas).toEqual(["Reading "]);
    expect(response).toMatchObject({
      text: "Reading",
      providerResponseId: "msg_stream",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
      usage: { totalTokens: 9 },
    });
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ model: "model-id" }), { signal: undefined });
  });

  it("maps Anthropic tool definitions and tool use blocks", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } }],
    });
    const provider = new AnthropicMessagesProvider({ messages: { create } });

    await expect(provider.generate(toolRequest)).resolves.toMatchObject({
      text: "",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
    });
    expect(create.mock.calls[0]![0].tools).toEqual([{
      name: "read_file",
      description: "Read a text file",
      input_schema: toolRequest.tools[0]!.inputSchema,
    }]);
  });

  it("maps Anthropic tool results into continuation messages", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Grounded result" }] });
    const provider = new AnthropicMessagesProvider({ messages: { create } });
    await provider.generate(continuationRequest);

    expect(create.mock.calls[0]![0].messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "# Prometheus", is_error: false }],
      },
    ]);
  });

  it("maps Gemini roles without inventing content", async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: "Gemini result" });
    const provider = new GeminiProvider({ models: { generateContent } });
    await expect(provider.generate(request)).resolves.toMatchObject({ text: "Gemini result" });
    expect(generateContent.mock.calls[0]![0].contents[0].role).toBe("user");
  });

  it("streams Gemini chunks and completes with function calls and usage", async () => {
    const generateContentStream = vi.fn().mockResolvedValue(asyncEvents(
      { responseId: "gem_stream", text: "Gem" },
      {
        responseId: "gem_stream",
        text: "ini",
        functionCalls: [{ id: "call-1", name: "read_file", args: { path: "README.md" } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      },
    ));
    const provider = new GeminiProvider({ models: { generateContent: vi.fn(), generateContentStream } });
    const deltas: string[] = [];

    const response = await collectProviderStream(provider.stream(toolRequest), (delta) => {
      deltas.push(delta);
    });

    expect(deltas).toEqual(["Gem", "ini"]);
    expect(response).toMatchObject({
      text: "Gemini",
      providerResponseId: "gem_stream",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
      usage: { totalTokens: 5 },
    });
    expect(generateContentStream).toHaveBeenCalledWith(expect.objectContaining({ model: "model-id" }));
  });

  it("maps Gemini function declarations and calls", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: "",
      functionCalls: [{ id: "call-1", name: "read_file", args: { path: "README.md" } }],
    });
    const provider = new GeminiProvider({ models: { generateContent } });

    await expect(provider.generate(toolRequest)).resolves.toMatchObject({
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
    });
    expect(generateContent.mock.calls[0]![0].config.tools).toEqual([{
      functionDeclarations: [{
        name: "read_file",
        description: "Read a text file",
        parametersJsonSchema: toolRequest.tools[0]!.inputSchema,
      }],
    }]);
  });

  it("maps Gemini tool results into continuation contents", async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: "Grounded result" });
    const provider = new GeminiProvider({ models: { generateContent } });
    await provider.generate(continuationRequest);

    expect(generateContent.mock.calls[0]![0].contents.slice(1)).toEqual([
      {
        role: "model",
        parts: [{ functionCall: { id: "call-1", name: "read_file", args: { path: "README.md" } } }],
      },
      {
        role: "user",
        parts: [{
          functionResponse: {
            id: "call-1",
            name: "read_file",
            response: { output: "# Prometheus", isError: false },
          },
        }],
      },
    ]);
  });

  it("rejects empty model output", async () => {
    const provider = new OpenAIResponsesProvider({ responses: { create: vi.fn().mockResolvedValue({ output_text: "" }) } });
    await expect(provider.generate(request)).rejects.toThrow("empty response");
  });
});

async function* asyncEvents<T>(...events: T[]): AsyncGenerator<T> {
  for (const event of events) yield event;
}
