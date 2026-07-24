import { DefaultProviderFactory } from "@prometheus/agent-core";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRepository } from "./agent-repository.js";
import { AgentRunService } from "./agent-run-service.js";
import { ApprovalCoordinator } from "./approval-coordinator.js";
import { buildApp } from "./app.js";
import { openDatabase } from "./database.js";
import { EventHub } from "./event-hub.js";
import { ProviderRepository } from "./provider-repository.js";
import { PermissionRuleRepository } from "./permission-rule-repository.js";
import { SecretVault } from "./secret-vault.js";
import { SessionRepository } from "./session-repository.js";
import { TeamRunRepository } from "./team-run-repository.js";
import { TeamRunService } from "./team-run-service.js";
import { TeamMessageRepository } from "./team-message-repository.js";
import { WorkspaceService } from "./workspace-service.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("control plane API", () => {
  it("creates a session, commits an event, and replays it by sequence", async () => {
    const database = openDatabase(":memory:");
    const repository = new SessionRepository(database);
    const app = await buildApp({ repository, workspace: new WorkspaceService(process.cwd()) });
    cleanups.push(() => database.close(), () => app.close());

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "Cross-device task" },
    });
    expect(createResponse.statusCode).toBe(201);
    const sessionId = createResponse.json().session.id as string;

    const appendResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/events`,
      payload: {
        eventId: crypto.randomUUID(),
        type: "message.user",
        actor: { kind: "user", id: "browser-a", label: "Browser A" },
        payload: { text: "Continue this task elsewhere" },
      },
    });
    expect(appendResponse.statusCode).toBe(201);

    const replayResponse = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/events?afterSequence=0`,
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json().events).toHaveLength(1);
    expect(replayResponse.json().events[0].payload.text).toBe("Continue this task elsewhere");
  });

  it("does not expose paths outside the workspace root", async () => {
    const database = openDatabase(":memory:");
    const app = await buildApp({
      repository: new SessionRepository(database),
      workspace: new WorkspaceService(process.cwd()),
    });
    cleanups.push(() => database.close(), () => app.close());

    const response = await app.inject({ method: "GET", url: "/api/workspace?path=.." });
    expect(response.statusCode).toBe(403);
  });

  it("rejects an agent profile that references a provider that does not exist", async () => {
    const app = await buildRuntimeTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Builder",
        description: "Builds scoped changes",
        systemPrompt: "Work carefully.",
        providerId: crypto.randomUUID(),
        model: "missing-model",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: "configuration_reference_not_found",
      message: "Provider not found",
    });
  });

  it("rejects changing an agent profile to a provider that does not exist", async () => {
    const app = await buildRuntimeTestApp();

    const providerResponse = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: {
        name: "OpenAI",
        kind: "openai",
        defaultModel: "gpt-model",
        apiKey: "secret",
      },
    });
    expect(providerResponse.statusCode).toBe(201);
    expect(providerResponse.json().provider).toMatchObject({
      name: "OpenAI",
      hasApiKey: true,
    });
    expect(providerResponse.json().provider).not.toHaveProperty("apiKey");
    const providerId = providerResponse.json().provider.id as string;
    const agentResponse = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Builder",
        description: "Builds scoped changes",
        systemPrompt: "Work carefully.",
        providerId,
        model: "gpt-model",
      },
    });
    expect(agentResponse.statusCode).toBe(201);
    expect(agentResponse.json().agent.providerId).toBe(providerId);
    const agentId = agentResponse.json().agent.id as string;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      payload: { providerId: crypto.randomUUID() },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: "configuration_reference_not_found",
      message: "Provider not found",
    });
  });

  it("resolves a pending approval through a session-scoped resource endpoint", async () => {
    const database = openDatabase(":memory:");
    const repository = new SessionRepository(database);
    const approvals = new ApprovalCoordinator();
    const app = await buildApp({
      repository,
      workspace: new WorkspaceService(process.cwd()),
      approvals,
    });
    cleanups.push(() => database.close(), () => app.close());
    const session = repository.createSession("Approval test");
    const otherSession = repository.createSession("Other session");
    const pending = approvals.create(session.id);

    const crossSessionResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${otherSession.id}/approvals/${pending.approvalId}/resolution`,
      payload: { decision: "approved" },
    });
    expect(crossSessionResponse.statusCode).toBe(404);

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/approvals/${pending.approvalId}/resolution`,
      payload: { decision: "approved" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      approval: {
        approvalId: pending.approvalId,
        sessionId: session.id,
        decision: "approved",
      },
    });
    await expect(pending.decision).resolves.toBe("approved");

    const duplicateResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/approvals/${pending.approvalId}/resolution`,
      payload: { decision: "denied" },
    });
    expect(duplicateResponse.statusCode).toBe(409);
  });

  it("creates, lists and deletes persistent permission rules", async () => {
    const database = openDatabase(":memory:");
    const permissionRules = new PermissionRuleRepository(database);
    const app = await buildApp({
      repository: new SessionRepository(database),
      workspace: new WorkspaceService(process.cwd()),
      permissionRules,
    });
    cleanups.push(() => database.close(), () => app.close());

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/permission-rules",
      payload: { toolName: "shell_command", effect: "deny", pattern: "git push *" },
    });
    expect(createResponse.statusCode).toBe(201);
    const rule = createResponse.json().rule;
    expect(rule).toMatchObject({ toolName: "shell_command", effect: "deny", pattern: "git push *" });

    const listResponse = await app.inject({ method: "GET", url: "/api/permission-rules" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().rules).toEqual([rule]);

    expect((await app.inject({ method: "DELETE", url: `/api/permission-rules/${rule.id}` })).statusCode)
      .toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/permission-rules/${rule.id}` })).statusCode)
      .toBe(404);
  });

  it("creates and reloads a durable parallel team run", async () => {
    const database = openDatabase(":memory:");
    const sessions = new SessionRepository(database);
    const providers = new ProviderRepository(database, new SecretVault(randomBytes(32)));
    const agents = new AgentRepository(database);
    const teams = new TeamRunRepository(database);
    const teamMessages = new TeamMessageRepository(database);
    const eventHub = new EventHub();
    const provider = providers.create({
      name: "Provider",
      kind: "openai",
      defaultModel: "model",
      apiKey: "secret",
    });
    const agentIds = ["Researcher", "Reviewer"].map((name) => agents.create({
      name,
      description: `${name} role`,
      systemPrompt: `Act as ${name}`,
      providerId: provider.id,
      model: "model",
    }).id);
    const sessionId = sessions.createSession("Team API").id;
    const runTask = async (_sessionId: string, agentId: string) => {
      const now = new Date().toISOString();
      const runId = crypto.randomUUID();
      const replyEvent = sessions.appendEvent(sessionId, {
        eventId: crypto.randomUUID(),
        type: "message.agent",
        actor: { kind: "agent", id: agentId, label: agentId },
        payload: { runId, text: `result:${agentId}`, isSubagent: true },
      });
      return {
        runId,
        replyEvent,
        completedEvent: {
          ...replyEvent,
          sequence: replyEvent.sequence + 1,
          eventId: crypto.randomUUID(),
          type: "agent.run.completed" as const,
          createdAt: now,
        },
      };
    };
    const app = await buildApp({
      repository: sessions,
      workspace: new WorkspaceService(process.cwd()),
      agents,
      teams,
      teamMessages,
      teamRuns: new TeamRunService(sessions, agents, teams, { runTask }, eventHub),
      eventHub,
    });
    cleanups.push(() => database.close(), () => app.close());

    const createResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/team-runs`,
      payload: { goal: "Review together", agentIds, maxConcurrency: 2 },
    });
    expect(createResponse.statusCode).toBe(202);
    const team = createResponse.json().team;
    expect(team).toMatchObject({ status: "running", tasks: [{ status: "queued" }, { status: "queued" }] });
    await vi.waitFor(() => {
      expect(teams.get(team.id)).toMatchObject({
        status: "completed",
        tasks: [{ status: "completed" }, { status: "completed" }],
      });
    });

    const listResponse = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/team-runs`,
    });
    expect(listResponse.json().teams).toHaveLength(1);
    const getResponse = await app.inject({ method: "GET", url: `/api/team-runs/${team.id}` });
    expect(getResponse.json().team.id).toBe(team.id);
    expect((await app.inject({
      method: "POST",
      url: `/api/team-runs/${team.id}/tasks/${team.tasks[0].id}/apply`,
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST",
      url: `/api/team-runs/${team.id}/tasks/${crypto.randomUUID()}/discard`,
    })).statusCode).toBe(404);

    const firstMessage = teamMessages.append({
      teamRunId: team.id,
      senderAgentId: agentIds[0]!,
      recipientId: "*",
      channel: "shared",
      body: "Shared evidence",
    });
    teamMessages.append({
      teamRunId: team.id,
      senderAgentId: agentIds[1]!,
      recipientId: "parent",
      channel: "direct",
      body: "Parent report",
    });
    const messageResponse = await app.inject({
      method: "GET",
      url: `/api/team-runs/${team.id}/messages?afterSequence=${firstMessage.sequence}`,
    });
    expect(messageResponse.statusCode).toBe(200);
    expect(messageResponse.json().messages).toMatchObject([{
      body: "Parent report",
      recipientId: "parent",
    }]);
    expect((await app.inject({
      method: "GET",
      url: `/api/team-runs/${crypto.randomUUID()}/messages?afterSequence=0`,
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "GET",
      url: `/api/team-runs/${team.id}/messages?afterSequence=-1`,
    })).statusCode).toBe(400);

    const missingAgent = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/team-runs`,
      payload: { goal: "Invalid team", agentIds: [crypto.randomUUID()], maxConcurrency: 1 },
    });
    expect(missingAgent.statusCode).toBe(404);
  });
});

async function buildRuntimeTestApp() {
  const database = openDatabase(":memory:");
  const sessions = new SessionRepository(database);
  const providers = new ProviderRepository(database, new SecretVault(randomBytes(32)));
  const agents = new AgentRepository(database);
  const eventHub = new EventHub();
  const app = await buildApp({
    repository: sessions,
    workspace: new WorkspaceService(process.cwd()),
    providers,
    agents,
    agentRuns: new AgentRunService(
      sessions,
      agents,
      providers,
      new DefaultProviderFactory(),
      eventHub,
    ),
    eventHub,
  });
  cleanups.push(() => database.close(), () => app.close());
  return app;
}
