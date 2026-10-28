import { type Attachment, toWire } from "./attachments.ts";
import { uuid } from "./uuid.ts";
import { notifyTurnDone } from "./notify.ts";
import { OPEN_FILE_TOOL } from "@prometheus/protocol";
import type {
	AssistantMessage,
	ChatMessage,
	ToolResultMessage,
	CommandInfo,
	HostSettings,
	HostInfo,
	ImageContent,
	MessageRef,
	ModelInfo,
	ModelRef,
	PackageJob,
	PermissionMode,
	GatewayChoice,
	GatewayConfig,
	PluginInfo,
	RuntimeInfo,
	RuntimeCapabilities,
	RuntimeKind,
	ServerFrame,
	SessionEvent,
	SessionSnapshot,
	SessionStats,
	SessionSummary,
	SubagentRun,
	GoalState,
	SubagentSortKey,
	ThinkingLevel,
	UIRequest,
	WorkspaceInfo,
} from "@prometheus/protocol";
import { create } from "zustand";
import type { ConnState, PrometheusClient } from "./client.ts";
import { localizeError } from "./errors.ts";
import { defineMessages, tr } from "./i18n.ts";
import { noteToolResult } from "./runtimes.ts";

const M = defineMessages({
	zh: {
		compacting: "正在压缩上下文…",
		compactFailed: "压缩失败：{e}",
		compactTooSmall: "当前对话还很短，暂无需压缩",
		alreadyCompacted: "上下文刚压缩过，暂无需再次压缩",
		compacted: "上下文已压缩",
		retrying: "请求失败，{s} 秒后重试（{a}/{m}）：{e}",
		retryFailed: "重试失败：{e}",
		forked: "已 Fork 为新会话",
		pkgInstalled: "已安装 {name}，会话已重新加载",
		pkgRemoved: "已卸载 {name}",
		pkgUpdated: "更新完成，会话已重新加载",
		pkgFailed: "{action} {name} 失败：{reason}",
		pkgInstall: "安装",
		pkgRemove: "卸载",
		pkgUpdate: "更新",
	},
	en: {
		compacting: "Compacting context…",
		compactFailed: "Compaction failed: {e}",
		compactTooSmall: "The conversation is still short; nothing to compact",
		alreadyCompacted: "Context was just compacted; nothing more to compact",
		compacted: "Context compacted",
		retrying: "Request failed, retrying in {s}s ({a}/{m}): {e}",
		retryFailed: "Retry failed: {e}",
		forked: "Forked into a new session",
		pkgInstalled: "Installed {name}; sessions reloaded",
		pkgRemoved: "Removed {name}",
		pkgUpdated: "Update complete; sessions reloaded",
		pkgFailed: "{action} {name} failed: {reason}",
		pkgInstall: "Install",
		pkgRemove: "Remove",
		pkgUpdate: "Update",
	},
});

export interface ToolRun {
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: "running" | "done" | "error";
	partial?: unknown;
	result?: unknown;
	durationMs?: number;
}

export interface Toast {
	id: string;
	message: string;
	level: "info" | "warning" | "error";
}

export interface Banner {
	kind: "retry" | "compaction";
	text: string;
}

export interface ActiveSession {
	id: string;
	name?: string;
	cwd: string;
	workspaceId: string;
	messages: ChatMessage[];
	/** Messages of the conversation before `messages[0]` that are not loaded yet; they come from the server as the user scrolls up. */
	messageOffset: number;
	/** A copy kept from an earlier visit, shown while the server sends the current one; not subscribed, so read-only. */
	preview?: boolean;
	tools: Record<string, ToolRun>;
	model: ModelRef | null;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	permissionMode: PermissionMode;
	isStreaming: boolean;
	queue: { steering: string[]; followUp: string[] };
	runtime: RuntimeKind;
	capabilities: RuntimeCapabilities;
	gateway?: GatewayChoice;
	agent?: string;
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement: string }>;
	subagents: SubagentRun[];
	/** /goal the agent works toward on its own; null when there is none. */
	goal: GoalState | null;
	banner: Banner | null;
	stats: SessionStats | null;
	/** Prompt just sent and not yet echoed by the server; shown at once so the UI reacts before the upstream does. */
	pending: { text: string; timestamp: number; images?: ImageContent[]; files?: { name: string; size: number }[] } | null;
}

export type SubagentSort = SubagentSortKey;

/** Stable empty list: a fresh `[]` per selector call would re-render forever. */
export const NO_SUBAGENTS: SubagentRun[] = [];

/** Side viewer tabs. Empty by default, so nothing is shown until a file or a terminal is actually opened. */
export type WorkbenchTab = { id: string; kind: "terminal"; cwd: string } | { id: string; kind: "folder"; cwd: string } | { id: string; kind: "file"; path: string; cwd: string; line?: number };
export interface WorkbenchUi {
	tabs: WorkbenchTab[];
	active: string | null;
}

/** The right-hand subagent panel: a list on top and the selected agent's process below, each closable on its own. */
export interface SubagentUi {
	open: boolean;
	listOpen: boolean;
	detailOpen: boolean;
	selected: string | null;
	sort: SubagentSort;
	/** Launches already seen, so only a new one reopens a panel the user closed. */
	known: string[];
}

const SORT_KEY = "prometheus.subagentSort";
function savedSort(): SubagentSort {
	const v = localStorage.getItem(SORT_KEY);
	return v === "started" || v === "ended" ? v : "status";
}

export type SettingsTab = "general" | "agents" | "gateways" | "mcp" | "connectors" | "skills" | "modes" | "subagents" | "market" | "veil" | "plugins" | "voice" | "network" | "runtimes" | "platforms" | "ssh" | "usage";
export type View = "chat" | "knowledge" | "memory" | "automations" | "git" | "settings" | { panel: string };

