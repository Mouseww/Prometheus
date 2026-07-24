import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  type AppendEventInput,
  type Session,
  type SessionEvent,
  sessionEventSchema,
  sessionSchema,
} from "@prometheus/protocol";

interface SessionRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_sequence: number;
}

interface EventRow {
  sequence: number;
  event_id: string;
  session_id: string;
  type: string;
  actor_json: string;
  payload_json: string;
  created_at: string;
}

export class SessionRepository {
  readonly #database: DatabaseSync;
  readonly #insertEvent: StatementSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
    this.#insertEvent = database.prepare(`
      INSERT OR IGNORE INTO session_events (
        event_id, session_id, type, actor_json, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  createSession(title: string): Session {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.#database
      .prepare(`
        INSERT INTO sessions (id, title, status, created_at, updated_at)
        VALUES (?, ?, 'idle', ?, ?)
      `)
      .run(id, title, now, now);

    return sessionSchema.parse({
      id,
      title,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      lastSequence: 0,
    });
  }

  listSessions(): Session[] {
    const rows = this.#database
      .prepare(`
        SELECT
          s.id,
          s.title,
          s.status,
          s.created_at,
          s.updated_at,
          COALESCE(MAX(e.sequence), 0) AS last_sequence
        FROM sessions s
        LEFT JOIN session_events e ON e.session_id = s.id
        GROUP BY s.id
        ORDER BY s.updated_at DESC
      `)
      .all() as unknown as SessionRow[];

    return rows.map(mapSessionRow);
  }

  getSession(id: string): Session | undefined {
    const row = this.#database
      .prepare(`
        SELECT
          s.id,
          s.title,
          s.status,
          s.created_at,
          s.updated_at,
          COALESCE(MAX(e.sequence), 0) AS last_sequence
        FROM sessions s
        LEFT JOIN session_events e ON e.session_id = s.id
        WHERE s.id = ?
        GROUP BY s.id
      `)
      .get(id) as unknown as SessionRow | undefined;

    return row ? mapSessionRow(row) : undefined;
  }

  listEvents(sessionId: string, afterSequence = 0): SessionEvent[] {
    const rows = this.#database
      .prepare(`
        SELECT sequence, event_id, session_id, type, actor_json, payload_json, created_at
        FROM session_events
        WHERE session_id = ? AND sequence > ?
        ORDER BY sequence ASC
      `)
      .all(sessionId, afterSequence) as unknown as EventRow[];

    return rows.map(mapEventRow);
  }

  appendEvent(sessionId: string, input: AppendEventInput): SessionEvent {
    if (!this.getSession(sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }

    const createdAt = new Date().toISOString();
    const actorJson = JSON.stringify(input.actor);
    const payloadJson = JSON.stringify(input.payload);
    const result = this.#insertEvent.run(
      input.eventId,
      sessionId,
      input.type,
      actorJson,
      payloadJson,
      createdAt,
    );

    const stored = this.#database
      .prepare(`
        SELECT sequence, event_id, session_id, type, actor_json, payload_json, created_at
        FROM session_events WHERE event_id = ?
      `)
      .get(input.eventId) as unknown as EventRow;

    if (
      result.changes === 0 &&
      (stored.session_id !== sessionId ||
        stored.type !== input.type ||
        stored.actor_json !== actorJson ||
        stored.payload_json !== payloadJson)
    ) {
      throw new EventConflictError(input.eventId);
    }

    this.#database
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(createdAt, sessionId);

    return mapEventRow(stored);
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
  }
}

export class EventConflictError extends Error {
  constructor(eventId: string) {
    super(`Event id was already used with different content: ${eventId}`);
  }
}

function mapSessionRow(row: SessionRow): Session {
  return sessionSchema.parse({
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSequence: Number(row.last_sequence),
  });
}

function mapEventRow(row: EventRow): SessionEvent {
  return sessionEventSchema.parse({
    sequence: Number(row.sequence),
    eventId: row.event_id,
    sessionId: row.session_id,
    type: row.type,
    actor: JSON.parse(row.actor_json),
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  });
}
