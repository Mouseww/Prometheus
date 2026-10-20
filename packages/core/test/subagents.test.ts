import { afterEach, describe, expect, it, vi } from "vitest";
import { launchSpecs, parseChildSession, SubagentTracker } from "../src/subagents.ts";

function make() {
	const emitted: unknown[][] = [];
	const tracker = new SubagentTracker({ emit: (runs) => emitted.push(runs) });
	const call = (toolCallId: string, args: unknown) => tracker.observe({ type: "tool_execution_start", toolCallId, toolName: "subagent", args });
	const update = (toolCallId: string, details: unknown) => tracker.observe({ type: "tool_execution_update", toolCallId, toolName: "subagent", partialResult: { details } });
	const end = (toolCallId: string, result: unknown, isError = false) => tracker.observe({ type: "tool_execution_end", toolCallId, toolName: "subagent", result, isError });
	return { tracker, emitted, call, update, end };
}

afterEach(() => vi.useRealTimers());

describe("launchSpecs", () => {
	it("reads single, parallel and chain launches", () => {
		expect(launchSpecs({ agent: "scout", task: "a" })).toEqual([{ agent: "scout", task: "a" }]);
		expect(launchSpecs({ tasks: [{ agent: "x", task: "1" }, { agent: "y", task: "2" }] })).toHaveLength(2);
		expect(launchSpecs({ chain: [{ agent: "a", task: "1" }, { parallel: [{ agent: "b", task: "2" }, { agent: "c", task: "3" }] }] }).map((s) => s.agent)).toEqual(["a", "b", "c"]);
		expect(launchSpecs({ action: "status" })).toEqual([]);
	});
});

