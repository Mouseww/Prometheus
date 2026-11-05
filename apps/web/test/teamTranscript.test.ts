import { describe, expect, it } from "vitest";
import { applyBoardEvent } from "../src/team/logic/board.ts";
import { barPercent, modelsToText, parseModels, usageTotals } from "../src/team/logic/gateway.ts";
import { argsPreview, buildTranscript, mergeEvents, pendingRequests, responseFor } from "../src/team/logic/transcript.ts";
import type { Board, SessionEvent } from "../src/team/types.ts";

const ev = (seq: number, kind: string, payload: unknown = {}): SessionEvent => ({ seq, kind, payload, createdAt: "" });
const msg = (seq: number, role: string, content: unknown) => ev(seq, "message_end", { message: { role, content } });

describe("buildTranscript", () => {
	it("builds user and assistant messages from message_end, string or parts content", () => {
		const items = buildTranscript([msg(0, "user", "hello"), msg(1, "assistant", [{ type: "text", text: "hi" }, { type: "toolCall", name: "x" }, { type: "text", text: "there" }]), msg(2, "toolResult", "ignored"), msg(3, "assistant", "  ")]);
		expect(items).toEqual([
			{ type: "user", key: "m0", seq: 0, text: "hello" },
			{ type: "assistant", key: "m1", seq: 1, text: "hi\nthere" },
		]);
	});

	it("pairs tool start and end into one collapsed item", () => {
		const items = buildTranscript([
			ev(1, "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { cmd: "ls" } }),
			ev(2, "tool_execution_start", { toolCallId: "c2", toolName: "read", args: { path: "a" }, parentToolCallId: "c1" }),
			ev(3, "tool_execution_end", { toolCallId: "c1", toolName: "bash", isError: false, result: "a.txt", durationMs: 12 }),
			ev(4, "tool_execution_end", { toolCallId: "c2", toolName: "read", isError: true, result: "nope" }),
		]);
		expect(items).toMatchObject([
			{ type: "tool", name: "bash", status: "done", result: "a.txt", durationMs: 12, args: { cmd: "ls" } },
			{ type: "tool", name: "read", status: "error", result: "nope", parentToolCallId: "c1" },
		]);
	});

	it("keeps a running tool running and survives an end that arrives first", () => {
		const running = buildTranscript([ev(1, "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} })]);
		expect(running[0]).toMatchObject({ status: "running" });
		const reversed = buildTranscript([ev(5, "tool_execution_end", { toolCallId: "c9", toolName: "bash", result: "ok" }), ev(4, "tool_execution_start", { toolCallId: "c9", toolName: "bash", args: { a: 1 } })]);
		// sorted by seq, so the start comes first and the end completes it
		expect(reversed).toHaveLength(1);
		expect(reversed[0]).toMatchObject({ status: "done", args: { a: 1 }, result: "ok" });
	});

	it("tracks ui requests until they are resolved", () => {
		const request = ev(2, "ui_request", { requestId: "r1", method: "permission", kind: "tool", toolName: "bash", title: "Run bash?", detail: "rm -rf" });
		const open = buildTranscript([msg(1, "user", "go"), request]);
		expect(pendingRequests(open)).toMatchObject([{ requestId: "r1", method: "permission", requestKind: "tool", toolName: "bash", title: "Run bash?", detail: "rm -rf" }]);
		const closed = buildTranscript([msg(1, "user", "go"), request, ev(3, "ui_resolved", { requestId: "r1" })]);
		expect(pendingRequests(closed)).toEqual([]);
		expect(closed[1]).toMatchObject({ type: "request", resolved: true });
	});

	it("records renames and ignores unknown kinds", () => {
		const items = buildTranscript([ev(1, "agent_start"), ev(2, "session_info_changed", { name: "Fix login" }), ev(3, "session_info_changed", {}), ev(4, "agent_end")]);
		expect(items).toEqual([{ type: "rename", key: "n2", seq: 2, name: "Fix login" }]);
	});

	it("orders by seq and drops duplicate seqs", () => {
		const merged = mergeEvents([msg(2, "assistant", "b")], [msg(0, "user", "a"), msg(2, "assistant", "b"), msg(1, "user", "c")]);
		expect(merged.map((e) => e.seq)).toEqual([0, 1, 2]);
		expect(buildTranscript([msg(1, "user", "x"), msg(0, "user", "y"), msg(1, "user", "x")]).map((i) => i.seq)).toEqual([0, 1]);
	});
});

describe("transcript helpers", () => {
	it("shortens arguments for the collapsed header", () => {
		expect(argsPreview({ cmd: "ls  -la" })).toBe('{"cmd":"ls -la"}');
		expect(argsPreview("x".repeat(300), 10)).toBe("xxxxxxxxxx...");
		expect(argsPreview(undefined)).toBe("");
	});

	it("maps a button to the response the owner's session expects", () => {
		expect(responseFor({ method: "permission", requestKind: "tool" }, "approve")).toEqual({ value: "allow" });
		expect(responseFor({ method: "permission", requestKind: "tool" }, "deny")).toEqual({ value: "deny" });
		expect(responseFor({ method: "permission", requestKind: "plan" }, "approve")).toEqual({ value: "default" });
		expect(responseFor({ method: "permission", requestKind: "plan" }, "deny")).toEqual({ value: "keep" });
		expect(responseFor({ method: "confirm" }, "approve")).toEqual({ confirmed: true });
		expect(responseFor({ method: "confirm" }, "deny")).toEqual({ confirmed: false });
		expect(responseFor({ method: "select" }, { value: "B" })).toEqual({ value: "B" });
	});
});

describe("applyBoardEvent", () => {
	const board: Board = {
		members: [{ user: { id: "u1", displayName: "A", email: "a@x" }, role: "member", online: true, sessions: [{ id: "s1", title: "t", status: "idle", lastActivityAt: "2026-11-05T00:00:00Z" }], lastActivityAt: null }],
		openMergeRequests: [],
		recentMerges: [],
	};

	it("patches a known session status without mutating the board", () => {
		const r = applyBoardEvent(board, { kind: "session.status", sessionId: "s1", status: "running", lastActivityAt: "2026-11-05T01:00:00Z" });
		expect(r.kind).toBe("patched");
		if (r.kind !== "patched") return;
		expect(r.board.members[0]?.sessions[0]).toMatchObject({ status: "running", lastActivityAt: "2026-11-05T01:00:00Z" });
		expect(board.members[0]?.sessions[0]?.status).toBe("idle");
	});

	it("asks for a reload for unknown sessions, new sessions and merge request changes", () => {
		expect(applyBoardEvent(board, { kind: "session.status", sessionId: "other", status: "idle" })).toEqual({ kind: "reload" });
		expect(applyBoardEvent(board, { kind: "session.created" })).toEqual({ kind: "reload" });
		expect(applyBoardEvent(board, { kind: "mergeRequest" })).toEqual({ kind: "reload" });
		expect(applyBoardEvent(board, { kind: "report.generated" })).toEqual({ kind: "ignore" });
		expect(applyBoardEvent(board, "nope")).toEqual({ kind: "ignore" });
	});
});

describe("gateway form helpers", () => {
	it("parses one model per line with optional display names", () => {
		expect(parseModels("gpt-4o\n\n claude-x | Claude X \ngpt-4o\n|bad")).toEqual([{ id: "gpt-4o" }, { id: "claude-x", name: "Claude X" }]);
		expect(modelsToText([{ id: "a" }, { id: "b", name: "B" }, { id: "c", name: "c" }])).toBe("a\nb | B\nc");
	});

	it("computes bars and totals", () => {
		expect(barPercent(50, 100)).toBe(50);
		expect(barPercent(1, 1000)).toBe(1);
		expect(barPercent(0, 10)).toBe(0);
		expect(barPercent(5, 0)).toBe(0);
		expect(usageTotals([{ key: "a", label: null, inputTokens: 1, outputTokens: 2, requests: 3 }, { key: "b", label: "B", inputTokens: 10, outputTokens: 20, requests: 30 }])).toEqual({ inputTokens: 11, outputTokens: 22, requests: 33 });
	});
});
