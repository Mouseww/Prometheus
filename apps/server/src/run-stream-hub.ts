import type { RunStreamSnapshot, WebSocketEnvelope } from "@prometheus/protocol";

export type RunStreamEnvelope =
  | Extract<WebSocketEnvelope, { kind: "run.stream.snapshot" }>
  | Extract<WebSocketEnvelope, { kind: "run.stream.delta" }>
  | Extract<WebSocketEnvelope, { kind: "run.stream.cleared" }>;

type Listener = (envelope: RunStreamEnvelope) => void;

export class RunStreamHub {
  readonly #streams = new Map<string, Map<string, RunStreamSnapshot>>();
  readonly #listeners = new Map<string, Set<Listener>>();

  startTurn(input: Omit<RunStreamSnapshot, "revision" | "text">): void {
    const stream: RunStreamSnapshot = { ...input, revision: 0, text: "" };
    const sessionStreams = this.#streams.get(input.sessionId) ?? new Map<string, RunStreamSnapshot>();
    sessionStreams.set(input.runId, stream);
    this.#streams.set(input.sessionId, sessionStreams);
    this.#publish(input.sessionId, { kind: "run.stream.snapshot", stream: { ...stream } });
  }

  append(sessionId: string, runId: string, turn: number, delta: string): void {
    if (!delta) return;
    for (let offset = 0; offset < delta.length; offset += 65_536) {
      this.#appendChunk(sessionId, runId, turn, delta.slice(offset, offset + 65_536));
    }
  }

  list(sessionId: string): RunStreamSnapshot[] {
    return [...(this.#streams.get(sessionId)?.values() ?? [])].map((stream) => ({ ...stream }));
  }

  clear(sessionId: string, runId: string): void {
    const sessionStreams = this.#streams.get(sessionId);
    if (!sessionStreams?.delete(runId)) return;
    if (sessionStreams.size === 0) this.#streams.delete(sessionId);
    this.#publish(sessionId, { kind: "run.stream.cleared", sessionId, runId });
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(sessionId);
    };
  }

  #appendChunk(sessionId: string, runId: string, turn: number, delta: string): void {
    const sessionStreams = this.#streams.get(sessionId);
    const current = sessionStreams?.get(runId);
    if (!current || current.turn !== turn) return;
    const revision = current.revision + 1;
    sessionStreams!.set(runId, {
      ...current,
      revision,
      text: current.text + delta,
    });
    this.#publish(sessionId, {
      kind: "run.stream.delta",
      sessionId,
      runId,
      turn,
      revision,
      delta,
    });
  }

  #publish(sessionId: string, envelope: RunStreamEnvelope): void {
    for (const listener of this.#listeners.get(sessionId) ?? []) listener(envelope);
  }
}
