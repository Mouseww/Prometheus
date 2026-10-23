import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { SubagentDetail, SubagentRun, SubagentState, SubagentStep } from "@prometheus/protocol";
import type { AgentStore, AgentView, RunnerKind } from "./agents.ts";
import { CLI_BINARY, cliAvailable } from "./cli-runner.ts";
import type { Runner } from "./types.ts";

export const SUBAGENT_TOOL = "subagent";
const RESULT_TYPE = "subagent-result";
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_STEPS = 400;
const MAX_OUTPUT = 20_000;
const EMIT_MS = 150;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const isDone = (s: SubagentState) => s === "completed" || s === "failed" || s === "stopped";

/** A run as the panel and the saved tool result see it. */
interface Entry {
	run: SubagentRun;
	steps: SubagentStep[];
	output?: string;
	ctrl?: AbortController;
	finished?: Promise<void>;
}

export interface SubagentRuntimeOptions {
	store: AgentStore;
	runners: Record<RunnerKind, Runner>;
	cwd: () => string;
	emit: (runs: SubagentRun[]) => void;
	/** Maximum runs executing at once; the rest wait as queued. */
	maxParallel?: number;
}

interface Slot {
	agent: string;
	task: string;
	model?: string;
	thinking?: string;
}

const toSlots = (p: Rec): Slot[] => {
	const one = (o: Rec): Slot | undefined => {
		const agent = str(o.agent).trim();
		const task = str(o.task).trim();
		return agent && task ? { agent, task, ...(str(o.model).trim() ? { model: str(o.model).trim() } : {}), ...(str(o.thinking).trim() ? { thinking: str(o.thinking).trim() } : {}) } : undefined;
	};
	const many = arr(p.tasks).map((t) => rec(t)).filter((t): t is Rec => !!t);
	if (many.length) {
		return many.map((t) => one({ model: p.model, thinking: p.thinking, ...t })).filter((s): s is Slot => !!s);
	}
	const single = one(p);
	return single ? [single] : [];
};

export class SubagentRuntime {
	private readonly opts: SubagentRuntimeOptions;
	private readonly runs = new Map<string, Entry>();
	private readonly waiting: { entry: Entry; go: () => void }[] = [];
	private active = 0;
	private flush: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private send: ((message: { customType: string; content: string; display: boolean; details: unknown }) => void) | undefined;

	constructor(options: SubagentRuntimeOptions) {
		this.opts = options;
	}

	// ---------- panel surface ----------

	list(): SubagentRun[] {
		return [...this.runs.values()].map((e) => ({ ...e.run }));
	}

	detail(id: string): SubagentDetail {
		const e = this.runs.get(id);
		if (!e) throw new Error("子代理不存在");
		return { run: { ...e.run }, task: e.run.task, steps: e.steps.map((s) => ({ ...s })), ...(e.output ? { output: e.output } : {}), complete: true };
	}

	stop(id: string): void {
		const e = this.runs.get(id);
		if (!e || isDone(e.run.state)) return;
		if (e.run.state === "queued") this.finish(e, "stopped", undefined, "已停止");
		e.ctrl?.abort();
	}

	dispose(): void {
		this.disposed = true;
		if (this.flush) clearTimeout(this.flush);
		for (const e of this.runs.values()) e.ctrl?.abort();
		this.send = undefined;
	}

	/** Rebuild finished runs from saved tool results; anything unfinished died with the previous process. */
	restore(messages: readonly unknown[]): void {
		for (const message of messages) {
			const m = rec(message);
			if (!m) continue;
			const carrier = m.role === "toolResult" && m.toolName === SUBAGENT_TOOL ? m : m.role === "custom" && m.customType === RESULT_TYPE ? m : undefined;
			for (const raw of arr(rec(carrier?.details)?.runs)) {
				const r = rec(raw);
				const run = rec(r?.run) as unknown as SubagentRun | undefined;
				if (!r || !run?.id) continue;
				const state = isDone(run.state) ? run.state : "stopped";
				this.runs.set(run.id, {
					run: { ...run, state, stoppable: false, ...(isDone(run.state) ? {} : { endedAt: run.startedAt, error: "会话重启时已中断" }) },
					steps: arr(r.steps) as SubagentStep[],
					...(str(r.output) ? { output: str(r.output) } : {}),
				});
			}
		}
		this.changed();
	}

