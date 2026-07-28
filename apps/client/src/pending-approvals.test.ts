import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@prometheus/protocol";
import { listPendingApprovals, mergePendingApprovals, pendingFromLiveApproval } from "./pending-approvals";

function event(partial: Partial<SessionEvent> & Pick<SessionEvent, "type" | "payload" | "sequence" | "eventId">): SessionEvent {
  return {
    sessionId: partial.sessionId ?? "session-1",
    sequence: partial.sequence,
    eventId: partial.eventId,
    type: partial.type,
    actor: partial.actor ?? { kind: "system", id: "system", label: "system" },
    createdAt: partial.createdAt ?? new Date().toISOString(),
    payload: partial.payload,
  };
}

describe("listPendingApprovals", () => {
  it("returns only unresolved approval requests", () => {
    const events = [
      event({
        type: "approval.requested",
        sequence: 1,
        eventId: "e1",
        payload: {
          approvalId: "a1",
          toolName: "write_file",
          arguments: { path: "src/a.ts", contentBytes: 12, contentPreview: "hello" },
        },
      }),
      event({
        type: "approval.requested",
        sequence: 2,
        eventId: "e2",
        payload: {
          approvalId: "a2",
          toolName: "shell_command",
          arguments: { command: "pnpm test", workdir: ".", timeoutMs: 10000 },
        },
      }),
      event({
        type: "approval.resolved",
        sequence: 3,
        eventId: "e3",
        payload: { approvalId: "a1", decision: "approved" },
      }),
    ];

    const pending = listPendingApprovals(events);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.approvalId).toBe("a2");
    expect(pending[0]?.live).toBe(false);
  });

  it("merges live cross-session approvals and preserves live flag", () => {
    const local = listPendingApprovals([
      event({
        type: "approval.requested",
        sequence: 1,
        eventId: "e1",
        payload: {
          approvalId: "a1",
          toolName: "write_file",
          arguments: { path: "src/a.ts", contentBytes: 4, contentPreview: "x" },
        },
      }),
    ]);
    const live = [
      pendingFromLiveApproval({
        approvalId: "a1",
        sessionId: "session-1",
        sessionTitle: "Ship auth",
        eventId: "e1",
        createdAt: "2026-07-28T00:00:00.000Z",
        toolName: "write_file",
        live: true,
        payload: {
          arguments: { path: "src/a.ts", contentBytes: 4, contentPreview: "x" },
        },
      }),
      pendingFromLiveApproval({
        approvalId: "a9",
        sessionId: "session-2",
        sessionTitle: "Other task",
        eventId: "e9",
        createdAt: "2026-07-28T00:00:00.000Z",
        toolName: "shell_command",
        live: false,
        payload: {
          arguments: { command: "echo hi", workdir: ".", timeoutMs: 10000 },
        },
      }),
    ];
    const merged = mergePendingApprovals(local, live);
    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.approvalId === "a1")?.live).toBe(true);
    expect(merged.find((item) => item.approvalId === "a9")?.live).toBe(false);
    expect(merged.find((item) => item.approvalId === "a1")?.sessionTitle).toBe("Ship auth");
  });
});
