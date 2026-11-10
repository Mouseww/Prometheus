// PiRuntimeSession: one PI AgentSession behind the runtime-neutral RuntimeSession interface.
// The per-session PI logic that used to live in host.ts is here; the host sees only wire shapes.
import { type AgentSession, type AgentSessionEvent, type ModelRuntime, SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import {
	AppError,
	type ChatMessage,
	type CommandInfo,
	type ImageContent,
	type MessageRef,
	type ModelRef,
	PERMISSION_MODES,
	type PermissionMode,
	type PromptDisposition,
	type SessionEvent,
	type SessionStats,
	type ThinkingLevel,
	type ToolInfo,
} from "@prometheus/protocol";
import { toModelRef } from "../../events.ts";
import type { PermissionGate } from "../../permission-gate.ts";
import { EXIT_PLAN_MODE } from "../../permissions.ts";
import type { PromptDelivery, RuntimeCapabilities, RuntimeSession, RuntimeSnapshot, SessionHooks, SessionRef, UserInput } from "../types.ts";
import { slimEvent } from "./events.ts";
import { ShellWatchdog, type StuckCall } from "./shell-watchdog.ts";
import { contextBreakdown, estimateTokens, hasReportedUsage, lastReply } from "./tokens.ts";

/** How many times in a row a hung shell command may be recovered without the user typing anything. */
const MAX_AUTO_RESUMES = 3;

export { PI_CAPABILITIES } from "./capabilities.ts";
import { PI_CAPABILITIES } from "./capabilities.ts";

export interface PiSessionOptions {
	session: AgentSession;
	modelRuntime: ModelRuntime;
	gate: PermissionGate;
	hooks?: SessionHooks;
	/** Shows a failure to the user (a prompt that PI rejected after accepting it). */
	notifyError: (message: string) => void;
	/** Hands the manager of a freshly forked session to the runtime, which resumes it from there. */
	keepFork: (manager: SessionManager) => void;
	/** Called once when the session is disposed (the runtime drops forks that were never resumed). */
	onDispose?: () => void;
	/** Called after the model changed: the compaction threshold is a share of the model's window and must be recomputed. */
	onModelChanged?: (contextWindow: number) => void;
}

type Entry = { entryId: string; message: ChatMessage };

const textOf = (content: Extract<ChatMessage, { role: "user" }>["content"]): string =>
	typeof content === "string" ? content : content.map((c) => (c.type === "text" ? c.text : "")).join("");

export class PiRuntimeSession implements RuntimeSession {
	readonly id: string;
	readonly nativeId: string;
	readonly capabilities = PI_CAPABILITIES;
	private readonly session: AgentSession;
	private readonly opts: PiSessionOptions;
	private readonly listeners = new Set<(event: SessionEvent) => void>();
	private readonly unsubscribe: () => void;
	private disposed = false;
	/** Probe for shell calls with no output change for 10 minutes (checked every 30s): aborts the turn. */
	private readonly shellWatchdog = new ShellWatchdog((call) => void this.recoverStuckShell(call));
	/** Consecutive automatic resumes after a stuck shell command; reset by any user prompt. */
	private autoResumes = 0;
	/** Where the chat stood before the last `rewind`, so a failed resubmit can put it back. */
	private rewound?: { from: string; to: string | null };

	constructor(opts: PiSessionOptions) {
		this.opts = opts;
		this.session = opts.session;
		this.id = opts.session.sessionId;
		this.nativeId = this.id;
		this.unsubscribe = opts.session.subscribe((e) => this.onPiEvent(e));
	}

	get isStreaming(): boolean {
		return this.session.isStreaming;
	}

	get cwd(): string {
		return this.session.sessionManager.getCwd();
	}

	ref(): SessionRef {
		const path = this.session.sessionFile;
		return { runtime: "pi", id: this.id, nativeId: this.nativeId, ...(path ? { path } : {}) };
	}

	// ---------- events ----------

	subscribe(listener: (event: SessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	private emit(event: SessionEvent): void {
		this.opts.hooks?.event?.(event);
		for (const listener of this.listeners) listener(event);
	}

	private onPiEvent(e: AgentSessionEvent): void {
		if (e.type === "tool_execution_start") this.shellWatchdog.start(e.toolCallId, e.toolName, e.args);
		else if (e.type === "tool_execution_update") this.shellWatchdog.touch(e.toolCallId);
		else if (e.type === "tool_execution_end") this.shellWatchdog.end(e.toolCallId);
		else if (e.type === "agent_settled") this.shellWatchdog.dispose();
		const slim = slimEvent(e);
		if (slim) this.emit(slim);
		const hooks = this.opts.hooks;
		if (e.type === "agent_start" || e.type === "agent_settled" || e.type === "session_info_changed") hooks?.sessionsChanged?.();
		// Compaction replaces the context; clients rebuild their message list from events and would otherwise keep the old one.
		if (e.type === "compaction_end" && e.result) hooks?.contextReplaced?.();
		if (e.type === "agent_settled") hooks?.settled?.();
	}

	/**
	 * Called by the gate when the permission mode changes (wired by PiRuntime before extensions bind):
	 * the plan-submission tool exists only while planning.
	 */
	onPermissionMode(mode: PermissionMode): void {
		const active = this.session.getActiveToolNames().filter((n) => n !== EXIT_PLAN_MODE);
		this.session.setActiveToolsByName(mode === "plan" ? [...active, EXIT_PLAN_MODE] : active);
		this.emit({ type: "permission_mode_changed", mode });
	}

	/** `provider/id` of the current model and the thinking level, for subagents that inherit them. */
	inherited(): { model: string | undefined; thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined } {
		const m = this.session.model;
		return { model: m ? `${m.provider}/${m.id}` : undefined, thinking: this.session.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined };
	}

	// ---------- turns ----------

	/** Abort the turn held by a hung shell command, then tell the model so it carries on (bounded, to avoid loops). */
	private async recoverStuckShell(call: StuckCall): Promise<void> {
		if (this.disposed) return;
		const secs = Math.round(call.idleMs / 1000);
		this.opts.notifyError(`Shell command had no output for ${secs}s and was aborted: ${call.command}`);
		try {
			await this.session.abort();
			// If the hung tool still does not release the turn, do not wait forever either.
			await Promise.race([this.session.waitForIdle(), new Promise<void>((r) => setTimeout(r, 15_000).unref?.())]);
		} catch {
			return;
		}
		if (this.disposed || this.autoResumes >= MAX_AUTO_RESUMES) return;
		this.autoResumes++;
		const note =
			`[系统提示] 上一条 ${call.toolName} 命令（${call.command}）连续 ${secs} 秒没有任何输出，已被自动中止。` +
			"请继续完成刚才的任务：不要原样重跑会卡住的命令，改用带 timeout 的方式、非交互参数、或放到后台运行并把输出写入日志文件后轮询；若确认只是耗时较长，可显式设置更大的 timeout 重试。";
		try {
			await this.session.prompt(note);
		} catch (err) {
			this.opts.notifyError(`Auto-resume failed: ${String(err)}`);
		}
	}

	prompt(input: UserInput, delivery: PromptDelivery): Promise<PromptDisposition> {
		this.autoResumes = 0;
		const session = this.session;
		// Resolve as soon as PI accepts the prompt; the run itself streams through events.
		return new Promise<PromptDisposition>((resolve, reject) => {
			session
				.prompt(input.context ? input.context + "\n\n" + input.text : input.text, {
					images: input.images,
					streamingBehavior: session.isStreaming ? (delivery === "send" ? "followUp" : delivery) : undefined,
					preflightResult: (disposition) => resolve(disposition),
				})
				.then(
					// PI defers a prompt submitted while it settles without reporting a disposition; it still runs.
					() => resolve("started"),
					(err: unknown) => {
						reject(err);
						this.opts.notifyError(err instanceof Error ? err.message : String(err));
					},
				);
		});
	}

	async run(input: UserInput): Promise<void> {
		await this.session.prompt(input.text);
		await this.session.waitForIdle();
	}

	abort(): Promise<void> {
		return this.session.abort();
	}

	waitForIdle(): Promise<void> {
		return this.session.waitForIdle();
	}

	lastReply(): string {
		return lastReply(this.session);
	}

	// ---------- settings ----------

	async setModel(model: ModelRef): Promise<void> {
		const target = this.opts.modelRuntime.getModel(model.provider, model.id);
		if (!target) throw new AppError("modelNotFound", { provider: model.provider, id: model.id });
		await this.session.setModel(target);
		this.opts.onModelChanged?.(this.session.model?.contextWindow ?? target.contextWindow ?? 0);
	}

	async setThinking(level: ThinkingLevel): Promise<void> {
		this.session.setThinkingLevel(level);
	}

	async setPermissionMode(mode: PermissionMode): Promise<void> {
		this.opts.gate.setMode(mode);
	}

	setName(name: string): void {
		this.session.setSessionName(name);
	}

	setAutoCompaction(enabled: boolean): void {
		// Live sessions cache their own SettingsManager.
		this.session.setAutoCompactionEnabled(enabled);
	}

	refreshTools(): Promise<void> {
		return this.session.reload();
	}

	// ---------- reading ----------

	messages(): ChatMessage[] {
		return this.session.messages as unknown as ChatMessage[];
	}

	/**
	 * What the user sees: the whole branch, compaction included as a divider where it happened.
	 * `messages()` is the model context and starts at the latest compaction summary, which would hide the history.
	 */
	private displayEntries(): Entry[] {
		const branch = this.session.sessionManager.getBranch();
		const edits = new Map<string, { content: unknown } | null>();
		for (const e of branch) if (e.type === "context_edit") edits.set(e.targetId, e.replacement);
		const out: Entry[] = [];
		for (const e of branch) {
			// Only the summary is shown for a compaction; its system message is part of the model context, not the chat.
			const messages = e.type === "compaction" ? sessionEntryToContextMessages(e).slice(-1) : sessionEntryToContextMessages(e);
			const edit = edits.get(e.id);
			if (edit === null) continue;
			for (const m of messages) {
				const r = m as unknown as { role: string; content?: unknown };
				const edited = edit && (r.role === "user" || r.role === "assistant" || r.role === "toolResult" || r.role === "custom");
				const content = edited ? (r.role !== "user" && typeof edit.content === "string" ? [{ type: "text", text: edit.content }] : edit.content) : undefined;
				out.push({ entryId: e.id, message: (edited ? { ...r, content } : m) as unknown as ChatMessage });
			}
		}
		return out;
	}

	snapshotState(): RuntimeSnapshot {
		const s = this.session;
		return {
			id: s.sessionId,
			name: s.sessionName,
			cwd: this.cwd,
			messages: this.displayEntries().map((x) => x.message),
			model: toModelRef(s.model),
			thinkingLevel: s.thinkingLevel as ThinkingLevel,
			availableThinkingLevels: s.getAvailableThinkingLevels() as ThinkingLevel[],
			isStreaming: s.isStreaming,
			queue: { steering: [...s.getSteeringMessages()], followUp: [...s.getFollowUpMessages()] },
		};
	}

	commands(): CommandInfo[] {
		const s = this.session;
		const out: CommandInfo[] = [];
		for (const c of s.extensionRunner.getRegisteredCommands()) out.push({ name: c.invocationName, description: c.description, source: "extension" });
		for (const t of s.promptTemplates) out.push({ name: t.name, description: t.description, source: "prompt" });
		for (const k of s.resourceLoader.getSkills().skills) out.push({ name: `skill:${k.name}`, description: k.description, source: "skill" });
		return out;
	}

	tools(): ToolInfo[] {
		const s = this.session;
		const active = new Set(s.getActiveToolNames());
		return s.getAllTools().filter((t) => t.name !== EXIT_PLAN_MODE).map((t) => ({ name: t.name, description: t.description ?? "", active: active.has(t.name) }));
	}

	usage(): SessionStats {
		const s = this.session;
		const stats = s.getSessionStats();
		const usage = s.getContextUsage();
		const breakdown = contextBreakdown(s);
		const piTokens = usage?.tokens ?? null;
		let tokens = Object.values(breakdown).reduce((a, b) => a + b, 0);
		let estimated = true;
		if (piTokens != null && hasReportedUsage(s)) {
			tokens = piTokens;
			estimated = false;
		}
		const contextWindow = usage?.contextWindow ?? s.model?.contextWindow ?? 0;
		return {
			contextTokens: tokens,
			contextEstimated: estimated,
			contextWindow,
			contextPercent: contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
			breakdown,
			totalCost: stats.cost,
			inputTokens: stats.tokens.input,
			outputTokens: stats.tokens.output,
			cacheReadTokens: stats.tokens.cacheRead,
			cacheWriteTokens: stats.tokens.cacheWrite,
		};
	}

	// ---------- compaction ----------

	/** Starts a compaction and returns at once with the promise of its end (it never rejects: failures reach the UI through the `compaction_end` event, and a failed restore of the keep-recent setting is only logged). */
	compact(instructions?: string): Promise<void> {
		const session = this.session;
		const settings = session.settingsManager;
		const model = session.model;
		// PI keeps the last `keepRecentTokens` (20k) verbatim, so a shorter chat has nothing to summarise; cap it at a third of the chat.
		const configured = settings.getCompactionKeepRecentTokens(model);
		const keep = Math.min(configured, Math.floor(session.messages.reduce((n, m) => n + estimateTokens(m), 0) / 3));
		const key = model ? `${model.provider}/${model.id}` : undefined;
		const apply = (n: number) => settings.applyOverrides({ compaction: { keepRecentTokens: n, ...(key ? { modelOverrides: { [key]: { keepRecentTokens: n } } } : {}) } });
		if (keep < configured) apply(keep);
		return session
			.compact(instructions)
			.then(() => undefined)
			.catch(() => undefined)
			.finally(() => {
				if (keep >= configured) return;
				try {
					apply(configured);
				} catch (err) {
					console.warn(`[prometheus] 恢复压缩设置失败: ${err instanceof Error ? err.message : err}`);
				}
			});
	}

	// ---------- message operations ----------

	/** Map a client-side message position to the session entry that produced it. */
	private locate(ref: MessageRef): { entryId: string; flat: Entry[]; pos: number } {
		const s = this.session;
		if (s.isStreaming) throw new AppError("waitForReply");
		const flat = this.displayEntries();
		const hit = flat[ref.index];
		if (!hit || hit.message.role !== ref.role || hit.message.timestamp !== ref.timestamp) throw new AppError("messageChanged");
		return { entryId: hit.entryId, flat, pos: ref.index };
	}

	/** Nearest user message at or before `pos`. */
	private userAt(flat: Entry[], pos: number): Entry {
		for (let i = pos; i >= 0; i--) {
			const item = flat[i];
			if (item?.message.role === "user") return item;
		}
		throw new AppError("messageNotFound");
	}

	async deleteMessages(ref: MessageRef): Promise<void> {
		const { entryId, flat, pos } = this.locate(ref);
		const targets = new Set([entryId]);
		const message = flat[pos]?.message;
		// Dropping a tool call without its results (or vice versa) would make the context invalid for providers.
		if (message?.role === "assistant") {
			const calls = new Set(message.content.flatMap((c) => (c?.type === "toolCall" ? [c.id] : [])));
			for (const item of flat) if (item.message.role === "toolResult" && calls.has(item.message.toolCallId)) targets.add(item.entryId);
		}
		const sm = this.session.sessionManager;
		for (const target of targets) sm.appendContextEdit(target, null);
		this.session.refreshContext();
	}

	async rewind(ref: MessageRef, edited?: string): Promise<UserInput> {
		const { flat, pos } = this.locate(ref);
		const user = this.userAt(flat, pos);
		const m = user.message as Extract<ChatMessage, { role: "user" }>;
		const text = edited ?? textOf(m.content);
		const images = typeof m.content === "string" ? [] : m.content.filter((c): c is ImageContent => c.type === "image");
		if (!text.trim() && !images.length) throw new AppError("messageEmpty");
		// Branch from before the user message; the old reply stays in the session tree.
		const sm = this.session.sessionManager;
		const from = sm.getLeafId();
		if (sm.getLeafId() === user.entryId) {
			// A message that got no reply (the run was cut off before one was saved) is itself the leaf, and PI's
			// navigateTree does nothing when asked to go to the leaf. Resending would then add the same message
			// a second time, so step back to its parent by hand.
			const parent = sm.getEntry(user.entryId)?.parentId ?? null;
			if (parent === null) sm.resetLeaf();
			else sm.branch(parent);
			this.session.refreshContext();
		} else {
			const result = await this.session.navigateTree(user.entryId);
			if (result.cancelled) throw new AppError("aborted");
		}
		this.rewound = from ? { from, to: sm.getLeafId() } : undefined;
		return { text, ...(images.length ? { images } : {}) };
	}

	undoRewind(): void {
		const undo = this.rewound;
		this.rewound = undefined;
		const sm = this.session.sessionManager;
		// Only while the chat still stands where the rewind left it: if the resubmit added anything, that is the new truth.
		if (!undo || this.session.isStreaming || sm.getLeafId() !== undo.to) return;
		sm.branch(undo.from);
		this.session.refreshContext();
	}

	/** Take one waiting message out of the steer / follow-up queue so it can be edited or dropped. */
	unqueue(kind: "steer" | "followUp", index: number, text: string): UserInput {
		// PI has no API for this: it keeps the display strings and the real messages (with pictures) in parallel
		// private lists, and both must change together. This is the only place that reaches into PI's internals.
		const internal = this.session as unknown as {
			_steeringMessages: string[];
			_followUpMessages: string[];
			_emitQueueUpdate(): void;
			agent: { steeringQueue: { messages: unknown[] }; followUpQueue: { messages: unknown[] } };
		};
		const labels = kind === "steer" ? internal._steeringMessages : internal._followUpMessages;
		const queue = kind === "steer" ? internal.agent.steeringQueue : internal.agent.followUpQueue;
		if (labels[index] !== text) throw new AppError("messageAlreadySent");
		const [message] = queue.messages.splice(index, 1) as { content?: unknown }[];
		labels.splice(index, 1);
		internal._emitQueueUpdate();
		const content = Array.isArray(message?.content) ? (message.content as ImageContent[]) : [];
		const images = content.filter((c) => c.type === "image");
		return { text, ...(images.length ? { images } : {}) };
	}

	async fork(ref: MessageRef): Promise<SessionRef & { editorText?: string }> {
		const { entryId, flat, pos } = this.locate(ref);
		const sm = this.session.sessionManager;
		const message = flat[pos]?.message;
		let leaf: string | null = entryId;
		let editorText: string | undefined;
		// Forking at a user message starts the new session just before it, with the text ready to edit.
		if (message?.role === "user") {
			leaf = sm.getEntry(entryId)?.parentId ?? null;
			editorText = textOf(message.content);
		}
		const source = this.session.sessionFile;
		let next: SessionManager;
		if (leaf && source) {
			next = SessionManager.open(source);
			next.createBranchedSession(leaf);
		} else {
			next = SessionManager.create(sm.getCwd(), undefined, source ? { parentSession: source } : undefined);
		}
		this.opts.keepFork(next);
		const id = next.getSessionId();
		const path = next.getSessionFile();
		return { runtime: "pi", id, nativeId: id, ...(path ? { path } : {}), editorText };
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.shellWatchdog.dispose();
		this.unsubscribe();
		this.opts.onDispose?.();
		this.listeners.clear();
		// AgentSession.dispose() does not emit session_shutdown (only the PI runtime does), and extensions such as the MCP client
		// close their connections and child processes there; without it every closed session leaves its MCP servers running.
		try {
			await Promise.race([
				this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
				new Promise<void>((resolve) => setTimeout(resolve, 5000).unref?.()),
			]);
		} catch {
			/* a failing shutdown hook must not keep the session from being disposed */
		}
		this.session.dispose();
	}
}
