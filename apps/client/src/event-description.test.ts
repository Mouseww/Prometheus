import type { SessionEvent } from "@prometheus/protocol";
import { expect, it } from "vitest";
import { describeApprovalRequest, describeEvent, deriveSessionTitle } from "./event-description";

const base: SessionEvent = {
  sequence: 1,
  eventId: "a32f92cf-2d4b-49f5-9a5e-cb20f12cf602",
  sessionId: "f19d8dca-4eb5-44e7-8a90-c322a951d2a3",
  type: "tool.call.started",
  actor: { kind: "tool", id: "read_file", label: "read_file" },
  payload: { toolName: "read_file" },
  createdAt: "2026-07-23T00:00:00.000Z",
};

it("describes durable tool lifecycle events without dumping payload JSON", () => {
  expect(describeEvent(base)).toBe("Running read_file");
  expect(describeEvent({
    ...base,
    type: "tool.call.completed",
    payload: { toolName: "read_file", isError: false },
  })).toBe("Completed read_file");
  expect(describeEvent({
    ...base,
    type: "tool.call.completed",
    payload: { toolName: "read_file", isError: true },
  })).toBe("Failed read_file");
});


it("describes cancelled agent runs", () => {
  expect(describeEvent({
    ...base,
    type: "agent.run.cancelled",
    payload: { message: "Cancelled by user", runId: crypto.randomUUID() },
  })).toBe("Cancelled by user");
});

it("describes approval requests and decisions", () => {
  expect(describeEvent({
    ...base,
    type: "approval.requested",
    payload: { toolName: "write_file" },
  })).toBe("Approval required for write_file");
  expect(describeEvent({
    ...base,
    type: "approval.resolved",
    payload: { toolName: "write_file", decision: "denied" },
  })).toBe("Denied write_file");
});

it("builds a shell-specific cross-device approval presentation", () => {
  expect(describeApprovalRequest({
    ...base,
    type: "approval.requested",
    payload: {
      toolName: "shell_command",
      arguments: {
        command: "pnpm test",
        workdir: "apps/server",
        timeoutMs: 12_000,
      },
    },
  })).toEqual({
    title: "apps/server",
    detail: "Shell command · 12000 ms timeout",
    preview: "pnpm test",
    approveLabel: "Approve command",
    denyLabel: "Deny",
    approveAriaLabel: "Approve shell command",
    denyAriaLabel: "Deny shell command",
  });
});

it("describes durable permission rule decisions", () => {
  expect(describeEvent({
    ...base,
    type: "permission.rule.matched",
    payload: { toolName: "shell_command", effect: "allow" },
  })).toBe("Allowed shell_command by permission rule");
  expect(describeEvent({
    ...base,
    type: "permission.rule.matched",
    payload: { toolName: "shell_command", effect: "deny" },
  })).toBe("Denied shell_command by permission rule");
});

it("describes durable team lifecycle events", () => {
  expect(describeEvent({
    ...base,
    type: "agent.spawned",
    actor: { kind: "system", id: "team-runtime", label: "Team Runtime" },
    payload: { agentLabel: "Research specialist", status: "queued" },
  })).toBe("Queued Research specialist for the team goal");
  expect(describeEvent({
    ...base,
    type: "agent.status",
    actor: { kind: "agent", id: "research-agent", label: "Research specialist" },
    payload: { status: "running" },
  })).toBe("Research specialist · running");
  expect(describeEvent({
    ...base,
    type: "team.workspace.created",
    payload: { branchName: "prometheus/team/task", allowedPaths: ["apps/server"] },
  })).toBe("Created isolated worktree for apps/server");
  expect(describeEvent({
    ...base,
    type: "team.changes.detected",
    payload: { status: "pending", changedPaths: ["apps/server/src/app.ts"], patchBytes: 420 },
  })).toBe("Pending patch · 1 paths · 420 bytes");
  expect(describeEvent({
    ...base,
    type: "team.changes.conflicted",
    payload: { status: "conflicted", conflictPaths: ["apps/server/src/app.ts"] },
  })).toBe("Conflicted patch · 1 paths");
});

it("describes durable Agent bus messages without dumping payload JSON", () => {
  expect(describeEvent({
    ...base,
    type: "agent.message",
    actor: { kind: "agent", id: "research-agent", label: "Research specialist" },
    payload: {
      channel: "decision",
      recipientLabel: "All agents",
      text: "Use the durable event log.",
    },
  })).toBe("Decision to All agents · Use the durable event log.");
});

it("derives a short session title from the first sentence", () => {
  expect(deriveSessionTitle("Fix the approval card layout. Then ship it.")).toBe(
    "Fix the approval card layout.",
  );
  expect(deriveSessionTitle("   hello world   ")).toBe("hello world");
  expect(deriveSessionTitle("")).toBe("New conversation");
});
