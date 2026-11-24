import type { AgentRunOptions, AgentRunResult } from "@prometheus/plugin-sdk";
import { flowLoopBackIds, MAX_FLOW_LOOPS, MAX_FLOW_RETRIES } from "@prometheus/protocol";
import type { BlockedCall, Flow, FlowEdge, FlowNode, FlowNodeRun, FlowNodeVisit, FlowResumeAction, FlowRun, RunAccess } from "@prometheus/protocol";

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
	/** Pause before an automatic retry, multiplied by the attempt number. Default 3 s; tests pass 0. */
	retryDelayMs?: number;
}

export interface ResumeOpts {
	run: FlowRun;
	action: FlowResumeAction;
}

/** Agents of one run working at the same time. */
const MAX_PARALLEL = 3;
/** How much of a step's reply is kept and handed on. */
export const OUTPUT_CHARS = 20_000;
/** Step executions in one run, loops included: a guard against nested loops multiplying out. */
export const MAX_STEPS_PER_RUN = 200;
/** Automatic retries when a node does not say: an agent call fails for passing reasons (network, model) often enough to retry once. */
const DEFAULT_RETRIES: Partial<Record<FlowNode["kind"], number>> = { agent: 1, condition: 1, subflow: 0 };

const RETRY_PROMPT = "上一次运行中途出错中断了。请检查已经完成的部分，从中断处继续把原任务做完，最后给出完整的最终结果。";
const VERDICT_RETRY_PROMPT = "没能从你的回复里识别出结论。请只回复一行：结论：YES 或 结论：NO";

/** Fills {{input}}, {{prev}} and {{<nodeId>}}; unknown names are left as written. */
export function fillTemplate(text: string, vars: Record<string, string>): string {
	return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name: string) => (name in vars ? (vars[name] ?? "") : whole));
}

/** Decides a condition from the upstream text. `ai` is handled by the runner, which has to ask the agent. */
export function checkText(mode: "contains" | "regex", match: string, text: string): boolean {
	if (mode === "regex") return new RegExp(match, "i").test(text);
	return text.toLowerCase().includes(match.toLowerCase());
}

/**
 * Reads a yes/no verdict from an agent reply. Prefers an explicit 「结论：YES/NO」, then the last line, then a reply that
 * names only one of YES/NO. Anything else is undefined: a guess would silently send the flow down the wrong branch.
 */
