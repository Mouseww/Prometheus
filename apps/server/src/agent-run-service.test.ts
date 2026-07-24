import { randomBytes } from "node:crypto";
import type {
  AgentTool,
  ModelProvider,
  ProviderFactory,
  ProviderResponse,
  ProviderStreamEvent,
} from "@prometheus/agent-core";
import type { CreatePermissionRuleInput } from "@prometheus/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRepository } from "./agent-repository.js";
import { AgentRunExecutionError, AgentRunService } from "./agent-run-service.js";
import { ApprovalCoordinator } from "./approval-coordinator.js";
import { openDatabase } from "./database.js";
import { EventHub } from "./event-hub.js";
import { ProviderRepository } from "./provider-repository.js";
import { PermissionRuleRepository } from "./permission-rule-repository.js";
import { SecretVault } from "./secret-vault.js";
import { SessionRepository } from "./session-repository.js";
import { ToolPermissionPolicy } from "./tool-permission-policy.js";
import { RunStreamHub } from "./run-stream-hub.js";

const databases = [] as ReturnType<typeof openDatabase>[];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("AgentRunService", () => {
  it("broadcasts live text while persisting only the final agent message", async () => {
    const fixture = createFixture(
      { text: "Streaming works." },
      [],
      [],
      [[
        { type: "text.delta", delta: "Streaming " },
        { type: "text.delta", delta: "works." },
        { type: "response.completed", response: { text: "Streaming works." } },
      ]],
    );
    const envelopes: unknown[] = [];
    fixture.runStreams.subscribe(fixture.sessionId, (envelope) => envelopes.push(envelope));

    const result = await fixture.service.run(fixture.sessionId, fixture.agentId);
    const events = fixture.sessions.listEvents(fixture.sessionId);

    expect(envelopes).toMatchObject([
      { kind: "run.stream.snapshot", stream: { revision: 0, text: "", turn: 1 } },
      { kind: "run.stream.delta", revision: 1, delta: "Streaming " },
      { kind: "run.stream.delta", revision: 2, delta: "works." },
      { kind: "run.stream.cleared", runId: result.runId },
    ]);
    expect(fixture.runStreams.list(fixture.sessionId)).toEqual([]);
    expect(events.filter((event) => event.type === "message.agent")).toHaveLength(1);
    expect(events.some((event) => event.type.startsWith("run.stream"))).toBe(false);
  });

  it("reconstructs history and persists durable run boundaries", async () => {
    const fixture = createFixture({ text: "A real provider reply", usage: { totalTokens: 12 } });
    const result = await fixture.service.run(fixture.sessionId, fixture.agentId);
    const events = fixture.sessions.listEvents(fixture.sessionId);

    expect(result.replyEvent.payload.text).toBe("A real provider reply");
    expect(events.map((event) => event.type)).toEqual([
      "message.user",
      "agent.run.started",
      "message.agent",
      "agent.run.completed",
    ]);
    expect(fixture.generate).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: "Return evidence.",
      messages: [{ role: "user", content: "Inspect the project" }],
    }));
  });

  it("runs a subagent task with isolated context and durable team metadata", async () => {
    const fixture = createFixture({ text: "Child evidence" });
    const teamRunId = crypto.randomUUID();
    const teamTaskId = crypto.randomUUID();

    await fixture.service.runTask(
      fixture.sessionId,
      fixture.agentId,
      "Inspect only the authentication module",
      { teamRunId, teamTaskId },
    );

    expect(fixture.generate).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: "user", content: "Inspect only the authentication module" }],
    }));
    const events = fixture.sessions.listEvents(fixture.sessionId);
    expect(events[1]?.payload).toMatchObject({ teamRunId, teamTaskId, isSubagent: true });
    expect(events[2]?.payload).toMatchObject({
      teamRunId,
      teamTaskId,
      isSubagent: true,
      text: "Child evidence",
    });
  });

  it("does not feed prior subagent replies into the parent conversation history", async () => {
    const fixture = createFixture([{ text: "Child evidence" }, { text: "Parent answer" }]);
    await fixture.service.runTask(
      fixture.sessionId,
      fixture.agentId,
      "Isolated child task",
      { teamRunId: crypto.randomUUID(), teamTaskId: crypto.randomUUID() },
    );
    fixture.sessions.appendEvent(fixture.sessionId, {
      eventId: crypto.randomUUID(),
      type: "message.user",
      actor: { kind: "user", id: "user", label: "You" },
      payload: { text: "Continue the parent task" },
    });

    await fixture.service.run(fixture.sessionId, fixture.agentId);

    expect(fixture.generate.mock.calls[1]![0].messages).toEqual([
      { role: "user", content: "Inspect the project" },
      { role: "user", content: "Continue the parent task" },
    ]);
  });

  it("adds context-aware tools while withholding team delegation from subagents", async () => {
    const delegateTeam: AgentTool = {
      definition: { name: "delegate_team", description: "Delegate", inputSchema: { type: "object" } },
      execute: vi.fn().mockResolvedValue({ content: "Team completed", isError: false }),
    };
    const sendMessage: AgentTool = {
      definition: { name: "send_team_message", description: "Send", inputSchema: { type: "object" } },
      execute: vi.fn().mockResolvedValue({ content: "Message sent", isError: false }),
    };
    const readMessages: AgentTool = {
      definition: { name: "read_team_messages", description: "Read", inputSchema: { type: "object" } },
      execute: vi.fn().mockResolvedValue({ content: "No messages", isError: false }),
    };
    const runtimeTools = vi.fn((context: { isSubagent: boolean }) =>
      context.isSubagent ? [sendMessage, readMessages] : [delegateTeam]);
    const fixture = createFixture([
      {
        text: "",
        toolCalls: [{
          id: "call-delegate",
          name: "delegate_team",
          arguments: { goal: "Review", agentIds: [crypto.randomUUID()], maxConcurrency: 1 },
        }],
      },
      { text: "Parent synthesized the team result." },
      { text: "Child completed without recursive delegation." },
    ], [], [], [], runtimeTools);

    await fixture.service.run(fixture.sessionId, fixture.agentId);
    await fixture.service.runTask(
      fixture.sessionId,
      fixture.agentId,
      "Child task",
      { teamRunId: crypto.randomUUID(), teamTaskId: crypto.randomUUID() },
    );

    expect(fixture.generate.mock.calls[0]![0].tools?.map((tool) => tool.name)).toEqual(["delegate_team"]);
    expect(fixture.generate.mock.calls[2]![0].tools?.map((tool) => tool.name)).toEqual([
      "send_team_message",
      "read_team_messages",
    ]);
    expect(runtimeTools).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: fixture.sessionId,
      agentId: fixture.agentId,
      isSubagent: false,
      runId: expect.any(String),
    }));
    expect(runtimeTools).toHaveBeenCalledWith(expect.objectContaining({
      isSubagent: true,
      teamRunId: expect.any(String),
      teamTaskId: expect.any(String),
    }));
  });

  it("replaces parent workspace tools with task-scoped tools for subagents", async () => {
    const tool = (name: string): AgentTool => ({
      approval: "never",
      definition: { name, description: name, inputSchema: { type: "object" } },
      execute: vi.fn().mockResolvedValue({ content: name, isError: false }),
    });
    const parentWrite = tool("write_file");
    const readonlyRead = tool("read_file");
    const worktreeWrite = tool("worktree_write_file");
    const taskTools = vi.fn((metadata: { workspaceMode?: string; workspaceRoot?: string }) =>
      metadata.workspaceMode === "worktree" ? [worktreeWrite] : [readonlyRead]);
    const fixture = createFixture(
      [{ text: "Parent" }, { text: "Readonly child" }, { text: "Worktree child" }],
      [parentWrite],
      [],
      [],
      undefined,
      taskTools,
    );

    await fixture.service.run(fixture.sessionId, fixture.agentId);
    await fixture.service.runTask(
      fixture.sessionId,
      fixture.agentId,
      "Readonly inspection",
      {
        teamRunId: crypto.randomUUID(),
        teamTaskId: crypto.randomUUID(),
        workspaceMode: "readonly",
        allowedPaths: [],
      },
    );
    await fixture.service.runTask(
      fixture.sessionId,
      fixture.agentId,
      "Isolated implementation",
      {
        teamRunId: crypto.randomUUID(),
        teamTaskId: crypto.randomUUID(),
        workspaceMode: "worktree",
        workspaceRoot: "C:/isolated/team-task",
        allowedPaths: ["apps/server"],
      },
    );

    expect(fixture.generate.mock.calls[0]![0].tools?.map((candidate) => candidate.name)).toEqual(["write_file"]);
    expect(fixture.generate.mock.calls[1]![0].tools?.map((candidate) => candidate.name)).toEqual(["read_file"]);
    expect(fixture.generate.mock.calls[2]![0].tools?.map((candidate) => candidate.name)).toEqual(["worktree_write_file"]);
    expect(taskTools).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceMode: "worktree",
      workspaceRoot: "C:/isolated/team-task",
      allowedPaths: ["apps/server"],
    }));
  });

  it("records sanitized provider failures without manufacturing a reply", async () => {
    const fixture = createFixture(new Error("authorization=super-secret upstream refused"));
    await expect(fixture.service.run(fixture.sessionId, fixture.agentId)).rejects.toThrow(AgentRunExecutionError);
    const events = fixture.sessions.listEvents(fixture.sessionId);

    expect(events.map((event) => event.type)).toEqual([
      "message.user",
      "agent.run.started",
      "agent.run.failed",
    ]);
    expect(JSON.stringify(events.at(-1)?.payload)).not.toContain("super-secret");
  });

  it("clears a partial live draft when the provider stream fails", async () => {
    const fixture = createFixture(
      { text: "unused" },
      [],
      [],
      [[
        { type: "text.delta", delta: "Partial reply" },
        new Error("upstream stream disconnected"),
      ]],
    );
    const envelopes: unknown[] = [];
    fixture.runStreams.subscribe(fixture.sessionId, (envelope) => envelopes.push(envelope));

    await expect(fixture.service.run(fixture.sessionId, fixture.agentId)).rejects.toThrow(AgentRunExecutionError);

    expect(envelopes).toMatchObject([
      { kind: "run.stream.snapshot", stream: { revision: 0, text: "", turn: 1 } },
      { kind: "run.stream.delta", revision: 1, delta: "Partial reply" },
      { kind: "run.stream.cleared" },
    ]);
    expect(fixture.runStreams.list(fixture.sessionId)).toEqual([]);
    expect(fixture.sessions.listEvents(fixture.sessionId).map((event) => event.type)).toEqual([
      "message.user",
      "agent.run.started",
      "agent.run.failed",
    ]);
  });

  it("persists tool lifecycle events before the final agent reply", async () => {
    const readFile: AgentTool = {
      definition: {
        name: "read_file",
        description: "Read a workspace file",
        inputSchema: { type: "object" },
      },
      execute: vi.fn().mockResolvedValue({ content: "# Prometheus", isError: false }),
    };
    const fixture = createFixture([
      {
        text: "",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
      },
      { text: "The repository is Prometheus.", usage: { totalTokens: 18 } },
    ], [readFile]);

    await fixture.service.run(fixture.sessionId, fixture.agentId);
    const events = fixture.sessions.listEvents(fixture.sessionId);

    expect(events.map((event) => event.type)).toEqual([
      "message.user",
      "agent.run.started",
      "tool.call.started",
      "tool.call.completed",
      "message.agent",
      "agent.run.completed",
    ]);
    expect(events[2]?.payload).toMatchObject({
      toolCallId: "call-1",
      toolName: "read_file",
      arguments: { path: "README.md" },
    });
    expect(events[3]?.payload).toMatchObject({
      toolCallId: "call-1",
      toolName: "read_file",
      output: "# Prometheus",
      isError: false,
    });
  });

  it("persists approval boundaries and does not execute a protected tool before approval", async () => {
    const secretContent = "sensitive-content-that-must-not-be-persisted-in-full";
    const writeFile: AgentTool = {
      approval: "always",
      definition: { name: "write_file", description: "Write", inputSchema: { type: "object" } },
      summarizeArguments: (argumentsValue) => ({
        path: argumentsValue.path,
        contentBytes: Buffer.byteLength(String(argumentsValue.content), "utf8"),
        contentPreview: "sensitive-content-that-must-not-be-persisted",
        contentSha256: "fixture-hash",
      }),
      execute: vi.fn().mockResolvedValue({ content: "Wrote file", isError: false }),
    };
    const fixture = createFixture([
      {
        text: "",
        toolCalls: [{
          id: "call-write",
          name: "write_file",
          arguments: { path: "notes.txt", content: secretContent },
        }],
      },
      { text: "The approved file was written." },
    ], [writeFile]);

    const runPromise = fixture.service.run(fixture.sessionId, fixture.agentId);
    await vi.waitFor(() => {
      expect(fixture.sessions.listEvents(fixture.sessionId).at(-1)?.type).toBe("approval.requested");
    });
    expect(writeFile.execute).not.toHaveBeenCalled();
    const requested = fixture.sessions.listEvents(fixture.sessionId).at(-1)!;
    fixture.approvals.resolve(fixture.sessionId, String(requested.payload.approvalId), "approved");
    await runPromise;

    const events = fixture.sessions.listEvents(fixture.sessionId);
    expect(events.map((event) => event.type)).toEqual([
      "message.user",
      "agent.run.started",
      "tool.call.started",
      "approval.requested",
      "approval.resolved",
      "tool.call.completed",
      "message.agent",
      "agent.run.completed",
    ]);
    expect(writeFile.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toContain(secretContent);
    expect(requested.payload).toMatchObject({
      runId: expect.any(String),
      toolCallId: "call-write",
      toolName: "write_file",
      arguments: {
        path: "notes.txt",
        contentBytes: Buffer.byteLength(secretContent, "utf8"),
        contentSha256: "fixture-hash",
      },
    });
  });

  it("returns a denied protected tool result to the provider without executing it", async () => {
    const writeFile: AgentTool = {
      approval: "always",
      definition: { name: "write_file", description: "Write", inputSchema: { type: "object" } },
      execute: vi.fn().mockResolvedValue({ content: "unexpected", isError: false }),
    };
    const fixture = createFixture([
      {
        text: "",
        toolCalls: [{ id: "call-write", name: "write_file", arguments: { path: "notes.txt", content: "no" } }],
      },
      { text: "The write was denied." },
    ], [writeFile]);

    const runPromise = fixture.service.run(fixture.sessionId, fixture.agentId);
    await vi.waitFor(() => {
      expect(fixture.sessions.listEvents(fixture.sessionId).at(-1)?.type).toBe("approval.requested");
    });
    const requested = fixture.sessions.listEvents(fixture.sessionId).at(-1)!;
    fixture.approvals.resolve(fixture.sessionId, String(requested.payload.approvalId), "denied");
    await runPromise;

    expect(writeFile.execute).not.toHaveBeenCalled();
    expect(fixture.generate.mock.calls[1]![0].messages.at(-1)).toMatchObject({
      role: "tool",
      content: "Tool execution denied by user",
      isError: true,
    });
    expect(fixture.sessions.listEvents(fixture.sessionId).map((event) => event.type)).toContain("agent.run.completed");
  });

  it("auto-allows a protected tool by rule and persists the matched policy boundary", async () => {
    const shell: AgentTool = {
      approval: "always",
      definition: { name: "shell_command", description: "Run", inputSchema: { type: "object" } },
      permissionTarget: (argumentsValue) => String(argumentsValue.command),
      execute: vi.fn().mockResolvedValue({ content: "Exit code: 0", isError: false }),
    };
    const fixture = createFixture([
      {
        text: "",
        toolCalls: [{ id: "call-shell", name: "shell_command", arguments: { command: "pnpm test" } }],
      },
      { text: "Tests completed." },
    ], [shell], [{ toolName: "shell_command", effect: "allow", pattern: "pnpm test*" }]);

    const runPromise = fixture.service.run(fixture.sessionId, fixture.agentId);
    await vi.waitFor(() => {
      const events = fixture.sessions.listEvents(fixture.sessionId);
      expect(events.some((event) =>
        event.type === "permission.rule.matched" || event.type === "approval.requested",
      )).toBe(true);
    });
    const unexpectedApproval = fixture.sessions.listEvents(fixture.sessionId)
      .find((event) => event.type === "approval.requested");
    if (unexpectedApproval) {
      fixture.approvals.resolve(
        fixture.sessionId,
        String(unexpectedApproval.payload.approvalId),
        "approved",
      );
    }
    await runPromise;

    const events = fixture.sessions.listEvents(fixture.sessionId);
    expect(shell.execute).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual([
      "message.user",
      "agent.run.started",
      "tool.call.started",
      "permission.rule.matched",
      "tool.call.completed",
      "message.agent",
      "agent.run.completed",
    ]);
    expect(events[3]?.payload).toMatchObject({
      toolName: "shell_command",
      effect: "allow",
      arguments: { command: "pnpm test" },
      rules: [{ pattern: "pnpm test*" }],
    });
  });

  it("denies a protected tool by rule without creating an approval request", async () => {
    const shell: AgentTool = {
      approval: "always",
      definition: { name: "shell_command", description: "Run", inputSchema: { type: "object" } },
      permissionTarget: (argumentsValue) => String(argumentsValue.command),
      execute: vi.fn().mockResolvedValue({ content: "unexpected", isError: false }),
    };
    const fixture = createFixture([
      {
        text: "",
        toolCalls: [{ id: "call-shell", name: "shell_command", arguments: { command: "git push origin main" } }],
      },
      { text: "The policy denied the push." },
    ], [shell], [
      { toolName: "shell_command", effect: "allow", pattern: "git *" },
      { toolName: "shell_command", effect: "deny", pattern: "git push *" },
    ]);

    await fixture.service.run(fixture.sessionId, fixture.agentId);

    const events = fixture.sessions.listEvents(fixture.sessionId);
    expect(shell.execute).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      "message.user",
      "agent.run.started",
      "tool.call.started",
      "permission.rule.matched",
      "tool.call.completed",
      "message.agent",
      "agent.run.completed",
    ]);
    expect(events[3]?.payload).toMatchObject({ effect: "deny", toolName: "shell_command" });
    expect(fixture.generate.mock.calls[1]![0].messages.at(-1)).toMatchObject({
      role: "tool",
      content: "Tool execution denied by permission rule",
      isError: true,
    });
  });

  it("routes an explicit ask rule through the existing cross-device approval coordinator", async () => {
    const write: AgentTool = {
      approval: "always",
      definition: { name: "write_file", description: "Write", inputSchema: { type: "object" } },
      permissionTarget: (argumentsValue) => String(argumentsValue.path),
      execute: vi.fn().mockResolvedValue({ content: "Wrote file", isError: false }),
    };
    const fixture = createFixture([
      {
        text: "",
        toolCalls: [{ id: "call-write", name: "write_file", arguments: { path: "notes/a.txt" } }],
      },
      { text: "The approved write completed." },
    ], [write], [{ toolName: "write_file", effect: "ask", pattern: "notes/*" }]);

    const runPromise = fixture.service.run(fixture.sessionId, fixture.agentId);
    await vi.waitFor(() => {
      expect(fixture.sessions.listEvents(fixture.sessionId).map((event) => event.type)).toEqual([
        "message.user",
        "agent.run.started",
        "tool.call.started",
        "permission.rule.matched",
        "approval.requested",
      ]);
    });
    const requested = fixture.sessions.listEvents(fixture.sessionId).at(-1)!;
    fixture.approvals.resolve(fixture.sessionId, String(requested.payload.approvalId), "approved");
    await runPromise;

    expect(write.execute).toHaveBeenCalledTimes(1);
    expect(fixture.sessions.listEvents(fixture.sessionId)[3]?.payload.effect).toBe("ask");
  });
});

