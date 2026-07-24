import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { EventConflictError, SessionRepository } from "./session-repository.js";

const databases = [] as ReturnType<typeof openDatabase>[];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("SessionRepository", () => {
  it("persists events in sequence order and treats exact retries as idempotent", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const repository = new SessionRepository(database);
    const session = repository.createSession("Foundation");
    const eventId = crypto.randomUUID();
    const input = {
      eventId,
      type: "message.user" as const,
      actor: { kind: "user" as const, id: "local-user", label: "You" },
      payload: { text: "Build the first slice" },
    };

    const first = repository.appendEvent(session.id, input);
    const retry = repository.appendEvent(session.id, input);

    expect(retry.sequence).toBe(first.sequence);
    expect(repository.listEvents(session.id)).toEqual([first]);
    expect(repository.getSession(session.id)?.lastSequence).toBe(first.sequence);
  });

  it("rejects reuse of an event id with different content", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const repository = new SessionRepository(database);
    const session = repository.createSession("Conflict");
    const eventId = crypto.randomUUID();

    repository.appendEvent(session.id, {
      eventId,
      type: "system.notice",
      actor: { kind: "system", id: "server", label: "Prometheus" },
      payload: { text: "first" },
    });

    expect(() =>
      repository.appendEvent(session.id, {
        eventId,
        type: "system.notice",
        actor: { kind: "system", id: "server", label: "Prometheus" },
        payload: { text: "changed" },
      }),
    ).toThrow(EventConflictError);
  });
});
