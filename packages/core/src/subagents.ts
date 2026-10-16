import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SubagentDetail, SubagentRun, SubagentState, SubagentStep } from "@prometheus/protocol";

/** Tool of the pi-subagents package; everything here is derived from its events and public RPC. */
export const SUBAGENT_TOOL = "subagent";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE = "subagent:async-complete";
const ASYNC_STARTED = "subagent:async-started";
const POLL_MS = 2000;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_STEPS = 400;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const isDone = (s: SubagentState) => s === "completed" || s === "failed" || s === "stopped";

/** pi-subagents blanks prompt text in its progress payloads; the call's own arguments are the real task. */
const REDACTED = /^\[prompt redacted\]$/;
const realTask = (v: unknown, fallback: string): string => {
	const s = str(v);
	return s && !REDACTED.test(s.trim()) ? clip(s, 6000) : fallback;
};

/** Map the vocabularies of progress rows, async snapshots and completion payloads onto one state. */
function toState(s: unknown): SubagentState | undefined {
	switch (s) {
		case "pending":
		case "queued":
			return "queued";
		case "running":
		case "detached":
			return "running";
		case "complete":
		case "completed":
		case "success":
		case "partial":
			return "completed";
		case "failed":
		case "error":
		case "rejected":
			return "failed";
		case "stopped":
		case "paused":
		case "cancelled":
			return "stopped";
		default:
			return undefined;
	}
}

function resultState(r: Rec): SubagentState {
	if (r.detached === true) return "running";
	if (r.stopped === true || r.interrupted === true) return "stopped";
	if (r.timedOut === true) return "failed";
	return (num(r.exitCode) ?? 0) === 0 && !str(r.error) ? "completed" : "failed";
}

interface Entry {
	id: string;
	callId: string;
	index: number;
	agent: string;
	task: string;
	state: SubagentState;
	background: boolean;
	startedAt: number;
	endedAt?: number;
	model?: string;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	error?: string;
	runId?: string;
	asyncId?: string;
	asyncDir?: string;
	childId?: string;
	sessionFile?: string;
	/** Stands in for children of a background run that have not been listed yet. */
	placeholder?: boolean;
	final?: string;
	live?: { tools: { tool: string; args: string }[]; output: string[] };
}

interface LaunchSpec {
	agent: string;
	task: string;
}

/** The agents a call asks for, read from its arguments before any result exists. */
export function launchSpecs(args: Rec): LaunchSpec[] {
	const spec = (v: unknown): LaunchSpec | undefined => {
		const r = rec(v);
		const agent = str(r?.agent);
		return r && agent ? { agent, task: str(r.task) ?? "" } : undefined;
	};
	const tasks = arr(args.tasks).map(spec).filter((x): x is LaunchSpec => !!x);
	if (tasks.length) return tasks;
	const chain = arr(args.chain).flatMap((step) => {
		const group = rec(step)?.parallel;
		return (Array.isArray(group) ? group : [step]).map(spec).filter((x): x is LaunchSpec => !!x);
	});
	if (chain.length) return chain;
	const single = spec(args);
	return single ? [single] : [];
}

const ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url"];
function argText(args: unknown): string {
	const r = rec(args);
	if (!r) return typeof args === "string" ? clip(args, 400) : "";
	const key = ARG_KEYS.find((k) => typeof r[k] === "string");
	return clip(key ? String(r[key]) : JSON.stringify(r), 400);
}

function blocksText(content: unknown): string {
	if (typeof content === "string") return content;
	return arr(content)
		.map((c) => str(rec(c)?.text) ?? "")
		.filter(Boolean)
		.join("\n");
}