function createFixture(
  response: ProviderResponse | ProviderResponse[] | Error,
  tools: AgentTool[] = [],
  permissionRuleInputs: CreatePermissionRuleInput[] = [],
  streamTurns: (ProviderStreamEvent | Error)[][] = [],
  runtimeToolFactory?: (context: {
    sessionId: string;
    runId: string;
    agentId: string;
    agentLabel: string;
    isSubagent: boolean;
    teamRunId?: string;
    teamTaskId?: string;
  }) => AgentTool[],
  taskToolFactory?: (metadata: {
    teamRunId: string;
    teamTaskId: string;
    workspaceMode?: string;
    workspaceRoot?: string;
    allowedPaths?: string[];
  }) => AgentTool[],
) {
  const database = openDatabase(":memory:");
  databases.push(database);
  const sessions = new SessionRepository(database);
  const providers = new ProviderRepository(database, new SecretVault(randomBytes(32)));
  const agents = new AgentRepository(database);
  const provider = providers.create({ name: "Provider", kind: "openai", defaultModel: "model", apiKey: "secret" });
  const agent = agents.create({
    name: "Builder",
    description: "",
    systemPrompt: "Return evidence.",
    providerId: provider.id,
    model: "model",
  });
  const session = sessions.createSession("Runtime test");
  sessions.appendEvent(session.id, {
    eventId: crypto.randomUUID(),
    type: "message.user",
    actor: { kind: "user", id: "user", label: "You" },
    payload: { text: "Inspect the project" },
  });
  const generate = vi.fn<ModelProvider["generate"]>();
  if (response instanceof Error) {
    generate.mockRejectedValue(response);
  } else if (Array.isArray(response)) {
    for (const item of response) generate.mockResolvedValueOnce(item);
  } else {
    generate.mockResolvedValue(response);
  }
  const modelProvider: ModelProvider = { generate };
  if (streamTurns.length > 0) {
    let streamTurn = 0;
    modelProvider.stream = async function* () {
      for (const event of streamTurns[streamTurn++] ?? []) {
        if (event instanceof Error) throw event;
        yield event;
      }
    };
  }
  const factory: ProviderFactory = { create: () => modelProvider };
  const approvals = new ApprovalCoordinator();
  const runStreams = new RunStreamHub();
  const permissionRules = new PermissionRuleRepository(database);
  for (const input of permissionRuleInputs) permissionRules.create(input);
  return {
    sessions,
    sessionId: session.id,
    agentId: agent.id,
    generate,
    approvals,
    runStreams,
    service: new AgentRunService(
      sessions,
      agents,
      providers,
      factory,
      new EventHub(),
      tools,
      approvals,
      new ToolPermissionPolicy(permissionRules),
      runStreams,
      runtimeToolFactory,
      taskToolFactory,
    ),
  };
}
