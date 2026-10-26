import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	getAgentDir,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CATALOG_URL, listModels, matchModelDefaults, mergeGatewayUpdate, type ModelCatalog, parseModelCatalog, parsePiModels, redactGateway, toProviderConfig } from "@prometheus/gateway";
import type { AgentRunOptions, AgentRunResult, PrometheusPlugin } from "@prometheus/plugin-sdk";
import {
	AppError,
	encodeError,
	type CommandInfo,
	type ModelPricing,
	type DirListing,
	type ImageContent,
	type MessageRef,
	type ModelInfo,
	PROTOCOL_VERSION,
	PERMISSION_MODES,
	type PromptDisposition,
	type RpcMethod,
	type RpcParams,
	type RpcResult,
	type ServerRpcMethod,
	type SessionEvent,
	type SessionSnapshot,
	type SessionSummary,
	type ThinkingLevel,
	type UIRequest,
	type ChatMessage,
} from "@prometheus/protocol";
import { contextBreakdown, estimateTokens, firstUserText, hasReportedUsage, lastReply } from "./agent/pi/tokens.ts";
import { slimEvent, toModelRef } from "./events.ts";
import { listExternalApps, openInExternalApp, openUrlNative, pickFolderNative } from "./native-dialog.ts";
import { checkImages, imageOnlyTitle, skipPiImageAutoResize } from "./images.ts";
import { PermissionGate } from "./permission-gate.ts";
import { EXIT_PLAN_MODE } from "./permissions.ts";
import { pluginBuilderExtension } from "./plugin-tool.ts";
import { bootstrap, type Runtime } from "./runtime.ts";
import { AgentStore, createPiRunner, runClaude, runCodex, SubagentRuntime } from "@prometheus/subagents";
import { UIBridge } from "./ui-bridge.ts";
import { collectUsage } from "./usage.ts";
import { normalizeDir, WorkspaceStore, workspaceId } from "./workspaces.ts";
import tauriConf from "../../../apps/desktop/src-tauri/tauri.conf.json" with { type: "json" };

// Single source of truth shared with the desktop release (the tag must match it).
export const PROMETHEUS_VERSION: string = tauriConf.version;

