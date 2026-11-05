import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CATALOG_URL, listModels, matchModelDefaults, mergeGatewayUpdate, type ModelCatalog, parseModelCatalog, redactGateway } from "@prometheus/gateway";
import type { AgentRunOptions, AgentRunResult, OpenSessionOptions, PrometheusPlugin, StreamPublishOptions } from "@prometheus/plugin-sdk";
import {
	type AgentProfile,
	type AgentUpdateInfo,
	AppError,
	withAttachmentNote,
	type ChatMessage,
	encodeError,
	type Caller,
	type ModelPricing,
	type CommandInfo,
	type DirListing,
	type HostSettings,
	parseGoalCommand,
	type Identity,
	type ImageContent,
	type MessageRef,
	type ModelRef,
	type PermissionMode,
	PROTOCOL_VERSION,
	PERMISSION_MODES,
	THINKING_LEVELS,
	type ThinkingLevel,
	type PromptDisposition,
	type RpcMethod,
	type RpcParams,
	type GatewayChoice,
	type RpcResult,
	type RuntimeCapabilities,
	type RuntimeInfo,
	type RuntimeKind,
	type ServerRpcMethod,
	agentPreset,
	BUILTIN_AGENTS,
	type SessionBadge,
	type SessionEvent,
	type SessionSnapshot,
	type SessionSummary,
	type SessionWorktree,
	type WorktreeSetting,
	type WorktreeStrategy,
	type UIRequest,
	type RunAccess,
	GOAL_DEFAULT_TURNS,
	GOAL_MAX_TURNS,
} from "@prometheus/protocol";
import { ToolBus } from "./agent/bus/tool-bus.ts";
import { BadgeStore } from "./agent/session-badges.ts";
import { OwnerStore } from "./agent/session-owners.ts";
import { allowedMode, publicPolicy } from "./policy.ts";
import { assertAgentAllowed, serverRole } from "./role.ts";
import { canAct, identityMayCall, SESSION_WRITE_METHODS } from "./session-access.ts";
import { bundledClaudeBinary, bundledClaudeVersion, ClaudeCodeRuntime } from "./agent/claude-code/cc-runtime.ts";
import { CodexRuntime } from "./agent/codex/codex-runtime.ts";
import { CODEX_CAPABILITIES } from "./agent/codex/codex-session.ts";
import { OpenCodeRuntime } from "./agent/opencode/opencode-runtime.ts";
import { AcpRuntime } from "./agent/acp/acp-runtime.ts";
import { ACP_CAPABILITIES } from "./agent/acp/acp-session.ts";
import { OPENCODE_CAPABILITIES } from "./agent/opencode/opencode-session.ts";
import { CC_CAPABILITIES } from "./agent/claude-code/cc-session.ts";
import type { PiRuntime } from "./agent/pi/pi-runtime.ts";
import { PI_CAPABILITIES } from "./agent/pi/capabilities.ts";
import { collectUsage } from "./usage.ts";
import { installOptionalPackage, isOptionalPackage, OPTIONAL_PACKAGES, type OptionalPackageId, optionalPackageStatus, uninstallOptionalPackage } from "./optional-packages.ts";
import { isPiMissing, piAgentDir } from "./pi-paths.ts";
import { buildHandoff, handoffBlock } from "./agent/handoff.ts";
import { GatewayRelay } from "./agent/relay/gateway-relay.ts";
import { SessionIndex } from "./agent/session-index.ts";
import { firstUserText } from "./first-text.ts";
import type { AgentRuntime, ResumeInit, RuntimeServices, RuntimeSession, SessionHooks } from "./agent/types.ts";
import { toModelRef } from "./events.ts";
import { GoalTracker, type GoalView } from "./goal.ts";
import { listExternalApps, openInExternalApp, openUrlNative, pickFolderNative } from "./native-dialog.ts";
import { checkImages, imageOnlyTitle, titleWithoutNote } from "./images.ts";
import { extraRoots, issuePanelTicket, issueTicket, panelTicketLookup, panelTicketValid, readChunk, resolveDownload, takeTicket } from "./downloads.ts";
import { UPLOAD_ROOT, pruneUploads, removeSessionUploads, saveAttachments } from "./uploads.ts";
import { fullResultContent, slimMessage, slimMessages } from "./slim.ts";
import { type GatePolicy, PermissionGate } from "./permission-gate.ts";
import { PermissionStore } from "./permission-store.ts";
import { AGENT_PACKAGES, agentEntry, agentStatuses, cliVersion, compareVersions, installAgentCli, isManaged, latestVersion, npmAvailable, npmPrefixOf, uninstallAgentCli, withAgentBin } from "./agent/install.ts";
import { bootstrap, type Runtime } from "./runtime.ts";
import { AgentStore, runClaude, runCodex, SubagentRuntime } from "@prometheus/subagents";
import { UIBridge } from "./ui-bridge.ts";
import { ceilingFor, clampAccess } from "./access.ts";
import { normalizeDir, WorkspaceStore, workspaceId } from "./workspaces.ts";
import { WorktreeManager } from "./worktree.ts";
import { DEFAULT_COMPACT_PERCENT } from "./agent/pi/compaction.ts";
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
	/** Live data for clients watching a plugin topic (PluginContext.stream); hosts without live clients leave it out. */
	pluginEvent?(plugin: string, topic: string, data: unknown, options?: StreamPublishOptions): void;
}

export interface PrometheusHostOptions {
	dataDir?: string;
	/** Default working directory for new sessions. */
	cwd?: string;
	builtinPlugins?: PrometheusPlugin[];
	listener: HostListener;
}

/** How many trailing messages of a conversation are carried over for display when it continues in another runtime. */
const SEED_MESSAGES = 200;
const MAX_WARMED = 3;

/**
 * Index where the last `turns` turns of `messages[0..end)` begin. A turn starts at a user message, so a reply and its
 * tool calls are never split from the question; 0 when the whole range is shorter than that.
 */
/**
 * How much of a conversation goes out at a time is the server's call, whatever a client asks: the latest OPEN_TURNS turns
 * when one opens, PAGE_TURNS more per page when scrolling up, and either way no more than about PAGE_BYTES (after tool
 * results are cut down) unless a single turn is bigger. A client may ask for fewer, never more.
 */
export const OPEN_TURNS = 6;
export const PAGE_TURNS = 10;
export const PAGE_BYTES = 160 * 1024;

/**
 * The slimmed messages of whole turns ending before `end`, newest last: at most `turns` turns, and stopping at the first
 * turn boundary past `budget` bytes of JSON. Always at least one turn, so a page is never empty while there is history.
 */
export function tailPage(messages: readonly ChatMessage[], end: number, turns: number, budget = PAGE_BYTES): { messages: ChatMessage[]; offset: number } {
	const newestFirst: ChatMessage[] = [];
	let bytes = 0;
	let seen = 0;
	let start = 0;
	for (let i = end - 1; i >= 0; i--) {
		const m = slimMessage(messages[i]!);
		newestFirst.push(m);
		bytes += JSON.stringify(m).length;
		if (m.role === "user" && (++seen >= turns || bytes >= budget)) {
			start = i;
			break;
		}
	}
	// Ran out of history before either limit: everything up to `end` goes, including anything before the first user message.
	return { messages: newestFirst.reverse(), offset: start };
}

/** A client's requested number of turns, held to the server's limit. */
const turnsWanted = (asked: number | undefined, limit: number) => (asked && asked > 0 ? Math.min(Math.floor(asked), limit) : limit);

export function turnStart(messages: readonly { role: string }[], end: number, turns: number): number {
	let seen = 0;
	for (let i = end - 1; i >= 0; i--) {
		if (messages[i]?.role !== "user") continue;
		if (++seen === turns) return i;
	}
	return 0;
}
/** Offered in every chat's slash menu, whatever the agent. */
const GOAL_COMMAND: CommandInfo = { name: "goal", description: "Set an objective; the agent keeps working on its own until it is done (/goal pause | resume | clear)", source: "builtin" };

const BUILTIN_IDS: readonly string[] = BUILTIN_AGENTS.map((a) => a.id);
const CAPABILITIES: Record<Exclude<RuntimeKind, "pi">, RuntimeCapabilities> = { "claude-code": CC_CAPABILITIES, codex: CODEX_CAPABILITIES, opencode: OPENCODE_CAPABILITIES, acp: ACP_CAPABILITIES };
const KIND_LABEL: Record<RuntimeKind, string> = { pi: "PI", "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", acp: "ACP agent" };

interface LiveSession {
	session: RuntimeSession;
	bridge: UIBridge;
	gate: PermissionGate;
	subagents: SubagentRuntime;
	/** Transcript from another runtime, handed to the model on the first prompt only. */
	handoff?: string;
}

type Handlers = { [M in Exclude<RpcMethod, ServerRpcMethod>]: (params: RpcParams<M>, caller?: Caller) => Promise<RpcResult<M>> | RpcResult<M> };

export type { Caller } from "@prometheus/protocol";

