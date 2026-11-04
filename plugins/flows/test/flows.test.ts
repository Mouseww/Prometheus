import { describe, expect, it } from "vitest";
import type { AgentRunOptions, AgentRunResult } from "@prometheus/plugin-sdk";
import type { Flow, FlowEdge, FlowNode } from "@prometheus/protocol";
import { flowIssues } from "@prometheus/protocol";
import { FLOW_TEMPLATES } from "../../../apps/web/src/lib/flowTemplates.ts";
import { FlowEngine, type FlowState } from "../src/engine.ts";
import { autoLayout, ensureStart, extractJson, hasCycle, normalizeFlow, validateFlow } from "../src/graph.ts";
import { checkText, fillTemplate, runFlow } from "../src/runner.ts";

const node = (id: string, kind: FlowNode["kind"], extra: Partial<FlowNode> = {}): FlowNode => ({
	id,
	kind,
	x: 0,
	y: 0,
	title: id,
	...(kind === "agent" ? { prompt: `do ${id}` } : {}),
	...extra,
});
const edge = (from: string, to: string, branch?: "true" | "false"): FlowEdge => ({ id: `${from}-${to}`, from, to, ...(branch ? { branch } : {}) });
const flowOf = (nodes: FlowNode[], edges: FlowEdge[]): Flow => ({ id: "f1", name: "demo", description: "", workspaceId: "w1", nodes, edges, createdAt: "", updatedAt: "" });

function agent(reply: (o: AgentRunOptions) => string | Error | Promise<string | Error>) {
	const calls: AgentRunOptions[] = [];
	const runAgent = async (o: AgentRunOptions): Promise<AgentRunResult> => {
		calls.push(o);
		const r = await reply(o);
		return r instanceof Error ? { sessionId: `s${calls.length}`, status: "error", access: o.access, text: "", error: r.message } : { sessionId: `s${calls.length}`, status: "success", access: o.access, text: r };
	};
	return { calls, runAgent };
}
const run = (flow: Flow, input: string, a: ReturnType<typeof agent>, signal = new AbortController().signal) =>
	runFlow(flow, input, "r1", { runAgent: a.runAgent, now: () => new Date(0), update: () => {}, cwd: "/proj" }, signal);

describe("validateFlow", () => {
	const ok = () => ({ name: "x", nodes: [node("start", "start"), node("a", "agent")], edges: [edge("start", "a")] });
	it("accepts a simple flow", () => expect(validateFlow(ok())).toEqual([]));
	it("rejects cycles, missing prompt, unreachable nodes and unlabeled branches", () => {
		const f = ok();
		f.nodes.push(node("b", "agent"), node("c", "condition", { mode: "contains", match: "x" }), node("d", "agent", { prompt: "" }));
		f.edges.push(edge("a", "b"), edge("b", "a"));
		const errors = validateFlow(f).join("|");
		expect(errors).toMatch(/环/);
		expect(errors).toMatch(/没有填写指令/);
		const g = ok();
		g.nodes.push(node("c", "condition", { mode: "contains", match: "x" }), node("z", "agent"));
		g.edges.push(edge("a", "c"), edge("c", "z"));
		expect(validateFlow(g).join("|")).toMatch(/是\/否/);
		const h = ok();
		h.nodes.push(node("z", "agent"));
		expect(validateFlow(h).join("|")).toMatch(/无法到达/);
	});
	it("needs exactly one start", () => {
		expect(validateFlow({ name: "x", nodes: [node("a", "agent")], edges: [] }).join("|")).toMatch(/开始节点/);
	});
	it("detects cycles", () => expect(hasCycle([node("a", "agent"), node("b", "agent")], [edge("a", "b"), edge("b", "a")])).toBe(true));
});