interface State {
	client: PrometheusClient | null;
	conn: ConnState;
	view: View;
	settingsTab: SettingsTab;
	sessions: SessionSummary[];
	/** Result of a run that finished in a conversation the user was not looking at; cleared when it is opened. */
	marks: Record<string, "done" | "error">;
	workspaces: WorkspaceInfo[];
	/** Every plugin the host knows, loaded or not; views use it to show or hide plugin-backed features. */
	plugins: PluginInfo[];
	hostSettings: HostSettings | null;
	hostInfo: HostInfo | null;
	session: ActiveSession | null;
	models: ModelInfo[];
	commands: CommandInfo[];
	uiQueue: { sessionId: string; request: UIRequest }[];
	toasts: Toast[];
	title: string | null;
	editorText: { text: string; nonce: number; images?: ImageContent[]; append?: boolean } | null;
	/** True once the first connection has restored (or decided not to restore) a session. */
	booted: boolean;
	/** Conversation the user switched to whose contents are still on the way, with the title to show meanwhile. */
	opening: { id: string; title?: string } | null;
	/** Model picked on the new-chat page before any workspace (and so any session) exists. */
	draftModel: ModelRef | null;
	/** Permission mode picked on the new-chat page before a session exists. */
	draftPermission: PermissionMode;
	/** Agent runtime picked on the new-chat page; fixed once the session exists. */
	draftRuntime: RuntimeKind;
	/** Runtimes this host can offer, with health and capabilities. */
	runtimes: RuntimeInfo[];
	/** Agent (built-in id or custom profile id) picked on the new-chat page. */
	draftAgentId: string;
	/** Configured gateways, for naming the model groups. */
	gateways: GatewayConfig[];
	/** Background marketplace operations (newest first); kept here so they survive switching Settings tabs. */
	packageJobs: PackageJob[];
	/** Bumped whenever a package operation succeeds, so views can reload the installed list. */
	packageRevision: number;
	subagentUi: SubagentUi;
	workbench: WorkbenchUi;
}

export const useStore = create<State>(() => ({
	client: null,
	conn: "idle",
	view: "chat",
	settingsTab: "general",
	sessions: [],
	marks: {},
	workspaces: [],
	plugins: [],
	hostSettings: null,
	hostInfo: null,
	session: null,
	models: [],
	commands: [],
	uiQueue: [],
	toasts: [],
	title: null,
	editorText: null,
	booted: false,
	opening: null,
	draftModel: null,
	draftPermission: "default",
	draftRuntime: "pi",
	runtimes: [],
	draftAgentId: "pi",
	gateways: [],
	packageJobs: [],
	packageRevision: 0,
	subagentUi: { open: false, listOpen: true, detailOpen: false, selected: null, sort: savedSort(), known: [] },
	workbench: { tabs: [], active: null },
}));

const set = useStore.setState;
const get = useStore.getState;

export function toast(message: string, level: Toast["level"] = "info"): void {
	const id = uuid();
	// 后端错误码在这里统一翻译，所有 toast 路径都不会漏。
	const text = localizeError(message);
	set((s) => ({ toasts: [...s.toasts.slice(-4), { id, message: text, level }] }));
	setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), level === "error" ? 8000 : 4000);
}

function errorText(err: unknown): string {
	return localizeError(err instanceof Error ? err.message : String(err));
}

/** Run an RPC and surface failures as a toast; returns undefined on error. */
export async function call<T>(fn: (c: PrometheusClient) => Promise<T>): Promise<T | undefined> {
	const client = get().client;
	if (!client) return undefined;
	try {
		return await fn(client);
	} catch (err) {
		toast(errorText(err), "error");
		return undefined;
	}
}

/** The connected server predates this method (a client newer than its remote server): the feature is simply absent there. */
export function isMissingMethod(err: unknown, method: string): boolean {
	const text = err instanceof Error ? err.message : String(err);
	return text.includes(method) && /notFound|不存在|not found/i.test(text);
}

/** Like `call`, for methods newer servers add: a server without them yields `undefined` quietly instead of an error toast. */
export async function callNewer<T>(method: string, fn: (c: PrometheusClient) => Promise<T>): Promise<T | undefined> {
	const client = get().client;
	if (!client) return undefined;
	try {
		return await fn(client);
	} catch (err) {
		if (!isMissingMethod(err, method)) toast(errorText(err), "error");
		return undefined;
	}
}

// ---------- message reconstruction ----------

function emptyAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		provider: "",
		model: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function applyDelta(msg: AssistantMessage, e: Extract<SessionEvent, { type: "message_update" }>): AssistantMessage {
	const d = e.delta;
	const content = [...msg.content];
	switch (d.type) {
		case "text_start":
			content[d.contentIndex] = { type: "text", text: "" };
			break;
		case "thinking_start":
			content[d.contentIndex] = { type: "thinking", thinking: "" };
			break;
		case "toolcall_start":
			content[d.contentIndex] = { type: "toolCall", id: d.id ?? "", name: d.name ?? "", arguments: {} };
			break;
		case "text_delta": {
			const block = content[d.contentIndex];
			content[d.contentIndex] = { type: "text", text: (block?.type === "text" ? block.text : "") + d.delta };
			break;
		}
		case "thinking_delta": {
			const block = content[d.contentIndex];
			content[d.contentIndex] = { type: "thinking", thinking: (block?.type === "thinking" ? block.thinking : "") + d.delta };
			break;
		}
		case "toolcall_end":
			content[d.contentIndex] = d.toolCall;
			break;
		default:
			return msg;
	}
	return { ...msg, content };
}

