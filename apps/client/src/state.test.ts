import type { RunStreamSnapshot, SessionEvent } from "@prometheus/protocol";
import { describe, expect, it } from "vitest";
import { applyRunStreamEnvelope, clearRunStreamForEvent, mergeEvents } from "./state";

const base = {
  sessionId: "f19d8dca-4eb5-44e7-8a90-c322a951d2a3",
  type: "system.notice" as const,
  actor: { kind: "system" as const, id: "server", label: "Prometheus" },
  payload: {},
  createdAt: "2026-07-23T00:00:00.000Z",
};

describe("mergeEvents", () => {
  it("deduplicates socket and HTTP copies while preserving server sequence", () => {
    const first: SessionEvent = {
      ...base,
      sequence: 1,
      eventId: "a32f92cf-2d4b-49f5-9a5e-cb20f12cf602",
    };
    const second: SessionEvent = {
      ...base,
      sequence: 2,
      eventId: "58762951-8767-4fe5-9337-5b2617cd67cb",
    };

    expect(mergeEvents([second], [first, second])).toEqual([first, second]);
  });

  it("keeps concurrent run streams isolated and clears only the matching final reply", () => {
    const stream: RunStreamSnapshot = {
      sessionId: base.sessionId,
      runId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      agentLabel: "Builder",
      turn: 1,
      revision: 0,
      text: "",
    };
    const secondStream: RunStreamSnapshot = {
      ...stream,
      runId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      agentLabel: "Reviewer",
    };
    let current = applyRunStreamEnvelope([], {
      kind: "run.stream.snapshot",
      stream,
    });
    current = applyRunStreamEnvelope(current, {
      kind: "run.stream.snapshot",
      stream: secondStream,
    });
    current = applyRunStreamEnvelope(current, {
      kind: "run.stream.delta",
      sessionId: stream.sessionId,
      runId: stream.runId,
      turn: 1,
      revision: 1,
      delta: "Hel",
    });
    current = applyRunStreamEnvelope(current, {
      kind: "run.stream.delta",
      sessionId: stream.sessionId,
      runId: stream.runId,
      turn: 1,
      revision: 3,
      delta: "gap",
    });

    expect(current).toMatchObject([
      { runId: stream.runId, revision: 1, text: "Hel" },
      { runId: secondStream.runId, revision: 0, text: "" },
    ]);
    const finalEvent: SessionEvent = {
      ...base,
      sequence: 3,
      eventId: crypto.randomUUID(),
      type: "message.agent",
      payload: { runId: stream.runId, text: "Hello" },
    };
    expect(clearRunStreamForEvent(current, finalEvent)).toMatchObject([
      { runId: secondStream.runId },
    ]);
  });
});
