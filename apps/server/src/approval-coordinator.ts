import { randomUUID } from "node:crypto";
import type { ToolAuthorizationDecision } from "@prometheus/agent-core";

interface PendingApproval {
  sessionId: string;
  resolve: (decision: ToolAuthorizationDecision) => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
}

export interface ApprovalResolution {
  approvalId: string;
  sessionId: string;
  decision: ToolAuthorizationDecision;
}

export class ApprovalCoordinator {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #resolved = new Map<string, string>();

  create(sessionId: string, signal?: AbortSignal): {
    approvalId: string;
    decision: Promise<ToolAuthorizationDecision>;
  } {
    if (signal?.aborted) throw signal.reason;
    const approvalId = randomUUID();
    let resolveDecision!: (decision: ToolAuthorizationDecision) => void;
    let rejectDecision!: (reason: unknown) => void;
    const decision = new Promise<ToolAuthorizationDecision>((resolve, reject) => {
      resolveDecision = resolve;
      rejectDecision = reject;
    });
    const abort = () => {
      const pending = this.#pending.get(approvalId);
      if (!pending) return;
      this.#pending.delete(approvalId);
      pending.cleanup();
      pending.reject(signal?.reason ?? new Error("Approval wait aborted"));
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    this.#pending.set(approvalId, {
      sessionId,
      resolve: resolveDecision,
      reject: rejectDecision,
      cleanup,
    });
    return { approvalId, decision };
  }

  resolve(
    sessionId: string,
    approvalId: string,
    decision: ToolAuthorizationDecision,
  ): ApprovalResolution {
    const pending = this.#pending.get(approvalId);
    if (!pending) {
      if (this.#resolved.get(approvalId) === sessionId) {
        throw new ApprovalConflictError(approvalId);
      }
      throw new ApprovalNotFoundError(approvalId);
    }
    if (pending.sessionId !== sessionId) {
      throw new ApprovalNotFoundError(approvalId);
    }

    this.#pending.delete(approvalId);
    pending.cleanup();
    this.#resolved.set(approvalId, sessionId);
    pending.resolve(decision);
    return { approvalId, sessionId, decision };
  }
}

export class ApprovalNotFoundError extends Error {
  constructor(approvalId: string) {
    super(`Approval not found: ${approvalId}`);
  }
}

export class ApprovalConflictError extends Error {
  constructor(approvalId: string) {
    super(`Approval was already resolved: ${approvalId}`);
  }
}