describe("graph helpers", () => {
	it("extracts JSON from chatter and fences", () => {
		expect(extractJson('好的：\n```json\n{"a":{"b":"}"}}\n```\n完毕')).toEqual({ a: { b: "}" } });
		expect(extractJson('text {"x":1} tail')).toEqual({ x: 1 });
		expect(() => extractJson("nothing")).toThrow();
	});
	it("normalizes a draft, lays it out and adds a start node", () => {
		const draft = normalizeFlow({ name: "n", nodes: [{ id: "a", kind: "agent", title: "A", prompt: "p", access: "root" }, { id: "b", kind: "agent", prompt: "q" }], edges: [{ from: "a", to: "b" }, { from: "a", to: "ghost" }] });
		expect(draft.nodes[0]?.access).toBe("readonly");
		expect(draft.edges).toHaveLength(1);
		expect(draft.nodes[1]!.x).toBeGreaterThan(draft.nodes[0]!.x);
		const withStart = ensureStart(draft);
		expect(validateFlow(withStart)).toEqual([]);
	});
	it("auto layout puts downstream nodes to the right", () => {
		const out = autoLayout([node("a", "start"), node("b", "agent"), node("c", "agent")], [edge("a", "b"), edge("a", "c")]);
		expect(out[1]!.x).toBe(out[2]!.x);
		expect(out[1]!.y).not.toBe(out[2]!.y);
	});
});

describe("runner helpers", () => {
	it("fills known variables only", () => expect(fillTemplate("{{input}} {{ a }} {{zz}}", { input: "I", a: "A" })).toBe("I A {{zz}}"));
	it("checks text", () => {
		expect(checkText("contains", "FAIL", "tests fail")).toBe(true);
		expect(checkText("regex", "^ok$", "ok")).toBe(true);
	});
});