/** Embeddable Prometheus host: one agent runtime, many sessions, all exposed through the RPC surface. */
export class PrometheusHost {
	readonly runtime: Runtime;
	/** Null when the PI agent is not installed: the other runtimes keep working and PI is offered for install. */
	private readonly pi: PiRuntime | null;
	private readonly cwd: string;
	private readonly live = new Map<string, LiveSession>();
	private readonly opening = new Map<string, Promise<LiveSession>>();
	private readonly paths = new Map<string, string>();
	private readonly pendingReload = new Set<string>();
	private readonly listener: HostListener;
	private readonly workspaces: WorkspaceStore;
	private readonly worktrees: WorktreeManager;
	private readonly index: SessionIndex;
	private readonly permissions: PermissionStore;
	private readonly owners: OwnerStore;
	private readonly badges: BadgeStore;
	private readonly externalRuntimes = new Map<string, AgentRuntime>();
	/** Runtimes replaced after a profile edit; what they keep across chats (a shared server) stops with the host. */
	private readonly retiredRuntimes: AgentRuntime[] = [];
	private externalServices: Promise<RuntimeServices> | undefined;
	/** /goal: keeps a conversation going on its own until the agent reports its objective done. */
	private readonly goals = new GoalTracker({
		prompt: (id, text) => this.prompt(id, text, undefined, undefined),
		view: (id) => this.goalView(id),
		emit: (id, goal) => this.emitEvent(id, { type: "goal_update", goal }),
		defaultTurns: () => this.runtime.config.get().goalTurns || GOAL_DEFAULT_TURNS,
		file: () => join(this.runtime.dataDir, "goals.json"),
	});

	private constructor(runtime: Runtime, pi: PiRuntime | null, options: PrometheusHostOptions) {
		this.runtime = runtime;
		this.pi = pi;
		this.cwd = options.cwd ?? process.cwd();
		this.listener = options.listener;
		this.workspaces = new WorkspaceStore(join(runtime.dataDir, "workspaces.json"));
		this.worktrees = new WorktreeManager(runtime.dataDir);
		this.index = new SessionIndex(join(runtime.dataDir, "sessions", "index.json"));
		this.permissions = new PermissionStore(join(runtime.dataDir, "sessions", "permissions.json"));
		this.owners = new OwnerStore(join(runtime.dataDir, "sessions", "owners.json"));
		this.badges = new BadgeStore(join(runtime.dataDir, "sessions", "badges.json"));
		runtime.plugins.sessionOps = {
			prompt: (id, text, opts) => this.pluginPrompt(id, text, opts?.actor),
			respond: async (id, requestId, response) => void this.require(id).bridge.respond(requestId, response),
			abort: async (id) => void (await this.live.get(id)?.session.abort()),
			exportTranscript: (id) => this.exportTranscript(id),
			importTranscript: (opts) => this.importTranscript(opts),
			setBadge: (id, badge) => this.setBadge(id, badge),
		};
		runtime.plugins.reloadSessions = () => this.reloadSessions();
		runtime.plugins.workspaces = async () => (await this.workspaces.list()).map((w) => ({ id: w.id, path: w.path, name: w.name }));
		runtime.plugins.hostProviders.push(async (req) => {
			const extras = await this.workspaces.extras(workspaceId(this.worktrees.rootOf(req.cwd)));
			if (!extras.length) return undefined;
			return { static: { sections: { extra_folders: `Additional project folders (the working folder is the primary one; these are also part of the project, read and edit files there by absolute path):
${extras.map((p) => `- ${p}`).join("
")}` }, guidelines: [] } };
		});
		runtime.plugins.runAgent = (opts) => this.runAgent(opts);
		runtime.plugins.openSession = (opts) => this.openSession(opts);
		runtime.plugins.sessionAccess = (id) => this.sessionAccess(id);
		runtime.plugins.sessionExists = (id) => this.sessionExists(id);
		runtime.plugins.sessionInfo = async (id) => (await this.listSessions()).find((x) => x.id === id);
		runtime.plugins.onChanged = () => this.listener.pluginsChanged();
		runtime.plugins.notifyPlugin = (name) => this.listener.pluginNotify(name);
		runtime.plugins.publishPlugin = (name, topic, data, opts) => this.listener.pluginEvent?.(name, topic, data, opts);
	}

	/** PI's model registry (shares auth.json/models.json with the TUI). */
	get modelRuntime(): PiRuntime["modelRuntime"] | undefined {
		return this.pi?.modelRuntime;
	}

	/** The PI runtime, or the error that tells the client to offer installing it. */
	private get needPi(): PiRuntime {
		if (!this.pi) throw new AppError("piNotInstalled");
		return this.pi;
	}

	static async create(options: PrometheusHostOptions): Promise<PrometheusHost> {
		const runtime = await bootstrap({ host: "server", dataDir: options.dataDir, cwd: options.cwd, builtinPlugins: options.builtinPlugins });
		let pi: PiRuntime | null = null;
		try {
			// Loaded on demand: the desktop installer does not carry the PI packages, and without them every other runtime still works.
			const { PiRuntime } = await import("./agent/pi/pi-runtime.ts");
			pi = await PiRuntime.start({ runtime, cwd: options.cwd ?? process.cwd() });
		} catch (err) {
			if (!isPiMissing(err)) throw err;
			console.warn("[prometheus] PI agent is not installed; only the other agent runtimes are available");
		}
		const host = new PrometheusHost(runtime, pi, options);
		await host.index.load();
		await host.worktrees.load();
		await host.permissions.load();
		await host.owners.load();
		await host.badges.load();
		pi?.syncGateways();
		void pruneUploads().catch(() => {});
		return host;
	}

	async call<M extends RpcMethod>(method: M, params: RpcParams<M>, caller?: Caller): Promise<RpcResult<M>> {
		const handler = (this.handlers as Partial<Record<RpcMethod, unknown>>)[method] as ((p: RpcParams<M>, caller?: Caller) => Promise<RpcResult<M>> | RpcResult<M>) | undefined;
		if (!handler) throw new AppError("notFound", { what: method });
		assertAgentAllowed(serverRole(), method, params);
		if (caller?.identity) this.assertIdentityMayCall(method, params, caller.identity);
		return handler(params ?? ({} as RpcParams<M>), caller);
	}

	/** The user the policy names as this server's owner, if any. */
	private serverOwner(): string | undefined {
		return this.runtime.config.policy()?.serverOwner;
	}

	/** What a vouched caller may do: the owner everything, a delegate reads and session writes only, and every session write needs a session it may act on. */
	private assertIdentityMayCall(method: string, params: unknown, identity: Identity): void {
		if (!identityMayCall(identity, this.serverOwner(), method)) throw new AppError("identityForbidden", { method });
		if (!SESSION_WRITE_METHODS.has(method)) return;
		const sessionId = (params as { sessionId?: unknown } | null | undefined)?.sessionId;
		if (typeof sessionId !== "string") throw new AppError("invalidParams", { method });
		if (!canAct(identity, this.owners.get(sessionId))) throw new AppError("sessionForbidden", { id: sessionId });
	}

	/** Every session event goes to the clients first, then to plugins; nothing a plugin does can disturb the stream. */
	private emitEvent(sessionId: string, event: SessionEvent): void {
		this.listener.event(sessionId, event);
		const plugins = this.runtime.plugins;
		if (!plugins.hasSessionListeners) return;
		const owner = this.owners.get(sessionId);
		const cwd = this.live.get(sessionId)?.session.cwd ?? this.index.get(sessionId)?.cwd ?? "";
		plugins.emitSession(sessionId, event, { ...(owner ? { owner } : {}), cwd });
	}

	private emitSessionsChanged(): void {
		this.listener.sessionsChanged();
		this.runtime.plugins.emitSessionsChanged();
	}

	/** Who owns the session, when a trusted issuer vouched for its creator. */
	sessionOwner(sessionId: string): string | undefined {
		return this.owners.get(sessionId);
	}

	/** The file a `file.link` ticket stands for (consumed by the HTTP download route). */
	takeDownload(id: string) {
		return takeTicket(id);
	}

	/** Whether `id` (from `panel.link`) still lets a plugin panel page load without the login cookie. */
	panelTicketValid(id: string | null | undefined): boolean {
		return panelTicketValid(id);
	}

	/** The live panel pass `id` and the identity of the client that asked for it (none for the machine's own user); undefined when it is not valid. */
	panelTicket(id: string | null | undefined): { identity?: Identity } | undefined {
		return panelTicketLookup(id);
	}