/** Rebuild a child's transcript from its own session file (one JSON entry per line). */
export function parseChildSession(text: string): SubagentStep[] {
	const steps: SubagentStep[] = [];
	const byCall = new Map<string, SubagentStep>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: Rec | undefined;
		try {
			entry = rec(JSON.parse(line));
		} catch {
			continue;
		}
		const m = entry?.type === "message" ? rec(entry.message) : undefined;
		if (!m) continue;
		if (m.role === "assistant") {
			for (const b of arr(m.content)) {
				const block = rec(b);
				if (!block) continue;
				if (block.type === "thinking" && str(block.thinking)?.trim()) steps.push({ kind: "thinking", text: clip(String(block.thinking), 6000) });
				else if (block.type === "text" && str(block.text)?.trim()) steps.push({ kind: "text", text: clip(String(block.text), 12000) });
				else if (block.type === "toolCall") {
					const step: SubagentStep = { kind: "tool", text: "", tool: str(block.name) ?? "tool", args: argText(block.arguments) };
					steps.push(step);
					const id = str(block.id);
					if (id) byCall.set(id, step);
				}
			}
		} else if (m.role === "toolResult") {
			const step = byCall.get(str(m.toolCallId) ?? "");
			if (step) {
				step.result = clip(blocksText(m.content), 4000);
				if (m.isError === true) step.isError = true;
			}
		}
	}
	return steps.slice(-MAX_STEPS);
}

export interface SubagentTrackerOptions {
	/** Receives the whole list whenever anything changed (coalesced). */
	emit: (runs: SubagentRun[]) => void;
	/** The parent conversation's session file; child transcripts live in a folder next to it. */
	parentFile?: () => string | undefined;
}

type EventBus = { on(channel: string, handler: (data: unknown) => void): () => void; emit(channel: string, data: unknown): void };

/**
 * Follows the `subagent` tool of one conversation: which agents were delegated to, where each stands,
 * what it is doing. Foreground runs are read from the tool's own streaming events; background runs
 * are read from the package's status snapshot and completion events. It also relays stop requests.
 */
