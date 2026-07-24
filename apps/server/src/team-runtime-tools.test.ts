import { randomBytes } from "node:crypto";
import type { TeamRun } from "@prometheus/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRepository } from "./agent-repository.js";
import { openDatabase } from "./database.js";
import { EventHub } from "./event-hub.js";
import { ProviderRepository } from "./provider-repository.js";
import { SecretVault } from "./secret-vault.js";
import { SessionRepository } from "./session-repository.js";
import { TeamMessageRepository } from "./team-message-repository.js";
import { TeamMessageService } from "./team-message-service.js";
import { TeamRunRepository } from "./team-run-repository.js";
import { TeamRuntimeToolFactory } from "./team-runtime-tools.js";

const databases = [] as ReturnType<typeof openDatabase>[];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("TeamRuntimeToolFactory", () => {
  it("gives only the primary agent a bounded delegation tool", async () => {
    const fixture = createFixture();
    const start = vi.fn().mockResolvedValue(completedTeam(fixture));
    fixture.factory.attachTeamRunner({ start });
    const [tool] = fixture.factory.create({
      sessionId: fixture.sessionId,
      runId: crypto.randomUUID(),
      agentId: fixture.coordinatorId,
      agentLabel: "Coordinator",
      isSubagent: false,
    });

    expect(tool?.definition.name).toBe("delegate_team");
    expect(tool?.definition.inputSchema).toMatchObject({
      properties: {
        agentIds: { items: { enum: fixture.workerIds } },
        maxConcurrency: { minimum: 1, maximum: 4 },
        workspaceMode: { enum: ["readonly", "worktree"] },
        pathAssignments: { maxItems: 8 },
      },
    });
    const result = await tool!.execute({
      goal: "Review independently",
      agentIds: fixture.workerIds,
      maxConcurrency: 2,
      workspaceMode: "readonly",
      mergeStrategy: "manual",
      pathAssignments: [],
    }, new AbortController().signal);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Research result");
    expect(start).toHaveBeenCalledWith(fixture.sessionId, {
      goal: "Review independently",
      agentIds: fixture.workerIds,
      maxConcurrency: 2,
      workspaceMode: "readonly",
      mergeStrategy: "manual",
      pathAssignments: [],
    });

    const invalid = await tool!.execute({
      goal: "Invalid",
      agentIds: [fixture.coordinatorId],
      maxConcurrency: 1,
    }, new AbortController().signal);
    expect(invalid).toMatchObject({ isError: true });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("gives subagents durable send/read tools without recursive delegation", async () => {
    const fixture = createFixture();
    const context = {
      sessionId: fixture.sessionId,
      runId: crypto.randomUUID(),
      agentId: fixture.workerIds[0]!,
      agentLabel: "Researcher",
      isSubagent: true as const,
      teamRunId: fixture.teamRunId,
      teamTaskId: fixture.teamTaskIds[0]!,
    };
    const tools = fixture.factory.create(context);
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "send_team_message",
      "read_team_messages",
    ]);

    const send = tools[0]!;
    const sent = await send.execute({
      to: "*",
      channel: "decision",
      subject: "Evidence",
      message: "Repository evidence is durable.",
    }, new AbortController().signal);
    expect(sent).toMatchObject({ isError: false });
    expect(sent.content).toContain("sequence=");

    const read = tools[1]!;
    const readResult = await read.execute({ afterSequence: 0 }, new AbortController().signal);
    expect(readResult.isError).toBe(false);
    expect(readResult.content).toContain("Repository evidence is durable.");

    const invalidRecipient = await send.execute({
      to: crypto.randomUUID(),
      message: "This must be rejected.",
    }, new AbortController().signal);
    expect(invalidRecipient).toMatchObject({ isError: true });
  });
});

function createFixture() {
  const database = openDatabase(":memory:");
  databases.push(database);
  const sessions = new SessionRepository(database);
  const providers = new ProviderRepository(database, new SecretVault(randomBytes(32)));
  const agents = new AgentRepository(database);
  const provider = providers.create({
    name: "Provider",
    kind: "openai",
    defaultModel: "model",
    apiKey: "secret",
  });
  const profiles = ["Coordinator", "Researcher", "Reviewer"].map((name) => agents.create({
    name,
    description: `${name} role`,
    systemPrompt: `Act as ${name}`,
    providerId: provider.id,
    model: "model",
  }));
  const sessionId = sessions.createSession("Autonomous team tools").id;
  const team = new TeamRunRepository(database).create({
    sessionId,
    goal: "Existing child team",
    maxConcurrency: 2,
    tasks: profiles.slice(1).map((agent) => ({
      agentId: agent.id,
      agentLabel: agent.name,
      prompt: `${agent.name} task`,
    })),
  });
  const messages = new TeamMessageRepository(database);
  return {
    sessionId,
    coordinatorId: profiles[0]!.id,
    workerIds: profiles.slice(1).map((agent) => agent.id),
    teamRunId: team.id,
    teamTaskIds: team.tasks.map((task) => task.id),
    factory: new TeamRuntimeToolFactory(
      agents,
      messages,
      new TeamMessageService(sessions, messages, new EventHub()),
    ),
  };
}

function completedTeam(fixture: ReturnType<typeof createFixture>): TeamRun {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    sessionId: fixture.sessionId,
    goal: "Review independently",
    status: "completed",
    maxConcurrency: 2,
    workspaceMode: "readonly",
    mergeStrategy: "manual",
    createdAt: now,
    completedAt: now,
    tasks: fixture.workerIds.map((agentId, index) => ({
      id: crypto.randomUUID(),
      teamRunId: crypto.randomUUID(),
      sessionId: fixture.sessionId,
      agentId,
      agentLabel: index === 0 ? "Researcher" : "Reviewer",
      prompt: `Task ${index + 1}`,
      status: "completed",
      output: index === 0 ? "Research result" : "Review result",
      error: null,
      allowedPaths: [],
      worktreeBranch: null,
      baseCommit: null,
      changedPaths: [],
      changeStatus: "not_applicable",
      conflictPaths: [],
      patchBytes: 0,
      createdAt: now,
      startedAt: now,
      completedAt: now,
    })),
  };
}
