import { expect, it } from "vitest";
import type { SessionEvent } from "@prometheus/protocol";
import { buildConversationItems, deriveConversationPhase } from "./conversation-model";

function event(partial: Partial<SessionEvent> & Pick<SessionEvent, "type" | "sequence" | "eventId">): SessionEvent {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    actor: partial.actor ?? { kind: "system", id: "sys", label: "System" },
    payload: partial.payload ?? {},
    createdAt: partial.createdAt ?? "2026-07-28T00:00:00.000Z",
    ...partial,
  };
}

it("builds user/agent bubbles and compact tool activity", () => {
  const items = buildConversationItems([
    event({
      sequence: 1,
      eventId: "e1",
      type: "message.user",
      actor: { kind: "user", id: "u", label: "You" },
      payload: { text: "hello" },
    }),
    event({
      sequence: 2,
      eventId: "e2",
      type: "agent.run.started",
      actor: { kind: "agent", id: "a", label: "Builder" },
      payload: { runId: "22222222-2222-4222-8222-222222222222" },
    }),
    event({
      sequence: 3,
      eventId: "e3",
      type: "tool.call.started",
      actor: { kind: "tool", id: "list_directory", label: "list_directory" },
      payload: { toolName: "list_directory", arguments: { path: "" } },
    }),
    event({
      sequence: 4,
      eventId: "e4",
      type: "message.agent",
      actor: { kind: "agent", id: "a", label: "Builder" },
      payload: { text: "hi there" },
    }),
  ], []);

  expect(items.map((item) => item.kind)).toEqual(["user", "activity", "activity", "agent"]);
  expect(items[0]).toMatchObject({ kind: "user", text: "hello" });
  expect(items[3]).toMatchObject({ kind: "agent", text: "hi there" });
});

it("derives sending / approval / streaming phases", () => {
  expect(deriveConversationPhase({
    sending: true,
    running: false,
    events: [],
    streams: [],
  }).phase).toBe("sending");

  expect(deriveConversationPhase({
    running: true,
    events: [
      event({
        sequence: 1,
        eventId: "a1",
        type: "approval.requested",
        payload: { approvalId: "33333333-3333-4333-8333-333333333333", toolName: "shell_command" },
      }),
    ],
    streams: [],
  })).toMatchObject({
    phase: "awaiting_approval",
    detail: expect.stringContaining("shell_command"),
  });

  expect(deriveConversationPhase({
    running: true,
    events: [],
    streams: [{
      sessionId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      agentId: "44444444-4444-4444-8444-444444444444",
      agentLabel: "Builder",
      turn: 1,
      revision: 2,
      text: "partial",
    }],
  }).phase).toBe("streaming");
});