	// ---------- the tool ----------

	extension(): InlineExtension {
		return {
			name: "prometheus:subagents",
			factory: (pi) => {
				this.send = (message) => pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
				pi.on("session_shutdown", () => this.dispose());
				pi.registerTool({
					name: SUBAGENT_TOOL,
					label: "子代理",
					description:
						"Delegate work to subagents that run in their own context. Run one agent ({agent, task}) or several in parallel ({tasks:[{agent, task}]}). " +
						"Set background:true to return immediately; you are notified when background runs finish. " +
						'Other actions: {action:"list"} shows the available agents and runs, {action:"status", id}, {action:"wait", id}, {action:"stop", id}. ' +
						"A subagent sees only the task text, so write a self-contained brief.",
					promptSnippet: `${SUBAGENT_TOOL}: delegate bounded work to subagents (parallel and background supported)`,
					parameters: Type.Object({
						action: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("list"), Type.Literal("status"), Type.Literal("wait"), Type.Literal("stop")])),
						agent: Type.Optional(Type.String({ description: "Agent name from the list action" })),
						task: Type.Optional(Type.String({ description: "Self-contained brief for the agent" })),
						tasks: Type.Optional(
							Type.Array(
								Type.Object({
									agent: Type.String(),
									task: Type.String(),
									model: Type.Optional(Type.String()),
									thinking: Type.Optional(Type.String()),
								}),
								{ maxItems: 16, description: "Independent jobs to run in parallel" },
							),
						),
						model: Type.Optional(Type.String({ description: "Override the agent's model for this call (provider/model)" })),
						thinking: Type.Optional(Type.String({ description: "off, minimal, low, medium, high or xhigh" })),
						background: Type.Optional(Type.Boolean({ description: "Return immediately and report back when done" })),
						id: Type.Optional(Type.String({ description: "Run id for status, wait and stop" })),
						timeoutSec: Type.Optional(Type.Number({ description: "Longest wait for action wait" })),
					}),
					execute: async (toolCallId, params, signal) => this.execute(toolCallId, (rec(params) ?? {}) as Rec, signal),
				});
			},
		};
	}

	private async execute(callId: string, p: Rec, signal: AbortSignal | undefined) {
		const action = str(p.action) || "run";
		if (action === "list") return this.reply(await this.roster());
		if (action === "status") return this.reply(this.statusText(str(p.id)));
		if (action === "stop") {
			this.stop(str(p.id));
			return this.reply(`已请求停止 ${str(p.id)}`);
		}
		if (action === "wait") return this.wait(str(p.id), Number(p.timeoutSec), signal);

		const slots = toSlots(p);
		if (!slots.length) return this.reply("需要 agent 和 task，或 tasks 数组。先用 action:\"list\" 查看可用的子代理。", true);
		const agents = await this.opts.store.list();
		const bad = slots.find((s) => !agents.some((a) => a.name === s.agent && !a.disabled));
		if (bad) return this.reply(`没有名为 ${bad.agent} 的可用子代理。可用: ${agents.filter((a) => !a.disabled).map((a) => a.name).join(", ")}`, true);

		const background = p.background === true;
		const entries = slots.map((slot, i) => this.launch(callId, i, slot, agents.find((a) => a.name === slot.agent) as AgentView, background));
		this.changed();

		if (background) {
			const ids = entries.map((e) => e.run.id);
			void Promise.all(entries.map((e) => e.finished)).then(() => this.report(entries));
			return this.reply(`已在后台启动 ${entries.length} 个子代理: ${ids.join(", ")}。完成后会自动通知你，不要轮询。`, false, entries);
		}
		const abort = () => {
			for (const e of entries) this.stop(e.run.id);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await Promise.all(entries.map((e) => e.finished));
		} finally {
			signal?.removeEventListener("abort", abort);
		}
		return this.reply(this.summary(entries), entries.every((e) => e.run.state !== "completed"), entries);
	}

	private async wait(id: string, timeoutSec: number, signal: AbortSignal | undefined) {
		const e = this.runs.get(id);
		if (!e) return this.reply(`没有找到 ${id}`, true);
		if (e.finished && !isDone(e.run.state)) {
			const limit = new Promise<void>((resolve) => setTimeout(resolve, (Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 600) * 1000).unref());
			const aborted = new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			await Promise.race([e.finished, limit, aborted]);
		}
		return this.reply(isDone(e.run.state) ? this.summary([e]) : `${id} 仍在运行`, false, [e]);
	}

	private async roster(): Promise<string> {
		const agents = (await this.opts.store.list()).filter((a) => !a.disabled);
		const lines = agents.map((a) => {
			const via = a.runner === "pi" ? "PI" : a.runner === "claude-code" ? `Claude Code${cliAvailable("claude-code") ? "" : "（未安装）"}` : `Codex${cliAvailable("codex") ? "" : "（未安装）"}`;
			const access = a.runner === "pi" ? (a.tools.length ? `tools: ${a.tools.join(",")}` : "") : a.writable ? "可写" : "只读";
			return `- ${a.name} [${via}${access ? `; ${access}` : ""}${a.model ? `; model: ${a.model}` : ""}]: ${a.description}`;
		});
		const runs = [...this.runs.values()].map((e) => `- ${e.run.id} ${e.run.agent} ${e.run.state}`);
		return `Available agents:\n${lines.join("\n") || "(none)"}${runs.length ? `\n\nRuns:\n${runs.join("\n")}` : ""}`;
	}

	private statusText(id: string): string {
		const e = this.runs.get(id);
		if (!e) return `没有找到 ${id}`;
		const r = e.run;
		return `${r.id} ${r.agent}: ${r.state}${r.currentTool ? ` (正在用 ${r.currentTool})` : ""}${r.error ? `\n错误: ${r.error}` : ""}${e.output ? `\n\n${clip(e.output, MAX_OUTPUT)}` : ""}`;
	}

	private summary(entries: Entry[]): string {
		return entries
			.map((e) => {
				const head = `## ${e.run.agent} (${e.run.id}) — ${e.run.state}`;
				if (e.run.state === "completed") return `${head}\n${clip(e.output || "(没有输出)", MAX_OUTPUT)}`;
				return `${head}\n${e.run.error ?? "未完成"}`;
			})
			.join("\n\n");
	}

	private reply(text: string, isError = false, entries?: Entry[]) {
		return {
			content: [{ type: "text" as const, text }],
			details: { runs: (entries ?? []).map((e) => this.record(e)) },
			...(isError ? { isError: true } : {}),
		};
	}

	/** The saved form of a run: enough to show the panel again after a restart. */
	private record(e: Entry) {
		return { run: { ...e.run, stoppable: false }, steps: e.steps.slice(-MAX_STEPS).map((s) => ({ ...s, text: clip(s.text, 6000), ...(s.result ? { result: clip(s.result, 2000) } : {}) })), ...(e.output ? { output: clip(e.output, MAX_OUTPUT) } : {}) };
	}

	private report(entries: Entry[]): void {
		if (this.disposed || !this.send) return;
		this.send({
			customType: RESULT_TYPE,
			content: `Background subagents finished.\n\n${this.summary(entries)}`,
			display: true,
			details: { runs: entries.map((e) => this.record(e)) },
		});
	}

	// ---------- running ----------

	private launch(callId: string, index: number, slot: Slot, def: AgentView, background: boolean): Entry {
		let id = `${callId}#${index}`;
		for (let n = 1; this.runs.has(id); n++) id = `${callId}#${index}.${n}`;
		const entry: Entry = {
			run: { id, callId, agent: def.name, task: clip(slot.task, 6000), state: "queued", background, startedAt: Date.now(), stoppable: true, ...(slot.model || def.model ? { model: slot.model || def.model } : {}) },
			steps: [],
			ctrl: new AbortController(),
		};
		this.runs.set(id, entry);
		entry.finished = this.execRun(entry, def, slot).catch(() => {});
		return entry;
	}

	private async execRun(entry: Entry, def: AgentView, slot: Slot): Promise<void> {
		await this.acquire(entry);
		if (isDone(entry.run.state)) return;
		const ctrl = entry.ctrl as AbortController;
		const limit = def.timeoutMin > 0 ? def.timeoutMin * 60_000 : DEFAULT_TIMEOUT_MS;
		const timer = setTimeout(() => ctrl.abort(new Error("timeout")), limit);
		timer.unref();
		entry.run.state = "running";
		entry.run.startedAt = Date.now();
		this.changed();
		try {
			const output = await this.opts.runners[def.runner](
				{ def, task: slot.task, cwd: this.opts.cwd(), ...(slot.model || def.model ? { model: slot.model || def.model } : {}), ...((slot.thinking || def.thinking) ? { thinking: slot.thinking || def.thinking } : {}) },
				{
					step: (s) => {
						entry.steps.push(s);
						if (entry.steps.length > MAX_STEPS * 2) entry.steps.splice(0, MAX_STEPS);
						this.changed();
					},
					tool: (name) => {
						entry.run.currentTool = name;
						entry.run.toolCount = (entry.run.toolCount ?? 0) + 1;
						this.changed();
					},
					tokens: (n) => {
						entry.run.tokens = Math.max(entry.run.tokens ?? 0, n);
						this.changed();
					},
					touch: () => this.changed(),
					model: (name) => {
						entry.run.model = name;
						this.changed();
					},
				},
				ctrl.signal,
			);
			this.finish(entry, ctrl.signal.aborted ? "stopped" : "completed", output);
		} catch (err) {
			const timedOut = ctrl.signal.aborted && String((ctrl.signal.reason as Error | undefined)?.message) === "timeout";
			const message = timedOut ? `超过 ${Math.round(limit / 60_000)} 分钟未完成，已中止` : err instanceof Error ? err.message : String(err);
			this.finish(entry, ctrl.signal.aborted && !timedOut ? "stopped" : "failed", undefined, message);
		} finally {
			clearTimeout(timer);
			this.release();
		}
	}

	private finish(entry: Entry, state: SubagentState, output?: string, error?: string): void {
		if (isDone(entry.run.state)) return;
		entry.run.state = state;
		entry.run.endedAt = Date.now();
		entry.run.stoppable = false;
		entry.run.currentTool = undefined;
		if (output !== undefined) entry.output = output;
		if (error && state !== "completed") entry.run.error = clip(error, 600);
		this.changed();
	}

	private acquire(entry: Entry): Promise<void> {
		const max = this.opts.maxParallel ?? 4;
		if (this.active < max) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.waiting.push({
				entry,
				go: () => {
					this.active++;
					resolve();
				},
			});
			// A stopped run leaves the line without taking a slot.
			entry.ctrl?.signal.addEventListener("abort", () => resolve(), { once: true });
		});
	}

	private release(): void {
		this.active = Math.max(0, this.active - 1);
		for (let next = this.waiting.shift(); next; next = this.waiting.shift()) {
			if (isDone(next.entry.run.state)) continue;
			next.go();
			return;
		}
	}

	private changed(): void {
		if (this.disposed || this.flush) return;
		this.flush = setTimeout(() => {
			this.flush = undefined;
			if (!this.disposed) this.opts.emit(this.list());
		}, EMIT_MS);
		this.flush.unref();
	}
}

export { CLI_BINARY };