function reduce(session: ActiveSession, e: SessionEvent): ActiveSession {
	switch (e.type) {
		case "agent_start":
			return { ...session, isStreaming: true };
		case "agent_settled":
			return { ...session, isStreaming: false, banner: null, pending: null };
		case "message_start": {
			const message = e.message.role === "assistant" ? { ...emptyAssistant(), ...(e.message as AssistantMessage), content: [] } : e.message;
			return { ...session, messages: [...session.messages, message], pending: e.message.role === "user" ? null : session.pending };
		}
		case "message_update": {
			const messages = session.messages;
			const last = messages[messages.length - 1];
			if (last?.role !== "assistant") return session;
			return { ...session, messages: [...messages.slice(0, -1), applyDelta(last as AssistantMessage, e)] };
		}
		case "message_end": {
			const messages = session.messages;
			const last = messages[messages.length - 1];
			if (last && last.role === e.message.role) return { ...session, messages: [...messages.slice(0, -1), e.message] };
			return { ...session, messages: [...messages, e.message] };
		}
		case "tool_execution_start":
			return {
				...session,
				tools: { ...session.tools, [e.toolCallId]: { toolCallId: e.toolCallId, toolName: e.toolName, args: e.args, status: "running" } },
			};
		case "tool_execution_update": {
			const run = session.tools[e.toolCallId];
			if (!run) return session;
			return { ...session, tools: { ...session.tools, [e.toolCallId]: { ...run, partial: e.partialResult } } };
		}
		case "tool_execution_end": {
			noteToolResult(e.toolName, e.result);
			const run = session.tools[e.toolCallId] ?? { toolCallId: e.toolCallId, toolName: e.toolName, args: undefined, status: "running" as const };
			return {
				...session,
				tools: { ...session.tools, [e.toolCallId]: { ...run, status: e.isError ? "error" : "done", result: e.result, durationMs: e.durationMs } },
			};
		}
		case "queue_update":
			return { ...session, queue: { steering: e.steering, followUp: e.followUp } };
		case "compaction_start":
			return { ...session, banner: { kind: "compaction", text: tr(M, "compacting") } };
		case "compaction_end":
			if (e.errorMessage?.includes("Nothing to compact")) toast(tr(M, "compactTooSmall"));
			else if (e.errorMessage?.includes("Already compacted")) toast(tr(M, "alreadyCompacted"));
			else if (e.errorMessage) toast(tr(M, "compactFailed", { e: e.errorMessage.replace(/^Compaction failed:\s*/, "") }), "error");
			else if (!e.aborted && e.reason === "manual") toast(tr(M, "compacted"));
			return { ...session, banner: null };
		case "auto_retry_start":
			return {
				...session,
				banner: { kind: "retry", text: tr(M, "retrying", { s: Math.round(e.delayMs / 1000), a: e.attempt, m: e.maxAttempts, e: e.errorMessage }) },
			};
		case "auto_retry_end":
			if (!e.success && e.finalError) toast(tr(M, "retryFailed", { e: e.finalError }), "error");
			return { ...session, banner: null };
		case "messages_reset":
			// A reset carries the latest turns; earlier ones load on scroll like after opening.
			return { ...session, messages: e.messages, messageOffset: e.offset ?? 0 };
		case "session_info_changed":
			return { ...session, name: e.name };
		case "thinking_level_changed":
			return { ...session, thinkingLevel: e.level };
		case "model_changed":
			return { ...session, model: e.model };
		case "permission_mode_changed":
			return { ...session, permissionMode: e.mode };
		case "subagents_update":
			return { ...session, subagents: e.runs };
		case "goal_update":
			return { ...session, goal: e.goal };
		default:
			return session;
	}
}

// Deltas arrive far faster than the screen refreshes; fold them into one state update per frame.
let buffer: SessionEvent[] = [];
let scheduled = false;

function flush(): void {
	scheduled = false;
	const events = buffer;
	buffer = [];
	const session = get().session;
	if (!session || !events.length) return;
	let next = session;
	for (const e of events) next = reduce(next, e);
	set({ session: next });
	if (next.subagents !== session.subagents) noteSubagents(next.subagents);
	for (const e of events) if (e.type === "tool_execution_start") noteWorkbenchTool(e.toolName, e.args, session.cwd);
	if (events.some((e) => e.type === "agent_settled" || e.type === "message_end" || e.type === "compaction_end")) void refreshStats();
}

function enqueue(e: SessionEvent): void {
	buffer.push(e);
	if (!scheduled) {
		scheduled = true;
		requestAnimationFrame(flush);
	}
}

// ---------- frames ----------

export function handleFrame(frame: ServerFrame): void {
	const active = get().session;
	switch (frame.type) {
		case "event": {
			const t = frame.event.type;
			if (t === "agent_start" || t === "agent_settled") {
				const running = t === "agent_start";
				set((s) => ({ sessions: s.sessions.map((x) => (x.id === frame.sessionId && x.running !== running ? { ...x, running } : x)) }));
				if (running) {
					erroredRuns.delete(frame.sessionId);
					clearMark(frame.sessionId);
				} else if (frame.event.type === "agent_settled" && !frame.event.aborted && frame.sessionId !== active?.id) {
					const mark = erroredRuns.has(frame.sessionId) ? "error" : "done";
					set((s) => ({ marks: { ...s.marks, [frame.sessionId]: mark } }));
				}
			}
			if (frame.event.type === "message_end" && frame.event.message.role === "assistant" && (frame.event.message as AssistantMessage).stopReason === "error") erroredRuns.add(frame.sessionId);
			if (frame.event.type === "agent_settled" && !frame.event.aborted) notifyTurnDone(get().sessions.find((x) => x.id === frame.sessionId)?.name ?? active?.name ?? "");
			if (frame.sessionId === active?.id) enqueue(frame.event);
			return;
		}
		case "ui.request":
			return handleUIRequest(frame.sessionId, frame.request);
		case "ui.resolved":
			set((s) => ({ uiQueue: s.uiQueue.filter((q) => q.request.id !== frame.requestId) }));
			return;
		case "sessions.changed":
			void refreshSessions();
			void refreshWorkspaces();
			return;
		case "gateways.changed":
			void refreshGateways();
			{
				const open = get().session;
				if (!open) void refreshDraftModels();
				else void refreshSessionModels(open.runtime ?? "pi", open.agent);
			}
			return;
		case "plugins.changed":
			void refreshPlugins();
			return;
		case "plugin.notify":
			for (const fn of pluginListeners.get(frame.plugin) ?? []) fn();
			return;
		case "error":
			toast(frame.message, "error");
			return;
	}
}

function handleUIRequest(sessionId: string, r: UIRequest): void {
	const active = get().session;
	switch (r.method) {
		case "notify":
			return toast(r.message, r.level);
		case "setTitle":
			set({ title: r.title });
			return;
		case "setEditorText":
			set({ editorText: { text: r.text, nonce: Date.now() } });
			return;
		case "setStatus": {
			if (!active || active.id !== sessionId) return;
			const statuses = { ...active.statuses };
			if (r.text === undefined) delete statuses[r.key];
			else statuses[r.key] = r.text;
			set({ session: { ...active, statuses } });
			return;
		}
		case "setWidget": {
			if (!active || active.id !== sessionId) return;
			const widgets = { ...active.widgets };
			if (!r.lines) delete widgets[r.key];
			else widgets[r.key] = { lines: r.lines, placement: r.placement ?? "aboveEditor" };
			set({ session: { ...active, widgets } });
			return;
		}
		default:
			set((s) => ({ uiQueue: [...s.uiQueue, { sessionId, request: r }] }));
	}
}

// ---------- actions ----------

