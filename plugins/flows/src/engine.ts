import { randomUUID } from "node:crypto";
import type { AgentRunOptions, AgentRunResult, WorkspaceRef } from "@prometheus/plugin-sdk";
import { type Flow, type FlowInput, type FlowRefContext, type FlowRun, MAX_SUBFLOW_DEPTH } from "@prometheus/protocol";
import { ensureStart, extractJson, GENERATE_GUIDE, normalizeFlow, validateFlow } from "./graph.ts";
import { runFlow } from "./runner.ts";
import { catchUpDue, nextRun, validateSchedule } from "./schedule.ts";

export interface FlowState {
	flows: Flow[];
	/** Newest first, capped. */
	runs: FlowRun[];
}

export interface FlowDeps {
	load(): Promise<FlowState>;
	save(state: FlowState): Promise<void>;
	workspaces(): Promise<WorkspaceRef[]>;
	runAgent(options: AgentRunOptions): Promise<AgentRunResult>;
	now(): Date;
	changed(): void;
	log(message: string): void;
}

const MAX_FLOWS = 100;
const MAX_RUNS = 60;
const TICK_MS = 20_000;

export class FlowEngine {
	private state: FlowState = { flows: [], runs: [] };
	private readonly running = new Map<string, AbortController>();
	private persisting: Promise<void> = Promise.resolve();
	private timer: ReturnType<typeof setInterval> | undefined;
	private ticking = false;

	private readonly deps: FlowDeps;
	constructor(deps: FlowDeps) {
		this.deps = deps;
	}

	async start(): Promise<void> {
		this.state = await this.deps.load();
		const now = this.deps.now().toISOString();
		for (const run of this.state.runs) {
			if (run.status !== "running") continue;
			run.status = "error";
			run.error = "应用关闭时中断";
			run.finishedAt = now;
			for (const n of Object.values(run.nodes)) if (n.status === "running" || n.status === "pending") n.status = "skipped";
		}
		const nowDate = this.deps.now();
		for (const flow of this.state.flows) {
			if (!flow.schedule || !flow.scheduleEnabled) continue;
			const due = flow.nextRunAt ? new Date(flow.nextRunAt) : undefined;
			if (due && due.getTime() <= nowDate.getTime() && catchUpDue(flow.schedule, due, nowDate)) continue; // runs on the first tick
			if (!due || due.getTime() <= nowDate.getTime()) this.reschedule(flow, nowDate);
		}
		await this.persist().catch(() => {});
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		this.timer.unref?.();
		void this.tick();
	}

	private reschedule(flow: Flow, from: Date): void {
		const next = flow.schedule && flow.scheduleEnabled ? nextRun(flow.schedule, from) : undefined;
		if (next) flow.nextRunAt = next.toISOString();
		else delete flow.nextRunAt;
		if (flow.scheduleEnabled && flow.schedule && !next) flow.scheduleEnabled = false; // a one-off that has fired
	}

