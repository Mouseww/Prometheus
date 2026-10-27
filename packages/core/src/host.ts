import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CATALOG_URL, listModels, matchModelDefaults, mergeGatewayUpdate, type ModelCatalog, parseModelCatalog, redactGateway } from "@prometheus/gateway";
import type { AgentRunOptions, AgentRunResult, PrometheusPlugin } from "@prometheus/plugin-sdk";
import {
	AppError,
	encodeError,
	type ModelPricing,
	type DirListing,
	type ImageContent,
	type MessageRef,
	PROTOCOL_VERSION,
	PERMISSION_MODES,
	type PromptDisposition,
	type RpcMethod,
	type RpcParams,
	type GatewayChoice,
	type RpcResult,
	type RuntimeInfo,
	type RuntimeKind,
	type ServerRpcMethod,
	type SessionEvent,
	type SessionSnapshot,
	type SessionSummary,
	type UIRequest,
} from "@prometheus/protocol";
import { ToolBus } from "./agent/bus/tool-bus.ts";
import { ClaudeCodeRuntime } from "./agent/claude-code/cc-runtime.ts";
import { CodexRuntime } from "./agent/codex/codex-runtime.ts";
import { CODEX_CAPABILITIES } from "./agent/codex/codex-session.ts";
import { CC_CAPABILITIES } from "./agent/claude-code/cc-session.ts";
import { PiRuntime } from "./agent/pi/pi-runtime.ts";
import { PI_CAPABILITIES } from "./agent/pi/pi-session.ts";
import { GatewayRelay } from "./agent/relay/gateway-relay.ts";
import { SessionIndex } from "./agent/session-index.ts";
import { firstUserText } from "./agent/pi/tokens.ts";
import type { AgentRuntime, ResumeInit, RuntimeServices, RuntimeSession, SessionHooks } from "./agent/types.ts";
import { toModelRef } from "./events.ts";
import { listExternalApps, openInExternalApp, openUrlNative, pickFolderNative } from "./native-dialog.ts";
import { checkImages, imageOnlyTitle } from "./images.ts";
import { PermissionGate } from "./permission-gate.ts";
import { bootstrap, type Runtime } from "./runtime.ts";
import { AgentStore, runClaude, runCodex, SubagentRuntime } from "@prometheus/subagents";
import { UIBridge } from "./ui-bridge.ts";
import { normalizeDir, WorkspaceStore, workspaceId } from "./workspaces.ts";
import tauriConf from "../../../apps/desktop/src-tauri/tauri.conf.json" with { type: "json" };

// Single source of truth shared with the desktop release (the tag must match it).
export const PROMETHEUS_VERSION: string = tauriConf.version;

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
	session: RuntimeSession;
	bridge: UIBridge;
	gate: PermissionGate;
	subagents: SubagentRuntime;
}

type Handlers = { [M in Exclude<RpcMethod, ServerRpcMethod>]: (params: RpcParams<M>) => Promise<RpcResult<M>> | RpcResult<M> };

/** Embeddable Prometheus host: one agent runtime, many sessions, all exposed through the RPC surface. */
export class PrometheusHost {
	readonly runtime: Runtime;
	private readonly pi: PiRuntime;
	private readonly cwd: string;
	private readonly live = new Map<string, LiveSession>();
	private readonly opening = new Map<string, Promise<LiveSession>>();
	private readonly paths = new Map<string, string>();
	private readonly pendingReload = new Set<string>();
	private readonly listener: HostListener;
	private readonly workspaces: WorkspaceStore;
	private readonly index: SessionIndex;
	private readonly externalRuntimes = new Map<RuntimeKind, AgentRuntime>();
	private externalServices: Promise<RuntimeServices> | undefined;

	private constructor(runtime: Runtime, pi: PiRuntime, options: PrometheusHostOptions) {
		this.runtime = runtime;
		this.pi = pi;
		this.cwd = options.cwd ?? process.cwd();
		this.listener = options.listener;
		this.workspaces = new WorkspaceStore(join(runtime.dataDir, "workspaces.json"));
		this.index = new SessionIndex(join(runtime.dataDir, "sessions", "index.json"));
		runtime.plugins.reloadSessions = () => this.reloadSessions();
		runtime.plugins.workspaces = async () => (await this.workspaces.list()).map((w) => ({ id: w.id, path: w.path, name: w.name }));
		runtime.plugins.runAgent = (opts) => this.runAgent(opts);
		runtime.plugins.onChanged = () => this.listener.pluginsChanged();
		runtime.plugins.notifyPlugin = (name) => this.listener.pluginNotify(name);
	}

