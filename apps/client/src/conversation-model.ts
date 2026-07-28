import type { RunStreamSnapshot, SessionEvent } from "@prometheus/protocol";
import { describeEvent } from "./event-description";

export type ConversationPhase =
  | "idle"
  | "sending"
  | "thinking"
  | "tool"
  | "streaming"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type ConversationItem =
  | {
    kind: "user";
    id: string;
    text: string;
    createdAt: string;
    pending?: boolean;
  }
  | {
    kind: "agent";
    id: string;
    text: string;
    createdAt: string;
    agentLabel: string;
  }
  | {
    kind: "activity";
    id: string;
    label: string;
    detail: string;
    status: "running" | "done" | "error" | "info" | "approval";
    createdAt: string;
    event: SessionEvent;
  }
  | {
    kind: "stream";
    id: string;
    stream: RunStreamSnapshot;
  };

export function buildConversationItems(
  events: SessionEvent[],
  streams: RunStreamSnapshot[],
  options?: { pendingUserText?: string | null },
): ConversationItem[] {
  const items: ConversationItem[] = [];
  const resolvedApprovals = new Set(
    events
      .filter((event) => event.type === "approval.resolved")
      .map((event) => String(event.payload.approvalId ?? ""))
      .filter(Boolean),
  );

  for (const event of events) {
    if (event.type === "message.user") {
      items.push({
        kind: "user",
        id: event.eventId,
        text: String(event.payload.text ?? ""),
        createdAt: event.createdAt,
      });
      continue;
    }

    if (event.type === "message.agent") {
      items.push({
        kind: "agent",
        id: event.eventId,
        text: String(event.payload.text ?? describeEvent(event)),
        createdAt: event.createdAt,
        agentLabel: event.actor.label,
      });
      continue;
    }

    // Resolved approvals are reflected on the request card; skip the raw follow-up event.
    if (event.type === "approval.resolved") continue;

    if (event.type === "approval.requested") {
      const approvalId = String(event.payload.approvalId ?? "");
      const resolved = approvalId ? resolvedApprovals.has(approvalId) : false;
      items.push({
        kind: "activity",
        id: event.eventId,
        label: resolved ? "Approval finished" : "Waiting for approval",
        detail: describeEvent(event),
        status: resolved ? "done" : "approval",
        createdAt: event.createdAt,
        event,
      });
      continue;
    }

    if (
      event.type === "tool.call.started"
      || event.type === "tool.call.completed"
      || event.type === "agent.run.started"
      || event.type === "agent.run.completed"
      || event.type === "agent.run.failed"
      || event.type === "agent.run.cancelled"
      || event.type.startsWith("team.")
      || event.type.startsWith("agent.")
    ) {
      items.push({
        kind: "activity",
        id: event.eventId,
        label: activityLabel(event),
        detail: describeEvent(event),
        status: activityStatus(event),
        createdAt: event.createdAt,
        event,
      });
    }
  }

  for (const stream of streams) {
    items.push({
      kind: "stream",
      id: `stream:${stream.runId}:${stream.turn}`,
      stream,
    });
  }

  if (options?.pendingUserText?.trim()) {
    items.push({
      kind: "user",
      id: "pending-user",
      text: options.pendingUserText.trim(),
      createdAt: new Date().toISOString(),
      pending: true,
    });
  }

  return items;
}

export function deriveConversationPhase(input: {
  sending?: boolean;
  running?: boolean;
  events: SessionEvent[];
  streams: RunStreamSnapshot[];
}): { phase: ConversationPhase; detail: string } {
  if (input.sending) {
    return { phase: "sending", detail: "Sending your message to the control plane…" };
  }

  const unresolvedApproval = input.events.find((event) => {
    if (event.type !== "approval.requested") return false;
    const approvalId = String(event.payload.approvalId ?? "");
    if (!approvalId) return false;
    return !input.events.some(
      (candidate) =>
        candidate.type === "approval.resolved"
        && String(candidate.payload.approvalId ?? "") === approvalId,
    );
  });
  if (unresolvedApproval) {
    return {
      phase: "awaiting_approval",
      detail: `Waiting for approval · ${String(unresolvedApproval.payload.toolName ?? "protected tool")}`,
    };
  }

  if (input.streams.some((stream) => stream.text.length > 0)) {
    const stream = input.streams.find((item) => item.text.length > 0) ?? input.streams[0]!;
    return {
      phase: "streaming",
      detail: `${stream.agentLabel} is writing a reply…`,
    };
  }

  if (input.streams.length > 0) {
    const stream = input.streams[0]!;
    return {
      phase: "thinking",
      detail: `${stream.agentLabel} is thinking…`,
    };
  }

  const latest = [...input.events].reverse().find((event) =>
    event.type === "tool.call.started"
    || event.type === "tool.call.completed"
    || event.type === "agent.run.started"
    || event.type === "agent.run.completed"
    || event.type === "agent.run.failed"
    || event.type === "agent.run.cancelled"
    || event.type === "message.agent"
    || event.type === "message.user"
  );

  if (input.running) {
    if (latest?.type === "tool.call.started") {
      return {
        phase: "tool",
        detail: `Running tool · ${String(latest.payload.toolName ?? latest.actor.label)}`,
      };
    }
    if (latest?.type === "tool.call.completed") {
      return {
        phase: "thinking",
        detail: "Tool finished · model is continuing…",
      };
    }
    if (latest?.type === "agent.run.started" || latest?.type === "message.user") {
      return {
        phase: "thinking",
        detail: "Message accepted · starting model turn…",
      };
    }
    return {
      phase: "thinking",
      detail: "Agent is working on your message…",
    };
  }

  if (latest?.type === "agent.run.failed") {
    return {
      phase: "failed",
      detail: describeEvent(latest),
    };
  }
  if (latest?.type === "agent.run.cancelled") {
    return {
      phase: "cancelled",
      detail: "Last run was cancelled",
    };
  }
  if (latest?.type === "message.agent" || latest?.type === "agent.run.completed") {
    return {
      phase: "completed",
      detail: "Reply ready",
    };
  }

  return { phase: "idle", detail: "Ready for the next message" };
}

function activityLabel(event: SessionEvent): string {
  switch (event.type) {
    case "agent.run.started":
      return "Run started";
    case "agent.run.completed":
      return "Run completed";
    case "agent.run.failed":
      return "Run failed";
    case "agent.run.cancelled":
      return "Run cancelled";
    case "tool.call.started":
      return `Tool · ${String(event.payload.toolName ?? event.actor.label)}`;
    case "tool.call.completed":
      return event.payload.isError === true
        ? `Tool failed · ${String(event.payload.toolName ?? event.actor.label)}`
        : `Tool done · ${String(event.payload.toolName ?? event.actor.label)}`;
    default:
      return event.type;
  }
}

function activityStatus(event: SessionEvent): "running" | "done" | "error" | "info" | "approval" {
  if (event.type === "tool.call.started" || event.type === "agent.run.started") return "running";
  if (event.type === "tool.call.completed" && event.payload.isError === true) return "error";
  if (event.type === "agent.run.failed") return "error";
  if (event.type === "agent.run.cancelled") return "info";
  if (event.type.endsWith(".completed") || event.type === "tool.call.completed") return "done";
  return "info";
}
