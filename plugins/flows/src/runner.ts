import type { AgentRunOptions, AgentRunResult } from "@prometheus/plugin-sdk";
import { flowSccs, isFlowLoopBack, MAX_FLOW_LOOPS } from "@prometheus/protocol";
import type { Flow, FlowEdge, FlowNode, FlowNodeRun, FlowNodeVisit, FlowResumeAction, FlowRun, RunAccess } from "@prometheus/protocol";

export interface RunnerDeps {
	runAgent(options: AgentRunOptions): Promise<AgentRunResult>;
	now(): Date;
	/** Called whenever the run record changed, so it can be saved and pushed to clients. */
	update(run: FlowRun): void;
	/** Where the agent steps work. */
	cwd: string;
	trigger?: FlowRun["trigger"];
	parentRunId?: string;
	location?: FlowRun["location"];
	/** Set when the user asked for one access level for the whole run; it replaces each step's own access. */
	accessOverride?: RunAccess;
	/** Runs another flow to completion for a subflow node. `onStart` gets the child run id as soon as it exists. */
	runChild?(flowId: string, input: string, onStart: (childRunId: string) => void): Promise<FlowRun>;
}

export interface ResumeOpts {
	run: FlowRun;
	action: FlowResumeAction;
}

const MAX_PARALLEL = 3;
const OUTPUT_CHARS = 6000;

/** Fills {{input}}, {{prev}} and {{<nodeId>}}; unknown names are left as written. */
export function fillTemplate(text: string, vars: Record<string, string>): string {
	return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name: string) => (name in vars ? (vars[name] ?? "") : whole));
}

/** Decides a condition from the upstream text. `ai` is handled by the runner, which has to ask the agent. */
export function checkText(mode: "contains" | "regex", match: string, text: string): boolean {
	if (mode === "regex") return new RegExp(match, "i").test(text);
	return text.toLowerCase().includes(match.toLowerCase());
}

function sccMembers(nodes: FlowNode[], edges: FlowEdge[], id: string): Set<string> {
	for (const scc of flowSccs(nodes, edges)) if (scc.includes(id)) return new Set(scc);
	return new Set([id]);
}

function snapshotVisit(state: FlowNodeRun): FlowNodeVisit | undefined {
	if (state.status !== "success" && state.status !== "error") return undefined;
	return {
		status: state.status,
		...(state.startedAt ? { startedAt: state.startedAt } : {}),
		...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
		...(state.sessionId ? { sessionId: state.sessionId } : {}),
		...(state.output ? { output: state.output } : {}),
		...(state.error ? { error: state.error } : {}),
		...(state.branch !== undefined ? { branch: state.branch } : {}),
	};
}

function archiveAndPend(state: FlowNodeRun): void {
	const snap = snapshotVisit(state);
	if (snap) state.history = [...(state.history ?? []), snap];
	state.status = "pending";
	delete state.startedAt;
	delete state.finishedAt;
	delete state.sessionId;
	delete state.childRunId;
	delete state.output;
	delete state.error;
	delete state.blocked;
	delete state.branch;
}

function endpointState(edge: FlowEdge, byId: Map<string, FlowNode>, runs: Record<string, FlowNodeRun>, taken: Map<string, boolean>): "live" | "dead" | "waiting" {
	const src = runs[edge.from];
	if (!src || src.status === "pending" || src.status === "running") return "waiting";
	if (src.status === "error") return "dead";
	if (byId.get(edge.from)?.kind === "condition") {
		const ans = taken.has(edge.from) ? taken.get(edge.from) : src.branch;
		return String(ans) === edge.branch ? "live" : "dead";
	}
	// A node the user skipped after it failed still has startedAt: treat it as live so the rest can continue.
	if (src.status === "skipped") return src.startedAt ? "live" : "dead";
	return "live";
}

function applyResume(run: FlowRun, action: FlowResumeAction): void {
	for (const state of Object.values(run.nodes)) {
		if (action === "retry" && state.status === "error") archiveAndPend(state);
		else if (action === "skip" && state.status === "error") {
			state.status = "skipped";
			// A skipped condition with no answer takes the "no" branch so the flow has an exit.
			if (state.branch === undefined) state.branch = false;
		} else if (state.status === "skipped") {
			state.status = "pending";
			delete state.finishedAt;
		}
	}
	run.status = "running";
	delete run.finishedAt;
	delete run.error;
	delete run.output;
	delete run.warning;
}