// Mirrors PI's CLI built-ins (main() adds them for the TUI); names keep `builtin:<name>` settings working.
const builtInExtensions: InlineExtension[] = [
	{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
	{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
	{ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
];

/** Fire-and-forget: the file manager's own exit code is meaningless (explorer.exe exits 1 on success). */
function openInFileManager(dir: string): void {
	const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [dir]] : process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
	const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" });
	child.on("error", () => {});
	child.unref();
}

export interface HostListener {
	event(sessionId: string, event: SessionEvent): void;
	uiRequest(sessionId: string, request: UIRequest): void;
	uiResolved(sessionId: string, requestId: string): void;
	sessionsChanged(): void;
	gatewaysChanged(): void;
	pluginsChanged(): void;
	pluginNotify(plugin: string): void;
}

export interface PrometheusHostOptions {
	dataDir?: string;
	/** Default working directory for new sessions. */
	cwd?: string;
	builtinPlugins?: PrometheusPlugin[];
	listener: HostListener;
}

interface LiveSession {
	session: AgentSession;
	bridge: UIBridge;
	gate: PermissionGate;
	subagents: SubagentRuntime;
	unsubscribe: () => void;
}

type Handlers = { [M in Exclude<RpcMethod, ServerRpcMethod>]: (params: RpcParams<M>) => Promise<RpcResult<M>> | RpcResult<M> };

/** Embeddable Prometheus host: one ModelRuntime, many PI sessions, all exposed through the RPC surface. */
export class PrometheusHost {
	readonly runtime: Runtime;
	readonly modelRuntime: ModelRuntime;
	private readonly cwd: string;
	private readonly agentDir = getAgentDir();
	private readonly live = new Map<string, LiveSession>();
	private readonly opening = new Map<string, Promise<LiveSession>>();
	private readonly paths = new Map<string, string>();
	private registered = new Set<string>();
	private readonly pendingReload = new Set<string>();
	private readonly listener: HostListener;
	private readonly workspaces: WorkspaceStore;
	private settingsManager: SettingsManager | undefined;

	private constructor(runtime: Runtime, modelRuntime: ModelRuntime, options: PrometheusHostOptions) {
		this.runtime = runtime;
		this.modelRuntime = modelRuntime;
		this.cwd = options.cwd ?? process.cwd();
		this.listener = options.listener;
		this.workspaces = new WorkspaceStore(join(runtime.dataDir, "workspaces.json"));
		runtime.plugins.reloadSessions = () => this.reloadSessions();
		runtime.plugins.workspaces = async () => (await this.workspaces.list()).map((w) => ({ id: w.id, path: w.path, name: w.name }));
		runtime.plugins.runAgent = (opts) => this.runAgent(opts);
		runtime.plugins.onChanged = () => this.listener.pluginsChanged();
		runtime.plugins.notifyPlugin = (name) => this.listener.pluginNotify(name);
	}

	static async create(options: PrometheusHostOptions): Promise<PrometheusHost> {
		const runtime = await bootstrap({ host: "server", dataDir: options.dataDir, cwd: options.cwd, builtinPlugins: options.builtinPlugins });
		const agentDir = getAgentDir();
		// Shares PI's auth.json/models.json so `/login` credentials from the TUI work here too.
		const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
		const host = new PrometheusHost(runtime, modelRuntime, options);
		host.syncGateways();
		return host;
	}

	async call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
		const handler = (this.handlers as Partial<Record<RpcMethod, unknown>>)[method] as ((p: RpcParams<M>) => Promise<RpcResult<M>> | RpcResult<M>) | undefined;
		if (!handler) throw new AppError("notFound", { what: method });
		return handler(params ?? ({} as RpcParams<M>));
	}

	async dispose(): Promise<void> {
		for (const [id] of this.live) await this.closeSession(id);
		await this.runtime.dispose();
	}

	// ---------- gateways ----------

	private readonly catalogs = new Map<string, { at: number; catalog: ModelCatalog }>();

	/** Gateways declared in the PI agent's own models.json (the file PI's /login and manual setups use). */
	private async readPiGateways(): Promise<ReturnType<typeof parsePiModels>> {
		let raw: string;
		try {
			raw = await readFile(join(this.agentDir, "models.json"), "utf8");
		} catch {
			return [];
		}
		const auth = await readFile(join(this.agentDir, "auth.json"), "utf8").then(
			(a) => {
				try {
					return JSON.parse(a) as unknown;
				} catch {
					return undefined;
				}
			},
			() => undefined,
		);
		try {
			return parsePiModels(JSON.parse(raw), process.env, auth);
		} catch {
			throw new AppError("catalogInvalid");
		}
	}

	private syncGateways(): void {
		const next = new Set<string>();
		for (const g of this.runtime.config.gateways()) {
			if (g.enabled === false) continue;
			try {
				const config = toProviderConfig(g);
				this.modelRuntime.registerProvider(g.id, config as Parameters<ModelRuntime["registerProvider"]>[1]);
				next.add(g.id);
			} catch (err) {
				console.warn(`[prometheus] 网关注册失败 ${g.id}: ${err instanceof Error ? err.message : err}`);
			}
		}
		for (const id of this.registered) if (!next.has(id)) this.modelRuntime.unregisterProvider(id);
		this.registered = next;
	}

	// ---------- sessions ----------

	private async reloadSessions(): Promise<void> {
		await Promise.all(
			[...this.live.entries()].map(async ([id, live]) => {
				if (live.session.isStreaming) {
					this.pendingReload.add(id);
					return;
				}
				await this.reloadOne(id, live);
			}),
		);
	}

	private async reloadOne(id: string, live: LiveSession): Promise<void> {
		this.pendingReload.delete(id);
		try {
			await live.session.reload();
		} catch (err) {
			live.bridge.context().notify(encodeError(new AppError("reloadFailed", { error: err instanceof Error ? err.message : String(err) })), "error");
		}
	}

	/** One loader per session: its extension runtime is invalidated when that session is disposed or reloaded, so sharing it would break sibling sessions. */
	private async loader(cwd: string, gate: PermissionGate, subagents: SubagentRuntime): Promise<DefaultResourceLoader> {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: this.agentDir,
			// PI's own built-ins (MCP client, codemode, tool search) come first, as in the TUI.
			extensionFactories: [...builtInExtensions, this.runtime.dynamicExtension(), pluginBuilderExtension(this.runtime.plugins), gate.extension(), subagents.extension()],
			// The app has its own `subagent` tool; the pi-subagents package would register a second one under the same name.
			extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((x) => !/pi-subagents/i.test(`${x.path} ${x.resolvedPath}`)) }),
		});
		await loader.reload();
		return loader;
	}

	private async attach(sessionManager: SessionManager): Promise<LiveSession> {
		const cwd = sessionManager.getCwd();
		const gate = new PermissionGate();
		let sessionRef: AgentSession | undefined;
		let sessionIdRef = "";
		const subagents = new SubagentRuntime({
			store: new AgentStore(this.agentDir),
			cwd: () => cwd,
			emit: (runs) => this.listener.event(sessionIdRef, { type: "subagents_update", runs }),
			runners: {
				pi: createPiRunner({
					modelRuntime: this.modelRuntime,
					agentDir: this.agentDir,
					parentModel: () => (sessionRef?.model ? `${sessionRef.model.provider}/${sessionRef.model.id}` : undefined),
					parentThinking: () => sessionRef?.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined,
				}),
				"claude-code": runClaude,
				codex: runCodex,
			},
		});
		const settingsManager = SettingsManager.create(cwd, this.agentDir);
		// PI auto-resize needs Photon WASM. A failed load drops every picture with
		// "Image omitted: could not be resized". The web UI already shrinks attachments.
		skipPiImageAutoResize(settingsManager);
		const { session } = await createAgentSession({
			cwd,
			agentDir: this.agentDir,
			modelRuntime: this.modelRuntime,
			sessionManager,
			settingsManager,
			resourceLoader: await this.loader(cwd, gate, subagents),
		});
		const id = session.sessionId;
		sessionRef = session;
		sessionIdRef = id;
		subagents.restore(session.messages);
		const bridge = new UIBridge({
			request: (r) => this.listener.uiRequest(id, r),
			resolved: (rid) => this.listener.uiResolved(id, rid),
		});
		gate.ask = (prompt, signal) => bridge.askPermission(prompt, signal);
		gate.onModeChange = (mode) => {
			bridge.auto = mode === "auto";
			if (bridge.auto) bridge.autoResolvePending();
			// The plan-submission tool exists only while planning.
			const active = session.getActiveToolNames().filter((n) => n !== EXIT_PLAN_MODE);
			session.setActiveToolsByName(mode === "plan" ? [...active, EXIT_PLAN_MODE] : active);
			this.listener.event(id, { type: "permission_mode_changed", mode });
		};
		const unsubscribe = session.subscribe((e) => {
			const slim = slimEvent(e);
			if (slim) this.listener.event(id, slim);
			if (e.type === "agent_start" || e.type === "agent_settled" || e.type === "session_info_changed") this.listener.sessionsChanged();
			// Compaction replaces the context; clients rebuild their message list from events and would otherwise keep the old one.
			if (e.type === "compaction_end" && e.result) {
				const current = this.live.get(id);
				if (current) this.resetMessages(id, current);
			}
			if (e.type === "agent_settled" && this.pendingReload.has(id)) {
				const current = this.live.get(id);
				if (current) void this.reloadOne(id, current);
			}
		});
		await session.bindExtensions({
			uiContext: bridge.context(),
			mode: "rpc",
			onError: (err) => bridge.context().notify(encodeError(new AppError("extensionError", { error: String(err.error) })), "error"),
		});
		const live = { session, bridge, gate, subagents, unsubscribe };
		this.live.set(id, live);
		const file = session.sessionFile;
		if (file) this.paths.set(id, file);
		return live;
	}

	private async resolvePath(sessionId: string): Promise<string> {
		let path = this.paths.get(sessionId);
		if (!path) {
			await this.listSessions();
			path = this.paths.get(sessionId);
		}
		if (!path) throw new AppError("sessionNotFound", { id: sessionId });
		return path;
	}

	private async open(sessionId: string): Promise<LiveSession> {
		const existing = this.live.get(sessionId);
		if (existing) return existing;
		let pending = this.opening.get(sessionId);
		if (!pending) {
			pending = (async () => this.attach(SessionManager.open(await this.resolvePath(sessionId))))();
			pending.finally(() => this.opening.delete(sessionId)).catch(() => {});
			this.opening.set(sessionId, pending);
		}
		return pending;
	}

	private require(sessionId: string): LiveSession {
		const live = this.live.get(sessionId);
		if (!live) throw new AppError("sessionNotOpen");
		return live;
	}

	private async closeSession(sessionId: string): Promise<void> {
		const live = this.live.get(sessionId);
		if (!live) return;
		live.bridge.cancelAll();
		if (live.session.isStreaming) await live.session.abort().catch(() => {});
		live.unsubscribe();
		live.subagents.dispose();
		live.session.dispose();
		this.live.delete(sessionId);
	}

	private async listSessions(): Promise<SessionSummary[]> {
		const infos = await SessionManager.listAll();
		for (const info of infos) this.paths.set(info.id, info.path);
		await this.workspaces.ensure(infos.map((i) => ({ path: i.cwd, modified: i.modified.toISOString() })));
		const archived = await this.workspaces.archived();
		const listed = new Set(infos.map((i) => i.id));
		const now = new Date().toISOString();
		// A first reply still in flight has no session file yet, so list it from memory.
		const unsaved: SessionSummary[] = [];
		for (const [id, live] of this.live) {
			if (listed.has(id) || !live.session.isStreaming) continue;
			const cwd = live.session.sessionManager.getCwd();
			unsaved.push({
				id,
				name: live.session.sessionName,
				cwd,
				created: now,
				modified: now,
				messageCount: live.session.messages.length,
				firstMessage: firstUserText(live.session.messages).slice(0, 200),
				live: true,
				running: true,
				archived: false,
				workspaceId: workspaceId(cwd),
			});
		}
		return [...infos
			.map((info) => ({
				id: info.id,
				name: info.name,
				cwd: info.cwd,
				created: info.created.toISOString(),
				modified: info.modified.toISOString(),
				messageCount: info.messageCount,
				firstMessage: imageOnlyTitle(info.firstMessage, info.messageCount).slice(0, 200),
				live: this.live.has(info.id),
				running: this.live.get(info.id)?.session.isStreaming ?? false,
				archived: archived.has(info.id),
				workspaceId: info.cwd ? workspaceId(info.cwd) : "",
			})), ...unsaved]
			.sort((a, b) => b.modified.localeCompare(a.modified));
	}

	private snapshot(live: LiveSession): SessionSnapshot {
		const s = live.session;
		const cwd = s.sessionManager.getCwd();
		return {
			id: s.sessionId,
			name: s.sessionName,
			cwd,
			workspaceId: workspaceId(cwd),
			messages: s.messages as unknown as ChatMessage[],
			model: toModelRef(s.model),
			thinkingLevel: s.thinkingLevel as ThinkingLevel,
			availableThinkingLevels: s.getAvailableThinkingLevels() as ThinkingLevel[],
			permissionMode: live.gate.mode,
			isStreaming: s.isStreaming,
			queue: { steering: [...s.getSteeringMessages()], followUp: [...s.getFollowUpMessages()] },
			pendingUI: live.bridge.pendingRequests(),
			statuses: Object.fromEntries(live.bridge.statuses),
			widgets: Object.fromEntries(live.bridge.widgets),
			subagents: live.subagents.list(),
		};
	}

	/**
	 * Runs the agent to completion in a new saved session with no user present (automations).
	 * Nothing is ever asked: whatever `access` does not cover is refused, so the run cannot hang.
	 */
	private async runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
		const dir = options.cwd?.trim();
		if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) throw new AppError("workdirNotFound", { dir });
		await this.workspaces.add(dir);
		const live = await this.attach(SessionManager.create(normalizeDir(dir)));
		const { session, bridge, gate } = live;
		const id = session.sessionId;
		gate.unattended = options.access;
		bridge.headless = true;
		if (options.name?.trim()) session.setSessionName(options.name.trim());
		this.listener.sessionsChanged();

		const stop = () => void session.abort().catch(() => {});
		const timeout = setTimeout(stop, options.timeoutMs ?? 30 * 60_000);
		options.signal?.addEventListener("abort", stop, { once: true });
		try {
			if (options.model) {
				const target = this.modelRuntime.getModel(options.model.provider, options.model.id);
				if (!target) throw new AppError("modelNotFound", { provider: options.model.provider, id: options.model.id });
				await session.setModel(target);
			}
			await session.prompt(options.prompt);
			await session.waitForIdle();
			const aborted = options.signal?.aborted || session.messages.some((m) => (m as unknown as { stopReason?: string }).stopReason === "aborted");
			const last = session.messages[session.messages.length - 1] as unknown as { stopReason?: string; errorMessage?: string } | undefined;
			if (aborted) return { sessionId: id, status: "aborted", text: lastReply(session), error: encodeError(new AppError("aborted")) };
			if (last?.stopReason === "error") return { sessionId: id, status: "error", text: lastReply(session), error: last.errorMessage ?? encodeError(new AppError("generic")) };
			return { sessionId: id, status: "success", text: lastReply(session) };
		} catch (err) {
			return { sessionId: id, status: "error", text: lastReply(session), error: err instanceof Error ? err.message : String(err) };
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", stop);
			// Nobody is subscribed to this session; release it once saved. It stays in the sidebar from disk.
			await this.closeSession(id).catch(() => {});
			this.listener.sessionsChanged();
		}
	}

	private async prompt(sessionId: string, text: string, images: ImageContent[] | undefined, delivery: "steer" | "followUp" | undefined): Promise<PromptDisposition> {
		const { session, bridge } = this.require(sessionId);
		// Resolve as soon as PI accepts the prompt; the run itself streams through events.
		return new Promise<PromptDisposition>((resolve, reject) => {
			session
				.prompt(text, {
					images,
					streamingBehavior: session.isStreaming ? (delivery ?? "followUp") : undefined,
					preflightResult: (disposition) => resolve(disposition),
				})
				.then(
					// PI defers a prompt submitted while it settles without reporting a disposition; it still runs.
					() => resolve("started"),
					(err: unknown) => {
						reject(err);
						bridge.context().notify(err instanceof Error ? err.message : String(err), "error");
					},
				);
		});
	}

	// ---------- message operations ----------

	/** Map a client-side message position to the session entry that produced it. */
	private locate(live: LiveSession, ref: MessageRef): { entryId: string; flat: { entryId: string; message: ChatMessage }[]; pos: number } {
		const s = live.session;
		if (s.isStreaming) throw new AppError("waitForReply");
		const projection = s.sessionManager.buildSessionProjection();
		const flat = projection.entries.flatMap((e) => e.messages.map((m) => ({ entryId: e.sourceEntry.id, message: m as unknown as ChatMessage })));
		const hit = flat[ref.index];
		if (!hit || hit.message.role !== ref.role || hit.message.timestamp !== ref.timestamp) throw new AppError("messageChanged");
		return { entryId: hit.entryId, flat, pos: ref.index };
	}

	private resetMessages(id: string, live: LiveSession): void {
		this.listener.event(id, { type: "messages_reset", messages: live.session.messages as unknown as ChatMessage[] });
		this.listener.sessionsChanged();
	}

	/** Nearest user message at or before `pos`. */
	private userAt(flat: { entryId: string; message: ChatMessage }[], pos: number) {
		for (let i = pos; i >= 0; i--) {
			const item = flat[i];
			if (item?.message.role === "user") return item;
		}
		throw new AppError("messageNotFound");
	}

	private async deleteMessage(sessionId: string, ref: MessageRef): Promise<void> {
		const live = this.require(sessionId);
		const { entryId, flat, pos } = this.locate(live, ref);
		const targets = new Set([entryId]);
		const message = flat[pos]?.message;
		// Dropping a tool call without its results (or vice versa) would make the context invalid for providers.
		if (message?.role === "assistant") {
			const calls = new Set(message.content.flatMap((c) => (c?.type === "toolCall" ? [c.id] : [])));
			for (const item of flat) if (item.message.role === "toolResult" && calls.has(item.message.toolCallId)) targets.add(item.entryId);
		}
		const sm = live.session.sessionManager;
		for (const target of targets) sm.appendContextEdit(target, null);
		live.session.refreshContext();
		this.resetMessages(sessionId, live);
	}

	private async retryMessage(sessionId: string, ref: MessageRef, edited?: string): Promise<void> {
		const live = this.require(sessionId);
		const { flat, pos } = this.locate(live, ref);
		const user = this.userAt(flat, pos);
		const m = user.message as Extract<ChatMessage, { role: "user" }>;
		const text = edited ?? (typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
		const images = typeof m.content === "string" ? [] : m.content.filter((c): c is ImageContent => c.type === "image");
		if (!text.trim() && !images.length) throw new AppError("messageEmpty");
		// Branch from before the user message; the old reply stays in the session tree.
		const result = await live.session.navigateTree(user.entryId);
		if (result.cancelled) throw new AppError("aborted");
		this.resetMessages(sessionId, live);
		await this.prompt(sessionId, text, images.length ? images : undefined, undefined);
	}

	/** Take one waiting message out of the steer / follow-up queue so it can be edited or dropped. */
	private takeQueued(sessionId: string, kind: "steer" | "followUp", index: number, text: string): { text: string; images?: ImageContent[] } {
		const { session } = this.require(sessionId);
		// PI keeps the display strings and the real messages (with pictures) in parallel lists; both must change together.
		const internal = session as unknown as { _steeringMessages: string[]; _followUpMessages: string[]; _emitQueueUpdate(): void; agent: { steeringQueue: { messages: unknown[] }; followUpQueue: { messages: unknown[] } } };
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

	private async forkMessage(sessionId: string, ref: MessageRef): Promise<{ snapshot: SessionSnapshot; editorText?: string }> {
		const live = this.require(sessionId);
		const { entryId, flat, pos } = this.locate(live, ref);
		const sm = live.session.sessionManager;
		const message = flat[pos]?.message;
		let leaf: string | null = entryId;
		let editorText: string | undefined;
		// Forking at a user message starts the new session just before it, with the text ready to edit.
		if (message?.role === "user") {
			leaf = sm.getEntry(entryId)?.parentId ?? null;
			editorText = typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		}
		const source = live.session.sessionFile;
		let next: SessionManager;
		if (leaf && source) {
			next = SessionManager.open(source);
			next.createBranchedSession(leaf);
		} else {
			next = SessionManager.create(sm.getCwd(), undefined, source ? { parentSession: source } : undefined);
		}
		const forked = await this.attach(next);
		const baseName = live.session.sessionName;
		if (baseName) forked.session.setSessionName(`${baseName} (fork)`);
		this.listener.sessionsChanged();
		return { snapshot: this.snapshot(forked), editorText };
	}

	// ---------- settings & filesystem ----------

	private settings(): SettingsManager {
		this.settingsManager ??= SettingsManager.create(this.cwd, this.agentDir);
		return this.settingsManager;
	}

	private listDirs(path: string | undefined): DirListing {
		const home = homedir();
		// A configured workspace root only matters while it still exists; a stale path must not break the picker.
		const configured = this.workspaceRoot();
		const dir = normalizeDir(path?.trim() || configured || home);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new AppError("dirNotFound", { dir });
		const dirs = readdirSync(dir, { withFileTypes: true })
			.filter((d) => {
				if (d.name.startsWith(".") || d.name.startsWith("$")) return false;
				if (d.isDirectory()) return true;
				if (!d.isSymbolicLink()) return false;
				try {
					return statSync(join(dir, d.name)).isDirectory();
				} catch {
					return false;
				}
			})
			.map((d) => ({ name: d.name, path: join(dir, d.name) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const parent = dirname(dir);
		const roots =
			process.platform === "win32"
				? [..."CDEFGHIJKLMNOPQRSTUVWXYZ"].map((l) => `${l}:\\`).filter((r) => existsSync(r))
				: ["/"];
		return { path: dir, parent: parent === dir ? null : parent, dirs, roots, home, ...(configured ? { workspaceRoot: configured } : {}) };
	}

	/** The configured default workspace root, or "" when unset or gone from this machine. */
	private workspaceRoot(): string {
		const root = this.runtime.config.get().workspaceRoot?.trim();
		if (!root) return "";
		try {
			return existsSync(root) && statSync(root).isDirectory() ? normalizeDir(root) : "";
		} catch {
			return "";
		}
	}

	/** Creates one new folder for a workspace; rejects traversal and existing names instead of nesting. */
	private async createDir(parent: string, name: string): Promise<DirListing> {
		const base = normalizeDir(parent?.trim() || this.cwd);
		const clean = name?.trim();
		if (!clean) throw new AppError("folderNameEmpty");
		if (/[\\/]/.test(clean) || clean === "." || clean === "..") throw new AppError("folderNameInvalid", { name: clean });
		if (!existsSync(base) || !statSync(base).isDirectory()) throw new AppError("dirNotFound", { dir: base });
		const target = join(base, clean);
		if (existsSync(target)) throw new AppError("folderExists", { name: clean });
		await mkdir(target, { recursive: false });
		return this.listDirs(base);
	}

	// ---------- RPC handlers ----------

	private readonly handlers: Handlers = {
		"host.info": () => ({
			version: PROMETHEUS_VERSION,
			piVersion: PI_VERSION,
			protocol: PROTOCOL_VERSION,
			cwd: this.cwd,
			platform: process.platform,
		}),

		"session.list": () => this.listSessions(),
		"session.create": async ({ cwd, name }) => {
			const dir = cwd?.trim() || this.cwd;
			if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new AppError("workdirNotFound", { dir });
			await this.workspaces.add(dir);
			const live = await this.attach(SessionManager.create(normalizeDir(dir)));
			if (name?.trim()) live.session.setSessionName(name.trim());
			this.listener.sessionsChanged();
			return this.snapshot(live);
		},
		"session.open": async ({ sessionId }) => this.snapshot(await this.open(sessionId)),
		"session.rename": async ({ sessionId, name }) => {
			(await this.open(sessionId)).session.setSessionName(name.trim());
			this.listener.sessionsChanged();
			return null;
		},
		"session.close": async ({ sessionId }) => {
			await this.closeSession(sessionId);
			this.listener.sessionsChanged();
			return null;
		},
		"session.archive": async ({ sessionId, archived }) => {
			await this.workspaces.setArchived(sessionId, archived);
			if (archived) await this.closeSession(sessionId);
			this.listener.sessionsChanged();
			return null;
		},
		"session.delete": async ({ sessionId }) => {
			const live = this.live.get(sessionId);
			const path = live?.session.sessionFile ?? (await this.resolvePath(sessionId).catch(() => undefined));
			await this.closeSession(sessionId);
			if (path?.endsWith(".jsonl")) await rm(path, { force: true });
			this.paths.delete(sessionId);
			await this.workspaces.setArchived(sessionId, false);
			this.listener.sessionsChanged();
			return null;
		},

		"message.delete": async ({ sessionId, ref }) => {
			await this.deleteMessage(sessionId, ref);
			return null;
		},
		"message.retry": async ({ sessionId, ref }) => {
			await this.retryMessage(sessionId, ref);
			return null;
		},
		"message.edit": async ({ sessionId, ref, text }) => {
			await this.retryMessage(sessionId, ref, text);
			return null;
		},
		"chat.unqueue": ({ sessionId, kind, index, text }) => this.takeQueued(sessionId, kind, index, text),
		"message.fork": ({ sessionId, ref }) => this.forkMessage(sessionId, ref),

		"workspace.list": async () => {
			// Nothing here needs the session index: the store already knows which folders were used. Reading
			// every session file to answer this made opening a workspace as slow as listing all history.
			return this.workspaces.list();
		},
		"workspace.add": async ({ path, name }) => {
			const w = await this.workspaces.add(path, name);
			this.listener.sessionsChanged();
			return w;
		},
		"workspace.rename": async ({ id, name }) => {
			const w = await this.workspaces.rename(id, name);
			this.listener.sessionsChanged();
			return w;
		},
		"workspace.open": async ({ id }) => {
			const w = (await this.workspaces.list()).find((x) => x.id === id);
			if (!w) throw new AppError("workspaceNotFound", { id });
			if (!existsSync(w.path) || !statSync(w.path).isDirectory()) throw new AppError("dirNotFound", { dir: w.path });
			openInFileManager(w.path);
			return null;
		},
		"workspace.remove": async ({ id }) => {
			await this.workspaces.remove(id);
			this.listener.sessionsChanged();
			return null;
		},
		"fs.dirs": ({ path }) => this.listDirs(path),
		"fs.pick": async ({ start, title }) => {
			const from = start && existsSync(start) ? start : undefined;
			return { path: await pickFolderNative(from, title || "Choose a folder") };
		},
		"system.apps": () => listExternalApps(),
		"system.openIn": async ({ app, path }) => {
			// Only folders the user added as workspaces: a client must not be able to launch arbitrary paths.
			const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p).replace(/[\\/]+$/, "");
			if (!(await this.workspaces.list()).some((w) => norm(w.path) === norm(path))) throw new AppError("dirNotWorkspace");
			await openInExternalApp(app, path);
			return { ok: true as const };
		},
		"system.open": async ({ url }) => {
			await openUrlNative(url);
			return { ok: true as const };
		},
		"fs.mkdir": ({ parent, name }) => this.createDir(parent, name),

		"settings.get": () => ({ autoCompaction: this.settings().getCompactionEnabled(), workspaceRoot: this.workspaceRoot() }),
		"settings.set": async ({ autoCompaction, workspaceRoot }) => {
			if (typeof autoCompaction === "boolean") {
				this.settings().setCompactionEnabled(autoCompaction);
				await this.settings().flush();
				// Live sessions cache their own SettingsManager.
				for (const { session } of this.live.values()) session.setAutoCompactionEnabled(autoCompaction);
			}
			if (typeof workspaceRoot === "string") {
				const next = workspaceRoot.trim();
				if (next && (!existsSync(next) || !statSync(next).isDirectory())) throw new AppError("dirNotFound", { dir: next });
				await this.runtime.config.setWorkspaceRoot(next);
			}
			return { autoCompaction: this.settings().getCompactionEnabled(), workspaceRoot: this.workspaceRoot() };
		},
		"session.stats": ({ sessionId }) => {
			const s = this.require(sessionId).session;
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
		},

		"usage.stats": async ({ days }) => {
			const infos = await SessionManager.listAll();
			return collectUsage(infos.map((i) => i.path), Number.isInteger(days) && (days as number) > 0 ? (days as number) : 0);
		},

		"chat.prompt": async ({ sessionId, text, images, delivery }) => {
			if (!text.trim() && !images?.length) throw new AppError("messageEmpty");
			checkImages(images);
			const disposition = await this.prompt(sessionId, text, images, delivery);
			return { disposition };
		},
		"chat.abort": async ({ sessionId }) => {
			await this.require(sessionId).session.abort();
			return null;
		},
		"chat.compact": ({ sessionId, instructions }) => {
			const { session } = this.require(sessionId);
			const settings = session.settingsManager;
			const model = session.model;
			// PI keeps the last `keepRecentTokens` (20k) verbatim, so a shorter chat has nothing to summarise; cap it at a third of the chat.
			const configured = settings.getCompactionKeepRecentTokens(model);
			const keep = Math.min(configured, Math.floor(session.messages.reduce((n, m) => n + estimateTokens(m), 0) / 3));
			const key = model ? `${model.provider}/${model.id}` : undefined;
			const apply = (n: number) => settings.applyOverrides({ compaction: { keepRecentTokens: n, ...(key ? { modelOverrides: { [key]: { keepRecentTokens: n } } } : {}) } });
			if (keep < configured) apply(keep);
			// Failures already reach the UI through the `compaction_end` event.
			session
				.compact(instructions)
				.catch(() => undefined)
				.finally(() => {
					if (keep < configured) apply(configured);
				});
			return null;
		},

		"model.list": async () => {
			const models = await this.modelRuntime.getAvailable();
			return models.map(
				(m): ModelInfo => ({
					provider: m.provider,
					id: m.id,
					name: m.name,
					reasoning: Boolean(m.reasoning),
					vision: Array.isArray(m.input) && m.input.includes("image"),
					contextWindow: m.contextWindow,
				}),
			);
		},
		"model.set": async ({ sessionId, model }) => {
			const target = this.modelRuntime.getModel(model.provider, model.id);
			if (!target) throw new AppError("modelNotFound", { provider: model.provider, id: model.id });
			const { session } = this.require(sessionId);
			await session.setModel(target);
			this.listener.event(sessionId, { type: "model_changed", model: toModelRef(target) });
			this.listener.event(sessionId, { type: "thinking_level_changed", level: session.thinkingLevel as ThinkingLevel });
			return null;
		},
		"thinking.set": ({ sessionId, level }) => {
			this.require(sessionId).session.setThinkingLevel(level);
			return null;
		},
		"permission.set": ({ sessionId, mode }) => {
			if (!PERMISSION_MODES.includes(mode)) throw new AppError("unknownPermissionMode", { mode: String(mode) });
			this.require(sessionId).gate.setMode(mode);
			return null;
		},

		"subagent.detail": ({ sessionId, id }) => this.require(sessionId).subagents.detail(id),
		"subagent.stop": async ({ sessionId, id }) => {
			this.require(sessionId).subagents.stop(id);
			return null;
		},

		"commands.list": ({ sessionId }) => {
			const s = this.require(sessionId).session;
			const out: CommandInfo[] = [];
			for (const c of s.extensionRunner.getRegisteredCommands()) out.push({ name: c.invocationName, description: c.description, source: "extension" });
			for (const t of s.promptTemplates) out.push({ name: t.name, description: t.description, source: "prompt" });
			for (const k of s.resourceLoader.getSkills().skills) out.push({ name: `skill:${k.name}`, description: k.description, source: "skill" });
			return out;
		},
		"tools.list": ({ sessionId }) => {
			const s = this.require(sessionId).session;
			const active = new Set(s.getActiveToolNames());
			return s.getAllTools().filter((t) => t.name !== EXIT_PLAN_MODE).map((t) => ({ name: t.name, description: t.description ?? "", active: active.has(t.name) }));
		},

		"ui.respond": ({ sessionId, requestId, response }) => {
			this.require(sessionId).bridge.respond(requestId, response);
			return null;
		},

		"gateway.list": () => this.runtime.config.gateways().map(redactGateway),
		"gateway.save": async ({ gateway }) => {
			const saved = await this.runtime.config.saveGateway(gateway);
			this.syncGateways();
			this.listener.gatewaysChanged();
			return redactGateway(saved);
		},
		"gateway.delete": async ({ id }) => {
			await this.runtime.config.deleteGateway(id);
			this.syncGateways();
			this.listener.gatewaysChanged();
			return null;
		},
		"gateway.test": async ({ id, model }) => {
			const g = this.runtime.config.gateways().find((x) => x.id === id);
			if (!g) throw new AppError("gatewayNotFound", { id });
			const modelId = model ?? g.models[0]?.id;
			const target = modelId && this.modelRuntime.getModel(id, modelId);
			if (!target) throw new AppError("gatewayNotRegistered");
			const started = performance.now();
			try {
				const reply = await this.modelRuntime.completeSimple(
					target,
					{ messages: [{ role: "user", content: "Reply with the single word: OK", timestamp: Date.now() }] },
					{ signal: AbortSignal.timeout(30_000) },
				);
				const latencyMs = Math.round(performance.now() - started);
				if (reply.stopReason === "error") return { ok: false, latencyMs, message: reply.errorMessage ?? encodeError(new AppError("generic")) };
				const text = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
				return { ok: true, latencyMs, message: text.slice(0, 200) || encodeError(new AppError("emptyReply")) };
			} catch (err) {
				return { ok: false, latencyMs: Math.round(performance.now() - started), message: err instanceof Error ? err.message : String(err) };
			}
		},

		"gateway.models": async ({ gateway }) => {
			const existing = this.runtime.config.gateways().find((x) => x.id === gateway.id);
			const merged = mergeGatewayUpdate(gateway, existing);
			if (!/^https?:\/\//.test(merged.baseUrl ?? "")) throw new AppError("baseUrlScheme");
			return listModels(merged, { signal: AbortSignal.timeout(20_000) });
		},

		"gateway.pricing": ({ models }) => {
			// Official prices live on built-in providers; user gateways are registered at zero cost and must not match.
			const norm = (id: string) => id.toLowerCase().replace(/^.*\//, "").replace(/[\s_.:]+/g, "-");
			const exact = new Map<string, ModelPricing>();
			const loose = new Map<string, ModelPricing>();
			for (const m of this.modelRuntime.getModels()) {
				if (this.registered.has(m.provider)) continue;
				const c = m.cost;
				if (!c || (!c.input && !c.output)) continue;
				const price = { input: c.input, output: c.output, cacheRead: c.cacheRead ?? 0, cacheWrite: c.cacheWrite ?? 0 };
				if (!exact.has(m.id.toLowerCase())) exact.set(m.id.toLowerCase(), price);
				if (!loose.has(norm(m.id))) loose.set(norm(m.id), price);
			}
			const out: Record<string, ModelPricing> = {};
			for (const id of models) {
				const hit = exact.get(id.toLowerCase()) ?? loose.get(norm(id));
				if (hit) out[id] = hit;
			}
			return out;
		},

		"gateway.defaults": async ({ models, url }) => {
			const source = (url ?? "").trim() || DEFAULT_CATALOG_URL;
			if (!/^https?:\/\//i.test(source)) throw new AppError("baseUrlScheme");
			const cached = this.catalogs.get(source);
			let catalog: ModelCatalog;
			if (cached && Date.now() - cached.at < 10 * 60_000) catalog = cached.catalog;
			else {
				const res = await fetch(source, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
				if (!res.ok) throw new AppError("fetchFailed", { status: res.status });
				catalog = parseModelCatalog(await res.json());
				if (!catalog.count) throw new AppError("catalogEmpty");
				this.catalogs.set(source, { at: Date.now(), catalog });
			}
			return { source, defaults: matchModelDefaults(catalog, models) };
		},
		"gateway.piList": async () => {
			const existing = new Set(this.runtime.config.gateways().map((g) => g.id));
			return (await this.readPiGateways()).map(({ gateway: g, missingKey }) => ({
				id: g.id,
				name: g.name,
				baseUrl: g.baseUrl,
				format: g.format,
				models: g.models.length,
				exists: existing.has(g.id),
				missingKey,
			}));
		},
		"gateway.piImport": async ({ ids }) => {
			const existing = new Set(this.runtime.config.gateways().map((g) => g.id));
			const wanted = ids ? new Set(ids) : undefined;
			const imported: string[] = [];
			const skipped: { id: string; reason: string }[] = [];
			for (const { gateway, missingKey } of await this.readPiGateways()) {
				if (wanted && !wanted.has(gateway.id)) continue;
				if (existing.has(gateway.id)) skipped.push({ id: gateway.id, reason: encodeError(new AppError("gatewayExists")) });
				else if (missingKey) skipped.push({ id: gateway.id, reason: encodeError(new AppError("gatewayKeyUnreadable")) });
				else {
					try {
						await this.runtime.config.saveGateway(gateway);
						imported.push(gateway.id);
					} catch (err) {
						skipped.push({ id: gateway.id, reason: err instanceof Error ? err.message : String(err) });
					}
				}
			}
			if (imported.length) {
				this.syncGateways();
				this.listener.gatewaysChanged();
			}
			return { imported, skipped };
		},

		"kb.list": () => this.runtime.knowledge.list(),
		"kb.create": (p) => this.runtime.knowledge.create(p),
		"kb.update": ({ id, ...patch }) => this.runtime.knowledge.update(id, patch),
		"kb.delete": async ({ id }) => {
			await this.runtime.knowledge.delete(id);
			return null;
		},
		"kb.documents": ({ id }) => this.runtime.knowledge.documents(id),
		"kb.ingest": ({ id, title, text }) => this.runtime.knowledge.ingest(id, title.trim() || "i18n:kbUntitled", text),
		"kb.removeDocument": async ({ id, documentId }) => {
			await this.runtime.knowledge.removeDocument(id, documentId);
			return null;
		},
		"kb.search": ({ id, query, topK }) => this.runtime.knowledge.search(id, query, topK),
		"kb.stores": () => [...this.runtime.plugins.stores.keys()],

		"plugin.list": () => this.runtime.plugins.list(),
		"plugin.install": (params) => this.runtime.plugins.install(params),
		"plugin.setEnabled": ({ id, enabled }) => this.runtime.plugins.setEnabled(id, enabled),
		"plugin.reload": ({ id }) => this.runtime.plugins.reload(id),
		"plugin.scan": () => this.runtime.plugins.scan(),
		"plugin.remove": async ({ id }) => {
			await this.runtime.plugins.remove(id);
			return null;
		},
		"plugin.call": async ({ plugin, method, params }) => {
			const handler = this.runtime.plugins.rpcs.get(`${plugin}/${method}`);
			if (!handler) throw new AppError("pluginMethodNotFound", { plugin, method });
			const isObject = params !== null && typeof params === "object" && !Array.isArray(params);
			return (await handler(isObject ? (params as Record<string, unknown>) : {})) ?? null;
		},
	};
}