function fromSnapshot(s: SessionSnapshot): ActiveSession {
	return {
		id: s.id,
		name: s.name,
		cwd: s.cwd,
		workspaceId: s.workspaceId,
		messages: s.messages,
		messageOffset: s.messageOffset ?? 0,
		tools: {},
		model: s.model,
		thinkingLevel: s.thinkingLevel,
		availableThinkingLevels: s.availableThinkingLevels,
		permissionMode: s.permissionMode,
		isStreaming: s.isStreaming,
		queue: s.queue,
		statuses: s.statuses,
		widgets: s.widgets,
		subagents: s.subagents ?? [],
		runtime: s.runtime ?? "pi",
		capabilities: s.capabilities,
		gateway: s.gateway,
		agent: s.agent,
		goal: s.goal ?? null,
		banner: null,
		stats: null,
		pending: null,
	};
}

/** Stop following the conversation on screen, keeping a copy so coming back to it paints at once. */
function leave(previous: ActiveSession | null, nextId: string): void {
	if (!previous || previous.id === nextId) return;
	const client = get().client;
	if (!previous.preview) client?.unsubscribe(previous.id);
	remember(previous);
	// An untouched new-chat session is never listed, so nothing else would ever release it.
	if (previous.messages.length === 0 && !previous.isStreaming) void client?.rpc("session.close", { sessionId: previous.id }).catch(() => undefined);
}

function activate(snapshot: SessionSnapshot): void {
	const client = get().client;
	const previous = get().session;
	leave(previous, snapshot.id);
	client?.subscribe(snapshot.id);
	buffer = [];
	const runs = snapshot.subagents ?? [];
	set((s) => ({
		subagentUi: { ...s.subagentUi, open: runs.some(isLive), listOpen: true, detailOpen: false, selected: null, known: [...new Set(runs.map((r) => r.callId))] },
	}));
	set({
		session: fromSnapshot(snapshot),
		view: "chat",
		draftModel: null,
		uiQueue: [
			// Prompts of other sessions stay pending on the server; only this session's are refreshed from its snapshot.
			...get().uiQueue.filter((q) => q.sessionId !== snapshot.id),
			...snapshot.pendingUI.filter((r) => !["notify", "setStatus", "setWidget", "setTitle", "setEditorText"].includes(r.method)).map((request) => ({ sessionId: snapshot.id, request })),
		],
	});
	if (snapshot.runtime && snapshot.runtime !== "pi") void refreshSessionModels(snapshot.runtime, snapshot.agent, snapshot.id);
	else if (previous && (previous.runtime ?? "pi") !== "pi") void refreshModels();
	localStorage.setItem("prometheus.lastSession", snapshot.id);
	void refreshCommands();
	void refreshStats();
}

export async function refreshSessions(): Promise<void> {
	const sessions = await coalesce("sessions", () => call((c) => c.rpc("session.list", {})));
	// One row per id: two rows of the same conversation would share every action, including delete.
	if (sessions) set({ sessions: sessions.filter((s, i) => sessions.findIndex((x) => x.id === s.id) === i) });
}

export async function refreshWorkspaces(): Promise<void> {
	const workspaces = await coalesce("workspaces", () => call((c) => c.rpc("workspace.list", {})));
	if (workspaces) set({ workspaces });
}

/**
 * One in-flight request per key.
 *
 * `sessions.changed` fires on every run start and settle, and the handler used to refetch the whole
 * session index each time — several full directory scans per turn, each re-rendering the sidebar.
 * Sharing the running request keeps the list fresh without stacking scans.
 */
let inflight = new Map<string, Promise<unknown>>();

function coalesce<T>(key: string, run: () => Promise<T | undefined>): Promise<T | undefined> {
	const running = inflight.get(key) as Promise<T | undefined> | undefined;
	if (running) return running;
	const next = run().finally(() => inflight.delete(key));
	inflight.set(key, next);
	return next;
}

export async function refreshPlugins(): Promise<void> {
	const plugins = await get().client?.rpc("plugin.list", {}).catch(() => undefined);
	if (plugins) set({ plugins });
}

/** A plugin that is installed, enabled and running; its sidebar entry and chat features appear only then. */
export function pluginActive(plugins: PluginInfo[], name: string): boolean {
	return plugins.some((p) => p.name === name && p.status === "loaded");
}

const pluginListeners = new Map<string, Set<() => void>>();

/** Runs `fn` whenever the named plugin reports a data change; returns the unsubscribe. */
export function onPluginChange(plugin: string, fn: () => void): () => void {
	const set_ = pluginListeners.get(plugin) ?? new Set();
	set_.add(fn);
	pluginListeners.set(plugin, set_);
	return () => void set_.delete(fn);
}

export async function refreshHostSettings(): Promise<void> {
	const hostSettings = await call((c) => c.rpc("settings.get", {}));
	if (hostSettings) set({ hostSettings });
}

export async function refreshHostInfo(): Promise<void> {
	const hostInfo = await call((c) => c.rpc("host.info", {}));
	if (hostInfo) set({ hostInfo });
}

export async function updateHostSettings(patch: Partial<HostSettings>): Promise<void> {
	const hostSettings = await call((c) => c.rpc("settings.set", patch));
	if (hostSettings) set({ hostSettings });
}

export async function refreshModels(): Promise<void> {
	const models = await call((c) => c.rpc("model.list", {}));
	if (models) set({ models });
}

/** Model list for an open chat: what its agent can use, across the agent's own login and every compatible gateway. */
async function refreshSessionModels(runtime: RuntimeKind, agent: string | undefined, sessionId?: string): Promise<void> {
	if (runtime === "pi") return refreshModels();
	const models = await callNewer("runtime.models", (c) => c.rpc("runtime.models", { runtime, agent }));
	if (models && (!sessionId || get().session?.id === sessionId)) set({ models });
}

async function refreshCommands(): Promise<void> {
	const id = get().session?.id;
	if (!id) return;
	const commands = await call((c) => c.rpc("commands.list", { sessionId: id }));
	if (commands) set({ commands });
}

export async function refreshStats(): Promise<void> {
	const session = get().session;
	if (!session) return;
	const stats = await get().client?.rpc("session.stats", { sessionId: session.id }).catch(() => undefined);
	const current = get().session;
	if (stats && current?.id === session.id) set({ session: { ...current, stats } });
}