function finishRun(flow: Flow, run: FlowRun, signal: AbortSignal, emit: () => void): FlowRun {
	for (const state of Object.values(run.nodes)) if (state.status === "pending") state.status = "skipped";
	if (signal.aborted) {
		run.status = "cancelled";
		run.error ??= "已取消";
	} else if (run.error) run.status = "error";
	else {
		run.status = "success";
		const outputOf = (id: string) => run.nodes[id]?.output ?? "";
		const ends = flow.nodes.filter((n) => n.kind === "end" && run.nodes[n.id]?.status === "success");
		const sinks = flow.nodes.filter((n) => run.nodes[n.id]?.status === "success" && !flow.edges.some((e) => e.from === n.id && run.nodes[e.to]?.status === "success"));
		const finals = ends.length ? ends : sinks.filter((n) => n.kind !== "start");
		run.output = finals.map((n) => outputOf(n.id)).filter(Boolean).join("\n\n---\n\n") || undefined;
	}
	const refused = flow.nodes.filter((n) => run.nodes[n.id]?.blocked?.length);
	if (refused.length) run.warning = `以下步骤有调用因权限不足被拒绝：${refused.map((n) => `${n.title}（${run.nodes[n.id]!.blocked!.length} 次）`).join("、")}。在这些步骤里把权限调高后重试。`;
	emit();
	return run;
}

/**
 * Walks the graph: a node runs once every *forward* incoming edge is settled and at least one is live.
 * A condition that takes a back-edge resets its strongly-connected component so the loop body runs again
 * (capped at MAX_FLOW_LOOPS). Independent branches run in parallel (up to MAX_PARALLEL agents at once).
 * A failing step stops the run; the same record can later be resumed (retry the failed node, or skip it).
 */