	async dispose(): Promise<void> {
		this.goals.dispose();
		for (const [id] of this.live) await this.closeSession(id);
		for (const rt of [...this.externalRuntimes.values(), ...this.retiredRuntimes.splice(0)]) await rt.dispose?.().catch(() => undefined);
		this.externalRuntimes.clear();
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

	/** The agent profile behind an id; built-ins have none unless the user configured an override. */
	private profileOf(id: string): AgentProfile | undefined {
		return this.runtime.config.agents().find((a) => a.id === id);
	}

	/** Runtime for a kind and, for custom agents, the profile whose executable and environment it uses. Profiles are read per use, so edits reach new sessions. */
	private async runtimeFor(kind: RuntimeKind, agent?: string): Promise<AgentRuntime> {
		if (kind === "pi") return this.needPi;
		const key = agent ?? kind;
		let rt = this.externalRuntimes.get(key);
		if (rt) return rt;
		// Which CLI runs: the executable the profile names, else the first one on PATH (the folder of one-click installs
		// is last on it, so who installed it does not matter), and for Claude Code the SDK's own when there is none.
		// Claude Code and Codex are resolved here because their runtimes would otherwise use the SDK's bundled CLI or
		// look at the server's own PATH.
		const executable = () => this.profileOf(key)?.executable || (kind === "claude-code" || kind === "codex" ? agentEntry(this.runtime.dataDir, kind, { ...process.env, ...(this.profileOf(key)?.env ?? {}) }) : undefined) || undefined;
		const env = () => withAgentBin(this.runtime.dataDir, { ...process.env, ...(this.profileOf(key)?.env ?? {}) }) as Record<string, string>;
		switch (kind) {
			case "claude-code":
				rt = new ClaudeCodeRuntime(() => this.servicesFor(), executable, env, (exe) => cliVersion(exe));
				break;
			case "opencode":
				rt = new OpenCodeRuntime(() => this.servicesFor(), executable, env, () => this.profileOf(key)?.server);
				break;
			case "acp":
				rt = new AcpRuntime(() => this.servicesFor(), () => {
					const profile = this.profileOf(key);
					const preset = agentPreset(key);
					return { id: key, name: profile?.name || preset?.name || key, command: profile?.executable || preset?.command || "", args: profile?.args ?? preset?.args ?? [], env: env() };
				});
				break;
			default:
				rt = new CodexRuntime(() => this.servicesFor(), executable, env);
		}
		this.externalRuntimes.set(key, rt);
		return rt;
	}

	/** Display name of the agent behind a session, for handoffs. */
	private agentName(kind: RuntimeKind, agent?: string): string {
		if (kind === "pi") return "PI";
		const id = agent ?? kind;
		return this.profileOf(id)?.name || agentPreset(id)?.name || KIND_LABEL[kind];
	}

	/**
	 * Which npm package (by AGENT_PACKAGES key) provides an agent's CLI: its own id for built-ins and ACP presets, the
	 * kind for custom agents built on Claude Code, Codex or OpenCode. Accepts an agent id or, as older clients send, a kind.
	 */
	private packageAgent(idOrKind: string | undefined): string {
		if (!idOrKind || idOrKind === "pi") throw new AppError("unknownRuntime", { runtime: String(idOrKind) });
		if (AGENT_PACKAGES[idOrKind]) return idOrKind;
		const kind = this.profileOf(idOrKind)?.kind;
		if (kind && kind !== "acp" && AGENT_PACKAGES[kind]) return kind;
		throw new AppError("unknownRuntime", { runtime: idOrKind });
	}

	/** The running CLI of an agent against the newest published version. */
	private async updateInfo(agent: AgentProfile, refresh: boolean): Promise<AgentUpdateInfo> {
		const base = { id: agent.id, updateAvailable: false } as const;
		if (agent.kind === "opencode" && agent.server?.url) return { ...base, source: "server", reason: "server" };
		if (agent.executable) return { ...base, source: "custom", reason: "custom" };
		let pkgAgent: string;
		try {
			pkgAgent = this.packageAgent(agent.id);
		} catch {
			return { ...base, source: "path", reason: "noPackage" };
		}
		const dataDir = this.runtime.dataDir;
		let source: AgentUpdateInfo["source"];
		let current: string | undefined;
		let canUpdate = true;
		const running = agentEntry(dataDir, pkgAgent, { ...process.env, ...(agent.env ?? {}) });
		if (running) {
			// Whatever is found first on PATH runs. Only a copy in Prometheus' own folder can be replaced from here.
			source = isManaged(dataDir, running) ? "prometheus" : "path";
			canUpdate = npmPrefixOf(pkgAgent, running) !== undefined;
			current = await cliVersion(running);
		} else if (agent.kind === "claude-code") {
			// The desktop installer ships without the SDK's binary; Claude Code is then simply not installed yet.
			if (!bundledClaudeBinary()) return { ...base, source: "missing", reason: "missing" };
			source = "bundled";
			current = bundledClaudeVersion();
		} else {
			return { ...base, source: "missing", reason: "missing" };
		}
		try {
			const latest = await latestVersion(pkgAgent, refresh);
			return { ...base, source, canUpdate, ...(current ? { current } : {}), latest, updateAvailable: !current || compareVersions(latest, current) > 0 };
		} catch (err) {
			return { ...base, source, ...(current ? { current } : {}), error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
		}
	}

	/** Drops the cached runtime of an agent; it is disposed with the host (live chats may still use it). */
	private retireRuntime(id: string): void {
		const rt = this.externalRuntimes.get(id);
		if (!rt) return;
		this.externalRuntimes.delete(id);
		if (rt.dispose) this.retiredRuntimes.push(rt);
	}

	/** Where a chosen model's traffic goes: a Prometheus gateway when the model's provider is one, else the agent's own login. */
	private gatewayFromModel(model: ModelRef | undefined, fallback?: GatewayChoice): GatewayChoice {
		if (model) {
			const g = this.runtime.config.gateways().find((x) => x.id === model.provider);
			if (g) return { mode: "prometheus", gatewayId: g.id, model };
			return { mode: "native" };
		}
		return fallback ?? { mode: "native" };
	}

	/** Built-in agents (with the user's overrides) followed by custom ones. */
	private agentList(): AgentProfile[] {
		const stored = this.runtime.config.agents();
		const builtin = BUILTIN_AGENTS.map((b): AgentProfile => stored.find((a) => a.id === b.id) ?? { id: b.id, name: b.name, kind: b.kind, ...(b.args ? { args: [...b.args] } : {}), enabled: true, builtin: true });
		return [...builtin, ...stored.filter((a) => !BUILTIN_IDS.includes(a.id))];
	}

	private syncIndex(id: string, live: LiveSession): void {
		const ref = live.session.ref();
		if (ref.runtime === "pi") return;
		const state = live.session.snapshotState();
		this.index.patch(id, { name: state.name, modified: new Date().toISOString(), messageCount: state.messages.length, firstMessage: titleWithoutNote(firstUserText(state.messages)).slice(0, 200) });
	}

	private async createExternal(kind: RuntimeKind, agent: string | undefined, dir: string, gateway: GatewayChoice | undefined, seed?: ChatMessage[]): Promise<LiveSession> {
		const rt = await this.runtimeFor(kind, agent);
		const choice: GatewayChoice = gateway ?? { mode: "native" };
		const live = await this.attach((init) => rt.create({ ...init, cwd: normalizeDir(dir), ...(seed ? { history: seed } : {}) }), choice);
		const now = new Date().toISOString();
		const ref = live.session.ref();
		this.index.upsert({ id: ref.id, runtime: kind, nativeId: ref.nativeId, cwd: normalizeDir(dir), created: now, modified: now, messageCount: 0, firstMessage: "", gateway: choice, ...(agent && agent !== kind ? { agent } : {}), ...(seed ? { seed } : {}) });
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
		gate.policy = this.gatePolicy();
		let session: RuntimeSession | undefined;
		let id = "";
		const subagents = new SubagentRuntime({
			store: new AgentStore(this.pi?.agentDir ?? piAgentDir()),
			cwd: () => session?.cwd ?? this.cwd,
			emit: (runs) => this.emitEvent(id, { type: "subagents_update", runs }),
			runners: {
				// Reads the chat's model and thinking level lazily: the session does not exist yet.
				pi: this.pi ? this.pi.subagentRunner(() => session) : async () => { throw new AppError("piNotInstalled"); },
				"claude-code": runClaude,
				codex: runCodex,
			},
		});
		const bridge = new UIBridge({
			request: (r) => {
				this.listener.uiRequest(id, r);
				this.runtime.plugins.emitUiRequest(id, r);
			},
			resolved: (rid) => {
				this.listener.uiResolved(id, rid);
				this.runtime.plugins.emitUiResolved(id, rid);
			},
		});
		const hooks: SessionHooks = {
			created: (s) => {
				session = s;
				id = s.id;
			},
			event: (e) => {
				this.emitEvent(id, e.type === "message_start" || e.type === "message_end" ? { ...e, message: slimMessage(e.message) } : e);
				if (e.type === "agent_settled") {
					this.goals.settled(id, e.aborted);
					if (this.worktrees.get(id)) void this.worktrees.checkpoint(id).catch(() => {});
				}
			},
			sessionsChanged: () => {
				const current = this.live.get(id);
				if (current) this.syncIndex(id, current);
				this.emitSessionsChanged();
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
		// PI wires these itself while it builds the session; the other runtimes ask through the same bridge.
		gate.ask ??= (prompt, signal) => bridge.askPermission(prompt, signal);
		gate.onModeChange ??= (mode) => {
			bridge.auto = mode === "auto";
			if (bridge.auto) bridge.autoResolvePending();
			// PI announces this itself; the others change the gate (also when a plan is approved) and the picker must follow.
			this.emitEvent(started.id, { type: "permission_mode_changed", mode });
		};
		// Remember every change, so the chat comes back in the same mode when it is opened again.
		const announce = gate.onModeChange;
		gate.onModeChange = (mode) => {
			this.permissions.set(started.id, mode);
			announce?.(mode);
		};
		bridge.auto = gate.mode === "auto";
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
		// PI writes the file with the first message, so a chat that was closed before anyone spoke in it has a remembered
		// path but no file. Opening that path would silently start an unrelated new session in the default folder.
		if (!existsSync(path)) {
			this.paths.delete(sessionId);
			throw new AppError("sessionNotFound", { id: sessionId });
		}
		return path;
	}

	private async open(sessionId: string): Promise<LiveSession> {
		const existing = this.live.get(sessionId);
		if (existing) return existing;
		let pending = this.opening.get(sessionId);
		if (!pending) {
			pending = (async () => {
				await this.worktrees.ensure(sessionId).catch(() => {});
				const live = await this.openFresh(sessionId);
				this.guardWorktree(live, sessionId);
				// Back to the mode it was left in; a chat from before modes were remembered gets the default setting.
				// A mode the policy has banned since (or that was saved before it) is not restored.
				live.gate.setMode(allowedMode(this.runtime.config.policy(), this.permissions.get(sessionId) ?? this.defaultPermission()));
				return live;
			})();
			pending.finally(() => this.opening.delete(sessionId)).catch(() => {});
			this.opening.set(sessionId, pending);
		}
		return pending;
	}

	private async openFresh(sessionId: string): Promise<LiveSession> {
		const entry = this.index.get(sessionId);
		if (entry && entry.runtime !== "pi") {
			const rt = await this.runtimeFor(entry.runtime, entry.agent);
			return this.attach((init) => rt.resume({ runtime: entry.runtime, id: entry.id, nativeId: entry.nativeId, cwd: entry.cwd, name: entry.name }, entry.seed ? { ...init, history: entry.seed } : init), entry.gateway);
		}
		const path = await this.resolvePath(sessionId);
		return this.attach((init) => this.needPi.resume({ runtime: "pi", id: sessionId, nativeId: sessionId, path }, init));
	}

	private require(sessionId: string): LiveSession {
		const live = this.live.get(sessionId);
		if (!live) throw new AppError("sessionNotOpen");
		return live;
	}

	/** The file behind a path the user wants to download, if the conversation's folder or an upload/temp folder holds it. */
	private async downloadable(sessionId: string, path: string) {
		const cwd = this.live.get(sessionId)?.session.cwd ?? this.index.get(sessionId)?.cwd;
		if (!cwd) return undefined;
		return resolveDownload(path, cwd, extraRoots(UPLOAD_ROOT));
	}

	/** Sessions opened by `session.warm` that no one has opened for real yet, oldest first. */
	private warmed: string[] = [];

	/** What the goal loop needs to decide on the next turn. */
	private goalView(sessionId: string): GoalView | undefined {
		const live = this.live.get(sessionId);
		if (!live) return undefined;
		const { session } = live;
		const { queue } = session.snapshotState();
		const messages = session.messages();
		const last = [...messages].reverse().find((m) => m.role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
		const failed = last?.stopReason === "error";
		return {
			isStreaming: session.isStreaming,
			queued: queue.steering.length + queue.followUp.length > 0,
			lastReply: session.lastReply(),
			...(failed ? { error: last?.errorMessage || "error" } : {}),
		};
	}

	/** `/goal ...` typed in the chat; null when the text is something else. */
	private async goalCommand(sessionId: string, text: string): Promise<PromptDisposition | null> {
		const command = parseGoalCommand(text);
		if (!command) return null;
		const live = this.require(sessionId);
		switch (command.action) {
			case "set": {
				const idle = !live.session.isStreaming;
				await this.goals.set(sessionId, command.objective, command.maxTurns);
				return idle && live.session.isStreaming ? "started" : "handled";
			}
			case "pause":
				this.goals.pause(sessionId);
				return "handled";
			case "resume":
				await this.goals.resume(sessionId);
				return "handled";
			case "clear":
				this.goals.clear(sessionId);
				return "handled";
			case "show": {
				// Re-announce the goal so every client shows it again; nothing to show tells the user how to set one.
				const goal = this.goals.get(sessionId);
				if (goal) this.emitEvent(sessionId, { type: "goal_update", goal });
				else this.listener.uiRequest(sessionId, { id: `goal-${Date.now()}`, method: "notify", message: "/goal <objective> [--max N] · /goal pause · /goal resume · /goal clear", level: "info" });
				return "handled";
			}
		}
	}

	private async closeSession(sessionId: string): Promise<void> {
		this.goals.drop(sessionId);
		const live = this.live.get(sessionId);
		if (!live) return;
		live.bridge.cancelAll();
		if (live.session.isStreaming) await live.session.abort().catch(() => {});
		live.subagents.dispose();
		this.live.delete(sessionId);
		await live.session.dispose();
	}

	/** Removes a session for good: its live state, transcript, uploads and list entry. */
	private refuseWhileRunning(sessionId: string): void {
		if (this.live.get(sessionId)?.session.isStreaming) throw new AppError("worktreeBusy");
	}

	private worktreeField(sessionId: string): { worktree?: SessionWorktree } {
		const wt = this.worktrees.get(sessionId);
		return wt ? { worktree: wt } : {};
	}

	/** Whether a new chat in `dir` gets its own worktree: the project's override wins, then the global setting and the new-chat switch. */
	private async wantsWorktree(dir: string, asked: boolean | undefined): Promise<boolean> {
		const override = await this.workspaces.override(workspaceId(dir));
		if (override !== "inherit") return override === "on";
		const mode = this.worktreeMode();
		if (mode === "off") return false;
		if (mode === "on") return true;
		return asked ?? this.runtime.config.get().worktreeDefault;
	}

	private worktreeMode(): WorktreeSetting {
		const m = this.runtime.config.get().worktreeMode;
		return m === "off" || m === "on" ? m : "ask";
	}

	private worktreeStrategy(): WorktreeStrategy {
		const m = this.runtime.config.get().worktreeStrategy;
		return m === "merge" || m === "apply" ? m : "squash";
	}

	/** Points a chat's permission gate at its worktree so it cannot write the project folder directly. */
	private guardWorktree(live: LiveSession, sessionId: string): void {
		live.gate.guard = this.worktrees.guardOf(sessionId);
	}

	/** Makes the chat's own checkout for a new chat, or tells why it works in the project folder instead. */
	private async tryWorktree(dir: string, asked: boolean | undefined): Promise<{ wt?: SessionWorktree; note?: string }> {
		if (!(await this.wantsWorktree(dir, asked))) return {};
		try {
			return { wt: await this.worktrees.create(dir) };
		} catch (err) {
			return { note: encodeError(err instanceof AppError ? err : new AppError("worktreeFailed", { error: err instanceof Error ? err.message : String(err) })) };
		}
	}

	private async deleteSession(sessionId: string): Promise<void> {
		await this.worktrees.release(sessionId).catch(() => {});
		void removeSessionUploads(sessionId).catch(() => {});
		this.goals.erase(sessionId);
		this.permissions.delete(sessionId);
		this.owners.delete(sessionId);
		this.badges.delete(sessionId);
		const entry = this.index.get(sessionId);
		if (entry && entry.runtime !== "pi") {
			await this.closeSession(sessionId);
			const rt = await this.runtimeFor(entry.runtime, entry.agent);
			await rt.deleteNative({ runtime: entry.runtime, id: entry.id, nativeId: entry.nativeId }).catch(() => {});
			this.index.delete(sessionId);
			await this.workspaces.setArchived(sessionId, false);
			this.emitSessionsChanged();
			return;
		}
		const live = this.live.get(sessionId);
		const path = live?.session.ref().path ?? (await this.resolvePath(sessionId).catch(() => undefined));
		await this.closeSession(sessionId);
		if (path && this.pi) await this.pi.deleteNative({ runtime: "pi", id: sessionId, nativeId: sessionId, path });
		this.paths.delete(sessionId);
		await this.workspaces.setArchived(sessionId, false);
		this.emitSessionsChanged();
	}

	private async listSessions(): Promise<SessionSummary[]> {
		const infos = (await this.pi?.listNative()) ?? [];
		for (const info of infos) if (info.ref.path) this.paths.set(info.ref.id, info.ref.path);
		await this.workspaces.ensure(infos.map((i) => ({ path: this.worktrees.rootOf(i.cwd), modified: i.modified })));
		const archived = await this.workspaces.archived();
		const listed = new Set(infos.map((i) => i.ref.id));
		const now = new Date().toISOString();
		// A first reply still in flight has no session file yet, so list it from memory.
		const unsaved: SessionSummary[] = [];
		for (const [id, live] of this.live) {
			// Other agents' conversations are listed from the index below; listing them here too showed the same id twice.
			if (listed.has(id) || !live.session.isStreaming || live.session.ref().runtime !== "pi" || this.index.get(id)) continue;
			const state = live.session.snapshotState();
			unsaved.push({
				id,
				name: state.name,
				cwd: state.cwd,
				created: now,
				modified: now,
				messageCount: state.messages.length,
				firstMessage: titleWithoutNote(firstUserText(state.messages)).slice(0, 200),
				live: true,
				running: true,
				archived: false,
				workspaceId: workspaceId(this.worktrees.rootOf(state.cwd)),
				...this.worktreeField(id),
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
				workspaceId: e.cwd ? workspaceId(this.worktrees.rootOf(e.cwd)) : "",
				...this.worktreeField(e.id),
				runtime: e.runtime,
				...(e.agent ? { agent: e.agent } : {}),
			});
		}
		await this.workspaces.ensure(external.map((e) => ({ path: this.worktrees.rootOf(e.cwd), modified: e.modified })));
		const all = [...external, ...infos
			.map((info) => ({
				id: info.ref.id,
				name: info.name,
				cwd: info.cwd,
				created: info.created,
				modified: info.modified,
				messageCount: info.messageCount,
				firstMessage: titleWithoutNote(imageOnlyTitle(info.firstMessage, info.messageCount)).slice(0, 200),
				live: this.live.has(info.ref.id),
				running: this.live.get(info.ref.id)?.session.isStreaming ?? false,
				archived: archived.has(info.ref.id),
				workspaceId: info.cwd ? workspaceId(this.worktrees.rootOf(info.cwd)) : "",
				...this.worktreeField(info.ref.id),
			})), ...unsaved]
			.sort((a, b) => b.modified.localeCompare(a.modified));
		return all.map((s) => {
			const owner = this.owners.get(s.id);
			const badge = this.badges.get(s.id);
			return owner || badge ? { ...s, ...(owner ? { owner } : {}), ...(badge ? { badge } : {}) } : s;
		});
	}

	private gatewayOf(ref: { id: string; runtime: RuntimeKind }): GatewayChoice | undefined {
		return ref.runtime === "pi" ? undefined : this.index.get(ref.id)?.gateway;
	}

	private snapshot(live: LiveSession, tail?: number): SessionSnapshot {
		const s = live.session.snapshotState();
		const page = tailPage(s.messages, s.messages.length, turnsWanted(tail, OPEN_TURNS));
		return {
			id: s.id,
			name: s.name,
			cwd: s.cwd,
			workspaceId: workspaceId(this.worktrees.rootOf(s.cwd)),
			...this.worktreeField(s.id),
			messages: page.messages,
			...(page.offset > 0 ? { messageOffset: page.offset } : {}),
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
			...(this.index.get(s.id)?.agent ? { agent: this.index.get(s.id)?.agent } : {}),
			...(this.goals.get(s.id) ? { goal: this.goals.get(s.id) } : {}),
			...(this.owners.get(s.id) ? { owner: this.owners.get(s.id) } : {}),
			...(this.badges.get(s.id) ? { badge: this.badges.get(s.id) } : {}),
		};
	}

	/** What a session may hand on to a delegated run (see AgentRunOptions.parentSessionId). */
	private sessionAccess(sessionId: string): RunAccess {
		const live = this.live.get(sessionId);
		return ceilingFor(live ? { unattended: live.gate.unattended, mode: live.gate.mode } : undefined);
	}

	private async sessionExists(sessionId: string): Promise<boolean> {
		if (this.live.has(sessionId) || this.index.get(sessionId)) return true;
		return this.resolvePath(sessionId).then(() => true, () => false);
	}

	/** Trusted plugin prompt (no caller check). A Hub still refuses to drive an agent. */
	private async pluginPrompt(sessionId: string, text: string, actor: string | undefined): Promise<void> {
		assertAgentAllowed(serverRole(), "chat.prompt", { sessionId, text });
		if (typeof text !== "string" || !text.trim()) throw new AppError("messageEmpty");
		const who = actor?.trim();
		const live = await this.open(sessionId);
		await this.prompt(sessionId, who ? `[来自 ${who}] ${text}` : text, undefined, live.session.isStreaming ? "followUp" : undefined);
	}

	/** The PI transcript file of a session; undefined for other runtimes or when nothing was written yet. */
	private async exportTranscript(sessionId: string): Promise<{ format: "pi-jsonl"; content: string } | undefined> {
		const live = this.live.get(sessionId);
		const runtime = live?.session.ref().runtime ?? this.index.get(sessionId)?.runtime ?? "pi";
		if (runtime !== "pi") return undefined;
		const path = live?.session.ref().path ?? (await this.resolvePath(sessionId).catch(() => undefined));
		if (!path) return undefined;
		try {
			return { format: "pi-jsonl", content: await readFile(path, "utf8") };
		} catch {
			return undefined;
		}
	}

	/** Writes a PI session file with a fresh id into the PI store, so it is listed and can be resumed. */
	private async importTranscript(opts: { cwd: string; content: string; name?: string; workspaceName?: string; owner?: string; runtime?: "pi" }): Promise<{ sessionId: string }> {
		if (opts.runtime !== undefined && opts.runtime !== "pi") throw new AppError("transcriptInvalid");
		const dir = opts.cwd?.trim();
		if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) throw new AppError("workdirNotFound", { dir });
		const cwd = normalizeDir(dir);
		const { id, path } = await this.needPi.importTranscript(cwd, opts.content, opts.name?.trim() || undefined);
		await this.workspaces.add(dir, opts.workspaceName?.trim() || undefined);
		this.paths.set(id, path);
		const owner = opts.owner ?? this.serverOwner();
		if (owner) this.owners.set(id, owner);
		this.emitSessionsChanged();
		return { sessionId: id };
	}

	private async setBadge(sessionId: string, badge: SessionBadge | undefined): Promise<void> {
		if (badge !== undefined && !(await this.sessionExists(sessionId))) throw new AppError("sessionNotFound", { id: sessionId });
		if (this.badges.set(sessionId, badge)) this.emitSessionsChanged();
	}

	/** A saved chat the user can open, as if they had pressed "new chat";the optional first message runs in the background. */
	private async openSession(options: OpenSessionOptions): Promise<{ sessionId: string }> {
		const dir = options.cwd?.trim();
		if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) throw new AppError("workdirNotFound", { dir });
		await this.workspaces.add(dir, options.workspaceName?.trim() || undefined);
		const live = await this.attach((init) => this.needPi.create({ ...init, cwd: normalizeDir(dir) }));
		if (options.name?.trim()) live.session.setName(options.name.trim());
		if (options.model) await live.session.setModel(options.model);
		this.assignOwner(live.session.id, undefined);
		this.emitSessionsChanged();
		const id = live.session.id;
		if (options.prompt?.trim()) void this.prompt(id, options.prompt, undefined, undefined).catch(() => {});
		return { sessionId: id };
	}

	/**
	 * Runs the agent to completion with no user present (automations, delegations), in a new saved session, or in
	 * an existing idle one. Nothing is ever asked: whatever `access` does not cover is refused, so the run cannot hang.
	 */
	private async runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
		const access = options.parentSessionId === undefined ? options.access : clampAccess(options.access, this.sessionAccess(options.parentSessionId));
		let live: LiveSession;
		let resumed = false;
		if (options.sessionId) {
			live = await this.open(options.sessionId);
			if (live.session.isStreaming) throw new AppError("generic");
			resumed = true;
		} else {
			const dir = options.cwd?.trim();
			if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) throw new AppError("workdirNotFound", { dir });
			await this.workspaces.add(dir);
			live = await this.attach((init) => this.needPi.create({ ...init, cwd: normalizeDir(dir) }));
			this.assignOwner(live.session.id, undefined);
		}
		const { session, bridge, gate } = live;
		const id = session.id;
		const before = { unattended: gate.unattended, headless: bridge.headless };
		gate.unattended = access;
		bridge.headless = true;
		gate.takeBlocked(); // refusals are reported per run
		if (!resumed && options.name?.trim()) session.setName(options.name.trim());
		try {
			options.onStart?.(id);
		} catch {
			// a recording hook must never break the run
		}
		this.emitSessionsChanged();

		const stop = () => void session.abort().catch(() => {});
		const timeout = setTimeout(stop, options.timeoutMs ?? 30 * 60_000);
		options.signal?.addEventListener("abort", stop, { once: true });
		try {
			if (options.model) await session.setModel(options.model);
			const seen = session.messages().length;
			await session.run({ text: options.prompt });
			const messages = session.messages();
			const fresh = messages.slice(seen);
			const aborted = options.signal?.aborted || fresh.some((m) => (m as unknown as { stopReason?: string }).stopReason === "aborted");
			const last = messages[messages.length - 1] as unknown as { stopReason?: string; errorMessage?: string } | undefined;
			const blocked = gate.takeBlocked();
			const refused = blocked.length ? { blocked } : {};
			if (aborted) return { sessionId: id, status: "aborted", access, text: session.lastReply(), error: encodeError(new AppError("aborted")), ...refused };
			if (last?.stopReason === "error") return { sessionId: id, status: "error", access, text: session.lastReply(), error: last.errorMessage ?? encodeError(new AppError("generic")), ...refused };
			return { sessionId: id, status: "success", access, text: session.lastReply(), ...refused };
		} catch (err) {
			const blocked = gate.takeBlocked();
			return { sessionId: id, status: "error", access, text: session.lastReply(), error: err instanceof Error ? err.message : String(err), ...(blocked.length ? { blocked } : {}) };
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", stop);
			if (resumed) {
				// The chat carries on as it was: the user may be looking at it.
				gate.unattended = before.unattended;
				bridge.headless = before.headless;
			} else {
				// Nobody is subscribed to this session; release it once saved. It stays in the sidebar from disk.
				await this.closeSession(id).catch(() => {});
			}
			this.emitSessionsChanged();
		}
	}

	private async prompt(sessionId: string, text: string, images: ImageContent[] | undefined, delivery: "steer" | "followUp" | undefined): Promise<PromptDisposition> {
		const live = this.require(sessionId);
		const context = live.handoff ? handoffBlock(live.handoff) : undefined;
		const disposition = await live.session.prompt({ text, images, ...(context ? { context } : {}) }, delivery ?? "send");
		if (context) live.handoff = undefined;
		return disposition;
	}

	// ---------- message operations ----------

	private resetMessages(id: string, live: LiveSession): void {
		const all = live.session.snapshotState().messages;
		const page = tailPage(all, all.length, OPEN_TURNS);
		this.emitEvent(id, { type: "messages_reset", messages: page.messages, ...(page.offset > 0 ? { offset: page.offset } : {}) });
		this.emitSessionsChanged();
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

	/** Records the owner of a new session: the vouched caller, else the session it came from, else the server's owner (plugins, automations, imports). */
	private assignOwner(id: string, caller: Caller | undefined, from?: string): void {
		const owner = caller?.identity?.userId ?? (from ? this.owners.get(from) : undefined) ?? this.serverOwner();
		if (owner) this.owners.set(id, owner);
	}

	private async forkMessage(sessionId: string, ref: MessageRef, caller?: Caller): Promise<{ snapshot: SessionSnapshot; editorText?: string }> {
		const live = this.require(sessionId);
		if (!live.session.fork) throw new AppError("generic");
		const { editorText, ...forkRef } = await live.session.fork(ref);
		const forked = await this.attach((init) => this.needPi.resume(forkRef, init));
		const baseName = live.session.snapshotState().name;
		if (baseName) forked.session.setName(`${baseName} (fork)`);
		// A fork belongs to whoever made it; without an identity it keeps the source's owner.
		this.assignOwner(forked.session.id, caller, sessionId);
		this.emitSessionsChanged();
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

	/** What each permission gate enforces from the administrator policy. */
	private gatePolicy(): GatePolicy | undefined {
		const policy = this.runtime.config.policy();
		const readOutsideProject = this.runtime.config.readOutsideProject();
		if (!policy?.forbiddenModes && readOutsideProject === "allow") return undefined;
		return {
			...(policy?.forbiddenModes ? { forbiddenModes: policy.forbiddenModes } : {}),
			...(readOutsideProject === "ask" ? { readOutsideProject } : {}),
		};
	}

	private hostSettings(): HostSettings {
		const policy = this.runtime.config.policy();
		return { ...(policy ? { policy: publicPolicy(policy) } : {}), ...(this.runtime.config.readOutsideProject() === "ask" ? { readOutsideProject: "ask" as const } : {}), autoCompaction: this.pi?.autoCompaction() ?? true, workspaceRoot: this.workspaceRoot(), defaultAgent: this.defaultAgent(), defaultPermission: this.defaultPermission(), defaultThinking: this.defaultThinking(), goalTurns: this.runtime.config.get().goalTurns || GOAL_DEFAULT_TURNS, compactPercent: this.compactPercent(), worktreeMode: this.worktreeMode(), worktreeDefault: this.runtime.config.get().worktreeDefault, worktreeStrategy: this.worktreeStrategy() };
	}

	/** The permission mode new chats start in; unknown values (a hand-edited config) fall back to asking first. */
	private defaultPermission(): PermissionMode {
		const mode = this.runtime.config.get().defaultPermission?.trim();
		return PERMISSION_MODES.find((m) => m === mode) ?? "default";
	}

	/** Auto-compaction threshold in percent; the built-in default when the setting is unset. */
	private compactPercent(): number {
		const set = this.runtime.config.get().compactPercent;
		return set >= 1 ? set : DEFAULT_COMPACT_PERCENT;
	}

	/** Thinking level new chats start in; unset or unknown leaves the choice to the model. */
	private defaultThinking(): ThinkingLevel | undefined {
		const level = this.runtime.config.get().defaultThinking?.trim();
		return THINKING_LEVELS.find((l) => l === level);
	}

	/** The agent new chats start with; falls back to PI when the configured one was deleted or hidden. */
	private defaultAgent(): string {
		const id = this.runtime.config.get().defaultAgent?.trim();
		if (!id || id === "pi") return "pi";
		return this.agentList().some((a) => a.id === id && a.enabled !== false) ? id : "pi";
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
			piVersion: this.pi?.version ?? "",
			protocol: PROTOCOL_VERSION,
			cwd: this.cwd,
			platform: process.platform,
		}),

		"session.list": () => this.listSessions(),
		"session.create": async ({ cwd, name, runtime: kind, agent, model, gateway, worktree }, caller) => {
			const dir = cwd?.trim() || this.cwd;
			if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new AppError("workdirNotFound", { dir });
			await this.workspaces.add(dir);
			const { wt, note } = await this.tryWorktree(dir, worktree);
			const workDir = wt?.cwd ?? dir;
			let live: LiveSession;
			try {
				live = kind && kind !== "pi" ? await this.createExternal(kind, agent, workDir, this.gatewayFromModel(model, gateway)) : await this.attach((init) => this.needPi.create({ ...init, cwd: normalizeDir(workDir) }));
			} catch (err) {
				if (wt) await this.worktrees.dispose(wt).catch(() => {});
				throw err;
			}
			if (wt) {
				await this.worktrees.bind(live.session.id, wt);
				this.guardWorktree(live, live.session.id);
			}
			if (note) live.bridge.context().notify(note, "warning");
			if (name?.trim()) live.session.setName(name.trim());
			this.assignOwner(live.session.id, caller);
			// The configured starting level, if this model offers it; otherwise keep the model's own default.
			const wanted = this.defaultThinking();
			if (wanted && live.session.snapshotState().availableThinkingLevels.includes(wanted)) await live.session.setThinking(wanted);
			this.emitSessionsChanged();
			return this.snapshot(live);
		},
		"session.switchRuntime": async ({ sessionId, runtime: kind, agent, model, gateway }, caller) => {
			const source = await this.open(sessionId);
			if (source.session.isStreaming) throw new AppError("generic");
			const state = source.session.snapshotState();
			const from = source.session.ref().runtime;
			const dir = state.cwd;
			const seed = state.messages.slice(-SEED_MESSAGES);
			const live = kind !== "pi" ? await this.createExternal(kind, agent, dir, this.gatewayFromModel(model, gateway), seed) : await this.attach((init) => this.needPi.create({ ...init, cwd: normalizeDir(dir), history: seed }));
			// The checkout moves to the new chat; releasing it with the old one would delete it.
			await this.worktrees.move(sessionId, live.session.id);
			this.guardWorktree(live, live.session.id);
			if (state.name) live.session.setName(state.name);
			// The source may hold a mode the policy has banned since; carry over what is still allowed so the switch cannot fail half way.
			live.gate.setMode(allowedMode(this.runtime.config.policy(), source.gate.mode));
			this.assignOwner(live.session.id, caller, sessionId);
			const handoff = buildHandoff(state.messages, this.agentName(from, this.index.get(sessionId)?.agent));
			// PI carries the history itself; the others get the transcript as hidden first-turn context.
			if (handoff && kind !== "pi") live.handoff = handoff;
			// A goal in progress carries on with the new agent.
			this.goals.move(sessionId, live.session.id);
			await this.deleteSession(sessionId);
			this.emitSessionsChanged();
			return this.snapshot(live);
		},
		"session.open": async ({ sessionId, tail }) => {
			const live = await this.open(sessionId);
			this.warmed = this.warmed.filter((id) => id !== sessionId);
			return this.snapshot(live, tail);
		},
		"session.warm": async ({ sessionId }) => {
			// Only PI sessions are cheap to hold; the others would start a child process for a hover.
			const entry = this.index.get(sessionId);
			if (this.live.has(sessionId) || (entry && entry.runtime !== "pi")) return null;
			await this.open(sessionId);
			this.warmed = [...this.warmed.filter((id) => id !== sessionId), sessionId];
			// Hovering many conversations must not leave them all open: release the oldest unclaimed ones.
			while (this.warmed.length > MAX_WARMED) {
				const old = this.warmed.shift()!;
				const live = this.live.get(old);
				if (live && !live.session.isStreaming) await this.closeSession(old);
			}
			return null;
		},
		"session.toolResult": async ({ sessionId, toolCallId }) => {
			const content = fullResultContent((await this.open(sessionId)).session.snapshotState().messages, toolCallId);
			if (!content) throw new AppError("messageNotFound");
			return { content };
		},
		"file.stat": async ({ sessionId, path }) => {
			const file = await this.downloadable(sessionId, path);
			return file ? { exists: true, name: file.name, size: file.size } : { exists: false };
		},
		"file.link": async ({ sessionId, path }) => {
			const file = await this.downloadable(sessionId, path);
			if (!file) throw new AppError("fileNotFound", { path });
			return { id: issueTicket(file), name: file.name };
		},
		"file.read": async ({ sessionId, path, offset, length }) => {
			const file = await this.downloadable(sessionId, path);
			if (!file) throw new AppError("fileNotFound", { path });
			return readChunk(file, offset, length);
		},
		"session.messages": async ({ sessionId, before, turns }) => {
			const messages = (await this.open(sessionId)).session.snapshotState().messages;
			const end = Math.max(0, Math.min(before, messages.length));
			return tailPage(messages, end, turnsWanted(turns, PAGE_TURNS));
		},
		"session.rename": async ({ sessionId, name }) => {
			(await this.open(sessionId)).session.setName(name.trim());
			this.emitSessionsChanged();
			return null;
		},
		"session.close": async ({ sessionId }) => {
			await this.closeSession(sessionId);
			this.emitSessionsChanged();
			return null;
		},
		"session.archive": async ({ sessionId, archived }) => {
			await this.workspaces.setArchived(sessionId, archived);
			if (archived) await this.closeSession(sessionId);
			this.emitSessionsChanged();
			return null;
		},
		"session.delete": async ({ sessionId }) => {
			await this.deleteSession(sessionId);
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
		"message.fork": ({ sessionId, ref }, caller) => this.forkMessage(sessionId, ref, caller),

		"workspace.list": async () => {
			// Nothing here needs the session index: the store already knows which folders were used. Reading
			// every session file to answer this made opening a workspace as slow as listing all history.
			return this.workspaces.list();
		},
		"workspace.add": async ({ path, name, extraPaths }) => {
			const w = await this.workspaces.add(path, name, extraPaths);
			this.emitSessionsChanged();
			return w;
		},
		"workspace.setFolders": async ({ id, extraPaths }) => {
			const w = await this.workspaces.setFolders(id, extraPaths);
			this.emitSessionsChanged();
			return w;
		},
		"workspace.rename": async ({ id, name }) => {
			const w = await this.workspaces.rename(id, name);
			this.emitSessionsChanged();
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
			this.emitSessionsChanged();
			return null;
		},
		"workspace.setWorktree": async ({ id, mode }) => {
			if (!["inherit", "off", "on"].includes(mode)) throw new AppError("generic");
			const w = await this.workspaces.setWorktree(id, mode);
			this.emitSessionsChanged();
			return w;
		},
		"worktree.status": ({ sessionId }) => this.worktrees.status(sessionId),
		"worktree.sync": ({ sessionId }) => {
			this.refuseWhileRunning(sessionId);
			return this.worktrees.sync(sessionId);
		},
		"worktree.merge": async ({ sessionId, strategy, message }) => {
			this.refuseWhileRunning(sessionId);
			const result = await this.worktrees.merge(sessionId, strategy ?? this.worktreeStrategy(), message);
			this.emitSessionsChanged();
			return result;
		},
		"worktree.discard": async ({ sessionId }) => {
			this.refuseWhileRunning(sessionId);
			await this.worktrees.discard(sessionId);
			const live = this.live.get(sessionId);
			if (live) live.gate.guard = undefined;
			this.emitSessionsChanged();
			return null;
		},
		"worktree.diff": ({ sessionId, path }) => this.worktrees.diff(sessionId, path),
		"worktree.pending": async ({ workspaceId: id }) =>
			Promise.all(this.worktrees.pending(id).map(async ({ sessionId, wt }) => ({ sessionId, branch: wt.branch, files: await this.worktrees.fileCount(sessionId) }))),
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

		"settings.get": () => this.hostSettings(),
		"settings.set": async ({ autoCompaction, workspaceRoot, defaultAgent, defaultPermission, defaultThinking, goalTurns, compactPercent, worktreeMode, worktreeDefault, worktreeStrategy, readOutsideProject }) => {
			if (typeof autoCompaction === "boolean") {
				await this.pi?.setAutoCompaction(autoCompaction);
				// Live sessions cache their own SettingsManager.
				for (const { session } of this.live.values()) session.setAutoCompaction?.(autoCompaction);
			}
			if (typeof workspaceRoot === "string") {
				const next = workspaceRoot.trim();
				if (next && (!existsSync(next) || !statSync(next).isDirectory())) throw new AppError("dirNotFound", { dir: next });
				await this.runtime.config.setWorkspaceRoot(next);
			}
			if (typeof defaultAgent === "string") {
				const next = defaultAgent.trim() || "pi";
				if (next !== "pi" && !this.agentList().some((a) => a.id === next)) throw new AppError("notFound", { what: next });
				await this.runtime.config.setDefaultAgent(next);
			}
			if (typeof defaultPermission === "string") {
				if (!PERMISSION_MODES.includes(defaultPermission)) throw new AppError("unknownPermissionMode", { mode: String(defaultPermission) });
				await this.runtime.config.setDefaultPermission(defaultPermission);
			}
			if (worktreeMode !== undefined || worktreeDefault !== undefined || worktreeStrategy !== undefined) {
				if (worktreeMode !== undefined && !["off", "ask", "on"].includes(worktreeMode)) throw new AppError("generic");
				if (worktreeStrategy !== undefined && !["squash", "merge", "apply"].includes(worktreeStrategy)) throw new AppError("generic");
				await this.runtime.config.setWorktree({ mode: worktreeMode, default: typeof worktreeDefault === "boolean" ? worktreeDefault : undefined, strategy: worktreeStrategy });
			}
			if (typeof compactPercent === "number") await this.runtime.config.setCompactPercent(compactPercent);
			if (readOutsideProject === "allow" || readOutsideProject === "ask") {
				await this.runtime.config.setReadOutsideProject(readOutsideProject);
				// Open chats follow the change at once.
				for (const live of this.live.values()) live.gate.policy = this.gatePolicy();
			}
			if (typeof defaultThinking === "string") {
				// An empty string clears it: new chats then keep whatever level their model starts at.
				const next = defaultThinking.trim();
				if (next && !THINKING_LEVELS.includes(next as ThinkingLevel)) throw new AppError("generic");
				await this.runtime.config.setDefaultThinking(next);
			}
			if (typeof goalTurns === "number") await this.runtime.config.setGoalTurns(Math.min(GOAL_MAX_TURNS, goalTurns));
			return this.hostSettings();
		},
		"session.stats": ({ sessionId }) => this.require(sessionId).session.usage(),

		"usage.stats": ({ days }) => (this.pi ? this.pi.collectUsage(days ?? 0) : collectUsage([], 0)),

		"chat.prompt": async ({ sessionId, text, images, files, delivery }) => {
			if (!text.trim() && !images?.length && !files?.length) throw new AppError("messageEmpty");
			checkImages(images);
			const wt = this.worktrees.get(sessionId);
			if (wt && wt.state !== "active") throw new AppError("worktreeGone");
			// Documents the model cannot read itself: stored in a temporary folder, and the message says where.
			const saved = files?.length ? await saveAttachments(sessionId, files) : [];
			const body = withAttachmentNote(text, saved);
			const goal = !saved.length && !images?.length ? await this.goalCommand(sessionId, text) : null;
			if (goal) return { disposition: goal };
			const disposition = await this.prompt(sessionId, body, images, delivery);
			return { disposition };
		},
		"goal.set": async ({ sessionId, objective, maxTurns }) => {
			this.require(sessionId);
			if (!objective?.trim()) throw new AppError("messageEmpty");
			return this.goals.set(sessionId, objective, maxTurns);
		},
		"goal.control": async ({ sessionId, action }) => {
			this.require(sessionId);
			if (action === "pause") return this.goals.pause(sessionId);
			if (action === "resume") return this.goals.resume(sessionId);
			return this.goals.clear(sessionId);
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

		"model.list": async () => (this.pi ? this.pi.listModels({ mode: "native" }) : []),
		"runtime.list": async (): Promise<RuntimeInfo[]> => {
			const out: RuntimeInfo[] = [{ id: "pi", name: "PI", kind: "pi", health: this.pi ? await this.pi.probe() : { available: false, missing: true }, capabilities: PI_CAPABILITIES }];
			// Probes start processes (an ACP handshake takes seconds): run them side by side.
			const agents = await Promise.all(
				this.agentList()
					.filter((a) => a.enabled !== false)
					.map(async (agent): Promise<RuntimeInfo> => {
						const rt = await this.runtimeFor(agent.kind, agent.id).catch(() => undefined);
						const health = (await rt?.probe().catch((err: unknown) => ({ available: false, reason: err instanceof Error ? err.message : String(err) }))) ?? { available: false, reason: "unavailable" };
						return {
							id: agent.id,
							name: agent.name,
							kind: agent.kind,
							health: health.available ? health : { ...health, ...(await agentStatuses(this.runtime.dataDir, agent.id)) },
							capabilities: CAPABILITIES[agent.kind],
						};
					}),
			);
			return [...out, ...agents];
		},
		"runtime.models": async ({ runtime: kind, agent }) => {
			if (kind === "pi") return this.pi ? this.pi.listModels({ mode: "native" }) : [];
			const rt = await this.runtimeFor(kind, agent);
			return rt.listAllModels ? rt.listAllModels(this.runtime.config.gateways()) : rt.listModels({ mode: "native" });
		},
		"agent.list": () => this.agentList(),
		"agent.syncSessions": async ({ id }) => {
			const agent = this.agentList().find((a) => a.id === id);
			if (!agent) throw new AppError("notFound", { what: id });
			const rt = await this.runtimeFor(agent.kind, agent.id);
			const native = (await rt.listNative()).filter((n) => n.cwd);
			const known = new Set(this.index.list().filter((e) => e.runtime === agent.kind).map((e) => e.nativeId));
			const before = (await this.workspaces.list()).length;
			const owner = this.serverOwner();
			await this.workspaces.ensure(native.map((n) => ({ path: this.worktrees.rootOf(n.cwd), modified: n.modified })));
			let added = 0;
			for (const n of native) {
				if (known.has(n.ref.nativeId)) continue;
				known.add(n.ref.nativeId);
				this.index.upsert({
					id: n.ref.id,
					runtime: agent.kind,
					nativeId: n.ref.nativeId,
					cwd: normalizeDir(n.cwd),
					...(n.name ? { name: n.name } : {}),
					created: n.created,
					modified: n.modified,
					messageCount: n.messageCount,
					firstMessage: titleWithoutNote(n.firstMessage).slice(0, 200),
					gateway: { mode: "native" },
					...(agent.id !== agent.kind ? { agent: agent.id } : {}),
				});
				if (owner) this.owners.set(n.ref.id, owner);
				added++;
			}
			await this.index.flush();
			if (added) this.emitSessionsChanged();
			return { found: native.length, added, workspaces: (await this.workspaces.list()).length - before };
		},
		"agent.save": async ({ agent }) => {
			const saved = await this.runtime.config.saveAgent(agent);
			// A new executable, environment or server applies to chats started from now on.
			this.retireRuntime(saved.id);
			return saved;
		},
		"agent.delete": async ({ id }) => {
			// Built-ins cannot be removed: dropping the override resets them.
			await this.runtime.config.deleteAgent(id);
			this.retireRuntime(id);
			return null;
		},
		/** Installs (or upgrades to the latest) a third-party CLI into Prometheus' own folder; it is used from the next chat on. */
		"agent.install": async ({ kind, agent }) => {
			const id = this.packageAgent(agent ?? kind);
			try {
				// A CLI that is already installed with npm is updated where it is, whoever installed it; otherwise it goes
				// into Prometheus' own folder.
				// Claude Code is driven through the Agent SDK, which the installer does not carry either.
				if (id === "claude-code" && !(await optionalPackageStatus(this.runtime.dataDir, "claude-agent-sdk")).installed) await installOptionalPackage(this.runtime.dataDir, "claude-agent-sdk");
				const profile = this.profileOf(agent ?? kind ?? id);
				const running = agentEntry(this.runtime.dataDir, id, { ...process.env, ...(profile?.env ?? {}) });
				const { command } = await installAgentCli(this.runtime.dataDir, id, running ? npmPrefixOf(id, running) : undefined);
				for (const key of [...this.externalRuntimes.keys()]) this.retireRuntime(key);
				return { command };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// Windows keeps a running executable locked, so npm cannot replace it while a chat uses it.
				if (/EBUSY|EPERM|resource busy|operation not permitted/i.test(message)) throw new Error(`${message}\n\nThe CLI is in use: close the chats that use this agent (or stop its server) and try again.`);
				throw err;
			}
		},
		"agent.uninstall": async ({ kind, agent }) => {
			const id = this.packageAgent(agent ?? kind);
			await uninstallAgentCli(this.runtime.dataDir, id);
			for (const key of [...this.externalRuntimes.keys()]) this.retireRuntime(key);
			return null;
		},
		"package.optionalList": () => Promise.all((Object.keys(OPTIONAL_PACKAGES) as OptionalPackageId[]).map((id) => optionalPackageStatus(this.runtime.dataDir, id))),
		"package.optionalInstall": async ({ id }) => {
			if (!isOptionalPackage(id)) throw new AppError("notFound", { what: id });
			await installOptionalPackage(this.runtime.dataDir, id);
			return optionalPackageStatus(this.runtime.dataDir, id);
		},
		"package.optionalUninstall": async ({ id }) => {
			if (!isOptionalPackage(id)) throw new AppError("notFound", { what: id });
			await uninstallOptionalPackage(this.runtime.dataDir, id);
			if (id === "claude-agent-sdk") for (const key of [...this.externalRuntimes.keys()]) this.retireRuntime(key);
			return optionalPackageStatus(this.runtime.dataDir, id);
		},
		"agent.checkUpdates": async ({ id, refresh }) => {
			const agents = this.agentList().filter((a) => (id ? a.id === id : a.enabled !== false));
			return Promise.all(agents.map((a) => this.updateInfo(a, refresh === true)));
		},
		"model.set": async ({ sessionId, model }) => {
			const { session } = this.require(sessionId);
			if (session.ref().runtime !== "pi") {
				// The external runtime owns the model list; it emits `model_changed` itself.
				await session.setModel(model);
				// The model decides the route, so a gateway change must survive reopening the chat.
				this.index.patch(sessionId, { gateway: this.gatewayFromModel(model) });
				return null;
			}
			const target = this.needPi.getModel(model.provider, model.id);
			if (!target) throw new AppError("modelNotFound", { provider: model.provider, id: model.id });
			await session.setModel(model);
			this.emitEvent(sessionId, { type: "model_changed", model: toModelRef(target) });
			this.emitEvent(sessionId, { type: "thinking_level_changed", level: session.snapshotState().thinkingLevel });
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

		"commands.list": async ({ sessionId }) => [GOAL_COMMAND, ...(await this.require(sessionId).session.commands())],
		"tools.list": ({ sessionId }) => this.require(sessionId).session.tools(),

		"ui.respond": ({ sessionId, requestId, response }) => {
			this.require(sessionId).bridge.respond(requestId, response);
			return null;
		},

		"gateway.list": () => this.runtime.config.gateways().map(redactGateway),
		"gateway.save": async ({ gateway }) => {
			const saved = await this.runtime.config.saveGateway(gateway);
			this.pi?.syncGateways();
			this.listener.gatewaysChanged();
			return redactGateway(saved);
		},
		"gateway.delete": async ({ id }) => {
			await this.runtime.config.deleteGateway(id);
			this.pi?.syncGateways();
			this.listener.gatewaysChanged();
			return null;
		},
		"gateway.test": async ({ id, model }) => {
			const g = this.runtime.config.gateways().find((x) => x.id === id);
			if (!g) throw new AppError("gatewayNotFound", { id });
			const modelId = model ?? g.models[0]?.id;
			const target = modelId && this.needPi.getModel(id, modelId);
			if (!target) throw new AppError("gatewayNotRegistered");
			const started = performance.now();
			try {
				const reply = await this.needPi.completeSimple(
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
			for (const m of this.pi?.getModels() ?? []) {
				if (this.pi?.registeredGateways.has(m.provider)) continue;
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
			return ((await this.pi?.readPiGateways()) ?? []).map(({ gateway: g, missingKey }) => ({
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
			for (const { gateway, missingKey } of (await this.pi?.readPiGateways()) ?? []) {
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
				this.pi?.syncGateways();
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
		"panel.link": (_params, caller) => ({ id: issuePanelTicket(caller?.identity) }),
		"plugin.call": async ({ plugin, method, params }, caller) => {
			const handler = this.runtime.plugins.rpcs.get(`${plugin}/${method}`);
			if (!handler) throw new AppError("pluginMethodNotFound", { plugin, method });
			const isObject = params !== null && typeof params === "object" && !Array.isArray(params);
			return (await handler(isObject ? (params as Record<string, unknown>) : {}, caller)) ?? null;
		},
	};
}