describe("runFlow", () => {
	it("passes outputs down a chain and returns the end output", async () => {
		const a = agent((o) => (o.prompt.startsWith("do a") ? "A-out" : "B-out"));
		const flow = flowOf([node("start", "start"), node("a", "agent", { prompt: "do a {{input}}" }), node("b", "agent"), node("end", "end")], [edge("start", "a"), edge("a", "b"), edge("b", "end")]);
		const r = await run(flow, "hello", a);
		expect(r.status).toBe("success");
		expect(a.calls[0]!.prompt).toBe("do a hello");
		// b never mentions {{prev}}, so the upstream output is appended automatically.
		expect(a.calls[1]!.prompt).toContain("do b");
		expect(a.calls[1]!.prompt).toContain("A-out");
		expect(r.output).toBe("B-out");
		expect(r.nodes.a?.sessionId).toBe("s1");
		expect(a.calls[0]!.cwd).toBe("/proj");
	});

	it("runs branches in parallel and joins them", async () => {
		let active = 0;
		let peak = 0;
		const a = agent(async (o) => {
			if (/do (x|y)/.test(o.prompt)) {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 20));
				active--;
			}
			return o.prompt.includes("do join") ? "joined" : o.prompt.includes("do x") ? "X" : "Y";
		});
		const flow = flowOf(
			[node("start", "start"), node("x", "agent"), node("y", "agent"), node("join", "agent", { prompt: "do join {{x}}+{{y}}" })],
			[edge("start", "x"), edge("start", "y"), edge("x", "join"), edge("y", "join")],
		);
		const r = await run(flow, "", a);
		expect(peak).toBe(2);
		expect(r.status).toBe("success");
		expect(a.calls.at(-1)!.prompt).toBe("do join X+Y");
		expect(r.output).toBe("joined");
	});

	it("takes only the matching condition branch and skips the other", async () => {
		const a = agent((o) => (o.prompt.startsWith("do a") ? "tests FAIL" : "ok"));
		const flow = flowOf(
			[node("start", "start"), node("a", "agent"), node("c", "condition", { mode: "contains", match: "fail" }), node("fix", "agent"), node("ship", "agent")],
			[edge("start", "a"), edge("a", "c"), edge("c", "fix", "true"), edge("c", "ship", "false")],
		);
		const r = await run(flow, "", a);
		expect(r.nodes.fix?.status).toBe("success");
		expect(r.nodes.ship?.status).toBe("skipped");
		expect(a.calls).toHaveLength(2);
	});

	it("asks the agent for ai conditions, read-only", async () => {
		const a = agent((o) => (o.prompt.includes("YES 或 NO") ? "NO." : "done"));
		const flow = flowOf(
			[node("start", "start"), node("a", "agent"), node("c", "condition", { mode: "ai", prompt: "有问题吗？" }), node("t", "agent"), node("f", "agent")],
			[edge("start", "a"), edge("a", "c"), edge("c", "t", "true"), edge("c", "f", "false")],
		);
		const r = await run(flow, "", a);
		expect(r.nodes.t?.status).toBe("skipped");
		expect(r.nodes.f?.status).toBe("success");
		expect(a.calls[1]!.access).toBe("readonly");
	});

	it("a join after a skipped branch still runs from the live one", async () => {
		const a = agent(() => "yes");
		const flow = flowOf(
			[node("start", "start"), node("c", "condition", { mode: "contains", match: "nope" }), node("t", "agent"), node("f", "agent"), node("j", "agent")],
			[edge("start", "c"), edge("c", "t", "true"), edge("c", "f", "false"), edge("t", "j"), edge("f", "j")],
		);
		const r = await run(flow, "x", a);
		expect(r.status).toBe("success");
		expect(r.nodes.t?.status).toBe("skipped");
		expect(r.nodes.j?.status).toBe("success");
	});

	it("stops at the first failing step and skips the rest", async () => {
		const a = agent((o) => (o.prompt.startsWith("do a") ? new Error("boom") : "ok"));
		const flow = flowOf([node("start", "start"), node("a", "agent"), node("b", "agent")], [edge("start", "a"), edge("a", "b")]);
		const r = await run(flow, "", a);
		expect(r.status).toBe("error");
		expect(r.error).toContain("boom");
		expect(r.nodes.b?.status).toBe("skipped");
	});

	it("records refused calls on the step and warns on the run", async () => {
		const calls: AgentRunOptions[] = [];
		const blocked = [{ tool: "bash", reason: 'Blocked by permissions: running commands is not covered by "edits" access: this step needs "full".' }];
		const runAgent = async (o: AgentRunOptions): Promise<AgentRunResult> => {
			calls.push(o);
			return { sessionId: "s1", status: "success", access: o.access, text: "done", blocked };
		};
		const flow = flowOf([node("start", "start"), node("a", "agent", { access: "edits" })], [edge("start", "a")]);
		const r = await runFlow(flow, "", "r1", { runAgent, now: () => new Date(0), update: () => {}, cwd: "/proj" }, new AbortController().signal);
		expect(r.status).toBe("success");
		expect(calls[0]!.access).toBe("edits");
		expect(r.nodes.a?.blocked?.[0]?.tool).toBe("bash");
		expect(r.warning).toContain("权限不足");
		expect(r.warning).toContain("a");
	});

	it("a clean run has no warning", async () => {
		const a = agent(() => "ok");
		const flow = flowOf([node("start", "start"), node("a", "agent")], [edge("start", "a")]);
		const r = await run(flow, "", a);
		expect(r.warning).toBeUndefined();
	});

	it("a run-wide access override replaces each step's own access", async () => {
		const a = agent(() => "ok");
		const flow = flowOf([node("start", "start"), node("a", "agent", { access: "readonly" })], [edge("start", "a")]);
		const r = await runFlow(flow, "", "r1", { runAgent: a.runAgent, now: () => new Date(0), update: () => {}, cwd: "/proj", accessOverride: "full" }, new AbortController().signal);
		expect(r.status).toBe("success");
		expect(a.calls[0]!.access).toBe("full");
	});

	it("cancels", async () => {
		const ctl = new AbortController();
		const a = agent(async () => {
			ctl.abort();
			return "x";
		});
		const flow = flowOf([node("start", "start"), node("a", "agent"), node("b", "agent")], [edge("start", "a"), edge("a", "b")]);
		const r = await run(flow, "", a, ctl.signal);
		expect(r.status).toBe("cancelled");
		expect(a.calls).toHaveLength(1);
	});
});