export async function runFlow(flow: Flow, input: string, runId: string, deps: RunnerDeps, signal: AbortSignal, resume?: ResumeOpts): Promise<FlowRun> {
	const byId = new Map(flow.nodes.map((n) => [n.id, n]));
	const startId = flow.nodes.find((n) => n.kind === "start")?.id ?? flow.nodes[0]!.id;
	const loopBack = (from: string, to: string) => isFlowLoopBack(startId, flow.edges, from, to);

	const run: FlowRun = resume
		? resume.run
		: {
				id: runId,
				flowId: flow.id,
				flowName: flow.name,
				input,
				startedAt: deps.now().toISOString(),
				status: "running",
				...(deps.trigger ? { trigger: deps.trigger } : {}),
				...(deps.parentRunId ? { parentRunId: deps.parentRunId } : {}),
				...(deps.location ? { location: deps.location } : {}),
				...(deps.accessOverride ? { accessOverride: deps.accessOverride } : {}),
				graph: { nodes: structuredClone(flow.nodes), edges: structuredClone(flow.edges) },
				nodes: Object.fromEntries(flow.nodes.map((n) => [n.id, { status: "pending" } satisfies FlowNodeRun])),
			};
	if (resume) applyResume(run, resume.action);

	const taken = new Map<string, boolean>();
	for (const [id, state] of Object.entries(run.nodes)) {
		if (byId.get(id)?.kind === "condition" && state.branch !== undefined) taken.set(id, state.branch);
	}
	const emit = () => deps.update(run);
	emit();

	const outputOf = (id: string) => run.nodes[id]?.output ?? "";
	const usable = (id: string) => {
		const s = run.nodes[id];
		return Boolean(s && (s.status === "success" || (s.status === "skipped" && s.startedAt)));
	};
	const upstream = (node: FlowNode) =>
		flow.edges
			.filter((e) => e.to === node.id && usable(e.from) && endpointState(e, byId, run.nodes, taken) === "live")
			.map((e) => e.from);

	const forwardIncoming = (node: FlowNode) => flow.edges.filter((e) => e.to === node.id && !loopBack(e.from, e.to));

	const execute = async (node: FlowNode): Promise<void> => {
		await Promise.resolve();
		const state = run.nodes[node.id]!;
		state.status = "running";
		state.startedAt = deps.now().toISOString();
		emit();
		const ups = upstream(node);
		const prev = ups.map((id) => (ups.length > 1 ? `【${byId.get(id)?.title ?? id}】\n${outputOf(id)}` : outputOf(id))).join("\n\n");
		const vars: Record<string, string> = { input, prev };
		for (const n of flow.nodes) vars[n.id] = outputOf(n.id);
		try {
			if (node.kind === "start") {
				state.output = input;
			} else if (node.kind === "end") {
				state.output = prev;
			} else if (node.kind === "subflow") {
				if (!deps.runChild) throw new Error("这里不能运行子流程");
				const childInput = node.prompt?.trim() ? fillTemplate(node.prompt, vars) : prev;
				const child = await deps.runChild(node.flowId ?? "", childInput, (id) => {
					state.childRunId = id;
					emit();
				});
				state.childRunId = child.id;
				if (child.status !== "success") throw new Error(child.error ?? (child.status === "cancelled" ? "已取消" : "子流程失败"));
				state.output = (child.output ?? "").slice(0, OUTPUT_CHARS);
			} else if (node.kind === "agent") {
				const raw = node.prompt ?? "";
				const onlyStart = ups.every((id) => byId.get(id)?.kind === "start");
				const needsContext = prev && !/\{\{\s*(?!input\b)[\w.-]+\s*\}\}/.test(raw) && !(onlyStart && /\{\{\s*input\s*\}\}/.test(raw));
				const prompt = fillTemplate(raw, vars) + (needsContext ? `\n\n以下是上游步骤的输出：\n${prev}` : "");
				const res = await deps.runAgent({
					cwd: deps.cwd,
					prompt,
					name: `⛓ ${flow.name} · ${node.title}`,
					access: deps.accessOverride ?? node.access ?? "readonly",
					model: node.model,
					signal,
					onStart: (sessionId) => {
						state.sessionId = sessionId;
						emit();
					},
				});
				state.sessionId = res.sessionId;
				if (res.blocked?.length) state.blocked = res.blocked;
				if (res.status !== "success") throw new Error(res.error ?? (res.status === "aborted" ? "已取消" : "运行失败"));
				state.output = res.text.slice(0, OUTPUT_CHARS);
			} else {
				const mode = node.mode ?? "contains";
				let answer: boolean;
				if (mode === "ai") {
					const res = await deps.runAgent({
						cwd: deps.cwd,
						prompt: `${fillTemplate(node.prompt ?? "", vars)}\n\n待判断的内容：\n${prev}\n\n只回答 YES 或 NO。`,
						name: `⛓ ${flow.name} · ${node.title}`,
						access: "readonly",
						signal,
						onStart: (sessionId) => {
							state.sessionId = sessionId;
							emit();
						},
					});
					if (res.status !== "success") throw new Error(res.error ?? "判断失败");
					state.sessionId = res.sessionId;
					if (res.blocked?.length) state.blocked = res.blocked;
					answer = /^\W*(yes|是|true|对)/i.test(res.text.trim());
				} else answer = checkText(mode, node.match ?? "", prev);
				taken.set(node.id, answer);
				state.branch = answer;
				state.output = prev;
			}
			state.status = "success";
		} catch (err) {
			state.status = "error";
			state.error = err instanceof Error ? err.message : String(err);
			if (!run.error) run.error = `「${node.title}」${state.error}`;
		} finally {
			state.finishedAt = deps.now().toISOString();
			state.visits = (state.visits ?? 0) + 1;
			emit();
		}
	};

	const reviveSkipped = (id: string, seen = new Set<string>()): void => {
		if (seen.has(id)) return;
		seen.add(id);
		const state = run.nodes[id];
		if (!state || state.status !== "skipped") return;
		state.status = "pending";
		delete state.finishedAt;
		for (const e of flow.edges) if (e.from === id) reviveSkipped(e.to, seen);
	};

	const rewindLoop = (from: string, to: string): boolean => {
		const body = sccMembers(flow.nodes, flow.edges, from);
		if (!body.has(to)) body.add(to);
		for (const id of body) {
			if ((run.nodes[id]?.visits ?? 0) >= MAX_FLOW_LOOPS) {
				run.error = `循环次数超过 ${MAX_FLOW_LOOPS}，条件「${byId.get(from)?.title ?? from}」一直走回「${byId.get(to)?.title ?? to}」`;
				return false;
			}
		}
		for (const id of body) {
			if (id === startId) continue;
			const state = run.nodes[id];
			if (!state) continue;
			archiveAndPend(state);
			taken.delete(id);
		}
		run.loopCount = (run.loopCount ?? 0) + 1;
		return true;
	};

	const running = new Map<string, Promise<string>>();
	const launch = (node: FlowNode) => running.set(node.id, execute(node).then(() => node.id));

	const forwardStates = (node: FlowNode) => {
		const list = forwardIncoming(node);
		const edges = list.length ? list : flow.edges.filter((e) => e.to === node.id);
		return edges.map((e) => endpointState(e, byId, run.nodes, taken));
	};

	for (;;) {
		const failed = Boolean(run.error) || Object.values(run.nodes).some((n) => n.status === "error");
		if (!failed && !signal.aborted) {
			for (let changed = true; changed; ) {
				changed = false;
				for (const node of flow.nodes) {
					if (run.nodes[node.id]!.status !== "pending" || node.kind === "start") continue;
					const states = forwardStates(node);
					if (!states.includes("waiting") && !states.includes("live")) {
						run.nodes[node.id]!.status = "skipped";
						changed = true;
					}
				}
			}
			for (const node of flow.nodes) {
				if (running.size >= MAX_PARALLEL) break;
				if (run.nodes[node.id]!.status !== "pending" || running.has(node.id)) continue;
				if (node.kind !== "start") {
					const states = forwardStates(node);
					if (states.includes("waiting") || !states.includes("live")) continue;
				}
				run.nodes[node.id]!.status = "running";
				launch(node);
			}
			emit();
		}
		if (running.size === 0) break;
		const done = await Promise.race(running.values());
		running.delete(done);
		const doneState = run.nodes[done];
		if (doneState?.status === "success") {
			for (const e of flow.edges) {
				if (e.from !== done || endpointState(e, byId, run.nodes, taken) !== "live") continue;
				if (loopBack(e.from, e.to)) {
					const target = run.nodes[e.to];
					if (!target || target.status === "pending") continue;
					if (!rewindLoop(e.from, e.to)) break;
				} else {
					// Previous loop iterations skipped the exit branch; bring it back now that this branch is live.
					reviveSkipped(e.to);
				}
			}
		}
	}

	run.finishedAt = deps.now().toISOString();
	return finishRun(flow, run, signal, emit);
}