	/** Starts scheduled flows that are due. A flow still running is left alone and tried again next tick. */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const now = this.deps.now();
			for (const flow of [...this.state.flows]) {
				if (!flow.schedule || !flow.scheduleEnabled || !flow.nextRunAt || new Date(flow.nextRunAt).getTime() > now.getTime()) continue;
				if (this.state.runs.some((r) => r.flowId === flow.id && r.status === "running")) continue;
				this.reschedule(flow, now);
				try {
					const { done } = await this.startRun(flow.id, flow.scheduleInput ?? "", undefined, "schedule");
					void done.catch((err: unknown) => this.deps.log(`定时流程失败：${err instanceof Error ? err.message : err}`));
				} catch (err) {
					this.deps.log(`定时流程无法启动：${err instanceof Error ? err.message : err}`);
				}
			}
			await this.persist().catch(() => {});
			this.deps.changed();
		} finally {
			this.ticking = false;
		}
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (const ctl of this.running.values()) ctl.abort();
		await this.persisting;
	}

	snapshot(): FlowState {
		return structuredClone(this.state);
	}

	get(id: string): Flow {
		const flow = this.state.flows.find((f) => f.id === id);
		if (!flow) throw new Error("流程不存在");
		return flow;
	}

	private persist(): Promise<void> {
		const write = this.persisting.then(() => this.deps.save(structuredClone(this.state)));
		this.persisting = write.catch((err: unknown) => this.deps.log(`保存失败：${err instanceof Error ? err.message : err}`));
		return write;
	}

	private async check(input: FlowInput, selfId?: string): Promise<void> {
		const errors = validateFlow(input, this.refs(selfId));
		if (input.schedule) errors.push(...validateSchedule(input.schedule));
		if (errors.length) throw new Error(errors.join("；"));
		if (!(await this.deps.workspaces()).some((w) => w.id === input.workspaceId)) throw new Error("工作区不存在，请先在侧栏添加");
	}

	async create(input: FlowInput): Promise<Flow> {
		if (this.state.flows.length >= MAX_FLOWS) throw new Error(`流程已达上限 ${MAX_FLOWS}`);
		await this.check(input);
		const at = this.deps.now().toISOString();
		const flow: Flow = { id: randomUUID().slice(0, 8), ...input, createdAt: at, updatedAt: at };
		this.reschedule(flow, this.deps.now());
		this.state.flows.push(flow);
		await this.persist();
		this.deps.changed();
		return flow;
	}

	async update(id: string, input: FlowInput): Promise<Flow> {
		const flow = this.get(id);
		await this.check(input, id);
		for (const key of ["schedule", "scheduleInput", "scheduleEnabled"] as const) delete flow[key];
		Object.assign(flow, input, { updatedAt: this.deps.now().toISOString() });
		this.reschedule(flow, this.deps.now());
		await this.persist();
		this.deps.changed();
		return flow;
	}

	async remove(id: string): Promise<void> {
		this.get(id);
		const users = this.state.flows.filter((f) => f.id !== id && f.nodes.some((n) => n.kind === "subflow" && n.flowId === id));
		if (users.length) throw new Error(`流程正被「${users.map((f) => f.name).join("」「")}」作为子流程引用，请先解除引用`);
		for (const run of this.state.runs) if (run.flowId === id) this.running.get(run.id)?.abort();
		this.state.flows = this.state.flows.filter((f) => f.id !== id);
		await this.persist();
		this.deps.changed();
	}

	async duplicate(id: string): Promise<Flow> {
		const src = this.get(id);
		const { name, description, workspaceId, nodes, edges } = structuredClone(src);
		// The copy starts unscheduled: two flows firing at the same time by accident is rarely wanted.
		return this.create({ name: `${name} 副本`.slice(0, 80), description, workspaceId, nodes, edges });
	}

	async clearRuns(): Promise<void> {
		this.state.runs = this.state.runs.filter((r) => r.status === "running");
		await this.persist();
		this.deps.changed();
	}

	// ---------- running ----------

	/** Starts a run and returns its id at once; the record fills in as steps finish. */
	async startRun(flowId: string, input: string, parentSessionId?: string, trigger: FlowRun["trigger"] = parentSessionId ? "agent" : "manual"): Promise<{ runId: string; done: Promise<FlowRun> }> {
		if (this.state.runs.some((r) => r.flowId === flowId && r.status === "running" && !r.parentRunId)) throw new Error("该流程正在运行");
		return this.launch(flowId, input, { parentSessionId, trigger, depth: 0 });
	}

	private async launch(
		flowId: string,
		input: string,
		o: { parentSessionId?: string; trigger: FlowRun["trigger"]; depth: number; parentRunId?: string; parentSignal?: AbortSignal; onStart?: (runId: string) => void },
	): Promise<{ runId: string; done: Promise<FlowRun> }> {
		if (o.depth > MAX_SUBFLOW_DEPTH) throw new Error(`子流程嵌套超过 ${MAX_SUBFLOW_DEPTH} 层`);
		const flow = structuredClone(this.get(flowId));
		const errors = validateFlow(flow, this.refs(flow.id));
		if (errors.length) throw new Error(errors.join("；"));
		const workspace = (await this.deps.workspaces()).find((w) => w.id === flow.workspaceId);
		if (!workspace) throw new Error("工作区已被移除");
		const runId = randomUUID().slice(0, 8);
		const ctl = new AbortController();
		// A parent that is stopped stops everything it started.
		if (o.parentSignal) {
			if (o.parentSignal.aborted) ctl.abort();
			else o.parentSignal.addEventListener("abort", () => ctl.abort(), { once: true });
		}
		this.running.set(runId, ctl);
		this.get(flowId).lastRunAt = this.deps.now().toISOString();
		let first = true;
		const done = runFlow(
			flow,
			input.slice(0, 8000),
			runId,
			{
				runAgent: (opts) => this.deps.runAgent(o.parentSessionId ? { ...opts, parentSessionId: o.parentSessionId } : opts),
				now: () => this.deps.now(),
				cwd: workspace.path,
				trigger: o.trigger,
				...(o.parentRunId ? { parentRunId: o.parentRunId } : {}),
				runChild: async (childFlowId, childInput, onStart) => {
					const child = await this.launch(childFlowId, childInput, { parentSessionId: o.parentSessionId, trigger: "subflow", depth: o.depth + 1, parentRunId: runId, parentSignal: ctl.signal });
					onStart(child.runId);
					return child.done;
				},
				update: (run) => {
					const i = this.state.runs.findIndex((r) => r.id === run.id);
					if (i >= 0) this.state.runs[i] = structuredClone(run);
					else if (first) {
						first = false;
						this.state.runs.unshift(structuredClone(run));
						this.state.runs = this.state.runs.slice(0, MAX_RUNS);
						o.onStart?.(run.id);
					}
					void this.persist().catch(() => {});
					this.deps.changed();
				},
			},
			ctl.signal,
		).finally(() => this.running.delete(runId));
		return { runId, done };
	}

	private subflowCatalog(): string {
		const list = this.state.flows;
		return list.length ? `\n\n可用的子流程（subflow 节点的 flowId 只能取这里的 id）：\n${list.map((f) => `- ${f.id}：${f.name}${f.description ? `（${f.description}）` : ""}`).join("\n")}` : "";
	}

	/** Snapshot of one run record, for callers that poll (automations). */
	getRun(runId: string): FlowRun | undefined {
		const r = this.state.runs.find((x) => x.id === runId);
		return r && structuredClone(r);
	}

	/** What a flow's subflow nodes can point at, and who points at this one. */
	private refs(selfId?: string): FlowRefContext {
		return { selfId, flows: this.state.flows.map((f) => ({ id: f.id, name: f.name, nodes: f.nodes })) };
	}

	cancel(runId: string): boolean {
		const ctl = this.running.get(runId);
		ctl?.abort();
		return Boolean(ctl);
	}

	// ---------- AI generation ----------

	/** Asks the agent to design a flow from a description. The draft is returned, not saved: the user reviews it on the canvas. */
	async generate(description: string, workspaceId: string, signal?: AbortSignal): Promise<FlowInput> {
		if (!description.trim()) throw new Error("请描述想要的流程");
		const workspace = (await this.deps.workspaces()).find((w) => w.id === workspaceId);
		if (!workspace) throw new Error("工作区不存在，请先在侧栏添加");
		const res = await this.deps.runAgent({
			cwd: workspace.path,
			prompt: `${GENERATE_GUIDE}${this.subflowCatalog()}\n\n用户描述：\n${description.trim()}`,
			name: "✨ 生成流程",
			access: "readonly",
			timeoutMs: 5 * 60_000,
			signal,
		});
		if (res.status !== "success") throw new Error(res.error ?? "生成失败");
		const draft = ensureStart(normalizeFlow(extractJson(res.text)));
		draft.workspaceId = workspaceId;
		if (!draft.name) draft.name = description.trim().slice(0, 30);
		const errors = validateFlow(draft);
		if (errors.length) throw new Error(`生成的流程不合法：${errors.join("；")}`);
		return draft;
	}
}