	/** PI's model registry (shares auth.json/models.json with the TUI). */
	get modelRuntime(): PiRuntime["modelRuntime"] {
		return this.pi.modelRuntime;
	}

	static async create(options: PrometheusHostOptions): Promise<PrometheusHost> {
		const runtime = await bootstrap({ host: "server", dataDir: options.dataDir, cwd: options.cwd, builtinPlugins: options.builtinPlugins });
		const pi = await PiRuntime.start({ runtime, cwd: options.cwd ?? process.cwd() });
		const host = new PrometheusHost(runtime, pi, options);
		await host.index.load();
		pi.syncGateways();
		return host;
	}

	async call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
		const handler = (this.handlers as Partial<Record<RpcMethod, unknown>>)[method] as ((p: RpcParams<M>) => Promise<RpcResult<M>> | RpcResult<M>) | undefined;
		if (!handler) throw new AppError("notFound", { what: method });
		return handler(params ?? ({} as RpcParams<M>));
	}

	async dispose(): Promise<void> {
		for (const [id] of this.live) await this.closeSession(id);
		if (this.externalServices) {
			const services = await this.externalServices.catch(() => undefined);
			await services?.bus.stop();
			await services?.relay.stop();
		}
		await this.index.flush();
		await this.runtime.dispose();
	}

	// ---------- agent runtimes ----------

	/** The tool bus and gateway relay start the first time a non-PI runtime is used. */
	private servicesFor(): Promise<RuntimeServices> {
		this.externalServices ??= (async () => {
			const bus = new ToolBus();
			const traffic = this.runtime.plugins.trafficHooks();
			const relay = new GatewayRelay({
				onRequest: (info, body) => (traffic.request ? traffic.request(info, body) : body),
				onResponse: (info, head) => traffic.response?.(info, head),
				log: { warn: (m) => console.warn(m) },
			});
			await bus.start();
			await relay.start();
			return {
				bus,
				relay,
				plugins: this.runtime.plugins,
				gateway: (id) => this.runtime.config.gateways().find((g) => g.id === id),
				dataDir: this.runtime.dataDir,
				log: { info: (m) => console.info(m), warn: (m) => console.warn(m) },
			} satisfies RuntimeServices;
		})();
		return this.externalServices;
	}

	private async runtimeFor(kind: RuntimeKind): Promise<AgentRuntime> {
		if (kind === "pi") return this.pi;
		let rt = this.externalRuntimes.get(kind);
		if (rt) return rt;
		rt = kind === "claude-code" ? new ClaudeCodeRuntime(() => this.servicesFor()) : new CodexRuntime(() => this.servicesFor());
		this.externalRuntimes.set(kind, rt);
		return rt;
	}

	private syncIndex(id: string, live: LiveSession): void {
		const ref = live.session.ref();
		if (ref.runtime === "pi") return;
		const state = live.session.snapshotState();
		this.index.patch(id, { name: state.name, modified: new Date().toISOString(), messageCount: state.messages.length, firstMessage: firstUserText(state.messages).slice(0, 200) });
	}

	private async createExternal(kind: RuntimeKind, dir: string, gateway: GatewayChoice | undefined): Promise<LiveSession> {
		const rt = await this.runtimeFor(kind);
		const choice: GatewayChoice = gateway ?? { mode: "native" };
		const live = await this.attach((init) => rt.create({ ...init, cwd: normalizeDir(dir) }), choice);
		const now = new Date().toISOString();
		const ref = live.session.ref();
		this.index.upsert({ id: ref.id, runtime: kind, nativeId: ref.nativeId, cwd: normalizeDir(dir), created: now, modified: now, messageCount: 0, firstMessage: "", gateway: choice });
		return live;
	}

	// ---------- gateways ----------

	private readonly catalogs = new Map<string, { at: number; catalog: ModelCatalog }>();

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
			await live.session.refreshTools();
		} catch (err) {
			live.bridge.context().notify(encodeError(new AppError("reloadFailed", { error: err instanceof Error ? err.message : String(err) })), "error");
		}
	}

	/** Builds the per-session Prometheus services, starts the session through `start`, and registers it as live. */
	private async attach(start: (init: ResumeInit) => Promise<RuntimeSession>, gateway?: GatewayChoice): Promise<LiveSession> {
		const gate = new PermissionGate();
		let session: RuntimeSession | undefined;
		let id = "";
		const subagents = new SubagentRuntime({
			store: new AgentStore(this.pi.agentDir),
			cwd: () => session?.cwd ?? this.cwd,
			emit: (runs) => this.listener.event(id, { type: "subagents_update", runs }),
			runners: {
				// Reads the chat's model and thinking level lazily: the session does not exist yet.
				pi: this.pi.subagentRunner(() => session),
				"claude-code": runClaude,
				codex: runCodex,
			},
		});
		const bridge = new UIBridge({
			request: (r) => this.listener.uiRequest(id, r),
			resolved: (rid) => this.listener.uiResolved(id, rid),
		});
		const hooks: SessionHooks = {
			created: (s) => {
				session = s;
				id = s.id;
			},
			event: (e) => this.listener.event(id, e),
			sessionsChanged: () => {
				const current = this.live.get(id);
				if (current) this.syncIndex(id, current);
				this.listener.sessionsChanged();
			},
			// Compaction replaces the context; clients rebuild their message list from events and would otherwise keep the old one.
			contextReplaced: () => {
				const current = this.live.get(id);
				if (current) this.resetMessages(id, current);
			},
			settled: () => {
				if (!this.pendingReload.has(id)) return;
				const current = this.live.get(id);
				if (current) void this.reloadOne(id, current);
			},
		};
		const started = await start({ permission: gate, ui: bridge, subagents, hooks, ...(gateway ? { gateway } : {}) });
		const live = { session: started, bridge, gate, subagents };
		this.live.set(started.id, live);
		const file = started.ref().path;
		if (file) this.paths.set(started.id, file);
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
			pending = (async () => {
				const entry = this.index.get(sessionId);
				if (entry && entry.runtime !== "pi") {
					const rt = await this.runtimeFor(entry.runtime);
					return this.attach((init) => rt.resume({ runtime: entry.runtime, id: entry.id, nativeId: entry.nativeId, cwd: entry.cwd, name: entry.name }, init), entry.gateway);
				}
				const path = await this.resolvePath(sessionId);
				return this.attach((init) => this.pi.resume({ runtime: "pi", id: sessionId, nativeId: sessionId, path }, init));
			})();
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
		live.subagents.dispose();
		this.live.delete(sessionId);
		await live.session.dispose();
	}

	private async listSessions(): Promise<SessionSummary[]> {
		const infos = await this.pi.listNative();
		for (const info of infos) if (info.ref.path) this.paths.set(info.ref.id, info.ref.path);
		await this.workspaces.ensure(infos.map((i) => ({ path: i.cwd, modified: i.modified })));
		const archived = await this.workspaces.archived();
		const listed = new Set(infos.map((i) => i.ref.id));
		const now = new Date().toISOString();
		// A first reply still in flight has no session file yet, so list it from memory.
		const unsaved: SessionSummary[] = [];
		for (const [id, live] of this.live) {
			if (listed.has(id) || !live.session.isStreaming) continue;
			const state = live.session.snapshotState();
			unsaved.push({
				id,
				name: state.name,
				cwd: state.cwd,
				created: now,
				modified: now,
				messageCount: state.messages.length,
				firstMessage: firstUserText(state.messages).slice(0, 200),
				live: true,
				running: true,
				archived: false,
				workspaceId: workspaceId(state.cwd),
			});
		}
		const external: SessionSummary[] = [];
		for (const e of this.index.list()) {
			if (e.runtime === "pi") continue;
			const live = this.live.get(e.id);
			external.push({
				id: e.id,
				name: e.name,
				cwd: e.cwd,
				created: e.created,
				modified: e.modified,
				messageCount: e.messageCount,
				firstMessage: e.firstMessage,
				live: Boolean(live),
				running: live?.session.isStreaming ?? false,
				archived: archived.has(e.id),
				workspaceId: e.cwd ? workspaceId(e.cwd) : "",
				runtime: e.runtime,
			});
		}
		await this.workspaces.ensure(external.map((e) => ({ path: e.cwd, modified: e.modified })));
		return [...external, ...infos
			.map((info) => ({
				id: info.ref.id,
				name: info.name,
				cwd: info.cwd,
				created: info.created,
				modified: info.modified,
				messageCount: info.messageCount,
				firstMessage: imageOnlyTitle(info.firstMessage, info.messageCount).slice(0, 200),
				live: this.live.has(info.ref.id),
				running: this.live.get(info.ref.id)?.session.isStreaming ?? false,
				archived: archived.has(info.ref.id),
				workspaceId: info.cwd ? workspaceId(info.cwd) : "",
			})), ...unsaved]
			.sort((a, b) => b.modified.localeCompare(a.modified));
	}

	private gatewayOf(ref: { id: string; runtime: RuntimeKind }): GatewayChoice | undefined {
		return ref.runtime === "pi" ? undefined : this.index.get(ref.id)?.gateway;
	}

	private snapshot(live: LiveSession): SessionSnapshot {
		const s = live.session.snapshotState();
		return {
			id: s.id,
			name: s.name,
			cwd: s.cwd,
			workspaceId: workspaceId(s.cwd),
			messages: s.messages,
			model: s.model,
			thinkingLevel: s.thinkingLevel,
			availableThinkingLevels: s.availableThinkingLevels,
			permissionMode: live.gate.mode,
			isStreaming: s.isStreaming,
			queue: s.queue,
			pendingUI: live.bridge.pendingRequests(),
			statuses: Object.fromEntries(live.bridge.statuses),
			widgets: Object.fromEntries(live.bridge.widgets),
			subagents: live.subagents.list(),
			runtime: live.session.ref().runtime,
			capabilities: live.session.capabilities,
			...(this.gatewayOf(live.session.ref()) ? { gateway: this.gatewayOf(live.session.ref()) } : {}),
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
		const live = await this.attach((init) => this.pi.create({ ...init, cwd: normalizeDir(dir) }));
		const { session, bridge, gate } = live;
		const id = session.id;
		gate.unattended = options.access;
		bridge.headless = true;
		if (options.name?.trim()) session.setName(options.name.trim());
		this.listener.sessionsChanged();

		const stop = () => void session.abort().catch(() => {});
		const timeout = setTimeout(stop, options.timeoutMs ?? 30 * 60_000);
		options.signal?.addEventListener("abort", stop, { once: true });
		try {
			if (options.model) await session.setModel(options.model);
			await session.run({ text: options.prompt });
			const messages = session.messages();
			const aborted = options.signal?.aborted || messages.some((m) => (m as unknown as { stopReason?: string }).stopReason === "aborted");
			const last = messages[messages.length - 1] as unknown as { stopReason?: string; errorMessage?: string } | undefined;
			if (aborted) return { sessionId: id, status: "aborted", text: session.lastReply(), error: encodeError(new AppError("aborted")) };
			if (last?.stopReason === "error") return { sessionId: id, status: "error", text: session.lastReply(), error: last.errorMessage ?? encodeError(new AppError("generic")) };
			return { sessionId: id, status: "success", text: session.lastReply() };
		} catch (err) {
			return { sessionId: id, status: "error", text: session.lastReply(), error: err instanceof Error ? err.message : String(err) };
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", stop);
			// Nobody is subscribed to this session; release it once saved. It stays in the sidebar from disk.
			await this.closeSession(id).catch(() => {});
			this.listener.sessionsChanged();
		}
	}

	private async prompt(sessionId: string, text: string, images: ImageContent[] | undefined, delivery: "steer" | "followUp" | undefined): Promise<PromptDisposition> {
		const { session } = this.require(sessionId);
		return session.prompt({ text, images }, delivery ?? "send");
	}

	// ---------- message operations ----------

	private resetMessages(id: string, live: LiveSession): void {
		this.listener.event(id, { type: "messages_reset", messages: live.session.messages() });
		this.listener.sessionsChanged();
	}

	private async deleteMessage(sessionId: string, ref: MessageRef): Promise<void> {
		const live = this.require(sessionId);
		if (!live.session.deleteMessages) throw new AppError("generic");
		await live.session.deleteMessages(ref);
		this.resetMessages(sessionId, live);
	}

	private async retryMessage(sessionId: string, ref: MessageRef, edited?: string): Promise<void> {
		const live = this.require(sessionId);
		if (!live.session.rewind) throw new AppError("generic");
		const input = await live.session.rewind(ref, edited);
		this.resetMessages(sessionId, live);
		await this.prompt(sessionId, input.text, input.images, undefined);
	}

	/** Take one waiting message out of the steer / follow-up queue so it can be edited or dropped. */
	private takeQueued(sessionId: string, kind: "steer" | "followUp", index: number, text: string): { text: string; images?: ImageContent[] } {
		const { session } = this.require(sessionId);
		if (!session.unqueue) throw new AppError("generic");
		return session.unqueue(kind, index, text);
	}

	private async forkMessage(sessionId: string, ref: MessageRef): Promise<{ snapshot: SessionSnapshot; editorText?: string }> {
		const live = this.require(sessionId);
		if (!live.session.fork) throw new AppError("generic");
		const { editorText, ...forkRef } = await live.session.fork(ref);
		const forked = await this.attach((init) => this.pi.resume(forkRef, init));
		const baseName = live.session.snapshotState().name;
		if (baseName) forked.session.setName(`${baseName} (fork)`);
		this.listener.sessionsChanged();
		return { snapshot: this.snapshot(forked), editorText };
	}

	// ---------- settings & filesystem ----------

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
			piVersion: this.pi.version,
			protocol: PROTOCOL_VERSION,
			cwd: this.cwd,
			platform: process.platform,
		}),

		"session.list": () => this.listSessions(),
		"session.create": async ({ cwd, name, runtime: kind, gateway }) => {
			const dir = cwd?.trim() || this.cwd;
			if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new AppError("workdirNotFound", { dir });
			await this.workspaces.add(dir);
			const live = kind && kind !== "pi" ? await this.createExternal(kind, dir, gateway) : await this.attach((init) => this.pi.create({ ...init, cwd: normalizeDir(dir) }));
			if (name?.trim()) live.session.setName(name.trim());
			this.listener.sessionsChanged();
			return this.snapshot(live);
		},
		"session.open": async ({ sessionId }) => this.snapshot(await this.open(sessionId)),
		"session.rename": async ({ sessionId, name }) => {
			(await this.open(sessionId)).session.setName(name.trim());
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
			const entry = this.index.get(sessionId);
			if (entry && entry.runtime !== "pi") {
				await this.closeSession(sessionId);
				const rt = await this.runtimeFor(entry.runtime);
				await rt.deleteNative({ runtime: entry.runtime, id: entry.id, nativeId: entry.nativeId }).catch(() => {});
				this.index.delete(sessionId);
				await this.workspaces.setArchived(sessionId, false);
				this.listener.sessionsChanged();
				return null;
			}
			const live = this.live.get(sessionId);
			const path = live?.session.ref().path ?? (await this.resolvePath(sessionId).catch(() => undefined));
			await this.closeSession(sessionId);
			if (path) await this.pi.deleteNative({ runtime: "pi", id: sessionId, nativeId: sessionId, path });
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

		"settings.get": () => ({ autoCompaction: this.pi.autoCompaction(), workspaceRoot: this.workspaceRoot() }),
		"settings.set": async ({ autoCompaction, workspaceRoot }) => {
			if (typeof autoCompaction === "boolean") {
				await this.pi.setAutoCompaction(autoCompaction);
				// Live sessions cache their own SettingsManager.
				for (const { session } of this.live.values()) session.setAutoCompaction?.(autoCompaction);
			}
			if (typeof workspaceRoot === "string") {
				const next = workspaceRoot.trim();
				if (next && (!existsSync(next) || !statSync(next).isDirectory())) throw new AppError("dirNotFound", { dir: next });
				await this.runtime.config.setWorkspaceRoot(next);
			}
			return { autoCompaction: this.pi.autoCompaction(), workspaceRoot: this.workspaceRoot() };
		},
		"session.stats": ({ sessionId }) => this.require(sessionId).session.usage(),

		"usage.stats": ({ days }) => this.pi.collectUsage(days ?? 0),

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
			if (!session.compact) throw new AppError("generic");
			// Runs on in the background; failures reach the UI through the `compaction_end` event.
			void session.compact(instructions);
			return null;
		},

		"model.list": () => this.pi.listModels({ mode: "native" }),
		"runtime.list": async (): Promise<RuntimeInfo[]> => {
			const out: RuntimeInfo[] = [{ kind: "pi", health: await this.pi.probe(), capabilities: PI_CAPABILITIES }];
			const cc = await this.runtimeFor("claude-code").catch(() => undefined);
			out.push({ kind: "claude-code", health: (await cc?.probe()) ?? { available: false, reason: "unavailable" }, capabilities: CC_CAPABILITIES });
			const codex = await this.runtimeFor("codex").catch(() => undefined);
			out.push({ kind: "codex", health: (await codex?.probe()) ?? { available: false, reason: "unavailable" }, capabilities: CODEX_CAPABILITIES });
			return out;
		},
		"runtime.models": async ({ runtime: kind, gateway }) => (await this.runtimeFor(kind)).listModels(gateway),
		"model.set": async ({ sessionId, model }) => {
			const { session } = this.require(sessionId);
			if (session.ref().runtime !== "pi") {
				// The external runtime owns the model list; it emits `model_changed` itself.
				await session.setModel(model);
				return null;
			}
			const target = this.pi.getModel(model.provider, model.id);
			if (!target) throw new AppError("modelNotFound", { provider: model.provider, id: model.id });
			await session.setModel(model);
			this.listener.event(sessionId, { type: "model_changed", model: toModelRef(target) });
			this.listener.event(sessionId, { type: "thinking_level_changed", level: session.snapshotState().thinkingLevel });
			return null;
		},
		"thinking.set": async ({ sessionId, level }) => {
			await this.require(sessionId).session.setThinking(level);
			return null;
		},
		"permission.set": async ({ sessionId, mode }) => {
			if (!PERMISSION_MODES.includes(mode)) throw new AppError("unknownPermissionMode", { mode: String(mode) });
			await this.require(sessionId).session.setPermissionMode(mode);
			return null;
		},

		"subagent.detail": ({ sessionId, id }) => this.require(sessionId).subagents.detail(id),
		"subagent.stop": async ({ sessionId, id }) => {
			this.require(sessionId).subagents.stop(id);
			return null;
		},

		"commands.list": ({ sessionId }) => this.require(sessionId).session.commands(),
		"tools.list": ({ sessionId }) => this.require(sessionId).session.tools(),

		"ui.respond": ({ sessionId, requestId, response }) => {
			this.require(sessionId).bridge.respond(requestId, response);
			return null;
		},

		"gateway.list": () => this.runtime.config.gateways().map(redactGateway),
		"gateway.save": async ({ gateway }) => {
			const saved = await this.runtime.config.saveGateway(gateway);
			this.pi.syncGateways();
			this.listener.gatewaysChanged();
			return redactGateway(saved);
		},
		"gateway.delete": async ({ id }) => {
			await this.runtime.config.deleteGateway(id);
			this.pi.syncGateways();
			this.listener.gatewaysChanged();
			return null;
		},
		"gateway.test": async ({ id, model }) => {
			const g = this.runtime.config.gateways().find((x) => x.id === id);
			if (!g) throw new AppError("gatewayNotFound", { id });
			const modelId = model ?? g.models[0]?.id;
			const target = modelId && this.pi.getModel(id, modelId);
			if (!target) throw new AppError("gatewayNotRegistered");
			const started = performance.now();
			try {
				const reply = await this.pi.completeSimple(
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
			for (const m of this.pi.getModels()) {
				if (this.pi.registeredGateways.has(m.provider)) continue;
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
			return (await this.pi.readPiGateways()).map(({ gateway: g, missingKey }) => ({
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
			for (const { gateway, missingKey } of await this.pi.readPiGateways()) {
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
				this.pi.syncGateways();
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
		"plugin.compatibility": () => this.runtime.plugins.compatibility(),
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
