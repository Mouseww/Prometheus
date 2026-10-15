import { randomUUID } from "node:crypto";
import type { AgentRunOptions, AgentRunResult, WorkspaceRef } from "@prometheus/plugin-sdk";
import type { AutomationInput, AutomationRun, AutomationTask } from "@prometheus/protocol";
import { catchUpDue, nextRun, validateSchedule } from "./schedule.ts";

export interface AutomationState {
	tasks: AutomationTask[];
	/** Newest first, capped. */
	runs: AutomationRun[];
}

export interface EngineDeps {
	load(): Promise<AutomationState>;
	save(state: AutomationState): Promise<void>;
	workspaces(): Promise<WorkspaceRef[]>;
	runAgent(options: AgentRunOptions): Promise<AgentRunResult>;
	now(): Date;
	/** Called after a run starts or ends, so clients can refresh. */
	changed(): void;
	log(message: string): void;
}

const MAX_RUNS = 100;
const MAX_TASKS = 50;
const TICK_MS = 20_000;
const SUMMARY_CHARS = 600;

export function validateInput(input: AutomationInput): string[] {
	const errors: string[] = [];
	if (!input.name?.trim()) errors.push("名称不能为空");
	if (!input.prompt?.trim()) errors.push("任务内容不能为空");
	if (!input.workspaceId) errors.push("请选择工作区");
	if (!["readonly", "edits", "full"].includes(input.access)) errors.push("权限级别不合法");
	errors.push(...validateSchedule(input.schedule));
	return errors;
}

/** Runs due tasks one at a time. Time only enters through `deps.now()`, so tests drive it by hand. */
export class AutomationEngine {
	private timer: ReturnType<typeof setInterval> | undefined;
	private ticking = false;
	private readonly running = new Map<string, AbortController>();
	private readonly deps: EngineDeps;
	private state: AutomationState = { tasks: [], runs: [] };
	private persisting: Promise<void> = Promise.resolve();

	constructor(deps: EngineDeps) {
		this.deps = deps;
	}

	async start(): Promise<void> {
		this.state = await this.deps.load();
		const now = this.deps.now();
		for (const task of this.state.tasks) {
			// A run cut short by shutting the app down can never be finished; do not leave it spinning forever.
			for (const run of this.state.runs) {
				if (run.taskId === task.id && run.status === "running") {
					run.status = "error";
					run.error = "应用关闭时中断";
					run.finishedAt = now.toISOString();
				}
			}
			if (!task.enabled) continue;
			const due = task.nextRunAt ? new Date(task.nextRunAt) : undefined;
			if (due && due.getTime() <= now.getTime() && catchUpDue(task.schedule, due, now)) continue; // stays due; the first tick runs it
			if (!due || due.getTime() <= now.getTime()) this.schedule(task, now);
		}
		await this.persist();
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		this.timer.unref?.();
		void this.tick();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (const ctl of this.running.values()) ctl.abort();
		await this.persisting;
	}

	snapshot(): AutomationState {
		return structuredClone(this.state);
	}

	private schedule(task: AutomationTask, from: Date): void {
		const next = task.enabled ? nextRun(task.schedule, from) : undefined;
		task.nextRunAt = next?.toISOString();
		// A one-off task that has fired has nothing left to wait for.
		if (task.enabled && !next && task.schedule.type === "once") task.enabled = false;
	}

	private persist(): Promise<void> {
		this.persisting = this.persisting.then(() => this.deps.save(structuredClone(this.state))).catch((err: unknown) => this.deps.log(`保存失败：${err instanceof Error ? err.message : err}`));
		return this.persisting;
	}

	// ---------- CRUD ----------

	async create(input: AutomationInput): Promise<AutomationTask> {
		if (this.state.tasks.length >= MAX_TASKS) throw new Error(`自动化任务已达上限 ${MAX_TASKS}`);
		const errors = validateInput(input);
		if (errors.length) throw new Error(errors.join("；"));
		await this.requireWorkspace(input.workspaceId);
		const task: AutomationTask = { id: randomUUID().slice(0, 8), ...clean(input), createdAt: this.deps.now().toISOString() };
		this.schedule(task, this.deps.now());
		this.state.tasks.push(task);
		await this.persist();
		this.deps.changed();
		return task;
	}