export class SubagentTracker {
	private readonly runs = new Map<string, Entry>();
	private readonly calls = new Set<string>();
	private readonly misses = new Map<string, number>();
	private readonly emitList: (runs: SubagentRun[]) => void;
	private readonly parentFile: () => string | undefined;
	private events: EventBus | undefined;
	private offs: (() => void)[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private polling = false;
	private failures = 0;
	private disposed = false;

	constructor(options: SubagentTrackerOptions) {
		this.emitList = options.emit;
		this.parentFile = options.parentFile ?? (() => undefined);
	}

	// ---------- public surface ----------

	list(): SubagentRun[] {
		return [...this.runs.values()].map((e) => this.pub(e));
	}

	/** Feed every raw session event; only the subagent tool matters. */
	observe(event: unknown): void {
		const e = rec(event);
		if (!e || e.toolName !== SUBAGENT_TOOL) return;
		const callId = str(e.toolCallId);
		if (!callId) return;
		if (e.type === "tool_execution_start") this.start(callId, e.args);
		else if (e.type === "tool_execution_update") this.update(callId, rec(rec(e.partialResult)?.details));
		else if (e.type === "tool_execution_end") this.end(callId, e);
	}

	/** Rebuild finished foreground runs from saved tool results, so the panel survives a restart. */
	restore(messages: readonly unknown[]): void {
		const args = new Map<string, unknown>();
		for (const message of messages) {
			const m = rec(message);
			if (m?.role !== "assistant") continue;
			for (const b of arr(m.content)) {
				const block = rec(b);
				if (block?.type === "toolCall" && block.name === SUBAGENT_TOOL && str(block.id)) args.set(String(block.id), block.arguments);
			}
		}
		for (const message of messages) {
			const m = rec(message);
			if (m?.role !== "toolResult" || m.toolName !== SUBAGENT_TOOL) continue;
			const callId = str(m.toolCallId);
			const details = rec(m.details);
			if (!callId || !details || details.background === true || str(details.asyncId)) continue;
			const when = num(m.timestamp) ?? Date.now();
			// The call's arguments hold the real task text; the saved result only has a redacted copy.
			this.start(callId, args.get(callId), when);
			this.apply(callId, details, true, when, true);
			for (const e of this.runs.values()) {
				if (e.callId !== callId || isDone(e.state)) continue;
				if (m.isError === true) e.error ??= "调用失败";
				this.settle(e, m.isError === true ? "failed" : "stopped", when);
			}
		}
		this.changed();
	}

	/** The PI extension that connects the tracker to the package's event bus. */
	extension(): InlineExtension {
		return {
			name: "prometheus:subagents",
			factory: (pi) => {
				for (const off of this.offs) off();
				this.offs = [];
				const bus = pi.events as unknown as EventBus;
				this.events = bus;
				this.offs.push(
					bus.on(ASYNC_COMPLETE, (d) => this.finishAsync(d)),
					bus.on(ASYNC_STARTED, () => this.ensurePolling()),
				);
				pi.on("session_shutdown", () => {
					for (const off of this.offs) off();
					this.offs = [];
					this.events = undefined;
					this.stopPolling();
				});
			},
		};
	}

	/** Call the package's in-process RPC (`status`, `interrupt`, `stop`, `spawn`, ...). */
	request(method: string, params: Rec): Promise<unknown> {
		const bus = this.events;
		if (!bus) return Promise.reject(new Error("子代理扩展未就绪"));
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			const finish = (fn: () => void) => {
				off();
				clearTimeout(timer);
				fn();
			};
			const off = bus.on(`${RPC_REPLY}${requestId}`, (reply) => {
				const r = rec(reply);
				if (r?.success === true) finish(() => resolve(r.data));
				else finish(() => reject(new Error(str(rec(r?.error)?.message) ?? "子代理请求失败")));
			});
			const timer = setTimeout(() => finish(() => reject(new Error("子代理扩展没有响应，请确认已安装 pi-subagents"))), 10_000);
			timer.unref();
			bus.emit(RPC_REQUEST, { version: 1, requestId, method, params });
		});
	}

	async stop(id: string): Promise<void> {
		const e = this.runs.get(id);
		if (!e) throw new Error("子代理不存在");
		if (isDone(e.state)) return;
		if (e.asyncId) await this.request("stop", e.childId ? { id: e.asyncId, childId: e.childId } : { id: e.asyncId });
		else await this.request("interrupt", e.runId ? { id: e.runId } : {});
		this.settle(e, "stopped", Date.now());
		this.changed();
	}

	async detail(id: string): Promise<SubagentDetail> {
		const e = this.runs.get(id);
		if (!e) throw new Error("子代理不存在");
		let steps: SubagentStep[] = [];
		let complete = false;
		const file = await this.transcriptFile(e);
		if (file) {
			try {
				if ((await stat(file)).size <= MAX_TRANSCRIPT_BYTES) {
					steps = parseChildSession(await readFile(file, "utf8"));
					complete = true;
				}
			} catch {
				// The file may be mid-write or gone; the live view below still has something.
			}
		}
		if (!complete) steps = this.liveSteps(e);
		return { run: this.pub(e), task: clip(e.task, 6000), steps, output: e.final ? clip(e.final, 20000) : undefined, complete };
	}

	dispose(): void {
		this.disposed = true;
		this.stopPolling();
		if (this.flushTimer) clearTimeout(this.flushTimer);
		for (const off of this.offs) off();
		this.offs = [];
	}

	// ---------- foreground events ----------

	private start(callId: string, args: unknown, at = Date.now()): void {
		const a = rec(args);
		// `action` calls (status, stop, ...) manage runs rather than launch them.
		if (!a || str(a.action)) return;
		this.calls.add(callId);
		const now = at;
		// Workflow calls carry the agents under `args`; the package no longer accepts top-level tasks/chain.
		const input = rec(a.args) ?? a;
		const chained = arr(input.chain).length > 0;
		launchSpecs(input).forEach((spec, i) => {
			const [e] = this.entry(callId, i, now);
			e.agent = spec.agent;
			e.task = spec.task;
			e.state = chained && i > 0 ? "queued" : "running";
		});
		this.changed();
	}

	private update(callId: string, details: Rec | undefined): void {
		if (!this.calls.has(callId)) return;
		this.apply(callId, details, false, Date.now());
		this.changed();
	}

	private end(callId: string, e: Rec): void {
		if (!this.calls.has(callId)) return;
		const now = Date.now();
		const result = rec(e.result);
		const details = rec(result?.details);
		this.apply(callId, details, true, now);
		const background = !!details && (details.background === true || !!str(details.asyncId));
		const asyncId = str(details?.asyncId);
		const mine = [...this.runs.values()].filter((x) => x.callId === callId);
		if (background) {
			if (!mine.length) {
				const [placeholder] = this.entry(callId, 0, now);
				placeholder.agent = "workflow";
				placeholder.placeholder = true;
			}
			for (const x of this.runs.values()) {
				if (x.callId !== callId) continue;
				x.background = true;
				x.asyncId = asyncId;
				x.asyncDir = str(details?.asyncDir);
				if (x.state === "queued") x.state = "running";
			}
			this.ensurePolling();
		} else {
			const reason = blocksText(result?.content)
				.split("\n")
				.filter((l) => !/^Run fan-out:/.test(l))
				.join("\n")
				.trim();
			for (const x of mine) {
				// A child the package already marked failed carries no message of its own; the call's error is the best one.
				if (e.isError === true && x.state === "failed" && !x.error && reason) x.error = clip(reason, 400);
				if (isDone(x.state)) continue;
				if (e.isError === true) {
					x.error = clip(reason, 400) || "调用失败";
					this.settle(x, "failed", now);
				} else {
					// A chain step that never started, or a child the result does not mention.
					x.error ??= "未执行";
					this.settle(x, "stopped", now);
				}
			}
		}
		this.changed();
	}

	/** Merge one `details` payload (streamed or final) of the subagent tool into the entries of a call. */
	private apply(callId: string, details: Rec | undefined, final: boolean, now: number, restoring = false): void {
		if (!details) return;
		const runId = str(details.runId);
		arr(details.progress).forEach((raw, i) => {
			const p = rec(raw);
			if (!p) return;
			const [e] = this.entry(callId, num(p.index) ?? i, now);
			if (runId) e.runId = runId;
			e.agent = str(p.agent) ?? e.agent;
			e.task = realTask(p.task, e.task);
			e.model = str(p.model) ?? e.model;
			e.tokens = num(p.tokens) ?? e.tokens;
			e.toolCount = num(p.toolCount) ?? e.toolCount;
			e.currentTool = str(p.currentTool);
			if (str(p.error)) e.error = clip(String(p.error), 400);
			e.live = {
				tools: arr(p.recentTools).flatMap((t) => {
					const r = rec(t);
					return r && str(r.tool) ? [{ tool: String(r.tool), args: clip(str(r.args) ?? "", 400) }] : [];
				}),
				output: arr(p.recentOutput).filter((l): l is string => typeof l === "string"),
			};
			const state = toState(p.status);
			if (state && !isDone(e.state)) this.settle(e, state, now);
			else if (state && isDone(state) && !e.endedAt) this.settle(e, state, now);
		});
		arr(rec(details.workflowChildren)?.children).forEach((raw, i) => {
			const c = rec(raw);
			if (!c) return;
			// Children are keyed task-1, task-2, ... in launch order; anything else falls back to its position.
			const n = /(\d+)$/.exec(str(c.childId) ?? "");
			const index = n && Number(n[1]) >= 1 ? Number(n[1]) - 1 : i;
			const [e] = this.entry(callId, index, now);
			const childRun = str(c.runId);
			if (childRun) e.runId = childRun;
			const state = toState(c.state);
			if (state) this.settle(e, state, now);
		});
		arr(details.results).forEach((raw, i) => {
			const r = rec(raw);
			if (!r) return;
			const [e] = this.entry(callId, num(r.index) ?? i, now);
			if (runId) e.runId = runId;
			e.agent = str(r.agent) ?? e.agent;
			e.task = realTask(r.task, e.task);
			e.model = str(r.model) ?? e.model;
			e.sessionFile = str(r.sessionFile) ?? e.sessionFile;
			const usage = rec(r.usage);
			if (usage) e.tokens = (num(usage.input) ?? 0) + (num(usage.output) ?? 0) || e.tokens;
			const summary = rec(r.progressSummary);
			e.toolCount = num(summary?.toolCount) ?? e.toolCount;
			if (!final) return;
			const duration = num(summary?.durationMs);
			// Saved results are replayed after the fact, so the recorded duration is the only clue to when the child began.
			if (restoring && duration !== undefined) e.startedAt = now - duration;
			e.final = str(r.finalOutput) ?? e.final;
			if (str(r.error)) e.error = clip(String(r.error), 400);
			e.currentTool = undefined;
			const state = resultState(r);
			if (!isDone(e.state)) this.settle(e, state, now);
		});
	}

	// ---------- background runs ----------

	private finishAsync(data: unknown): void {
		const d = rec(data);
		const id = str(d?.runId) ?? str(d?.id);
		if (!d || !id) return;
		const mine = [...this.runs.values()].filter((e) => e.asyncId === id);
		if (!mine.length) return;
		const overall = toState(d.state) ?? (d.success === false ? "failed" : "completed");
		const kids = arr(d.results).map(rec);
		const now = Date.now();
		for (const e of mine) {
			const kid = kids.find((k) => k && num(k.index) === e.index);
			// The completion payload is authoritative: it overrides a guess made from a missing snapshot.
			this.settle(e, toState(kid?.status) ?? overall, now, true);
			if (str(kid?.summary)) e.final = String(kid?.summary);
			e.error = e.state === "failed" ? clip(str(d.error) ?? str(kid?.summary) ?? e.error ?? "", 400) || undefined : undefined;
		}
		this.changed();
	}

	private hasLiveBackground(): boolean {
		for (const e of this.runs.values()) if (e.asyncId && !isDone(e.state)) return true;
		return false;
	}

	private ensurePolling(): void {
		if (this.timer || this.disposed) return;
		this.failures = 0;
		this.timer = setInterval(() => void this.poll(), POLL_MS);
		this.timer.unref();
		void this.poll();
	}

	private stopPolling(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private async poll(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			const data = rec(await this.request("status", {}));
			const nodes = arr(rec(data?.asyncSnapshot)?.runs).map(rec).filter((n): n is Rec => !!n);
			this.applySnapshot(nodes);
			this.failures = 0;
		} catch {
			this.failures++;
		} finally {
			this.polling = false;
		}
		if (!this.hasLiveBackground() || this.failures >= 5) this.stopPolling();
	}

	private applySnapshot(nodes: Rec[]): void {
		const now = Date.now();
		const ids = new Set<string>();
		for (const e of this.runs.values()) if (e.asyncId && !isDone(e.state)) ids.add(e.asyncId);
		for (const id of ids) {
			const node = nodes.find((n) => n.id === id);
			if (!node) {
				// Finished runs drop out of the snapshot; the completion event normally lands first.
				const missed = (this.misses.get(id) ?? 0) + 1;
				this.misses.set(id, missed);
				if (missed >= 4) {
					for (const e of this.runs.values()) {
						if (e.asyncId === id && !isDone(e.state)) {
							e.error = "状态未知（已不在运行列表中）";
							this.settle(e, "stopped", now);
						}
					}
				}
				continue;
			}
			this.misses.delete(id);
			const kids = this.leaves(node);
			const mine = [...this.runs.values()].filter((e) => e.asyncId === id);
			const first = mine[0];
			if (!first) continue;
			if (kids.length) {
				for (const e of mine) if (!e.childId) this.runs.delete(e.id);
				for (const kid of kids) {
					const key = `${first.callId}~${id}~${str(kid.id) ?? kids.indexOf(kid)}`;
					let e = this.runs.get(key);
					if (!e) {
						e = { id: key, callId: first.callId, index: kids.indexOf(kid), agent: "agent", task: "", state: "running", background: true, startedAt: now, asyncId: id, asyncDir: first.asyncDir };
						this.runs.set(key, e);
					}
					e.childId = str(kid.id);
					this.fromNode(e, kid, now);
				}
			} else {
				for (const e of mine) this.fromNode(e, node, now);
			}
		}
		this.changed();
	}

	private leaves(node: Rec): Rec[] {
		const children = arr(node.children).map(rec).filter((n): n is Rec => !!n && n.kind !== "host-step");
		return children.flatMap((c) => (arr(c.children).length ? this.leaves(c) : [c]));
	}

	private fromNode(e: Entry, node: Rec, now: number): void {
		const label = str(node.label);
		if (label && (e.agent === "agent" || e.agent === "workflow")) e.agent = clip(label, 80);
		e.placeholder = false;
		e.startedAt = num(node.startedAt) ?? e.startedAt;
		const activity = rec(node.activity);
		e.currentTool = str(activity?.currentTool);
		e.toolCount = num(activity?.toolCount) ?? e.toolCount;
		const state = toState(node.state);
		if (state && !isDone(e.state)) this.settle(e, state, num(node.endedAt) ?? now);
	}

	// ---------- details ----------

	private async transcriptFile(e: Entry): Promise<string | undefined> {
		const candidates: string[] = [];
		if (e.sessionFile) candidates.push(e.sessionFile);
		const parent = this.parentFile();
		// Foreground children keep their session at <parent session>/<run id>/run-<n>/session.jsonl.
		if (parent && e.runId) candidates.push(join(parent.replace(/\.jsonl$/, ""), e.runId, `run-${e.index}`, "session.jsonl"));
		if (e.asyncDir) {
			try {
				const status = rec(JSON.parse(await readFile(join(e.asyncDir, "status.json"), "utf8")));
				const step = rec(arr(status?.steps)[e.index]);
				for (const key of ["sessionFile", "sessionPath"]) if (str(step?.[key])) candidates.push(String(step?.[key]));
			} catch {
				// No status file (yet): nothing to add.
			}
		}
		return candidates.find((c) => existsSync(c));
	}

	private liveSteps(e: Entry): SubagentStep[] {
		const steps: SubagentStep[] = (e.live?.tools ?? []).map((t) => ({ kind: "tool", text: "", tool: t.tool, args: t.args }));
		const output = e.live?.output.join("\n").trim();
		if (output) steps.push({ kind: "text", text: clip(output, 12000) });
		return steps;
	}

	// ---------- bookkeeping ----------

	private entry(callId: string, index: number, now: number): [Entry, boolean] {
		const id = `${callId}#${index}`;
		let e = this.runs.get(id);
		if (e) return [e, false];
		e = { id, callId, index, agent: "agent", task: "", state: "running", background: false, startedAt: now };
		this.runs.set(id, e);
		return [e, true];
	}

	private settle(e: Entry, state: SubagentState, now: number, force = false): void {
		if (isDone(e.state) && !force) return;
		e.state = state;
		if (isDone(state)) {
			e.endedAt = e.endedAt && !force ? e.endedAt : now;
			e.currentTool = undefined;
		} else {
			e.endedAt = undefined;
		}
	}

	private pub(e: Entry): SubagentRun {
		const stoppable = e.asyncId ? !isDone(e.state) : e.state === "running" && !e.background;
		return {
			id: e.id,
			callId: e.callId,
			agent: e.agent,
			task: clip(e.task, 600),
			state: e.state,
			background: e.background,
			startedAt: e.startedAt,
			...(e.endedAt !== undefined ? { endedAt: e.endedAt } : {}),
			...(e.model ? { model: e.model } : {}),
			...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
			...(e.toolCount !== undefined ? { toolCount: e.toolCount } : {}),
			...(e.currentTool ? { currentTool: e.currentTool } : {}),
			...(e.error ? { error: e.error } : {}),
			stoppable,
		};
	}

	/** Coalesce bursts of progress events into one update. */
	private changed(): void {
		if (this.flushTimer || this.disposed) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			if (!this.disposed) this.emitList(this.list());
		}, 120);
		this.flushTimer.unref();
	}
}

/**
 * pi-subagents starts background children as separate processes and must find the PI package to do
 * so. A host that is not the `pi` CLI gives it nothing to find, so point it at ours.
 */
export function ensureSubagentEnv(): void {
	const key = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";
	if (process.env[key]?.trim()) return;
	try {
		let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		for (;;) {
			const manifest = join(dir, "package.json");
			if (existsSync(manifest)) {
				const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
				if (name === "@earendil-works/pi-coding-agent") {
					process.env[key] = dir;
					return;
				}
			}
			const parent = dirname(dir);
			if (parent === dir) return;
			dir = parent;
		}
	} catch {
		// Resolution failed: background children report their own clear error.
	}
}