describe("FlowEngine", () => {
	it("runs every step at the access the user picked for the run", async () => {
		const { engine, a } = harness();
		await engine.create({ name: "demo", description: "", workspaceId: "w1", nodes: [node("start", "start"), node("a", "agent")], edges: [edge("start", "a")] });
		const id = engine.snapshot().flows[0]!.id;
		const started = await engine.startRun(id, "", undefined, "manual", undefined, "full");
		const r = await started.done;
		expect(r.status).toBe("success");
		expect(a.calls[0]!.access).toBe("full");
	});

	function harness(reply: (o: AgentRunOptions) => string = () => "out", initial: FlowState = { flows: [], runs: [] }) {
		let saved: FlowState = initial;
		const a = agent(reply);
		const engine = new FlowEngine({
			load: async () => structuredClone(saved),
			save: async (s) => void (saved = s),
			workspaces: async () => [{ id: "w1", name: "p", path: "/proj" }],
			defaultCwd: async () => "/default",
			runAgent: a.runAgent,
			now: () => new Date(0),
			changed: () => {},
			log: () => {},
		});
		return { engine, a, saved: () => saved };
	}
	const body = () => ({ name: "demo", description: "", workspaceId: "w1", nodes: [node("start", "start"), node("a", "agent")], edges: [edge("start", "a")] });

	it("creates, runs, records and duplicates", async () => {
		const h = harness();
		await h.engine.start();
		const flow = await h.engine.create(body());
		const { done } = await h.engine.startRun(flow.id, "in", "parent1");
		const r = await done;
		expect(r.status).toBe("success");
		expect(h.a.calls[0]!.parentSessionId).toBe("parent1");
		expect(h.saved().runs[0]?.status).toBe("success");
		expect((await h.engine.duplicate(flow.id)).name).toBe("demo 副本");
		await expect(h.engine.create({ ...body(), workspaceId: "nope" })).rejects.toThrow(/工作区/);
		await h.engine.stop();
	});

	it("generates a draft from the agent reply without saving it", async () => {
		const h = harness(() => '```json\n{"name":"G","nodes":[{"id":"a","kind":"agent","title":"A","prompt":"p"}],"edges":[]}\n```');
		await h.engine.start();
		const draft = await h.engine.generate("做点事", "w1");
		expect(draft.nodes.map((n) => n.kind)).toEqual(["start", "agent"]);
		expect(draft.workspaceId).toBe("w1");
		expect(h.engine.snapshot().flows).toHaveLength(0);
		expect(h.a.calls[0]!.access).toBe("readonly");
		await h.engine.stop();
	});

	it("marks runs cut short by a shutdown", async () => {
		const stale = { id: "old", flowId: "f", flowName: "demo", input: "", startedAt: "", status: "running" as const, nodes: { a: { status: "running" as const } } };
		const h = harness(() => "out", { flows: [], runs: [stale] });
		await h.engine.start();
		expect(h.saved().runs[0]).toMatchObject({ status: "error", error: "应用关闭时中断" });
		expect(h.saved().runs[0]!.nodes.a?.status).toBe("skipped");
		await h.engine.stop();
	});
});

describe("flowIssues", () => {
	it("ties problems to the node that has them", () => {
		const nodes = [node("start", "start"), node("a", "agent", { prompt: "" }), node("c", "condition", { mode: "ai", prompt: "q" })];
		const issues = flowIssues({ name: "x", nodes, edges: [edge("start", "a"), edge("a", "c")] });
		expect(issues.find((i) => i.message.includes("没有填写指令"))?.nodeId).toBe("a");
		expect(issues.find((i) => i.message.includes("还没有连出"))?.nodeId).toBe("c");
	});
});

describe("templates", () => {
	it("a step whose prompt runs commands is given full access", () => {
		for (const lang of ["zh", "en"] as const)
			for (const step of FLOW_TEMPLATES.find((x) => x.id === "bug")!.build(lang).nodes)
				if (step.kind === "agent" && /测试|tests/.test(step.prompt ?? "")) expect(step.access, `${lang}/${step.title}`).toBe("full");
	});

	for (const tpl of FLOW_TEMPLATES)
		for (const lang of ["zh", "en"] as const)
			it(`${tpl.id} (${lang}) is a valid, runnable flow`, async () => {
				const f = tpl.build(lang);
				expect(flowIssues(f)).toEqual([]);
				const a = agent((o) => (o.prompt.includes("YES 或 NO") ? "YES" : "PASS ok"));
				const r = await run(flowOf(f.nodes, f.edges), "input", a);
				expect(r.status).toBe("success");
				expect(r.output).toBeTruthy();
			});
});

