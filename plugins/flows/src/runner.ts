import type { AgentRunOptions, AgentRunResult } from "@prometheus/plugin-sdk";
import type { Flow, FlowEdge, FlowNode, FlowNodeRun, FlowRun } from "@prometheus/protocol";

export interface RunnerDeps {
	runAgent(options: AgentRunOptions): Promise<AgentRunResult>;
	now(): Date;
	/** Called whenever the run record changed, so it can be saved and pushed to clients. */
	update(run: FlowRun): void;
	/** Where the agent steps work. */
	cwd: string;
	trigger?: FlowRun["trigger"];
	parentRunId?: string;
	/** Runs another flow to completion for a subflow node. `onStart` gets the child run id as soon as it exists. */
	runChild?(flowId: string, input: string, onStart: (childRunId: string) => void): Promise<FlowRun>;
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

function endpointState(edge: FlowEdge, byId: Map<string, FlowNode>, runs: Record<string, FlowNodeRun>, taken: Map<string, boolean>): "live" | "dead" | "waiting" {
	const src = runs[edge.from];
	if (!src || src.status === "pending" || src.status === "running") return "waiting";
	if (src.status !== "success") return "dead";
	if (byId.get(edge.from)?.kind === "condition") return String(taken.get(edge.from)) === edge.branch ? "live" : "dead";
	return "live";
}

/**
 * Walks the graph: a node runs once every incoming edge is settled and at least one is live; nodes on a branch that
 * was not taken are skipped. Independent branches run in parallel (up to MAX_PARALLEL agents at once). The first
 * failing step stops the run.
 */
export async function runFlow(flow: Flow, input: string, runId: string, deps: RunnerDeps, signal: AbortSignal): Promise<FlowRun> {
	const byId = new Map(flow.nodes.map((n) => [n.id, n]));
	const run: FlowRun = {
		id: runId,
		flowId: flow.id,
		flowName: flow.name,
		input,
		startedAt: deps.now().toISOString(),
		status: "running",
		...(deps.trigger ? { trigger: deps.trigger } : {}),
		...(deps.parentRunId ? { parentRunId: deps.parentRunId } : {}),
		nodes: Object.fromEntries(flow.nodes.map((n) => [n.id, { status: "pending" } satisfies FlowNodeRun])),
	};
	const taken = new Map<string, boolean>();
	const emit = () => deps.update(run);
	emit();

	const outputOf = (id: string) => run.nodes[id]?.output ?? "";
	const upstream = (node: FlowNode) =>
		flow.edges
			.filter((e) => e.to === node.id && run.nodes[e.from]?.status === "success" && endpointState(e, byId, run.nodes, taken) === "live")
			.map((e) => e.from);

	const execute = async (node: FlowNode): Promise<void> => {
		// Settle asynchronously even for trivial nodes, so the scheduler never sees a node finish mid-pass.
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
				// A prompt that never mentions the upstream result still needs it, or the step would work blind.
				const onlyStart = ups.every((id) => byId.get(id)?.kind === "start");
				const needsContext = prev && !/\{\{\s*(?!input\b)[\w.-]+\s*\}\}/.test(raw) && !(onlyStart && /\{\{\s*input\s*\}\}/.test(raw));
				const prompt = fillTemplate(raw, vars) + (needsContext ? `\n\n以下是上游步骤的输出：\n${prev}` : "");
				const res = await deps.runAgent({
					cwd: deps.cwd,
					prompt,
					name: `⛓ ${flow.name} · ${node.title}`,
					access: node.access ?? "readonly",
					model: node.model,
					signal,
					onStart: (sessionId) => {
						state.sessionId = sessionId;
						emit();
					},
				});
				state.sessionId = res.sessionId;
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
					answer = /^\W*(yes|是|true|对)/i.test(res.text.trim());
				} else answer = checkText(mode, node.match ?? "", prev);
				taken.set(node.id, answer);
				state.output = prev;
			}
			state.status = "success";
		} catch (err) {
			state.status = "error";
			state.error = err instanceof Error ? err.message : String(err);
			if (!run.error) run.error = `「${node.title}」${state.error}`;
		} finally {
			state.finishedAt = deps.now().toISOString();
			emit();
		}
	};

	const running = new Map<string, Promise<string>>();
	const launch = (node: FlowNode) => running.set(node.id, execute(node).then(() => node.id));

	const settled = (node: FlowNode) => flow.edges.filter((e) => e.to === node.id).map((e) => endpointState(e, byId, run.nodes, taken));

	for (;;) {
		const failed = Object.values(run.nodes).some((n) => n.status === "error");
		if (!failed && !signal.aborted) {
			// Skipping one node can settle the next, so repeat until nothing changes.
			for (let changed = true; changed; ) {
				changed = false;
				for (const node of flow.nodes) {
					if (run.nodes[node.id]!.status !== "pending" || node.kind === "start") continue;
					const states = settled(node);
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
					const states = settled(node);
					if (states.includes("waiting") || !states.includes("live")) continue; // not ready, or skipped on the next pass
				}
				run.nodes[node.id]!.status = "running";
				launch(node);
			}
			emit();
		}
		if (running.size === 0) break;
		const done = await Promise.race(running.values());
		running.delete(done);
	}

	for (const state of Object.values(run.nodes)) if (state.status === "pending") state.status = "skipped";
	run.finishedAt = deps.now().toISOString();
	if (signal.aborted) {
		run.status = "cancelled";
		run.error ??= "已取消";
	} else if (run.error) run.status = "error";
	else {
		run.status = "success";
		const ends = flow.nodes.filter((n) => n.kind === "end" && run.nodes[n.id]?.status === "success");
		const sinks = flow.nodes.filter((n) => run.nodes[n.id]?.status === "success" && !flow.edges.some((e) => e.from === n.id && run.nodes[e.to]?.status === "success"));
		const finals = ends.length ? ends : sinks.filter((n) => n.kind !== "start");
		run.output = finals.map((n) => outputOf(n.id)).filter(Boolean).join("\n\n---\n\n") || undefined;
	}
	emit();
	return run;
}