export async function refreshRuntimes(): Promise<void> {
	// An older remote server has no agent runtimes: leave the list empty and the agent menu stays hidden.
	const runtimes = await callNewer("runtime.list", (c) => c.rpc("runtime.list", {}));
	set({ runtimes: runtimes ?? [] });
}

/** Model list of the agent picked on the new-chat page: PI's shared list, or everything the agent can use (own login plus gateways). */
export async function refreshDraftModels(): Promise<void> {
	const { draftRuntime: runtime, draftAgentId: agent } = get();
	if (runtime === "pi") return refreshModels();
	const models = await call((c) => c.rpc("runtime.models", { runtime, agent }));
	if (models) set({ models });
}

export async function refreshGateways(): Promise<void> {
	const gateways = await call((c) => c.rpc("gateway.list", {}));
	if (gateways) set({ gateways });
}

/** The agent id a session carries: only custom agents need one, the built-ins are identified by their kind. */
function customAgent(info: Pick<RuntimeInfo, "id" | "kind">): string | undefined {
	return info.id === info.kind ? undefined : info.id;
}

/** Continue the open conversation with another agent: the conversation moves to another runtime in the same folder and the old session is deleted. The current model is kept when the new agent can use it. */
export async function switchRuntime(info: RuntimeInfo): Promise<void> {
	const session = get().session;
	if (!session || session.isStreaming) return;
	const models = info.kind === "pi" ? [] : ((await call((c) => c.rpc("runtime.models", { runtime: info.kind, agent: info.id }))) ?? []);
	const cur = session.model;
	const keep = cur && models.find((m) => m.provider === cur.provider && m.id === cur.id);
	const snap = await call((c) =>
		c.rpc("session.switchRuntime", { sessionId: session.id, runtime: info.kind, agent: customAgent(info), ...(keep ? { model: { provider: keep.provider, id: keep.id } } : {}) }),
	);
	if (!snap) return;
	get().client?.unsubscribe(session.id);
	activate(snap);
}

/**
 * New-chat agent; its model list replaces the current one. The new-chat page may already hold an empty session (choosing a
 * workspace creates it), and that session belongs to the previous agent: replace it with one of the chosen agent in the same
 * folder, or the first message would still go to the old agent.
 */
export async function setDraftAgent(info: RuntimeInfo): Promise<void> {
	const empty = get().session;
	const replace = empty && empty.messages.length === 0 && !empty.pending && !empty.isStreaming ? empty : null;
	set({ draftRuntime: info.kind, draftAgentId: info.id, draftModel: null });
	if (!replace) {
		void refreshDraftModels();
		return;
	}
	const permission = replace.permissionMode;
	get().client?.unsubscribe(replace.id);
	await createSession(replace.cwd);
	const created = get().session;
	if (!created || created.id === replace.id) return;
	// The empty session of the previous agent is of no use any more.
	void get().client?.rpc("session.delete", { sessionId: replace.id }).catch(() => {});
	set({ draftModel: null });
	if (permission !== created.permissionMode) await setPermissionMode(permission);
}

export async function createSession(cwd?: string): Promise<void> {
	const { draftRuntime: runtime, draftAgentId, draftModel } = get();
	const agent = customAgent({ id: draftAgentId, kind: runtime });
	const snap = await call((c) =>
		c.rpc("session.create", runtime === "pi" ? { cwd } : { cwd, runtime, ...(agent ? { agent } : {}), ...(draftModel ? { model: draftModel } : {}) }),
	);
	if (snap) activate(snap);
}


/** Conversations shown recently, as they were when left. Reopening one paints this copy while the fresh one comes over the network. */
const recent = new Map<string, ActiveSession>();
const RECENT_MAX = 12;

function remember(s: ActiveSession): void {
	if (s.messages.length === 0) return;
	recent.delete(s.id);
	recent.set(s.id, { ...s, preview: undefined, pending: null, banner: null });
	while (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value as string);
}

let openSeq = 0;

function clearMark(id: string): void {
	if (get().marks[id]) set((s) => ({ marks: Object.fromEntries(Object.entries(s.marks).filter(([k]) => k !== id)) }));
}

/** Sessions whose latest run produced an error reply. */
const erroredRuns = new Set<string>();

/**
 * Switch to a conversation. Its contents come from the server, which on a slow link takes a while, so the switch shows at
 * once: the copy kept from the last visit if there is one (refreshed when the server answers), a placeholder otherwise.
 * Only the last of several quick clicks wins, whatever order the answers arrive in.
 */
export async function openSession(sessionId: string): Promise<void> {
	const seq = ++openSeq;
	clearMark(sessionId);
	const current = get().session;
	const summary = get().sessions.find((s) => s.id === sessionId);
	const cached = current?.id === sessionId ? undefined : recent.get(sessionId);
	if (cached) {
		leave(current, sessionId);
		set({ session: { ...cached, preview: true }, opening: null, view: "chat" });
	} else if (current?.id !== sessionId || current.preview) {
		set({ opening: { id: sessionId, title: summary?.name || summary?.firstMessage }, view: "chat" });
	}
	// The server decides how much of the conversation comes now; the rest loads as the user scrolls up.
	const snap = await call((c) => c.rpc("session.open", { sessionId }));
	if (seq !== openSeq) return;
	if (snap) {
		activate(snap);
		set({ opening: null });
		return;
	}
	// Could not open it (gone, or the connection dropped): do not leave a copy on screen that nothing keeps up to date.
	recent.delete(sessionId);
	set({ opening: null });
	if (get().session?.preview) set({ session: null });
}

const warmedAt = new Map<string, number>();
let warmTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The pointer is over a conversation in the list: have the server open it now, so the click that probably follows finds
 * it ready. Waits a moment so sweeping across the list does not warm every row, and asks again for a row only after a while.
 */
export function prefetchSession(sessionId: string): void {
	const current = get().session;
	if (current?.id === sessionId) return;
	const at = warmedAt.get(sessionId);
	if (at !== undefined && Date.now() - at < 60_000) return;
	clearTimeout(warmTimer);
	warmTimer = setTimeout(() => {
		warmedAt.set(sessionId, Date.now());
		void get().client?.rpc("session.warm", { sessionId }).catch(() => {
			// An older server has no such method, or the conversation is gone: nothing to warm.
			warmedAt.delete(sessionId);
		});
	}, 150);
}