describe("SubagentTracker (foreground)", () => {
	it("shows a run the moment the call starts and finishes it from the result", () => {
		const { tracker, call, update, end } = make();
		call("c1", { agent: "scout", task: "read the code" });
		expect(tracker.list()).toMatchObject([{ agent: "scout", task: "read the code", state: "running", stoppable: true, background: false }]);

		update("c1", { runId: "r1", progress: [{ index: 0, agent: "scout", status: "running", task: "read the code", tokens: 120, toolCount: 2, currentTool: "read", recentTools: [], recentOutput: [] }] });
		expect(tracker.list()[0]).toMatchObject({ tokens: 120, toolCount: 2, currentTool: "read", state: "running" });

		end("c1", { details: { runId: "r1", results: [{ index: 0, agent: "scout", task: "read the code", exitCode: 0, usage: { input: 100, output: 50 }, finalOutput: "done" }] } });
		const run = tracker.list()[0];
		expect(run).toMatchObject({ state: "completed", stoppable: false, tokens: 150 });
		expect(run?.endedAt).toBeTypeOf("number");
		expect(run?.currentTool).toBeUndefined();
	});

	it("ignores management calls and other tools", () => {
		const { tracker, call } = make();
		call("m", { action: "status" });
		tracker.observe({ type: "tool_execution_start", toolCallId: "x", toolName: "bash", args: { agent: "scout" } });
		expect(tracker.list()).toEqual([]);
	});

	it("marks a rejected call as failed with the reason", () => {
		const { tracker, call, end } = make();
		call("c2", { agent: "scout", task: "t" });
		end("c2", { content: [{ type: "text", text: "Rejected: a subagent call is already in progress." }], details: { mode: "single", results: [] } }, true);
		expect(tracker.list()[0]).toMatchObject({ state: "failed", error: expect.stringContaining("already in progress") });
	});

	it("tracks parallel children independently and queues later chain steps", () => {
		const { tracker, call, update, end } = make();
		call("p", { tasks: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] });
		expect(tracker.list().map((r) => r.state)).toEqual(["running", "running"]);
		update("p", { progress: [{ index: 0, agent: "a", status: "completed", task: "1", recentTools: [], recentOutput: [], toolCount: 1, tokens: 1 }, { index: 1, agent: "b", status: "running", task: "2", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0 }] });
		expect(tracker.list().map((r) => r.state)).toEqual(["completed", "running"]);
		end("p", { details: { results: [{ index: 0, agent: "a", exitCode: 0 }, { index: 1, agent: "b", exitCode: 1, error: "boom" }] } });
		expect(tracker.list().map((r) => r.state)).toEqual(["completed", "failed"]);

		call("ch", { chain: [{ agent: "x", task: "1" }, { agent: "y", task: "2" }] });
		expect(tracker.list().filter((r) => r.callId === "ch").map((r) => r.state)).toEqual(["running", "queued"]);
	});

	it("reads workflow-mode calls: agents from args.args, states from streamed workflowChildren", () => {
		const { tracker, call, update, end } = make();
		call("w", { workflow: "parallel", args: { tasks: [{ agent: "scout", task: "one" }, { agent: "scout", task: "two" }] }, async: false });
		expect(tracker.list().map((r) => r.task)).toEqual(["one", "two"]);

		update("w", { mode: "workflow", workflowChildren: { children: [{ childId: "task-1", state: "running" }, { childId: "task-2", state: "failed", runId: "child-2" }] } });
		expect(tracker.list().map((r) => r.state)).toEqual(["running", "failed"]);

		end("w", { content: [{ type: "text", text: "Run fan-out: 2/64 used\nWorkflow failed: Model not found" }], details: { mode: "workflow", results: [] } }, true);
		const runs = tracker.list();
		expect(runs[0]).toMatchObject({ state: "failed", error: expect.stringContaining("Model not found") });
		expect(runs[1]).toMatchObject({ state: "failed", error: expect.stringContaining("Model not found") });
		expect(runs[1]?.error).not.toContain("fan-out");
	});

	it("treats a stopped or interrupted child as stopped, not failed", () => {
		const { tracker, call, end } = make();
		call("s", { agent: "a", task: "t" });
		end("s", { details: { results: [{ index: 0, agent: "a", exitCode: 1, interrupted: true }] } });
		expect(tracker.list()[0]?.state).toBe("stopped");
	});

	it("never moves a finished child back to running on a late progress update", () => {
		const { tracker, call, update, end } = make();
		call("l", { agent: "a", task: "t" });
		end("l", { details: { results: [{ index: 0, agent: "a", exitCode: 0 }] } });
		update("l", { progress: [{ index: 0, agent: "a", status: "running", task: "t", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0 }] });
		expect(tracker.list()[0]?.state).toBe("completed");
	});

	it("keeps the task it read from the call when the package redacts prompts in progress and results", () => {
		const { tracker, call, update, end } = make();
		call("r", { agent: "scout", task: "read the manifest" });
		update("r", { progress: [{ index: 0, agent: "scout", status: "running", task: "[prompt redacted]", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0 }] });
		expect(tracker.list()[0]?.task).toBe("read the manifest");
		end("r", { details: { results: [{ index: 0, agent: "scout", task: "[prompt redacted]", exitCode: 0 }] } });
		expect(tracker.list()[0]?.task).toBe("read the manifest");
	});

	it("is rebuilt from saved tool results", () => {
		const { tracker } = make();
		tracker.restore([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "toolCall", id: "old", name: "subagent", arguments: { agent: "scout", task: "the real brief" } }] },
			{ role: "toolResult", toolName: "subagent", toolCallId: "old", timestamp: 5000, details: { runId: "r", results: [{ index: 0, agent: "scout", task: "[prompt redacted]", exitCode: 0, progressSummary: { durationMs: 1000, toolCount: 3 } }] } },
			{ role: "toolResult", toolName: "subagent", toolCallId: "bg", timestamp: 6000, details: { asyncId: "a1", results: [] } },
		]);
		const runs = tracker.list();
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ agent: "scout", task: "the real brief", state: "completed", toolCount: 3, endedAt: 5000, startedAt: 4000 });
	});

	it("restores a call that was rejected as failed, and one that never finished as stopped", () => {
		const { tracker } = make();
		tracker.restore([
			{ role: "assistant", content: [{ type: "toolCall", id: "bad", name: "subagent", arguments: { agent: "a", task: "t" } }] },
			{ role: "toolResult", toolName: "subagent", toolCallId: "bad", timestamp: 100, isError: true, details: { mode: "single", results: [] } },
			{ role: "assistant", content: [{ type: "toolCall", id: "cut", name: "subagent", arguments: { agent: "b", task: "t" } }] },
			{ role: "toolResult", toolName: "subagent", toolCallId: "cut", timestamp: 200, details: { mode: "single", results: [] } },
		]);
		expect(tracker.list().map((r) => [r.agent, r.state])).toEqual([["a", "failed"], ["b", "stopped"]]);
	});

	it("batches bursts of updates into one emission", () => {
		vi.useFakeTimers();
		const { tracker, emitted, call, update } = make();
		call("b", { agent: "a", task: "t" });
		for (let i = 0; i < 20; i++) update("b", { progress: [{ index: 0, agent: "a", status: "running", task: "t", recentTools: [], recentOutput: [], toolCount: i, tokens: i }] });
		vi.advanceTimersByTime(500);
		expect(emitted).toHaveLength(1);
		expect(tracker.list()[0]?.toolCount).toBe(19);
	});
});

