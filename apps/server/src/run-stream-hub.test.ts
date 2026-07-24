import { describe, expect, it, vi } from "vitest";
import { RunStreamHub } from "./run-stream-hub.js";

describe("RunStreamHub", () => {
  it("keeps concurrent run snapshots isolated and clears only the requested run", () => {
    const hub = new RunStreamHub();
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const secondRunId = crypto.randomUUID();
    const listener = vi.fn();
    hub.subscribe(sessionId, listener);

    hub.startTurn({
      sessionId,
      runId,
      agentId: crypto.randomUUID(),
      agentLabel: "Builder",
      turn: 1,
    });
    hub.append(sessionId, runId, 1, "Hel");
    hub.append(sessionId, runId, 1, "lo");
    hub.startTurn({
      sessionId,
      runId: secondRunId,
      agentId: crypto.randomUUID(),
      agentLabel: "Reviewer",
      turn: 1,
    });
    hub.append(sessionId, secondRunId, 1, "Reviewing");
    hub.append(sessionId, crypto.randomUUID(), 1, "stale");

    expect(hub.list(sessionId)).toMatchObject([
      { runId, turn: 1, revision: 2, text: "Hello" },
      { runId: secondRunId, turn: 1, revision: 1, text: "Reviewing" },
    ]);
    expect(listener.mock.calls.map(([envelope]) => envelope.kind)).toEqual([
      "run.stream.snapshot",
      "run.stream.delta",
      "run.stream.delta",
      "run.stream.snapshot",
      "run.stream.delta",
    ]);
    expect(listener.mock.calls[2]![0]).toMatchObject({ revision: 2, delta: "lo" });

    hub.clear(sessionId, crypto.randomUUID());
    expect(hub.list(sessionId)).toHaveLength(2);
    hub.clear(sessionId, runId);
    expect(hub.list(sessionId)).toMatchObject([{ runId: secondRunId }]);
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "run.stream.cleared", runId });
  });

  it("starts a new provider turn with a replacement snapshot", () => {
    const hub = new RunStreamHub();
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    hub.startTurn({ sessionId, runId, agentId, agentLabel: "Builder", turn: 1 });
    hub.append(sessionId, runId, 1, "Intermediate text");

    hub.startTurn({ sessionId, runId, agentId, agentLabel: "Builder", turn: 2 });

    expect(hub.list(sessionId)).toMatchObject([{ turn: 2, revision: 0, text: "" }]);
  });
});
