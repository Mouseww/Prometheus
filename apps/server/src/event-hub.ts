import type { SessionEvent } from "@prometheus/protocol";

type Listener = (event: SessionEvent) => void;

export class EventHub {
  readonly #listeners = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#listeners.delete(sessionId);
      }
    };
  }

  publish(event: SessionEvent): void {
    for (const listener of this.#listeners.get(event.sessionId) ?? []) {
      listener(event);
    }
  }
}