describe("SubagentTracker (background)", () => {
	function started() {
		const m = make();
		m.call("bg", { agent: "worker", task: "long job", async: true });
		m.end("bg", { details: { mode: "single", asyncId: "A1", asyncDir: "/tmp/a1", background: true, results: [] } });
		return m;
	}

	it("keeps a launched background run running and flags it as background", () => {
		const { tracker } = started();
		tracker.dispose();
		expect(tracker.list()[0]).toMatchObject({ background: true, state: "running", stoppable: true });
	});

	it("lets the completion event settle it, overriding earlier guesses", () => {
		const { tracker } = started();
		(tracker as unknown as { finishAsync(d: unknown): void }).finishAsync({ runId: "A1", state: "complete", results: [{ index: 0, status: "completed", summary: "all good" }] });
		tracker.dispose();
		expect(tracker.list()[0]).toMatchObject({ state: "completed", stoppable: false });
	});

	it("expands a workflow into its children from the status snapshot", () => {
		const { tracker } = started();
		const apply = (nodes: unknown[]) => (tracker as unknown as { applySnapshot(n: unknown[]): void }).applySnapshot(nodes);
		apply([{ id: "A1", kind: "workflow", label: "wf", state: "running", children: [{ id: "k1", kind: "step", label: "scout", state: "running", startedAt: 10, activity: { currentTool: "grep", toolCount: 4 } }, { id: "k2", kind: "step", label: "reviewer", state: "queued" }] }]);
		let runs = tracker.list();
		expect(runs.map((r) => r.agent).sort()).toEqual(["reviewer", "scout"]);
		expect(runs.find((r) => r.agent === "scout")).toMatchObject({ currentTool: "grep", toolCount: 4, state: "running" });
		apply([{ id: "A1", kind: "workflow", label: "wf", state: "running", children: [{ id: "k1", kind: "step", label: "scout", state: "complete", endedAt: 99 }, { id: "k2", kind: "step", label: "reviewer", state: "running" }] }]);
		runs = tracker.list();
		expect(runs.find((r) => r.agent === "scout")).toMatchObject({ state: "completed", endedAt: 99, stoppable: false });
		expect(runs.find((r) => r.agent === "reviewer")?.state).toBe("running");
		tracker.dispose();
	});

	it("gives up on a run that vanished from the snapshot instead of spinning forever", () => {
		const { tracker } = started();
		const apply = (nodes: unknown[]) => (tracker as unknown as { applySnapshot(n: unknown[]): void }).applySnapshot(nodes);
		for (let i = 0; i < 4; i++) apply([]);
		tracker.dispose();
		expect(tracker.list()[0]).toMatchObject({ state: "stopped", error: expect.stringContaining("状态未知") });
	});
});