describe("scheduled flows", () => {
	it("runs a due flow once and moves nextRunAt forward", async () => {
		let clock = new Date(2026, 0, 1, 8, 59, 0);
		let saved: FlowState = { flows: [], runs: [] };
		const a = agent(() => "out");
		const engine = new FlowEngine({
			load: async () => structuredClone(saved),
			save: async (s) => void (saved = s),
			workspaces: async () => [{ id: "w1", name: "p", path: "/proj" }],
			defaultCwd: async () => "/default",
			runAgent: a.runAgent,
			now: () => clock,
			changed: () => {},
			log: () => {},
		});
		await engine.start();
		const body = { name: "daily", description: "", workspaceId: "w1", nodes: [node("start", "start"), node("a", "agent")], edges: [edge("start", "a")], schedule: { type: "daily" as const, time: "09:00" }, scheduleEnabled: true, scheduleInput: "hi" };
		const flow = await engine.create(body);
		expect(flow.nextRunAt).toBe(new Date(2026, 0, 1, 9, 0).toISOString());
		await engine.tick();
		expect(a.calls).toHaveLength(0);
		clock = new Date(2026, 0, 1, 9, 0, 5);
		await engine.tick();
		await engine.tick();
		await new Promise((r) => setTimeout(r, 20));
		expect(a.calls).toHaveLength(1);
		expect(a.calls[0]!.prompt).toContain("do a");
		expect(engine.snapshot().runs[0]).toMatchObject({ trigger: "schedule", input: "hi" });
		expect(engine.snapshot().flows[0]!.nextRunAt).toBe(new Date(2026, 0, 2, 9, 0).toISOString());
		await engine.update(flow.id, { ...body, scheduleEnabled: false });
		expect(engine.snapshot().flows[0]!.nextRunAt).toBeUndefined();
		await engine.stop();
	});
	it("rejects a bad schedule", async () => {
		const h = { name: "x", description: "", workspaceId: "w1", nodes: [node("start", "start"), node("a", "agent")], edges: [edge("start", "a")], schedule: { type: "interval" as const, minutes: 1 }, scheduleEnabled: true };
		const engine = new FlowEngine({ load: async () => ({ flows: [], runs: [] }), save: async () => {}, workspaces: async () => [{ id: "w1", name: "p", path: "/p" }],
		defaultCwd: async () => "/default", runAgent: agent(() => "x").runAgent, now: () => new Date(), changed: () => {}, log: () => {} });
		await engine.start();
		await expect(engine.create(h)).rejects.toThrow(/间隔/);
		await engine.stop();
	});
});

