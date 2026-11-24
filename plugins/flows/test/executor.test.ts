import { describe, expect, it } from "vitest";
import type { AgentRunOptions, AgentRunResult } from "@prometheus/plugin-sdk";
import type { Flow, FlowEdge, FlowNode } from "@prometheus/protocol";
import { flowIssues, flowLoopBackIds, MAX_FLOW_LOOPS } from "@prometheus/protocol";
import { normalizeFlow } from "../src/graph.ts";
import { MAX_STEPS_PER_RUN, OUTPUT_CHARS, parseVerdict, runFlow } from "../src/runner.ts";

const node = (id: string, kind: FlowNode["kind"], extra: Partial<FlowNode> = {}): FlowNode => ({ id, kind, x: 0, y: 0, title: id, ...(kind === "agent" ? { prompt: `do ${id}` } : {}), ...extra });
const edge = (from: string, to: string, branch?: "true" | "false"): FlowEdge => ({ id: `${from}-${to}`, from, to, ...(branch ? { branch } : {}) });
const flowOf = (nodes: FlowNode[], edges: FlowEdge[]): Flow => ({ id: "f1", name: "demo", description: "", workspaceId: "", nodes, edges, createdAt: "", updatedAt: "" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake agent. A retry continues the same session with a follow-up; the mock answers it as the step's original prompt. */
function agent(reply: (o: AgentRunOptions) => string | Error | Promise<string | Error>) {
	const calls: AgentRunOptions[] = [];
	const firstPrompt = new Map<string, string>();
	const runAgent = async (o: AgentRunOptions): Promise<AgentRunResult> => {
		calls.push(o);
		const sessionId = o.sessionId ?? `s${calls.length}`;
		if (!o.sessionId) firstPrompt.set(sessionId, o.prompt);
		const r = await reply(o.sessionId ? { ...o, prompt: firstPrompt.get(o.sessionId) ?? o.prompt } : o);
		return r instanceof Error ? { sessionId, status: "error", access: o.access, text: "", error: r.message } : { sessionId, status: "success", access: o.access, text: r };
	};
	return { calls, runAgent, prompts: () => calls.map((c) => c.prompt.split("\n")[0]!) };
}
const run = (flow: Flow, a: ReturnType<typeof agent>, signal = new AbortController().signal) =>
	runFlow(flow, "in", "r1", { runAgent: a.runAgent, now: () => new Date(0), update: () => {}, cwd: "/", retryDelayMs: 0 }, signal);

/** start → o → i → qi(true: back to i | false) → x → qo(true: back to o | false) → end */
const nested = (qi: Partial<FlowNode>, qo: Partial<FlowNode>) =>
	flowOf(
		[node("start", "start"), node("o", "agent"), node("i", "agent"), node("qi", "condition", qi), node("x", "agent"), node("qo", "condition", qo), node("end", "end")],
		[edge("start", "o"), edge("o", "i"), edge("i", "qi"), edge("qi", "i", "true"), edge("qi", "x", "false"), edge("x", "qo"), edge("qo", "o", "true"), edge("qo", "end", "false")],
	);

describe("executor: loops", () => {
	it("a join inside a loop body is a forward edge, not a loop", () => {
		const nodes = [node("start", "start"), node("a", "agent"), node("b", "agent"), node("c", "agent"), node("j", "agent"), node("q", "condition"), node("end", "end")];
		const edges = [edge("start", "a"), edge("a", "b"), edge("a", "c"), edge("b", "j"), edge("c", "j"), edge("j", "q"), edge("q", "a", "true"), edge("q", "end", "false")];
		expect([...flowLoopBackIds(nodes, edges)]).toEqual(["q-a"]);
		// Drawing order does not change the answer.
		expect([...flowLoopBackIds(nodes, [...edges].reverse())]).toEqual(["q-a"]);
	});

	it("repeats a loop whose body runs branches in parallel", async () => {
		let n = 0;
		const a = agent(async (o) => {
			if (o.prompt.startsWith("do b")) await sleep(5);
			return o.prompt.startsWith("do j") ? `round ${++n}` : "x";
		});
		const f = flowOf(
			[node("start", "start"), node("a", "agent"), node("b", "agent"), node("c", "agent"), node("j", "agent"), node("q", "condition", { mode: "contains", match: "round 1" }), node("end", "end")],
			[edge("start", "a"), edge("a", "b"), edge("a", "c"), edge("b", "j"), edge("c", "j"), edge("j", "q"), edge("q", "a", "true"), edge("q", "end", "false")],
		);
		const r = await run(f, a);
		expect(r.status).toBe("success");
		expect(a.prompts().filter((p) => p === "do j")).toHaveLength(2);
		expect(a.prompts().filter((p) => p === "do c")).toHaveLength(2);
		expect(r.output).toBe("round 2");
	});

	it("an inner loop repeats only its own body, not the outer loop", async () => {
		let inner = 0;
		let outer = 0;
		const a = agent((o) => (o.prompt.startsWith("do i") ? `i${++inner}` : o.prompt.startsWith("do o") ? `o${++outer}` : `pass ${outer}`));
		const r = await run(nested({ mode: "regex", match: "i[13579]$" }, { mode: "contains", match: "pass 1" }), a);
		expect(r.status).toBe("success");
		expect(a.prompts()).toEqual(["do o", "do i", "do i", "do x", "do o", "do i", "do i", "do x"]);
		expect(r.loopCount).toBe(3);
		expect(r.nodes.i?.history).toHaveLength(3);
	});

	it("an inner loop gets a fresh loop budget on each outer pass", async () => {
		let outer = 0;
		let inPass = 0;
		let inner = 0;
		const per = MAX_FLOW_LOOPS - 5;
		const a = agent((o) => {
			if (o.prompt.startsWith("do o")) return (inPass = 0), `o${++outer}`;
			if (o.prompt.startsWith("do i")) return inner++, ++inPass < per ? "more" : "done";
			return `pass ${outer}`;
		});
		const r = await run(nested({ mode: "contains", match: "more" }, { mode: "contains", match: "pass 1" }), a);
		expect(r.status).toBe("success");
		expect(inner).toBe(per * 2);
		expect(inner).toBeGreaterThan(MAX_FLOW_LOOPS);
	});

	it("stops a loop that never exits, and caps the steps of one run", async () => {
		const a = agent(() => "again");
		const r = await run(nested({ mode: "contains", match: "never" }, { mode: "contains", match: "again" }), a);
		expect(r.status).toBe("error");
		expect(r.error).toMatch(/循环次数|步骤/);
		expect(a.calls.length).toBeLessThanOrEqual(MAX_STEPS_PER_RUN);
	});

	it("keeps a branch outside the loop running while the loop repeats", async () => {
		let n = 0;
		const a = agent(async (o) => {
			if (o.prompt.startsWith("do slow")) await sleep(30);
			return o.prompt.startsWith("do a") ? `t ${++n}` : "x";
		});
		const f = flowOf(
			[node("start", "start"), node("slow", "agent"), node("a", "agent"), node("q", "condition", { mode: "contains", match: "t 1" }), node("j", "agent"), node("end", "end")],
			[edge("start", "slow"), edge("start", "a"), edge("a", "q"), edge("q", "a", "true"), edge("q", "j", "false"), edge("slow", "j"), edge("j", "end")],
		);
		const r = await run(f, a);
		expect(r.status).toBe("success");
		expect(a.prompts().filter((p) => p === "do slow")).toHaveLength(1);
		expect(a.prompts().filter((p) => p === "do j")).toHaveLength(1);
	});
});

describe("executor: failures", () => {
	it("retries a failed step once by itself, continuing the same chat", async () => {
		let n = 0;
		const a = agent((o) => (o.prompt.startsWith("do a") && ++n === 1 ? new Error("network") : "ok"));
		const r = await run(flowOf([node("start", "start"), node("a", "agent"), node("b", "agent")], [edge("start", "a"), edge("a", "b")]), a);
		expect(r.status).toBe("success");
		expect(r.nodes.a?.attempts).toBe(2);
		expect(a.calls[1]!.sessionId).toBe("s1");
		expect(a.calls[1]!.prompt).toContain("继续");
		expect(r.nodes.b?.status).toBe("success");
	});

	it("honours the retry count and the timeout of a step", async () => {
		const a = agent(() => new Error("down"));
		const r = await run(flowOf([node("start", "start"), node("a", "agent", { retries: 2, timeoutMin: 5 })], [edge("start", "a")]), a);
		expect(r.status).toBe("error");
		expect(a.calls).toHaveLength(3);
		expect(a.calls.every((c) => c.timeoutMs === 300_000)).toBe(true);
		expect(r.nodes.a?.attempts).toBe(3);
	});

	it("does not retry a cancelled step", async () => {
		const ctl = new AbortController();
		const a = agent(async () => (ctl.abort(), new Error("aborted")));
		const r = await run(flowOf([node("start", "start"), node("a", "agent", { retries: 3 })], [edge("start", "a")]), a, ctl.signal);
		expect(r.status).toBe("cancelled");
		expect(a.calls).toHaveLength(1);
	});

	it("a step set to continue on failure lets the flow go on and warns", async () => {
		const a = agent((o) => (o.prompt.startsWith("do a") ? new Error("boom") : "B-ok"));
		const r = await run(flowOf([node("start", "start"), node("a", "agent", { retries: 0, onError: "continue" }), node("b", "agent")], [edge("start", "a"), edge("a", "b")]), a);
		expect(r.status).toBe("success");
		expect(r.nodes.a).toMatchObject({ status: "error", tolerated: true });
		expect(a.calls[1]!.prompt).toContain("失败");
		expect(r.output).toBe("B-ok");
		expect(r.warning).toContain("按设置继续");
	});

	it("an ai condition with no readable verdict fails instead of guessing NO", async () => {
		const a = agent((o) => (o.prompt.includes("结论") ? "嗯，这个不好说" : "done"));
		const f = flowOf(
			[node("start", "start"), node("a", "agent"), node("c", "condition", { mode: "ai", prompt: "通过了吗？" }), node("t", "agent"), node("f", "agent")],
			[edge("start", "a"), edge("a", "c"), edge("c", "t", "true"), edge("c", "f", "false")],
		);
		const r = await run(f, a);
		expect(r.status).toBe("error");
		expect(r.error).toMatch(/结论/);
		expect(r.nodes.f?.status).toBe("skipped");
		expect(a.calls).toHaveLength(3); // the step, the question, one follow-up asking for a verdict
		expect(a.calls[2]!.sessionId).toBe("s2");
	});

	it("reads verdicts", () => {
		expect(parseVerdict("分析了一堆……\n结论：YES")).toBe(true);
		expect(parseVerdict("**结论：否**")).toBe(false);
		expect(parseVerdict("No.")).toBe(false);
		expect(parseVerdict("YES")).toBe(true);
		expect(parseVerdict("是")).toBe(true);
		expect(parseVerdict("不是")).toBe(false);
		expect(parseVerdict("答案：YES，因为找不到说 NO 的理由")).toBe(true);
		expect(parseVerdict("说不准")).toBeUndefined();
		expect(parseVerdict("yes and no")).toBeUndefined();
	});

	it("marks long output as cut instead of silently dropping the end", async () => {
		const a = agent(() => "x".repeat(OUTPUT_CHARS + 10));
		const r = await run(flowOf([node("start", "start"), node("a", "agent")], [edge("start", "a")]), a);
		expect(r.nodes.a?.output).toContain("已截断");
	});

	it("keeps finished siblings when one parallel branch fails", async () => {
		const a = agent(async (o) => (o.prompt.startsWith("do x") ? new Error("boom") : (await sleep(10), "ok")));
		const f = flowOf([node("start", "start"), node("x", "agent", { retries: 0 }), node("y", "agent"), node("j", "agent")], [edge("start", "x"), edge("start", "y"), edge("x", "j"), edge("y", "j")]);
		const r = await run(f, a);
		expect(r.status).toBe("error");
		expect(r.nodes.y?.status).toBe("success");
		expect(r.nodes.j?.status).toBe("skipped");
	});
});

describe("failure settings in the graph", () => {
	it("keeps and clamps retries, timeout and onError, and rejects bad values", () => {
		const d = normalizeFlow({ name: "n", nodes: [{ id: "a", kind: "agent", prompt: "p", retries: 9, timeoutMin: 0.4, onError: "continue" }, { id: "s", kind: "start" }], edges: [] });
		expect(d.nodes[0]).toMatchObject({ retries: 3, timeoutMin: 1, onError: "continue" });
		const bad = flowIssues({ name: "x", nodes: [node("start", "start"), node("a", "agent", { retries: 7, timeoutMin: 999 })], edges: [edge("start", "a")] }).map((i) => i.message).join();
		expect(bad).toMatch(/重试/);
		expect(bad).toMatch(/超时/);
	});
});
