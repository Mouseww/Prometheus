import type { SessionEvent } from "@prometheus/protocol";

export function describeEvent(event: SessionEvent): string {
  if (event.type === "agent.message") {
    const channel = String(event.payload.channel ?? "message");
    const label = channel.charAt(0).toUpperCase() + channel.slice(1);
    const recipient = String(event.payload.recipientLabel ?? event.payload.recipientId ?? "team");
    const text = String(event.payload.text ?? "Message sent");
    return `${label} to ${recipient} · ${text}`;
  }
  if (typeof event.payload.text === "string") return event.payload.text;
  if (typeof event.payload.message === "string") return event.payload.message;
  if (event.type === "agent.run.started") {
    return `Started model ${String(event.payload.model ?? "request")}`;
  }
  if (event.type === "agent.run.completed") {
    const usage = event.payload.usage as Record<string, unknown> | undefined;
    const total = usage?.totalTokens;
    return typeof total === "number" ? `Completed · ${total} tokens` : "Completed successfully";
  }
  if (event.type === "agent.run.failed") {
    return `Failed · ${String(event.payload.message ?? "Provider request failed")}`;
  }
  if (event.type === "agent.run.cancelled") {
    return "Cancelled by user";
  }
  if (event.type === "agent.spawned") {
    return `Queued ${String(event.payload.agentLabel ?? event.actor.label)} for the team goal`;
  }
  if (event.type === "agent.status") {
    const status = String(event.payload.status ?? "updated");
    return `${event.actor.label} · ${status}`;
  }
  if (event.type === "team.workspace.created") {
    const paths = Array.isArray(event.payload.allowedPaths)
      ? event.payload.allowedPaths.map(String).join(", ")
      : "assigned paths";
    return `Created isolated worktree for ${paths}`;
  }
  if (event.type === "team.changes.detected") {
    const paths = Array.isArray(event.payload.changedPaths) ? event.payload.changedPaths.length : 0;
    const bytes = typeof event.payload.patchBytes === "number" ? ` · ${event.payload.patchBytes} bytes` : "";
    const status = String(event.payload.status ?? "pending");
    return `${capitalize(status)} patch · ${paths} paths${bytes}`;
  }
  if (event.type === "team.changes.applied") {
    const paths = Array.isArray(event.payload.changedPaths) ? event.payload.changedPaths.length : 0;
    return `Applied isolated patch · ${paths} paths`;
  }
  if (event.type === "team.changes.conflicted") {
    const paths = Array.isArray(event.payload.conflictPaths) ? event.payload.conflictPaths.length : 0;
    const status = String(event.payload.status ?? "conflicted");
    return `${capitalize(status)} patch · ${paths} paths`;
  }
  if (event.type === "team.workspace.discarded") return "Discarded isolated workspace changes";
  if (event.type === "team.workspace.cleaned") return "Cleaned isolated worktree";
  if (event.type === "tool.call.started") {
    return `Running ${String(event.payload.toolName ?? event.actor.label)}`;
  }
  if (event.type === "tool.call.completed") {
    const prefix = event.payload.isError === true ? "Failed" : "Completed";
    const name = String(event.payload.toolName ?? event.actor.label);
    const output = typeof event.payload.output === "string" ? event.payload.output.trim() : "";
    if (!output) return `${prefix} ${name}`;
    const preview = output.split(/\r?\n/).find((line) => line.trim()) ?? output;
    const short = preview.length > 120 ? preview.slice(0, 117) + "..." : preview;
    return `${prefix} ${name} · ${short}`;
  }
  if (event.type === "approval.requested") {
    return `Approval required for ${String(event.payload.toolName ?? "tool call")}`;
  }
  if (event.type === "approval.resolved") {
    const prefix = event.payload.decision === "approved" ? "Approved" : "Denied";
    return `${prefix} ${String(event.payload.toolName ?? "tool call")}`;
  }
  if (event.type === "permission.rule.matched") {
    const effect = event.payload.effect;
    const prefix = effect === "allow" ? "Allowed" : effect === "deny" ? "Denied" : "Reviewing";
    return `${prefix} ${String(event.payload.toolName ?? "tool call")} by permission rule`;
  }
  return event.type;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export interface ApprovalPresentation {
  title: string;
  detail: string;
  preview: string;
  approveLabel: string;
  denyLabel: string;
  approveAriaLabel: string;
  denyAriaLabel: string;
}

export function describeApprovalRequest(event: SessionEvent): ApprovalPresentation {
  const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : "protected_tool";
  const argumentsValue = event.payload.arguments as Record<string, unknown> | undefined;
  if (toolName === "shell_command") {
    const workdir = typeof argumentsValue?.workdir === "string" && argumentsValue.workdir
      ? argumentsValue.workdir
      : "Workspace root";
    const timeoutMs = typeof argumentsValue?.timeoutMs === "number" ? argumentsValue.timeoutMs : 10_000;
    return {
      title: workdir,
      detail: `Shell command · ${timeoutMs} ms timeout`,
      preview: typeof argumentsValue?.command === "string" ? argumentsValue.command : "",
      approveLabel: "Approve command",
      denyLabel: "Deny",
      approveAriaLabel: "Approve shell command",
      denyAriaLabel: "Deny shell command",
    };
  }

  const path = typeof argumentsValue?.path === "string" ? argumentsValue.path : "Unknown path";
  const bytes = typeof argumentsValue?.contentBytes === "number" ? argumentsValue.contentBytes : null;
  return {
    title: path,
    detail: bytes === null ? "Workspace write" : `${bytes} UTF-8 bytes`,
    preview: typeof argumentsValue?.contentPreview === "string" ? argumentsValue.contentPreview : "",
    approveLabel: "Approve write",
    denyLabel: "Deny",
    approveAriaLabel: `Approve write to ${path}`,
    denyAriaLabel: `Deny write to ${path}`,
  };
}

export function deriveSessionTitle(text: string, fallback = "New conversation"): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;

  // Prefer the first sentence-ish chunk so titles stay short and readable.
  const sentence = normalized.split(/(?<=[.!?])\s+/)[0] ?? normalized;
  const title = sentence.length > 160 ? `${sentence.slice(0, 157).trimEnd()}...` : sentence;
  return title || fallback;
}