	async update(id: string, input: AutomationInput): Promise<AutomationTask> {
		const task = this.require(id);
		const errors = validateInput(input);
		if (errors.length) throw new Error(errors.join("；"));
		await this.requireWorkspace(input.workspaceId);
		Object.assign(task, clean(input));
		if (!task.model) delete task.model;
		this.schedule(task, this.deps.now());
		await this.persist();
		this.deps.changed();
		return task;
	}

	async setEnabled(id: string, enabled: boolean): Promise<AutomationTask> {
		const task = this.require(id);
		task.enabled = enabled;
		this.schedule(task, this.deps.now());
		await this.persist();
		this.deps.changed();
		return task;
	}

	async remove(id: string): Promise<void> {
		this.require(id);
		this.running.get(id)?.abort();
		this.state.tasks = this.state.tasks.filter((t) => t.id !== id);
		await this.persist();
		this.deps.changed();
	}

	async clearRuns(): Promise<void> {
		this.state.runs = this.state.runs.filter((r) => r.status === "running");
		await this.persist();
		this.deps.changed();
	}

	private require(id: string): AutomationTask {
		const task = this.state.tasks.find((t) => t.id === id);
		if (!task) throw new Error("任务不存在");
		return task;
	}

	private async requireWorkspace(id: string): Promise<void> {
		if (!(await this.deps.workspaces()).some((w) => w.id === id)) throw new Error("工作区不存在，请先在侧栏添加");
	}

	// ---------- running ----------

	/** Starts the task now, outside its schedule. Resolves when the run finishes. */
	async runNow(id: string): Promise<AutomationRun> {
		const task = this.require(id);
		if (this.running.has(id)) throw new Error("该任务正在运行");
		return this.execute(task);
	}

	cancel(id: string): boolean {
		const ctl = this.running.get(id);
		ctl?.abort();
		return Boolean(ctl);
	}

	/** Runs everything that is due. Sequential on purpose: unattended agents should not pile onto one machine. */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const now = this.deps.now();
			for (const task of [...this.state.tasks]) {
				if (!task.enabled || !task.nextRunAt || this.running.has(task.id)) continue;
				if (new Date(task.nextRunAt).getTime() > now.getTime()) continue;
				await this.execute(task);
			}
		} finally {
			this.ticking = false;
		}
	}

	private async execute(task: AutomationTask): Promise<AutomationRun> {
		const started = this.deps.now();
		const run: AutomationRun = { id: randomUUID().slice(0, 8), taskId: task.id, taskName: task.name, startedAt: started.toISOString(), status: "running" };
		// Reschedule first, so a crash or a slow run can never make the same slot fire twice.
		this.schedule(task, started);
		task.lastRunAt = run.startedAt;
		this.state.runs.unshift(run);
		this.state.runs = this.state.runs.slice(0, MAX_RUNS);
		const ctl = new AbortController();
		this.running.set(task.id, ctl);
		await this.persist();
		this.deps.changed();

		try {
			const workspace = (await this.deps.workspaces()).find((w) => w.id === task.workspaceId);
			if (!workspace) {
				run.status = "skipped";
				run.error = "工作区已被移除";
			} else {
				const result = await this.deps.runAgent({
					cwd: workspace.path,
					prompt: task.prompt,
					name: `⏱ ${task.name}`,
					access: task.access,
					model: task.model,
					signal: ctl.signal,
				});
				run.sessionId = result.sessionId;
				run.status = result.status === "success" ? "success" : "error";
				run.summary = result.text.slice(0, SUMMARY_CHARS) || undefined;
				if (result.status !== "success") run.error = result.error ?? (result.status === "aborted" ? "已取消" : "运行失败");
			}
		} catch (err) {
			run.status = "error";
			run.error = err instanceof Error ? err.message : String(err);
		} finally {
			run.finishedAt = this.deps.now().toISOString();
			this.running.delete(task.id);
			await this.persist();
			this.deps.changed();
		}
		return run;
	}
}

function clean(input: AutomationInput): AutomationInput {
	return {
		name: input.name.trim().slice(0, 80),
		prompt: input.prompt.trim().slice(0, 8000),
		workspaceId: input.workspaceId,
		schedule: input.schedule,
		access: input.access,
		enabled: input.enabled !== false,
		...(input.model ? { model: { provider: input.model.provider, id: input.model.id } } : {}),
	};
}