/** The whole text of a tool result that the conversation carried only the start of. */
export async function fetchToolResult(toolCallId: string): Promise<ToolResultMessage["content"] | undefined> {
	const session = get().session;
	if (!session) return undefined;
	return (await call((c) => c.rpc("session.toolResult", { sessionId: session.id, toolCallId })))?.content;
}

let loadingEarlier = false;

/** Fetch the turns before the first loaded message and put them in front. */
export async function loadEarlier(): Promise<void> {
	const session = get().session;
	if (!session || session.messageOffset <= 0 || loadingEarlier) return;
	loadingEarlier = true;
	try {
		const chunk = await call((c) => c.rpc("session.messages", { sessionId: session.id, before: session.messageOffset }));
		const now = get().session;
		// The conversation changed underneath (another one opened, or it was reset): the chunk no longer fits.
		if (!chunk || !now || now.id !== session.id || now.messageOffset !== session.messageOffset) return;
		set({ session: { ...now, messages: [...chunk.messages, ...now.messages], messageOffset: chunk.offset } });
	} finally {
		loadingEarlier = false;
	}
}

/** Show the new-chat page: leave the current conversation (it keeps running) until a workspace is chosen. */
export function startNewChat(): void {
	const current = get().session;
	// A conversation still loading must not take over the screen when it arrives.
	openSeq++;
	set({ view: "chat", opening: null });
	// Already on the new-chat page: keep the workspace chosen so far.
	if (!current || current.messages.length === 0) return;
	if (!current.preview) get().client?.unsubscribe(current.id);
	remember(current);
	buffer = [];
	const draft = defaultDraft();
	const wasPi = draft.draftRuntime === "pi" && get().draftRuntime === "pi" && (current.runtime ?? "pi") === "pi";
	set({ session: null, commands: [], draftModel: wasPi ? current.model : null, draftPermission: "default", ...draft });
	if (!wasPi) void refreshDraftModels();
}

/** The agent a new chat starts with: the one set as default under Agent runtimes, or PI when it is missing or unavailable. */
function defaultDraft(): { draftRuntime: RuntimeKind; draftAgentId: string } {
	const id = get().hostSettings?.defaultAgent ?? "pi";
	const info = id === "pi" ? undefined : get().runtimes.find((r) => r.id === id && r.health.available);
	return info ? { draftRuntime: info.kind, draftAgentId: info.id } : { draftRuntime: "pi", draftAgentId: "pi" };
}

/** Make `agentId` the agent of new chats; the new-chat page, if showing and untouched, follows right away. */
export async function setDefaultAgent(agentId: string): Promise<void> {
	await updateHostSettings({ defaultAgent: agentId });
	if (get().session) return;
	const draft = defaultDraft();
	if (draft.draftAgentId === get().draftAgentId) return;
	set({ ...draft, draftModel: null });
	void refreshDraftModels();
}

/** Pick the workspace of the new-chat page, carrying over any model and thinking level chosen so far. */
export async function chooseWorkspace(path: string): Promise<void> {
	const prev = get().session;
	if (prev && (prev.messages.length > 0 || prev.isStreaming)) return;
	const model = prev?.model ?? get().draftModel;
	const draftWasPi = get().draftRuntime === "pi";
	const thinking = draftWasPi ? prev?.thinkingLevel : undefined;
	const permission = prev?.permissionMode ?? get().draftPermission;
	await createSession(path);
	const created = get().session;
	if (!created || created.id === prev?.id) return;
	set({ draftModel: null, draftPermission: "default" });
	if (permission !== created.permissionMode) await setPermissionMode(permission);
	if (draftWasPi && model && (created.model?.provider !== model.provider || created.model.id !== model.id)) await setModel(model);
	const ready = get().session;
	if (thinking && ready && thinking !== ready.thinkingLevel && ready.availableThinkingLevels.includes(thinking)) await setThinking(thinking);
}

/** New-chat page with `workspace` already chosen; keeps the current model and thinking level like the picker does. */
export async function newChatIn(workspace: WorkspaceInfo): Promise<void> {
	const current = get().session;
	if (current && current.messages.length === 0 && !current.pending && current.workspaceId === workspace.id) {
		set({ view: "chat" });
		return;
	}
	startNewChat();
	await chooseWorkspace(workspace.path);
}

/** After the active session disappears, fall back to the newest one in the same workspace, else the new-chat page. */
async function leaveSession(sessionId: string): Promise<void> {
	recent.delete(sessionId);
	const current = get().session;
	if (current?.id !== sessionId) return;
	get().client?.unsubscribe(sessionId);
	set({ session: null });
	await refreshSessions();
	const next = get().sessions.find((s) => !s.archived && s.id !== sessionId && s.workspaceId === current.workspaceId);
	if (next) await openSession(next.id);
}

export async function archiveSession(sessionId: string, archived: boolean): Promise<void> {
	const ok = await call((c) => c.rpc("session.archive", { sessionId, archived }));
	if (ok !== undefined && archived) await leaveSession(sessionId);
}

export async function deleteSession(sessionId: string): Promise<void> {
	const ok = await call((c) => c.rpc("session.delete", { sessionId }));
	if (ok !== undefined) await leaveSession(sessionId);
}

export async function renameSession(sessionId: string, name: string): Promise<void> {
	await call((c) => c.rpc("session.rename", { sessionId, name }));
}

function refOf(index: number): MessageRef | null {
	const session = get().session;
	const m = session?.messages[index];
	// The list shows a window of the conversation; the server counts from its start.
	return m && session ? { index: index + session.messageOffset, role: m.role, timestamp: m.timestamp } : null;
}

export async function deleteMessage(index: number): Promise<void> {
	const session = get().session;
	const ref = refOf(index);
	if (session && ref) await call((c) => c.rpc("message.delete", { sessionId: session.id, ref }));
}

export async function retryMessage(index: number): Promise<void> {
	const session = get().session;
	const ref = refOf(index);
	if (session && ref) await call((c) => c.rpc("message.retry", { sessionId: session.id, ref }));
}

/** Branch from before a sent message and run it again with new words (its pictures stay). */
export async function editMessage(index: number, text: string): Promise<boolean> {
	const session = get().session;
	const ref = refOf(index);
	if (!session || !ref) return false;
	return (await call((c) => c.rpc("message.edit", { sessionId: session.id, ref, text }))) !== undefined;
}

