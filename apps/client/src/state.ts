import type {
  RunStreamSnapshot,
  SessionEvent,
  WebSocketEnvelope,
} from "@prometheus/protocol";

export function mergeEvents(current: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  const byId = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) {
    byId.set(event.eventId, event);
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

export function applyRunStreamEnvelope(
  current: RunStreamSnapshot[],
  envelope: WebSocketEnvelope,
): RunStreamSnapshot[] {
  if (envelope.kind === "run.stream.snapshot") {
    const index = current.findIndex((stream) => stream.runId === envelope.stream.runId);
    if (index < 0) return [...current, { ...envelope.stream }];
    return current.map((stream, currentIndex) =>
      currentIndex === index ? { ...envelope.stream } : stream,
    );
  }
  if (envelope.kind === "run.stream.cleared") {
    return current.filter((stream) => stream.runId !== envelope.runId);
  }
  if (envelope.kind !== "run.stream.delta") return current;
  return current.map((stream) => {
    if (
      stream.sessionId !== envelope.sessionId ||
      stream.runId !== envelope.runId ||
      stream.turn !== envelope.turn ||
      envelope.revision !== stream.revision + 1
    ) {
      return stream;
    }
    return {
      ...stream,
      revision: envelope.revision,
      text: stream.text + envelope.delta,
    };
  });
}

export function clearRunStreamForEvent(
  current: RunStreamSnapshot[],
  event: SessionEvent,
): RunStreamSnapshot[] {
  if (event.type !== "message.agent" && event.type !== "agent.run.failed") return current;
  return current.filter((stream) => stream.runId !== event.payload.runId);
}