describe("subflows", () => {
	function harness(reply: (o: AgentRunOptions) => string = (o) => `out:${o.prompt.slice(0, 20)}`) {
		let saved: FlowState = { flows: [], runs: [] };
		const a = agent(reply);
		const engine = new FlowEngine({
			load: async () => structuredClone(saved),
			save: async (s) => void (saved = s),
			workspaces: async () => [{ id: "w1", name: "p", path: "/proj" }],
			defaultCwd: async () => "/default",
			runAgent: a.runAgent,
			now: () => new Date(0),
			changed: () => {},
			log: () => {},
		});
		return { engine, a, saved: () => saved };
	}
	const inner = (name = "inner") => ({ name, description: "", workspaceId: "w1", nodes: [node("start", "start"), node("x", "agent", { prompt: "inner work {{input}}" })], edges: [edge("start", "x")] });
	const outer = (flowId: string, name = "outer", extra: Partial<FlowNode> = {}) => ({
		name,
		description: "",
		workspaceId: "w1",
		nodes: [node("start", "start"), node("a", "agent", { prompt: "first" }), node("sub", "subflow", { flowId, ...extra }), node("z", "agent", { prompt: "last {{sub}}" })],
		edges: [edge("start", "a"), edge("a", "sub"), edge("sub", "z")],
	});

	it("runs another flow as a step, passes its output on and records the child run", async () => {
		const h = harness();
		await h.engine.start();
		const child = await h.engine.create(inner());
		const parent = await h.engine.create(outer(child.id, "outer", { prompt: "go {{prev}}" }));
		const { done } = await h.engine.startRun(parent.id, "in");
		const r = await done;
		expect(r.status).toBe("success");
		const childRun = h.engine.snapshot().runs.find((x) => x.parentRunId === r.id)!;
		expect(childRun).toMatchObject({ flowId: child.id, status: "success", trigger: "subflow" });
		expect(r.nodes.sub?.childRunId).toBe(childRun.id);
		expect(h.a.calls.some((c) => c.prompt.startsWith("inner work go out:first"))).toBe(true);
		expect(h.a.calls.at(-1)!.prompt).toContain("last out:inner work");
		expect(r.nodes.sub?.output).toContain("out:inner work");
		await h.engine.stop();
	});

	it("rejects loops, self calls and deleting a flow that is used", async () => {
		const h = harness();
		await h.engine.start();
		const b = await h.engine.create(inner("b"));
		const a = await h.engine.create(outer(b.id, "a"));
		await expect(h.engine.update(b.id, { ...inner("b"), nodes: [node("start", "start"), node("c", "subflow", { flowId: a.id })], edges: [edge("start", "c")] })).rejects.toThrow(/循环/);
		await expect(h.engine.update(a.id, outer(a.id, "a"))).rejects.toThrow(/自己/);
		await expect(h.engine.remove(b.id)).rejects.toThrow(/引用/);
		await h.engine.stop();
	});

	it("a failing child fails the parent step", async () => {
		const h = harness((o) => (o.prompt.startsWith("inner") ? (new Error("boom") as never) : "ok"));
		await h.engine.start();
		const child = await h.engine.create(inner());
		const parent = await h.engine.create(outer(child.id));
		const r = await (await h.engine.startRun(parent.id, "")).done;
		expect(r.status).toBe("error");
		expect(r.error).toContain("boom");
		expect(r.nodes.z?.status).toBe("skipped");
		await h.engine.stop();
	});

	it("stopping the parent stops the child", async () => {
		let release!: () => void;
		const gate = new Promise<void>((res) => (release = res));
		const h = harness();
		const slow = new FlowEngine({
			load: async () => ({ flows: [], runs: [] }),
			save: async () => {},
			workspaces: async () => [{ id: "w1", name: "p", path: "/proj" }],
			defaultCwd: async () => "/default",
			runAgent: async (o) => {
				if (o.prompt.startsWith("inner")) {
					await new Promise<void>((res) => (o.signal?.addEventListener("abort", () => res()), void gate.then(res)));
					return { sessionId: "s", status: o.signal?.aborted ? "aborted" : "success", access: o.access, text: "" };
				}
				return { sessionId: "s", status: "success", access: o.access, text: "ok" };
			},
			now: () => new Date(0),
			changed: () => {},
			log: () => {},
		});
		void h;
		await slow.start();
		const child = await slow.create(inner());
		const parent = await slow.create(outer(child.id));
		const { runId, done } = await slow.startRun(parent.id, "");
		await new Promise((r) => setTimeout(r, 30));
		slow.cancel(runId);
		const r = await done;
		release();
		expect(r.status).toBe("cancelled");
		expect(slow.snapshot().runs.find((x) => x.parentRunId === runId)?.status).toBe("cancelled");
		await slow.stop();
	});

	it("flowIssues needs a target and counts a subflow as a step", () => {
		const f = { name: "x", nodes: [node("start", "start"), node("s", "subflow")], edges: [edge("start", "s")] };
		expect(flowIssues(f).map((i) => i.message).join("|")).toMatch(/还没有选择/);
		expect(flowIssues({ ...f, nodes: [node("start", "start"), node("s", "subflow", { flowId: "q" })] }, { selfId: "me", flows: [] }).map((i) => i.message).join("|")).toMatch(/已被删除/);
	});
});

describe("flows without a project", () => {
	it("can be saved and run with no workspace, in the default folder", async () => {
		const a = agent(() => "ok");
		const engine = new FlowEngine({ load: async () => ({ flows: [], runs: [] }), save: async () => {}, workspaces: async () => [], defaultCwd: async () => "/default", runAgent: a.runAgent, now: () => new Date(0), changed: () => {}, log: () => {} });
		await engine.start();
		const f = await engine.create({ name: "free", description: "", workspaceId: "", nodes: [node("start", "start"), node("a", "agent")], edges: [edge("start", "a")] });
		const r = await (await engine.startRun(f.id, "")).done;
		expect(r.status).toBe("success");
		expect(a.calls[0]!.cwd).toBe("/default");
		await engine.stop();
	});
});

