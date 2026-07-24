import { describe, expect, it } from "vitest";
import {
  ApprovalConflictError,
  ApprovalCoordinator,
  ApprovalNotFoundError,
} from "./approval-coordinator.js";

describe("ApprovalCoordinator", () => {
  it("waits for and resolves a pending approval exactly once", async () => {
    const coordinator = new ApprovalCoordinator();
    const pending = coordinator.create("session-a");

    expect(coordinator.resolve("session-a", pending.approvalId, "approved")).toEqual({
      approvalId: pending.approvalId,
      sessionId: "session-a",
      decision: "approved",
    });
    await expect(pending.decision).resolves.toBe("approved");
    expect(() => coordinator.resolve("session-a", pending.approvalId, "denied"))
      .toThrow(ApprovalConflictError);
  });

  it("does not reveal or resolve approvals owned by another session", () => {
    const coordinator = new ApprovalCoordinator();
    const pending = coordinator.create("session-a");

    expect(() => coordinator.resolve("session-b", pending.approvalId, "approved"))
      .toThrow(ApprovalNotFoundError);
  });

  it("removes a pending approval when its run is aborted", async () => {
    const coordinator = new ApprovalCoordinator();
    const controller = new AbortController();
    const pending = coordinator.create("session-a", controller.signal);

    controller.abort(new Error("run cancelled"));

    await expect(pending.decision).rejects.toThrow("run cancelled");
    expect(() => coordinator.resolve("session-a", pending.approvalId, "approved"))
      .toThrow(ApprovalNotFoundError);
  });
});