describe("SubagentTracker.stop", () => {
	function bus() {
		const handlers = new Map<string, (d: unknown) => void>();
		const sent: { method: string; params: unknown }[] = [];
		return {
			sent,
			on: (ch: string, h: (d: unknown) => void) => {
				handlers.set(ch, h);
				return () => handlers.delete(ch);
			},
			emit: (ch: string, d: unknown) => {
				const req = d as { requestId: string; method: string; params: unknown };
				sent.push({ method: req.method, params: req.params });
				handlers.get(`subagents:rpc:v1:reply:${req.requestId}`)?.({ success: true, data: {} });
			},
		};
	}

	it("interrupts a foreground run and marks it stopped", async () => {
		const { tracker, call, update } = make();
		const b = bus();
		(tracker as unknown as { events: unknown }).events = b;
		call("f", { agent: "a", task: "t" });
		update("f", { runId: "RUN", progress: [{ index: 0, agent: "a", status: "running", task: "t", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0 }] });
		await tracker.stop(tracker.list()[0]!.id);
		expect(b.sent).toEqual([{ method: "interrupt", params: { id: "RUN" } }]);
		expect(tracker.list()[0]).toMatchObject({ state: "stopped", stoppable: false });
	});

	it("stops a single background child by its child id", async () => {
		const { tracker, call, end } = make();
		const b = bus();
		(tracker as unknown as { events: unknown }).events = b;
		call("bg", { agent: "w", task: "t", async: true });
		end("bg", { details: { asyncId: "A", background: true, results: [] } });
		(tracker as unknown as { applySnapshot(n: unknown[]): void }).applySnapshot([{ id: "A", kind: "workflow", label: "wf", state: "running", children: [{ id: "k1", label: "w", state: "running" }] }]);
		tracker.dispose();
		await tracker.stop(tracker.list()[0]!.id);
		// Launching a background run also starts a status poll; only the stop request matters here.
		expect(b.sent.filter((s) => s.method !== "status")).toEqual([{ method: "stop", params: { id: "A", childId: "k1" } }]);
	});

	it("rejects an unknown id and does nothing for a finished run", async () => {
		const { tracker, call, end } = make();
		const b = bus();
		(tracker as unknown as { events: unknown }).events = b;
		await expect(tracker.stop("nope")).rejects.toThrow();
		call("d", { agent: "a", task: "t" });
		end("d", { details: { results: [{ index: 0, agent: "a", exitCode: 0 }] } });
		await tracker.stop(tracker.list()[0]!.id);
		expect(b.sent).toEqual([]);
	});
});

describe("parseChildSession", () => {
	const line = (message: unknown) => JSON.stringify({ type: "message", message });
	it("rebuilds thinking, text and tool steps with their results", () => {
		const text = [
			JSON.stringify({ type: "session", id: "s" }),
			line({ role: "user", content: "task" }),
			line({ role: "assistant", content: [{ type: "thinking", thinking: "plan it" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }] }),
			line({ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "file body" }], isError: false }),
			line({ role: "assistant", content: [{ type: "text", text: "all done" }] }),
			"not json",
		].join("\n");
		expect(parseChildSession(text)).toEqual([
			{ kind: "thinking", text: "plan it" },
			{ kind: "tool", text: "", tool: "read", args: "a.ts", result: "file body" },
			{ kind: "text", text: "all done" },
		]);
	});

	it("flags failed tool calls and caps very long transcripts", () => {
		const calls = Array.from({ length: 500 }, (_, i) => line({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `echo ${i}` } }] }));
		const steps = parseChildSession([...calls, line({ role: "toolResult", toolCallId: "c499", content: [{ type: "text", text: "no" }], isError: true })].join("\n"));
		expect(steps).toHaveLength(400);
		expect(steps.at(-1)).toMatchObject({ args: "echo 499", isError: true });
	});
});

describe("child gateway extension", () => {
	it("writes an extension that registers gateways and requires it per session", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { pathToFileURL } = await import("node:url");
		const { requireChildExtension, writeChildGatewayExtension } = await import("../src/subagents.ts");
		const dir = mkdtempSync(join(tmpdir(), "prom-sub-"));
		try {
			const entry = writeChildGatewayExtension(dir, { "hakimi-router": { api: "openai-completions", models: [{ id: "deepseek-v4.1-flash" }] } });
			const registered: [string, unknown][] = [];
			const mod = (await import(pathToFileURL(entry).href)) as { default: (pi: unknown) => void };
			mod.default({ registerProvider: (id: string, config: unknown) => registered.push([id, config]) });
			expect(registered.map(([id]) => id)).toEqual(["hakimi-router"]);

			const release = requireChildExtension("s1", "prometheus-gateways", entry);
			const store = (globalThis as Record<symbol, { bySession: Map<string, { id: string; path: string }[]> }>)[Symbol.for("pi-subagents.required-child-extensions.v1")];
			expect(store?.bySession.get("s1")?.map((e) => e.id)).toEqual(["prometheus-gateways"]);
			release();
			expect(store?.bySession.has("s1")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
