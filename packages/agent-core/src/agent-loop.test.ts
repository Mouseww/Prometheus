import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "./agent-loop.js";
import type { AgentLoopEvent, AgentTool, ModelProvider } from "./types.js";

describe("runAgentLoop", () => {
  it("streams provider text by turn and waits for completed tool calls before execution", async () => {
    let turn = 0;
    const stream = vi.fn<NonNullable<ModelProvider["stream"]>>((async function* () {
      turn += 1;
      if (turn === 1) {
        yield { type: "text.delta", delta: "Inspecting" } as const;
        yield {
          type: "response.completed",
          response: {
            text: "Inspecting",
            toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
          },
        } as const;
        return;
      }
      yield { type: "text.delta", delta: "Verified" } as const;
      yield {
        type: "response.completed",
        response: { text: "Verified", usage: { totalTokens: 9 } },
      } as const;
    }) as NonNullable<ModelProvider["stream"]>);
    const tool: AgentTool = {
      definition: { name: "read_file", description: "Read", inputSchema: { type: "object" } },
      execute: vi.fn().mockResolvedValue({ content: "# Prometheus", isError: false }),
    };
    const events: AgentLoopEvent[] = [];

    const result = await runAgentLoop({
      provider: { generate: vi.fn(), stream },
      request: {
        model: "fixture-model",
        systemPrompt: "Inspect first.",
        messages: [{ role: "user", content: "What is this?" }],
      },
      tools: [tool],
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.text).toBe("Verified");
    expect(events.map((event) => event.type)).toEqual([
      "provider.turn.started",
      "assistant.text.delta",
      "tool.started",
      "tool.completed",
      "provider.turn.started",
      "assistant.text.delta",
    ]);
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it("executes a requested tool and feeds its result into the next provider turn", async () => {
    const generate = vi
      .fn<ModelProvider["generate"]>()
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
      })
      .mockResolvedValueOnce({ text: "The workspace is Prometheus.", usage: { totalTokens: 9 } });
    const tool: AgentTool = {
      definition: {
        name: "read_file",
        description: "Read a text file from the workspace",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      execute: vi.fn().mockResolvedValue({ content: "# Prometheus", isError: false }),
    };
    const events: AgentLoopEvent[] = [];

    const result = await runAgentLoop({
      provider: { generate },
      request: {
        model: "fixture-model",
        systemPrompt: "Inspect the workspace before answering.",
        messages: [{ role: "user", content: "What is this project?" }],
      },
      tools: [tool],
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.text).toBe("The workspace is Prometheus.");
    expect(tool.execute).toHaveBeenCalledWith(
      { path: "README.md" },
      expect.any(AbortSignal),
      { toolCall: { id: "call-1", name: "read_file", arguments: { path: "README.md" } } },
    );
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![0].messages).toEqual([
      { role: "user", content: "What is this project?" },
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
    ]);
    expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.completed"]);
  });

  it("returns an error tool result to the provider when a tool name is unknown", async () => {
    const generate = vi
      .fn<ModelProvider["generate"]>()
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "call-unknown", name: "delete_everything", arguments: {} }],
      })
      .mockResolvedValueOnce({ text: "I could not use that tool." });

    await runAgentLoop({
      provider: { generate },
      request: {
        model: "fixture-model",
        systemPrompt: "Use registered tools only.",
        messages: [{ role: "user", content: "Inspect safely." }],
      },
      tools: [],
    });

    expect(generate.mock.calls[1]![0].messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-unknown",
      toolName: "delete_everything",
      content: "Unknown tool: delete_everything",
      isError: true,
    });
  });

  it("waits for authorization before executing a protected tool", async () => {
    const order: string[] = [];
    const generate = vi
      .fn<ModelProvider["generate"]>()
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "call-write", name: "write_file", arguments: { path: "notes.txt", content: "hello" } }],
      })
      .mockResolvedValueOnce({ text: "The file was written." });
    const tool: AgentTool = {
      approval: "always",
      definition: { name: "write_file", description: "Write", inputSchema: { type: "object" } },
      execute: vi.fn(async () => {
        order.push("execute");
        return { content: "Wrote notes.txt", isError: false };
      }),
    };

    await runAgentLoop({
      provider: { generate },
      request: {
        model: "fixture-model",
        systemPrompt: "Write only after approval.",
        messages: [{ role: "user", content: "Create notes.txt" }],
      },
      tools: [tool],
      onEvent: (event) => {
        order.push(event.type);
      },
      authorizeToolCall: async ({ toolCall }) => {
        order.push(`authorize:${toolCall.id}`);
        return "approved" as const;
      },
    });

    expect(order).toEqual(["tool.started", "authorize:call-write", "execute", "tool.completed"]);
  });

  it("feeds a denial back to the provider without executing the protected tool", async () => {
    const generate = vi
      .fn<ModelProvider["generate"]>()
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "call-write", name: "write_file", arguments: { path: "notes.txt", content: "hello" } }],
      })
      .mockResolvedValueOnce({ text: "I did not write the file." });
    const tool: AgentTool = {
      approval: "always",
      definition: { name: "write_file", description: "Write", inputSchema: { type: "object" } },
      execute: vi.fn().mockResolvedValue({ content: "unexpected", isError: false }),
    };

    await runAgentLoop({
      provider: { generate },
      request: {
        model: "fixture-model",
        systemPrompt: "Respect denials.",
        messages: [{ role: "user", content: "Create notes.txt" }],
      },
      tools: [tool],
      authorizeToolCall: async () => "denied" as const,
    });

    expect(tool.execute).not.toHaveBeenCalled();
    expect(generate.mock.calls[1]![0].messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-write",
      toolName: "write_file",
      content: "Tool execution denied by user",
      isError: true,
    });
  });

  it("feeds an authorization policy denial reason back to the provider", async () => {
    const generate = vi
      .fn<ModelProvider["generate"]>()
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "call-shell", name: "shell_command", arguments: { command: "git push" } }],
      })
      .mockResolvedValueOnce({ text: "The policy denied the command." });
    const tool: AgentTool = {
      approval: "always",
      definition: { name: "shell_command", description: "Run", inputSchema: { type: "object" } },
      execute: vi.fn().mockResolvedValue({ content: "unexpected", isError: false }),
    };

    await runAgentLoop({
      provider: { generate },
      request: {
        model: "fixture-model",
        systemPrompt: "Respect policy.",
        messages: [{ role: "user", content: "Push the branch" }],
      },
      tools: [tool],
      authorizeToolCall: async () => ({
        decision: "denied" as const,
        message: "Tool execution denied by permission rule",
      }),
    });

    expect(tool.execute).not.toHaveBeenCalled();
    expect(generate.mock.calls[1]![0].messages.at(-1)).toMatchObject({
      role: "tool",
      content: "Tool execution denied by permission rule",
      isError: true,
    });
  });

  it("fails explicitly when provider tool calls exceed the turn limit", async () => {
    const generate = vi.fn<ModelProvider["generate"]>().mockResolvedValue({
      text: "",
      toolCalls: [{ id: "call-loop", name: "read_file", arguments: { path: "README.md" } }],
    });
    const tool: AgentTool = {
      definition: { name: "read_file", description: "Read", inputSchema: { type: "object" } },
      execute: vi.fn().mockResolvedValue({ content: "content", isError: false }),
    };

    await expect(runAgentLoop({
      provider: { generate },
      request: {
        model: "fixture-model",
        systemPrompt: "Stop looping.",
        messages: [{ role: "user", content: "Inspect." }],
      },
      tools: [tool],
      maxTurns: 2,
    })).rejects.toThrow("exceeded 2 provider turns");
  });
});
