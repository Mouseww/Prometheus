import type { SessionEvent } from "@prometheus/protocol";
import type { LivePendingApproval } from "./api";
import { describeApprovalRequest } from "./event-description";

export type PendingApprovalItem = {
  sessionId: string;
  sessionTitle?: string;
  approvalId: string;
  event: SessionEvent;
  title: string;
  detail: string;
  preview: string;
  approveLabel: string;
  denyLabel: string;
};

export function listPendingApprovals(events: SessionEvent[]): PendingApprovalItem[] {
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.type !== "approval.resolved") continue;
    const approvalId = typeof event.payload.approvalId === "string" ? event.payload.approvalId : null;
    if (approvalId) resolved.add(approvalId);
  }

  const pending: PendingApprovalItem[] = [];
  for (const event of events) {
    if (event.type !== "approval.requested") continue;
    const approvalId = typeof event.payload.approvalId === "string" ? event.payload.approvalId : null;
    if (!approvalId || resolved.has(approvalId)) continue;
    const presentation = describeApprovalRequest(event);
    pending.push({
      sessionId: event.sessionId,
      approvalId,
      event,
      title: presentation.title,
      detail: presentation.detail,
      preview: presentation.preview,
      approveLabel: presentation.approveLabel,
      denyLabel: presentation.denyLabel,
    });
  }
  return pending;
}

export function pendingFromLiveApproval(item: LivePendingApproval): PendingApprovalItem {
  const event = {
    eventId: item.eventId,
    sessionId: item.sessionId,
    sequence: 0,
    type: "approval.requested" as const,
    actor: { kind: "system" as const, id: "approval-gate", label: "Approval Gate" },
    createdAt: item.createdAt,
    payload: {
      ...item.payload,
      approvalId: item.approvalId,
      toolName: item.toolName,
    },
  } satisfies SessionEvent;
  const presentation = describeApprovalRequest(event);
  return {
    sessionId: item.sessionId,
    sessionTitle: item.sessionTitle,
    approvalId: item.approvalId,
    event,
    title: presentation.title,
    detail: presentation.detail,
    preview: presentation.preview,
    approveLabel: presentation.approveLabel,
    denyLabel: presentation.denyLabel,
  };
}

export function mergePendingApprovals(
  local: PendingApprovalItem[],
  live: PendingApprovalItem[],
): PendingApprovalItem[] {
  const map = new Map<string, PendingApprovalItem>();
  for (const item of local) map.set(item.approvalId, item);
  for (const item of live) {
    const existing = map.get(item.approvalId);
    map.set(
      item.approvalId,
      existing
        ? {
            ...existing,
            sessionTitle: item.sessionTitle ?? existing.sessionTitle,
          }
        : item,
    );
  }
  return [...map.values()];
}
