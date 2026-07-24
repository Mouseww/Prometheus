import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "./agent-repository.js";
import { openDatabase } from "./database.js";
import { EventHub } from "./event-hub.js";
import { ProviderRepository } from "./provider-repository.js";
import { SecretVault } from "./secret-vault.js";
import { SessionRepository } from "./session-repository.js";
import { TeamMessageRepository } from "./team-message-repository.js";
import { TeamMessageService, TeamMessageValidationError } from "./team-message-service.js";
import { TeamRunRepository } from "./team-run-repository.js";

const databases = [] as ReturnType<typeof openDatabase>[];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("TeamMessageService", () => {
  it("persists ordered team messages and publishes the same durable session fact", () => {
    const fixture = createFixture();

    const first = fixture.service.send({
      teamRunId: fixture.teamRunId,
      senderAgentId: fixture.agentIds[0]!,
      recipientId: "*",
      channel: "decision",
      subject: "Evidence boundary",
      body: "Use the durable event log as the source of truth.",
      sourceRunId: crypto.randomUUID(),
      sourceToolCallId: "call-send-1",
    });
    const second = fixture.service.send({
      teamRunId: fixture.teamRunId,
      senderAgentId: fixture.agentIds[1]!,
      recipientId: "parent",
      channel: "direct",
      body: "Review completed.",
    });

    expect(first.sequence).toBeLessThan(second.sequence);
    expect(fixture.messages.list(fixture.teamRunId, first.sequence)).toEqual([second]);
    expect(fixture.messages.listVisibleTo(fixture.teamRunId, fixture.agentIds[1]!, 0))
      .toEqual([first, second]);
    const events = fixture.sessions.listEvents(fixture.sessionId)
      .filter((event) => event.type === "agent.message");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actor: { id: fixture.agentIds[0], label: "Researcher" },
      payload: {
        teamRunId: fixture.teamRunId,
        messageId: first.id,
        channel: "decision",
        recipientId: "*",
        text: "Use the durable event log as the source of truth.",
      },
    });
  });

  it("rejects senders and direct recipients outside the durable team roster", () => {
    const fixture = createFixture();

    expect(() => fixture.service.send({
      teamRunId: fixture.teamRunId,
      senderAgentId: crypto.randomUUID(),
      recipientId: "*",
      channel: "shared",
      body: "Invalid sender",
    })).toThrow(TeamMessageValidationError);
    expect(() => fixture.service.send({
      teamRunId: fixture.teamRunId,
      senderAgentId: fixture.agentIds[0]!,
      recipientId: crypto.randomUUID(),
      channel: "direct",
      body: "Invalid recipient",
    })).toThrow("Message recipient is not a member of this team");
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
  const agentIds = ["Researcher", "Reviewer"].map((name) => agents.create({
    name,
    description: `${name} role`,
    systemPrompt: `Act as ${name}`,
    providerId: provider.id,
    model: "model",
  }).id);
  const sessionId = sessions.createSession("Message bus test").id;
  const team = new TeamRunRepository(database).create({
    sessionId,
    goal: "Communicate through the bus",
    maxConcurrency: 2,
    tasks: agentIds.map((agentId, index) => ({
      agentId,
      agentLabel: index === 0 ? "Researcher" : "Reviewer",
      prompt: `Task ${index + 1}`,
    })),
  });
  const messages = new TeamMessageRepository(database);
  return {
    sessions,
    sessionId,
    agentIds,
    teamRunId: team.id,
    messages,
    service: new TeamMessageService(sessions, messages, new EventHub()),
  };
}
