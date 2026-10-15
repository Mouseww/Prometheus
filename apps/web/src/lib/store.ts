import type {
	AssistantMessage,
	ChatMessage,
	CommandInfo,
	HostSettings,
	HostInfo,
	MessageRef,
	ModelInfo,
	ModelRef,
	ServerFrame,
	SessionEvent,
	SessionSnapshot,
	SessionStats,
	SessionSummary,
	ThinkingLevel,
	UIRequest,
	WorkspaceInfo,
} from "@prometheus/protocol";
import { create } from "zustand";
import type { ConnState, PrometheusClient } from "./client.ts";
import { defineMessages, tr } from "./i18n.ts";

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
	tools: Record<string, ToolRun>;
	model: ModelRef | null;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	isStreaming: boolean;
	queue: { steering: string[]; followUp: string[] };
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement: string }>;
	banner: Banner | null;
	stats: SessionStats | null;
}

export type SettingsTab = "general" | "gateways" | "mcp" | "skills" | "market" | "plugins";
export type View = "chat" | "knowledge" | "memory" | "settings" | { panel: string };

interface State {
	client: PrometheusClient | null;
	conn: ConnState;
	view: View;
	settingsTab: SettingsTab;
	sessions: SessionSummary[];
	workspaces: WorkspaceInfo[];
	hostSettings: HostSettings | null;
	hostInfo: HostInfo | null;
	session: ActiveSession | null;
	models: ModelInfo[];
	commands: CommandInfo[];
	uiQueue: { sessionId: string; request: UIRequest }[];
	toasts: Toast[];
	title: string | null;
	editorText: { text: string; nonce: number } | null;
}

export const useStore = create<State>(() => ({
	client: null,
	conn: "idle",
	view: "chat",
	settingsTab: "general",
	sessions: [],
	workspaces: [],
	hostSettings: null,
	hostInfo: null,
	session: null,
	models: [],
	commands: [],
	uiQueue: [],
	toasts: [],
	title: null,
	editorText: null,
}));

const set = useStore.setState;
const get = useStore.getState;

export function toast(message: string, level: Toast["level"] = "info"): void {
	const id = crypto.randomUUID();
	set((s) => ({ toasts: [...s.toasts.slice(-4), { id, message, level }] }));
	setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), level === "error" ? 8000 : 4000);
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
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
			return { ...session, isStreaming: false, banner: null };
		case "message_start": {
			const message = e.message.role === "assistant" ? { ...emptyAssistant(), ...(e.message as AssistantMessage), content: [] } : e.message;
			return { ...session, messages: [...session.messages, message] };
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
			return { ...session, messages: e.messages };
		case "session_info_changed":
			return { ...session, name: e.name };
		case "thinking_level_changed":
			return { ...session, thinkingLevel: e.level };
		case "model_changed":
			return { ...session, model: e.model };
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
		case "event":
			if (frame.sessionId === active?.id) enqueue(frame.event);
			return;
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
			void refreshModels();
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
		tools: {},
		model: s.model,
		thinkingLevel: s.thinkingLevel,
		availableThinkingLevels: s.availableThinkingLevels,
		isStreaming: s.isStreaming,
		queue: s.queue,
		statuses: s.statuses,
		widgets: s.widgets,
		banner: null,
		stats: null,
	};
}

function activate(snapshot: SessionSnapshot): void {
	const client = get().client;
	const previous = get().session;
	if (previous && previous.id !== snapshot.id) client?.unsubscribe(previous.id);
	client?.subscribe(snapshot.id);
	buffer = [];
	set({
		session: fromSnapshot(snapshot),
		view: "chat",
		uiQueue: snapshot.pendingUI.filter((r) => !["notify", "setStatus", "setWidget", "setTitle", "setEditorText"].includes(r.method)).map((request) => ({ sessionId: snapshot.id, request })),
	});
	localStorage.setItem("prometheus.lastSession", snapshot.id);
	void refreshCommands();
	void refreshStats();
}

export async function refreshSessions(): Promise<void> {
	const sessions = await call((c) => c.rpc("session.list", {}));
	if (sessions) set({ sessions });
}

export async function refreshWorkspaces(): Promise<void> {
	const workspaces = await call((c) => c.rpc("workspace.list", {}));
	if (workspaces) set({ workspaces });
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

export async function createSession(cwd?: string): Promise<void> {
	const snap = await call((c) => c.rpc("session.create", { cwd }));
	if (snap) activate(snap);
}

export async function openSession(sessionId: string): Promise<void> {
	const snap = await call((c) => c.rpc("session.open", { sessionId }));
	if (snap) activate(snap);
}

/** After the active session disappears, fall back to the newest one in the same workspace (or a fresh one). */
async function leaveSession(sessionId: string): Promise<void> {
	const current = get().session;
	if (current?.id !== sessionId) return;
	get().client?.unsubscribe(sessionId);
	set({ session: null });
	await refreshSessions();
	const next = get().sessions.find((s) => !s.archived && s.id !== sessionId && s.workspaceId === current.workspaceId);
	if (next) await openSession(next.id);
	else await createSession(current.cwd);
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
	const m = get().session?.messages[index];
	return m ? { index, role: m.role, timestamp: m.timestamp } : null;
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

export async function sendPrompt(text: string, delivery?: "steer" | "followUp"): Promise<boolean> {
	const session = get().session;
	if (!session) return false;
	const result = await call((c) => c.rpc("chat.prompt", { sessionId: session.id, text, delivery }));
	return result !== undefined;
}

export async function abortRun(): Promise<void> {
	const session = get().session;
	if (session) await call((c) => c.rpc("chat.abort", { sessionId: session.id }));
}

export async function setModel(model: ModelRef): Promise<void> {
	const session = get().session;
	if (!session) return;
	await call((c) => c.rpc("model.set", { sessionId: session.id, model }));
	const snap = await call((c) => c.rpc("session.open", { sessionId: session.id }));
	const current = get().session;
	if (snap && current) set({ session: { ...current, model: snap.model, thinkingLevel: snap.thinkingLevel, availableThinkingLevels: snap.availableThinkingLevels } });
	void refreshStats();
}

export async function setThinking(level: ThinkingLevel): Promise<void> {
	const session = get().session;
	if (session) await call((c) => c.rpc("thinking.set", { sessionId: session.id, level }));
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
	await Promise.all([refreshSessions(), refreshModels(), refreshWorkspaces(), refreshHostSettings(), refreshHostInfo()]);
	const current = get().session;
	const target = current?.id ?? localStorage.getItem("prometheus.lastSession");
	const exists = target && get().sessions.some((s) => s.id === target && !s.archived);
	if (exists) await openSession(target);
	else if (!current) {
		const ws = get().workspaces[0];
		await createSession(ws?.path);
	}
}