/** Pull a waiting message out of the queue; with `edit` it goes back to the composer, otherwise it is dropped. */
export async function unqueue(kind: "steer" | "followUp", index: number, text: string, edit: boolean): Promise<void> {
	const session = get().session;
	if (!session) return;
	const taken = await call((c) => c.rpc("chat.unqueue", { sessionId: session.id, kind, index, text }));
	if (taken && edit) set({ editorText: { text: taken.text, nonce: Date.now(), images: taken.images, append: true } });
}

export async function forkMessage(index: number): Promise<void> {
	const session = get().session;
	const ref = refOf(index);
	if (!session || !ref) return;
	const result = await call((c) => c.rpc("message.fork", { sessionId: session.id, ref }));
	if (!result) return;
	activate(result.snapshot);
	if (result.editorText) set({ editorText: { text: result.editorText, nonce: Date.now() } });
	toast(tr(M, "forked"));
}

export async function addWorkspace(path: string): Promise<WorkspaceInfo | undefined> {
	const w = await call((c) => c.rpc("workspace.add", { path }));
	if (w) await refreshWorkspaces();
	return w;
}

export async function sendPrompt(text: string, delivery?: "steer" | "followUp", images?: ImageContent[], files?: Attachment[]): Promise<boolean> {
	const session = get().session;
	if (!session || session.pending) return false;

	// Queued/steered messages ride on a run that is already visible; only a fresh run needs the instant echo.
	const mark = session.isStreaming ? null : { text, timestamp: Date.now(), ...(images?.length ? { images } : {}), ...(files?.length ? { files: files.map((f) => ({ name: f.name, size: f.size })) } : {}) };
	if (mark) set({ session: { ...session, pending: mark } });

	const result = await call((c) => c.rpc("chat.prompt", { sessionId: session.id, text, delivery, ...(images?.length ? { images } : {}), ...(files?.length ? { files: toWire(files) } : {}) }));

	// Only a started run echoes the user message later; anything else must drop the placeholder now.
	if (mark && result?.disposition !== "started") {
		const current = get().session;
		if (current?.id === session.id && current.pending === mark) set({ session: { ...current, pending: null } });
	}
	return result !== undefined;
}

/** Pause, resume or drop the open conversation's goal. */
export async function controlGoal(action: "pause" | "resume" | "clear"): Promise<void> {
	const session = get().session;
	if (!session) return;
	const goal = await callNewer("goal.control", (c) => c.rpc("goal.control", { sessionId: session.id, action }));
	const current = get().session;
	if (goal !== undefined && current?.id === session.id) set({ session: { ...current, goal } });
}

export async function abortRun(): Promise<void> {
	const session = get().session;
	if (session) await call((c) => c.rpc("chat.abort", { sessionId: session.id }));
}

const isLive = (r: SubagentRun) => r.state === "running" || r.state === "queued";

/** A launch the panel has not seen yet opens it, even if the user closed it before. */
function noteSubagents(runs: SubagentRun[]): void {
	const ui = get().subagentUi;
	const fresh = runs.map((r) => r.callId).filter((id) => !ui.known.includes(id));
	if (!fresh.length) return;
	set({ subagentUi: { ...ui, open: true, listOpen: true, known: [...ui.known, ...new Set(fresh)] } });
}

// ---------- workbench (file viewer) ----------

/** Open (or focus) a file in the side viewer; a line re-scrolls an already open tab. */
export function openFile(path: string, cwd: string, line?: number): void {
	const id = `file:${cwd}::${path}`;
	set((s) => {
		const old = s.workbench.tabs.find((t) => t.id === id);
		const tab: WorkbenchTab = { id, kind: "file", path, cwd, line };
		const tabs = old ? s.workbench.tabs.map((t) => (t.id === id ? tab : t)) : [...s.workbench.tabs, tab];
		return { workbench: { tabs, active: id } };
	});
}

/** Server-side shell id of each open terminal tab, so switching tabs keeps the same shell. */
export const terminalIds = new Map<string, string>();

/** Open a terminal in the given folder (the current session's), or focus the one already open. */
export function openTerminalTab(cwd: string): void {
	set((s) => ({ workbench: { tabs: s.workbench.tabs.some((t) => t.kind === "terminal") ? s.workbench.tabs : [...s.workbench.tabs, { id: "terminal", kind: "terminal", cwd }], active: "terminal" } }));
}

/** Open the folder tree for the current session's folder, or focus the one already open. */
export function openFolderTab(cwd: string): void {
	set((s) => ({ workbench: { tabs: s.workbench.tabs.some((t) => t.kind === "folder") ? s.workbench.tabs : [...s.workbench.tabs, { id: "folder", kind: "folder", cwd }], active: "folder" } }));
}

export function closeWorkbenchTab(id: string): void {
	const shell = terminalIds.get(id);
	if (shell) {
		terminalIds.delete(id);
		void get().client?.rpc("plugin.call", { plugin: "terminal", method: "close", params: { id: shell } }).catch(() => undefined);
	}
	set((s) => {
		const idx = s.workbench.tabs.findIndex((t) => t.id === id);
		const tabs = s.workbench.tabs.filter((t) => t.id !== id);
		const active = s.workbench.active === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.workbench.active;
		return { workbench: { tabs, active } };
	});
}

export function activateWorkbenchTab(id: string): void {
	set((s) => ({ workbench: { ...s.workbench, active: id } }));
}

/** A live tool call on the viewer's behalf opens its tab; history loaded on connect never does. */
function noteWorkbenchTool(name: string, args: unknown, cwd: string): void {
	if (!pluginActive(get().plugins, "workbench")) return;
	if (name === OPEN_FILE_TOOL) {
		const a = (args ?? {}) as { path?: unknown; line?: unknown };
		if (typeof a.path === "string") openFile(a.path, cwd, typeof a.line === "number" ? a.line : undefined);
	}
}

/** Show a subagent's process in the lower half, opening the panel if needed. */
export function selectSubagent(id: string): void {
	set((s) => ({ subagentUi: { ...s.subagentUi, open: true, detailOpen: true, selected: id } }));
}

/** The title-bar button: hide the panel, or bring back whichever regions make sense. */
export function toggleSubagentPanel(): void {
	set((s) => {
		const ui = s.subagentUi;
		if (ui.open) return { subagentUi: { ...ui, open: false } };
		return { subagentUi: { ...ui, open: true, listOpen: true, detailOpen: ui.selected !== null } };
	});
}