export function parseVerdict(text: string): boolean | undefined {
	const word = (w: string) => /^(yes|是|对|true)$/i.test(w);
	const labelled = [...text.matchAll(/(?:结论|答案|verdict|answer)\s*[:：]\s*\**\s*(yes|no|是|否|对|不对|不是|true|false)(?![a-z])/gi)].pop();
	if (labelled) return word(labelled[1]!);
	const lines = text.split(/\r?\n/).map((l) => l.replace(/[*_`#>\s。.!！]+/g, " ").trim()).filter(Boolean);
	const last = lines.at(-1) ?? "";
	const bare = /^(yes|no|是|否|对|不对|不是|true|false)$/i.exec(last);
	if (bare) return word(bare[1]!);
	const yes = /\byes\b/i.test(text);
	const no = /\bno\b/i.test(text);
	if (yes !== no) return yes;
	return undefined;
}

function clip(text: string): string {
	return text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n\n[……输出过长，已截断为前 ${OUTPUT_CHARS} 字]` : text;
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

/** Puts a node back to pending, keeping what it did before in its history. */
function archiveAndPend(state: FlowNodeRun): void {
	const snap = snapshotVisit(state);
	if (snap) state.history = [...(state.history ?? []), snap];
	state.status = "pending";
	for (const key of ["startedAt", "finishedAt", "sessionId", "childRunId", "output", "error", "blocked", "branch", "attempts", "tolerated"] as const) delete state[key];
}

/** The static shape of a flow, worked out once per run. */
class Graph {
	readonly byId: Map<string, FlowNode>;
	readonly startId: string;
	/** Edges that close a loop (the condition's way back). Everything else is a forward edge. */
	readonly back: Set<string>;
	private readonly out = new Map<string, FlowEdge[]>();
	private readonly inForward = new Map<string, FlowEdge[]>();
	private readonly flow: Flow;

	constructor(flow: Flow) {
		this.flow = flow;
		this.byId = new Map(flow.nodes.map((n) => [n.id, n]));
		this.startId = flow.nodes.find((n) => n.kind === "start")?.id ?? flow.nodes[0]!.id;
		this.back = flowLoopBackIds(flow.nodes, flow.edges);
		for (const n of flow.nodes) {
			this.out.set(n.id, []);
			this.inForward.set(n.id, []);
		}
		for (const e of flow.edges) {
			this.out.get(e.from)?.push(e);
			if (!this.back.has(e.id)) this.inForward.get(e.to)?.push(e);
		}
		// A node reached only through back edges (unusual drawing) still needs inputs to wait on.
		for (const n of flow.nodes) if (!this.inForward.get(n.id)!.length) this.inForward.set(n.id, flow.edges.filter((e) => e.to === n.id));
	}

	outgoing(id: string): FlowEdge[] {
		return this.out.get(id) ?? [];
	}
	inputs(id: string): FlowEdge[] {
		return this.inForward.get(id) ?? [];
	}

	private reach(from: Iterable<string>, dir: "down" | "up"): Set<string> {
		const seen = new Set(from);
		const stack = [...seen];
		while (stack.length) {
			const id = stack.pop()!;
			for (const e of this.flow.edges) {
				if (this.back.has(e.id)) continue;
				const [a, b] = dir === "down" ? [e.from, e.to] : [e.to, e.from];
				if (a === id && !seen.has(b)) (seen.add(b), stack.push(b));
			}
		}
		return seen;
	}

	/**
	 * The nodes a back edge repeats: those on a forward path from its target to its source. Only forward edges count,
	 * so an inner loop repeats just its own body, not the outer loop that contains it.
	 */
	loopBody(edge: FlowEdge): Set<string> {
		const down = this.reach([edge.to], "down");
		const up = this.reach([edge.from], "up");
		const body = new Set([...down].filter((id) => up.has(id)));
		body.add(edge.to);
		body.add(edge.from);
		return body;
	}

	/** Everything downstream of `ids` along forward edges, `ids` included. */
	downstream(ids: Set<string>): Set<string> {
		return this.reach(ids, "down");
	}
}

/** What one execution of a node produced; it is applied to the run record only if the node was not reset meanwhile. */
type Outcome = { ok: true; output: string; branch?: boolean } | { ok: false; error: string };

function applyResume(run: FlowRun, action: FlowResumeAction): void {
	for (const state of Object.values(run.nodes)) {
		if (state.status === "error" && !state.tolerated) {
			if (action === "retry") archiveAndPend(state);
			else {
				// Skipped after it ran: downstream may use it. A condition with no answer takes the "no" branch so the flow has an exit.
				state.status = "skipped";
				if (state.branch === undefined) state.branch = false;
			}
		} else if (state.status === "skipped" && !state.startedAt) {
			state.status = "pending";
			delete state.finishedAt;
		} else if (state.status === "running") archiveAndPend(state);
	}
	run.status = "running";
	for (const key of ["finishedAt", "error", "output", "warning"] as const) delete run[key];
}

/**
 * Runs a flow as a small dataflow machine.
 *
 * - Every forward edge carries a signal derived from its source: waiting (not finished), live, or dead
 *   (a condition took the other branch, or the source was skipped). A node runs once none of its forward inputs is
 *   waiting and at least one is live; when all are dead it is skipped, and that skip flows on downstream.
 * - A live back edge repeats a loop: the nodes on the forward path from its target to its source, plus everything
 *   downstream of them, go back to pending (their earlier visits kept in history). Nodes still running there are
 *   aborted and their late results ignored. Each back edge may fire MAX_FLOW_LOOPS times per pass of its enclosing loop.
 * - Steps retry by themselves on failure (agent steps continue in the same chat), may have a timeout, and may be set to
 *   let the flow go on when they fail. A failure that stops the flow lets running siblings finish, then ends the run;
 *   the record can be resumed later (retry the failed step, or skip it).
 */
export async function runFlow(flow: Flow, input: string, runId: string, deps: RunnerDeps, signal: AbortSignal, resume?: ResumeOpts): Promise<FlowRun> {
	const g = new Graph(flow);
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
	for (const n of flow.nodes) run.nodes[n.id] ??= { status: "pending" };

	const emit = () => deps.update(run);
	const retryDelay = deps.retryDelayMs ?? 3000;
	const st = (id: string) => run.nodes[id]!;
	const outputOf = (id: string) => run.nodes[id]?.output ?? "";

	/** Bumped whenever a node starts or is reset, so a result from an older execution is recognised and dropped. */
	const gens = new Map<string, number>();
	const inflight = new Map<string, { gen: number; ctl: AbortController; done: Promise<void> }>();
	const loops = new Map<string, number>();
	let steps = 0;
	let halted = false;

	const fail = (message: string) => {
		run.error ??= message;
		halted = true;
	};

	const edgeSignal = (e: FlowEdge): "live" | "dead" | "waiting" => {
		const s = run.nodes[e.from];
		if (!s || s.status === "pending" || s.status === "running") return "waiting";
		if (s.status === "error" && !s.tolerated) return "dead";
		if (s.status === "skipped" && !s.startedAt) return "dead";
		if (g.byId.get(e.from)?.kind === "condition") return s.branch !== undefined && String(s.branch) === e.branch ? "live" : "dead";
		return "live";
	};

	const readiness = (node: FlowNode): "ready" | "waiting" | "dead" => {
		if (node.id === g.startId) return "ready";
		const signals = g.inputs(node.id).map(edgeSignal);
		if (signals.includes("waiting")) return "waiting";
		return signals.includes("live") ? "ready" : "dead";
	};

	/** Upstream nodes whose output feeds this node now. */
	const upstream = (node: FlowNode) => g.inputs(node.id).filter((e) => edgeSignal(e) === "live").map((e) => e.from);

	const sleep = (ms: number, s: AbortSignal) =>
		new Promise<void>((res) => {
			if (ms <= 0 || s.aborted) return res();
			const t = setTimeout(res, ms);
			s.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
		});

	/** One agent call with automatic retries. A retry continues the same chat, so work already done is not repeated. */
	const callAgent = async (
		node: FlowNode,
		gen: number,
		s: AbortSignal,
		opts: Pick<AgentRunOptions, "prompt" | "access" | "model" | "timeoutMs">,
		accept: (res: AgentRunResult) => string | undefined,
		retryPrompt: string,
	): Promise<{ res: AgentRunResult; value?: string; error?: string }> => {
		const state = st(node.id);
		const max = 1 + Math.max(0, Math.min(MAX_FLOW_RETRIES, node.retries ?? DEFAULT_RETRIES[node.kind] ?? 0));
		const blocked: BlockedCall[] = [];
		let session: string | undefined;
		let last: { res: AgentRunResult; error: string } | undefined;
		for (let attempt = 1; attempt <= max; attempt++) {
			if (attempt > 1) {
				await sleep(retryDelay * (attempt - 1), s);
				if (s.aborted) break;
			}
			if (gens.get(node.id) === gen) {
				state.attempts = attempt;
				if (attempt > 1) emit();
			}
			const res = await deps.runAgent({
				cwd: deps.cwd,
				name: `⛓ ${flow.name} · ${node.title}`,
				...opts,
				...(attempt > 1 && session ? { prompt: retryPrompt, sessionId: session } : {}),
				signal: s,
				onStart: (sessionId) => {
					if (gens.get(node.id) !== gen) return;
					state.sessionId = sessionId;
					emit();
				},
			});
			if (res.sessionId) session = res.sessionId;
			if (res.blocked?.length) blocked.push(...res.blocked);
			res.blocked = blocked.length ? blocked : undefined;
			if (res.status === "success") {
				const value = accept(res);
				if (value !== undefined) return { res, value };
				last = { res, error: `回复里没有可识别的结论：${res.text.trim().slice(0, 80) || "（空）"}` };
			} else {
				last = { res, error: res.error ?? (res.status === "aborted" ? "已取消" : "运行失败") };
				if (res.status === "aborted" || s.aborted) break;
			}
		}
		return { res: last!.res, error: s.aborted ? "已取消" : last!.error };
	};

	const execute = async (node: FlowNode, gen: number, s: AbortSignal): Promise<Outcome> => {
		const state = st(node.id);
		const ups = upstream(node);
		const prev = ups.map((id) => (ups.length > 1 ? `【${g.byId.get(id)?.title ?? id}】\n${outputOf(id)}` : outputOf(id))).join("\n\n");
		const vars: Record<string, string> = { input, prev };
		for (const n of flow.nodes) vars[n.id] = outputOf(n.id);
		const timeoutMs = node.timeoutMin ? node.timeoutMin * 60_000 : undefined;
		const record = (res: AgentRunResult) => {
			if (gens.get(node.id) !== gen) return;
			if (res.sessionId) state.sessionId = res.sessionId;
			if (res.blocked?.length) state.blocked = res.blocked;
		};

		if (node.kind === "start") return { ok: true, output: input };
		if (node.kind === "end") return { ok: true, output: prev };
		if (node.kind === "subflow") {
			if (!deps.runChild) return { ok: false, error: "这里不能运行子流程" };
			const childInput = node.prompt?.trim() ? fillTemplate(node.prompt, vars) : prev;
			const max = 1 + Math.max(0, Math.min(MAX_FLOW_RETRIES, node.retries ?? DEFAULT_RETRIES.subflow ?? 0));
			let error = "子流程失败";
			for (let attempt = 1; attempt <= max && !s.aborted; attempt++) {
				if (attempt > 1) await sleep(retryDelay * (attempt - 1), s);
				if (gens.get(node.id) === gen) state.attempts = attempt;
				const child = await deps.runChild(node.flowId ?? "", childInput, (id) => {
					if (gens.get(node.id) !== gen) return;
					state.childRunId = id;
					emit();
				});
				if (gens.get(node.id) === gen) state.childRunId = child.id;
				if (child.status === "success") return { ok: true, output: clip(child.output ?? "") };
				error = child.error ?? (child.status === "cancelled" ? "已取消" : "子流程失败");
				if (child.status === "cancelled") break;
			}
			return { ok: false, error };
		}
		if (node.kind === "agent") {
			const raw = node.prompt ?? "";
			const onlyStart = ups.every((id) => g.byId.get(id)?.kind === "start");
			const needsContext = prev && !/\{\{\s*(?!input\b)[\w.-]+\s*\}\}/.test(raw) && !(onlyStart && /\{\{\s*input\s*\}\}/.test(raw));
			const prompt = fillTemplate(raw, vars) + (needsContext ? `\n\n以下是上游步骤的输出：\n${prev}` : "");
			const access = deps.accessOverride ?? node.access ?? "readonly";
			const out = await callAgent(node, gen, s, { prompt, access, model: node.model, timeoutMs }, (res) => res.text, RETRY_PROMPT);
			record(out.res);
			return out.value !== undefined ? { ok: true, output: clip(out.value) } : { ok: false, error: out.error ?? "运行失败" };
		}
		// condition
		const mode = node.mode ?? "contains";
		if (mode !== "ai") {
			try {
				return { ok: true, output: prev, branch: checkText(mode, node.match ?? "", prev) };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		}
		const prompt = `${fillTemplate(node.prompt ?? "", vars)}\n\n待判断的内容：\n${prev}\n\n请判断后只回答 YES 或 NO，最后一行写「结论：YES」或「结论：NO」。`;
		let verdict: boolean | undefined;
		const out = await callAgent(
			node,
			gen,
			s,
			{ prompt, access: "readonly", model: node.model, timeoutMs },
			(res) => {
				verdict = parseVerdict(res.text);
				return verdict === undefined ? undefined : res.text;
			},
			VERDICT_RETRY_PROMPT,
		);
		record(out.res);
		return out.value !== undefined && verdict !== undefined ? { ok: true, output: prev, branch: verdict } : { ok: false, error: out.error ?? "判断失败" };
	};

	/** Repeats a loop: its body and everything downstream go back to pending; running ones there are stopped. */
	const rewind = (edge: FlowEdge): void => {
		const count = loops.get(edge.id) ?? 0;
		if (count >= MAX_FLOW_LOOPS) {
			fail(`循环次数超过 ${MAX_FLOW_LOOPS}，「${g.byId.get(edge.from)?.title ?? edge.from}」一直走回「${g.byId.get(edge.to)?.title ?? edge.to}」`);
			return;
		}
		loops.set(edge.id, count + 1);
		run.loopCount = (run.loopCount ?? 0) + 1;
		const body = g.loopBody(edge);
		// Inner loops start counting afresh on each pass of the outer one.
		for (const id of g.back) {
			if (id === edge.id) continue;
			const e = flow.edges.find((x) => x.id === id);
			if (e && body.has(e.from) && body.has(e.to)) loops.delete(id);
		}
		for (const id of g.downstream(body)) {
			if (id === g.startId) continue;
			const job = inflight.get(id);
			if (job) {
				job.ctl.abort();
				inflight.delete(id);
			}
			gens.set(id, (gens.get(id) ?? 0) + 1);
			archiveAndPend(st(id));
		}
	};

	const commit = (node: FlowNode, gen: number, outcome: Outcome): void => {
		if (gens.get(node.id) !== gen) return; // reset by a loop while it ran
		inflight.delete(node.id);
		const state = st(node.id);
		state.finishedAt = deps.now().toISOString();
		state.visits = (state.visits ?? 0) + 1;
		if (outcome.ok) {
			state.status = "success";
			state.output = outcome.output;
			if (outcome.branch !== undefined) state.branch = outcome.branch;
			for (const e of g.outgoing(node.id)) if (g.back.has(e.id) && edgeSignal(e) === "live" && !halted) rewind(e);
		} else {
			state.status = "error";
			state.error = outcome.error;
			if (node.onError === "continue" && !signal.aborted) {
				state.tolerated = true;
				state.output = `（步骤「${node.title}」失败：${outcome.error}）`;
				if (node.kind === "condition") state.branch = false;
			} else fail(`「${node.title}」${outcome.error}`);
		}
		emit();
	};

	const launch = (node: FlowNode): void => {
		const gen = (gens.get(node.id) ?? 0) + 1;
		gens.set(node.id, gen);
		const state = st(node.id);
		state.status = "running";
		state.startedAt = deps.now().toISOString();
		const ctl = new AbortController();
		if (signal.aborted) ctl.abort();
		else signal.addEventListener("abort", () => ctl.abort(), { once: true });
		steps++;
		const done = Promise.resolve()
			.then(() => execute(node, gen, ctl.signal))
			.catch((err: unknown): Outcome => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
			.then((outcome) => commit(node, gen, outcome));
		inflight.set(node.id, { gen, ctl, done });
	};

	const schedule = (): void => {
		if (halted || signal.aborted) return;
		// Dead-path elimination: a node none of whose inputs can still deliver is skipped, which may kill its successors too.
		for (let changed = true; changed; ) {
			changed = false;
			for (const node of flow.nodes) {
				if (st(node.id).status === "pending" && readiness(node) === "dead") {
					st(node.id).status = "skipped";
					changed = true;
				}
			}
		}
		for (const node of flow.nodes) {
			if (inflight.size >= MAX_PARALLEL) break;
			if (st(node.id).status !== "pending" || inflight.has(node.id) || readiness(node) !== "ready") continue;
			if (steps >= MAX_STEPS_PER_RUN) {
				fail(`本次运行已执行 ${MAX_STEPS_PER_RUN} 个步骤，可能是循环套循环停不下来，已中止`);
				return;
			}
			launch(node);
		}
	};

	emit();
	for (;;) {
		schedule();
		emit();
		if (inflight.size === 0) break;
		await Promise.race([...inflight.values()].map((j) => j.done));
	}

	run.finishedAt = deps.now().toISOString();
	return finishRun(flow, run, signal, emit);
}

function finishRun(flow: Flow, run: FlowRun, signal: AbortSignal, emit: () => void): FlowRun {
	for (const state of Object.values(run.nodes)) if (state.status === "pending") state.status = "skipped";
	if (signal.aborted) {
		run.status = "cancelled";
		run.error ??= "已取消";
	} else if (run.error) run.status = "error";
	else {
		run.status = "success";
		const ok = (id: string) => run.nodes[id]?.status === "success" || Boolean(run.nodes[id]?.tolerated);
		const ends = flow.nodes.filter((n) => n.kind === "end" && ok(n.id));
		const sinks = flow.nodes.filter((n) => ok(n.id) && !flow.edges.some((e) => e.from === n.id && ok(e.to)));
		const finals = ends.length ? ends : sinks.filter((n) => n.kind !== "start");
		run.output = finals.map((n) => run.nodes[n.id]?.output ?? "").filter(Boolean).join("\n\n---\n\n") || undefined;
	}
	const warnings: string[] = [];
	const tolerated = flow.nodes.filter((n) => run.nodes[n.id]?.tolerated);
	if (tolerated.length) warnings.push(`以下步骤失败后按设置继续了：${tolerated.map((n) => `${n.title}（${run.nodes[n.id]!.error}）`).join("、")}。`);
	const refused = flow.nodes.filter((n) => run.nodes[n.id]?.blocked?.length);
	if (refused.length) warnings.push(`以下步骤有调用因权限不足被拒绝：${refused.map((n) => `${n.title}（${run.nodes[n.id]!.blocked!.length} 次）`).join("、")}。在这些步骤里把权限调高后重试。`);
	if (warnings.length) run.warning = warnings.join("\n");
	emit();
	return run;
}
