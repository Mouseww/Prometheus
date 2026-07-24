import { describe, expect, it } from "vitest";
import {
  appendEventSchema,
  createTeamRunSchema,
  createProviderSchema,
  createPermissionRuleSchema,
  providerSchema,
  resolveApprovalSchema,
  teamMessageSchema,
  websocketEnvelopeSchema,
} from "./index";

describe("protocol schemas", () => {
  it("rejects unknown event types", () => {
    const result = appendEventSchema.safeParse({
      eventId: crypto.randomUUID(),
      type: "agent.did.magic",
      actor: { kind: "agent", id: "builder", label: "Builder" },
      payload: {},
    });

    expect(result.success).toBe(false);
  });

  it("rejects malformed websocket events", () => {
    const result = websocketEnvelopeSchema.safeParse({
      kind: "event",
      event: { sequence: 0 },
    });

    expect(result.success).toBe(false);
  });

  it("validates transient run stream websocket envelopes", () => {
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const agentId = crypto.randomUUID();

    expect(websocketEnvelopeSchema.parse({
      kind: "run.stream.snapshot",
      stream: {
        sessionId,
        runId,
        agentId,
        agentLabel: "Builder",
        turn: 1,
        revision: 0,
        text: "",
      },
    })).toMatchObject({ kind: "run.stream.snapshot", stream: { runId, revision: 0 } });
    expect(websocketEnvelopeSchema.parse({
      kind: "run.stream.delta",
      sessionId,
      runId,
      turn: 1,
      revision: 1,
      delta: "Hello",
    })).toMatchObject({ kind: "run.stream.delta", delta: "Hello" });
    expect(websocketEnvelopeSchema.parse({
      kind: "run.stream.cleared",
      sessionId,
      runId,
    })).toMatchObject({ kind: "run.stream.cleared", runId });

    expect(websocketEnvelopeSchema.safeParse({
      kind: "run.stream.delta",
      sessionId,
      runId,
      turn: 1,
      revision: 0,
      delta: "",
    }).success).toBe(false);
  });

  it("requires a base URL for OpenAI-compatible providers", () => {
    const result = createProviderSchema.safeParse({
      name: "Private gateway",
      kind: "openai_compatible",
      defaultModel: "private-model",
      apiKey: "secret",
    });

    expect(result.success).toBe(false);
  });

  it("never accepts an API key in provider read models", () => {
    const result = providerSchema.safeParse({
      id: crypto.randomUUID(),
      name: "OpenAI",
      kind: "openai",
      baseUrl: null,
      defaultModel: "gpt-model",
      hasApiKey: true,
      apiKey: "must-not-leak",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(result.success).toBe(true);
    expect(Object.hasOwn(result.data!, "apiKey")).toBe(false);
  });

  it("accepts only explicit approval decisions", () => {
    expect(resolveApprovalSchema.parse({ decision: "approved" })).toEqual({ decision: "approved" });
    expect(resolveApprovalSchema.parse({ decision: "denied" })).toEqual({ decision: "denied" });
    expect(resolveApprovalSchema.safeParse({ decision: "allow_once" }).success).toBe(false);
  });

  it("accepts permission rule tools, effects and bounded patterns", () => {
    expect(createPermissionRuleSchema.parse({
      toolName: "shell_command",
      effect: "deny",
      pattern: "git push *",
    })).toEqual({ toolName: "shell_command", effect: "deny", pattern: "git push *" });
    expect(createPermissionRuleSchema.parse({
      toolName: "mcp__echo__echo",
      effect: "allow",
      pattern: "*",
    })).toEqual({ toolName: "mcp__echo__echo", effect: "allow", pattern: "*" });
    expect(createPermissionRuleSchema.safeParse({
      toolName: "bad tool",
      effect: "allow",
      pattern: "*",
    }).success).toBe(false);
    expect(createPermissionRuleSchema.safeParse({
      toolName: "write_file",
      effect: "permit",
      pattern: "*",
    }).success).toBe(false);
    expect(createPermissionRuleSchema.safeParse({
      toolName: "write_file",
      effect: "ask",
      pattern: "   ",
    }).success).toBe(false);
  });

  it("validates bounded parallel team runs with unique agents", () => {
    const firstAgent = crypto.randomUUID();
    const secondAgent = crypto.randomUUID();

    expect(createTeamRunSchema.parse({
      goal: "Review the runtime from two independent roles.",
      agentIds: [firstAgent, secondAgent],
      maxConcurrency: 2,
    })).toEqual({
      goal: "Review the runtime from two independent roles.",
      agentIds: [firstAgent, secondAgent],
      maxConcurrency: 2,
      workspaceMode: "readonly",
      mergeStrategy: "manual",
      pathAssignments: [],
    });
    expect(createTeamRunSchema.safeParse({
      goal: "Duplicate",
      agentIds: [firstAgent, firstAgent],
      maxConcurrency: 2,
    }).success).toBe(false);
    expect(createTeamRunSchema.safeParse({
      goal: "Too much parallelism",
      agentIds: [firstAgent],
      maxConcurrency: 5,
    }).success).toBe(false);
    expect(createTeamRunSchema.safeParse({
      goal: "   ",
      agentIds: [secondAgent],
      maxConcurrency: 1,
    }).success).toBe(false);
  });

  it("requires safe non-overlapping path ownership for worktree teams", () => {
    const firstAgent = crypto.randomUUID();
    const secondAgent = crypto.randomUUID();
    const input = {
      goal: "Implement isolated server and client changes.",
      agentIds: [firstAgent, secondAgent],
      maxConcurrency: 2,
      workspaceMode: "worktree",
      mergeStrategy: "auto",
      pathAssignments: [
        { agentId: firstAgent, paths: ["apps/server", "packages/protocol/src/index.ts"] },
        { agentId: secondAgent, paths: ["apps/client"] },
      ],
    } as const;

    expect(createTeamRunSchema.parse(input)).toEqual(input);
    expect(createTeamRunSchema.safeParse({
      ...input,
      pathAssignments: [{ agentId: firstAgent, paths: ["apps/server"] }],
    }).success).toBe(false);
    expect(createTeamRunSchema.safeParse({
      ...input,
      pathAssignments: [
        { agentId: firstAgent, paths: ["apps"] },
        { agentId: secondAgent, paths: ["apps/client"] },
      ],
    }).success).toBe(false);
    expect(createTeamRunSchema.safeParse({
      ...input,
      pathAssignments: [
        { agentId: firstAgent, paths: ["../outside"] },
        { agentId: secondAgent, paths: ["C:\\outside"] },
      ],
    }).success).toBe(false);
    expect(createTeamRunSchema.safeParse({
      ...input,
      workspaceMode: "readonly",
    }).success).toBe(false);
  });

  it("validates durable bounded team messages and the agent.message event", () => {
    const now = new Date().toISOString();
    const message = {
      id: crypto.randomUUID(),
      sequence: 1,
      teamRunId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      senderAgentId: crypto.randomUUID(),
      senderLabel: "Research specialist",
      recipientId: "*",
      recipientLabel: "All agents",
      channel: "decision",
      subject: "Verified boundary",
      body: "The runtime uses a durable message bus.",
      sourceRunId: crypto.randomUUID(),
      sourceToolCallId: "call-message-1",
      createdAt: now,
    };

    expect(teamMessageSchema.parse(message)).toEqual(message);
    expect(teamMessageSchema.safeParse({ ...message, channel: "telepathy" }).success).toBe(false);
    expect(teamMessageSchema.safeParse({ ...message, body: "x".repeat(12_001) }).success).toBe(false);
    expect(appendEventSchema.safeParse({
      eventId: crypto.randomUUID(),
      type: "agent.message",
      actor: { kind: "agent", id: message.senderAgentId, label: message.senderLabel },
      payload: { teamRunId: message.teamRunId, messageId: message.id },
    }).success).toBe(true);
  });
});