export function closeSubagentRegion(region: "list" | "detail"): void {
	set((s) => {
		const ui = { ...s.subagentUi, ...(region === "list" ? { listOpen: false } : { detailOpen: false }) };
		return { subagentUi: { ...ui, open: ui.listOpen || ui.detailOpen } };
	});
}

export function openSubagentList(): void {
	set((s) => ({ subagentUi: { ...s.subagentUi, open: true, listOpen: true } }));
}

export function setSubagentSort(sort: SubagentSort): void {
	localStorage.setItem(SORT_KEY, sort);
	set((s) => ({ subagentUi: { ...s.subagentUi, sort } }));
}

/** Stopping ends only that agent; the conversation and its other agents carry on. */
export async function stopSubagent(id: string): Promise<void> {
	const session = get().session;
	if (session) await call((c) => c.rpc("subagent.stop", { sessionId: session.id, id }));
}

export async function setModel(model: ModelRef): Promise<void> {
	const session = get().session;
	if (!session) {
		set({ draftModel: model });
		return;
	}
	await call((c) => c.rpc("model.set", { sessionId: session.id, model }));
	const snap = await call((c) => c.rpc("session.open", { sessionId: session.id, tail: 1 }));
	const current = get().session;
	if (snap && current) set({ session: { ...current, model: snap.model, thinkingLevel: snap.thinkingLevel, availableThinkingLevels: snap.availableThinkingLevels, gateway: snap.gateway } });
	void refreshStats();
}

export async function setThinking(level: ThinkingLevel): Promise<void> {
	const session = get().session;
	if (session) await call((c) => c.rpc("thinking.set", { sessionId: session.id, level }));
}

export async function setPermissionMode(mode: PermissionMode): Promise<void> {
	const session = get().session;
	if (!session) {
		set({ draftPermission: mode });
		return;
	}
	const ok = await call((c) => c.rpc("permission.set", { sessionId: session.id, mode }));
	// The server echoes a permission_mode_changed event; setting it here too keeps the picker instant.
	const current = get().session;
	if (ok !== undefined && current?.id === session.id) set({ session: { ...current, permissionMode: mode } });
}

export async function respondUI(sessionId: string, requestId: string, response: { value: string } | { confirmed: boolean } | { cancelled: true }): Promise<void> {
	set((s) => ({ uiQueue: s.uiQueue.filter((q) => q.request.id !== requestId) }));
	await call((c) => c.rpc("ui.respond", { sessionId, requestId, response }));
}

export function setView(view: View): void {
	set({ view });
}

export function openSettings(tab: SettingsTab = "general"): void {
	set({ view: "settings", settingsTab: tab });
}

/** Call a method a plugin registered with ctx.rpc(); errors surface as toasts. */
export function pluginCall<T>(plugin: string, method: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
	return call(async (c) => (await c.rpc("plugin.call", { plugin, method, params })) as T);
}

// ---------- marketplace jobs ----------

const isActive = (j: PackageJob) => j.status === "queued" || j.status === "running";
const JOB_POLL_MS = 1000;
let jobTimer: ReturnType<typeof setInterval> | undefined;
/** Jobs this client has seen running, so only those produce a result toast (not old history after a reload). */
const watched = new Set<string>();

function announce(job: PackageJob): void {
	const action = tr(M, job.action === "install" ? "pkgInstall" : job.action === "remove" ? "pkgRemove" : "pkgUpdate");
	if (job.status === "error") {
		toast(tr(M, "pkgFailed", { action, name: job.label, reason: job.error ?? "" }), "error");
		return;
	}
	toast(tr(M, job.action === "install" ? "pkgInstalled" : job.action === "remove" ? "pkgRemoved" : "pkgUpdated", { name: job.label }));
	set((s) => ({ packageRevision: s.packageRevision + 1 }));
}

function applyJobs(jobs: PackageJob[]): void {
	for (const j of jobs) {
		if (isActive(j)) watched.add(j.id);
		else if (watched.delete(j.id)) announce(j);
	}
	set({ packageJobs: jobs });
	if (jobs.some(isActive)) {
		jobTimer ??= setInterval(() => void refreshPackageJobs(), JOB_POLL_MS);
	} else if (jobTimer) {
		clearInterval(jobTimer);
		jobTimer = undefined;
	}
}

export async function refreshPackageJobs(): Promise<void> {
	const jobs = await get().client?.rpc("plugin.call", { plugin: "packages", method: "jobs", params: {} }).catch(() => undefined);
	if (Array.isArray(jobs)) applyJobs(jobs as PackageJob[]);
}

/** Start an install/remove/update in the background; progress and the result arrive through `packageJobs` and toasts. */
export async function startPackageJob(method: "install" | "remove" | "update", params: Record<string, unknown>): Promise<boolean> {
	const job = await pluginCall<PackageJob>("packages", method, params);
	if (!job) return false;
	watched.add(job.id);
	await refreshPackageJobs();
	return true;
}

export async function dismissPackageJob(id: string): Promise<void> {
	set((s) => ({ packageJobs: s.packageJobs.filter((j) => j.id !== id) }));
	await pluginCall("packages", "dismiss", { id });
}


export function bindClient(client: PrometheusClient): () => void {
	set({ client, conn: client.state });
	const offFrame = client.onFrame(handleFrame);
	const offState = client.onState((conn) => {
		set({ conn });
		if (conn === "open") void onConnected();
	});
	return () => {
		offFrame();
		offState();
	};
}

async function onConnected(): Promise<void> {
	await Promise.all([refreshSessions(), refreshModels(), refreshWorkspaces(), refreshPlugins(), refreshHostSettings(), refreshHostInfo(), refreshPackageJobs(), refreshRuntimes(), refreshGateways()]);
	const current = get().session;
	const target = current?.id ?? (get().booted ? null : localStorage.getItem("prometheus.lastSession"));
	const exists = target && get().sessions.some((s) => s.id === target && !s.archived);
	if (exists) await openSession(target);
	else if (!get().booted && !get().session) {
		// First start on the new-chat page: begin with the default agent.
		const draft = defaultDraft();
		if (draft.draftAgentId !== get().draftAgentId) {
			set({ ...draft, draftModel: null });
			void refreshDraftModels();
		}
	}
	set({ booted: true });
}