describe("where flows run", () => {
	function setup() {
		const a = agent(() => "ok");
		const spaces = [{ id: "wa", name: "A", path: "/a" }, { id: "wb", name: "B", path: "/b" }];
		const engine = new FlowEngine({ load: async () => ({ flows: [], runs: [] }), save: async () => {}, workspaces: async () => spaces, defaultCwd: async () => "/home", runAgent: a.runAgent, now: () => new Date(0), changed: () => {}, log: () => {} });
		return { a, engine };
	}
	const body = (workspaceId: string) => ({ name: "f" + workspaceId, description: "", workspaceId, nodes: [node("start", "start"), node("x", "agent")], edges: [edge("start", "x")] });

	it("a general flow works wherever it is called from, and the run says where", async () => {
		const { a, engine } = setup();
		await engine.start();
		const f = await engine.create(body(""));
		const r1 = await (await engine.startRun(f.id, "", undefined, "manual", { workspaceId: "wb" })).done;
		expect(a.calls.at(-1)!.cwd).toBe("/b");
		expect(r1.location).toMatchObject({ name: "B", workspaceId: "wb" });
		const r2 = await (await engine.startRun(f.id, "", "s1", "agent", { cwd: "/a" })).done;
		expect(a.calls.at(-1)!.cwd).toBe("/a");
		expect(r2.location?.name).toBe("A");
		const r3 = await (await engine.startRun(f.id, "", undefined, "manual", { workspaceId: "" })).done;
		expect(a.calls.at(-1)!.cwd).toBe("/home");
		expect(r3.location).toMatchObject({ personal: true });
		const r4 = await (await engine.startRun(f.id, "")).done;
		expect(r4.location?.personal).toBe(true);
		await engine.stop();
	});

	it("a project flow only runs in its project and refuses other places", async () => {
		const { a, engine } = setup();
		await engine.start();
		const f = await engine.create(body("wa"));
		await (await engine.startRun(f.id, "", undefined, "manual")).done;
		expect(a.calls.at(-1)!.cwd).toBe("/a");
		await (await engine.startRun(f.id, "", "s", "agent", { cwd: "/a" })).done;
		await expect(engine.startRun(f.id, "", "s", "agent", { cwd: "/b" })).rejects.toThrow(/专属/);
		await expect(engine.startRun(f.id, "", undefined, "manual", { workspaceId: "" })).rejects.toThrow(/专属/);
		await engine.stop();
	});

	it("a general subflow follows its parent; a project subflow keeps to its project", async () => {
		const { a, engine } = setup();
		await engine.start();
		const general = await engine.create(body(""));
		const bound = await engine.create({ ...body("wa"), name: "bound" });
		const parent = await engine.create({
			name: "parent",
			description: "",
			workspaceId: "",
			nodes: [node("start", "start"), node("g", "subflow", { flowId: general.id }), node("p", "subflow", { flowId: bound.id })],
			edges: [edge("start", "g"), edge("g", "p")],
		});
		const r = await (await engine.startRun(parent.id, "", undefined, "manual", { workspaceId: "wb" })).done;
		expect(r.status).toBe("success");
		const cwds = a.calls.map((c) => c.cwd);
		expect(cwds).toEqual(["/b", "/a"]);
		const runs = engine.snapshot().runs;
		expect(runs.find((x) => x.flowId === general.id)?.location?.name).toBe("B");
		expect(runs.find((x) => x.flowId === bound.id)?.location?.name).toBe("A");
		await engine.stop();
	});

	it("schedules a general flow in the chosen place", async () => {
		const { a, engine } = setup();
		let clock = new Date(2026, 0, 1, 8, 59);
		void clock;
		await engine.start();
		const f = await engine.create({ ...body(""), schedule: { type: "interval", minutes: 5 }, scheduleEnabled: true, scheduleWorkspaceId: "wb" });
		expect(f.scheduleWorkspaceId).toBe("wb");
		await expect(engine.create({ ...body(""), scheduleWorkspaceId: "zzz", schedule: { type: "interval", minutes: 5 }, scheduleEnabled: true })).rejects.toThrow(/定时运行位置/);
		void a;
		await engine.stop();
	});
});

