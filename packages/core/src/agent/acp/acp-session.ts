// AcpSession: one agent process speaking the Agent Client Protocol over stdio, behind the runtime-neutral
// RuntimeSession. Prometheus tools reach the agent as an MCP server (the tool bus, over HTTP or a stdio bridge),
// permission requests go through the single PermissionGate, and the agent is kept in its own "ask" mode so that the
// gate decides by Prometheus' permission mode (docs/agent-runtime.md §4, §6, §12.6).
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginTool, PluginToolContext } from "@prometheus/plugin-sdk";
import { AppError, type ChatMessage, type CommandInfo, type GatewayFormat, type ModelRef, type PermissionMode, type PromptDisposition, type SessionEvent, type SessionStats, type ThinkingLevel, type ToolInfo, gatewayAs, pickGatewayFormat } from "@prometheus/protocol";
import type { PermissionGate } from "../../permission-gate.ts";
import { applyPermissionPrompt } from "../../permission-gate.ts";
import type { BusSession } from "../bus/tool-bus.ts";
import { buildHandoff, handoffBlock } from "../handoff.ts";
import { withLoopbackNoProxy } from "../loopback-env.ts";
import type { RelayGrant } from "../relay/gateway-relay.ts";
import type { GatewayChoice, PromptDelivery, RuntimeCapabilities, RuntimeServices, RuntimeSession, RuntimeSnapshot, SessionHooks, SessionInit, SessionRef, UserInput } from "../types.ts";
import { AcpConnection, AcpError, resolveAcpCommand } from "./acp-connection.ts";
import { acpGatewayAdapter } from "./acp-gateway.ts";
import { AcpMapper, CONTEXT_TAG, canonicalAcpTool } from "./acp-mapper.ts";
import { mcpBridgeScript } from "./mcp-bridge.ts";

export const ACP_CAPABILITIES: RuntimeCapabilities = {
	steering: false,
	followUpQueue: true,
	compaction: "none",
	fork: false,
	treeNavigation: false,
	thinkingLevels: [],
	images: true,
	liveToolListChange: false,
	systemPromptReplace: "none",
	contextBreakdown: false,
	permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions", "auto"],
	nativeTools: ["exec", "read", "edit", "write", "search", "fetch", "todo"],
};

/** The agent picks the model from its own configuration when none is named. */
export const ACP_DEFAULT_MODEL = "default";
/** Model provider of an ACP agent's own models (anything else is a gateway id). */
export const ACP_PROVIDER = "acp";
const PROTOCOL_VERSION = 1;
const MCP_NAME = "prometheus";

/** What to run for one ACP agent, resolved from its profile or preset. */
export interface AcpAgentSpec {
	id: string;
	name: string;
	command: string;
	args: string[];
	/** Environment for the agent process (already includes the user's own and the profile's). */
	env: Record<string, string | undefined>;
}

export interface AcpSessionOptions {
	id: string;
	cwd: string;
	init: SessionInit;
	services: RuntimeServices;
	spec: AcpAgentSpec;
	model: ModelRef;
	/** The agent's session id, when resuming. */
	sessionId?: string;
	history?: ChatMessage[];
	name?: string;
	/** The agent reported the models it offers. */
	onModels?(models: { id: string; name: string; contextWindow?: number }[]): void;
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Where Prometheus keeps the transcript it showed for an ACP chat (agents differ in what they can replay). */
export function acpMirrorPath(dataDir: string, id: string): string {
	return join(dataDir, "sessions", "acp", `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export class AcpSession implements RuntimeSession {
	readonly capabilities = ACP_CAPABILITIES;
	readonly id: string;
	readonly cwd: string;
	private nativeSessionId: string;
	private readonly services: RuntimeServices;
	private readonly gate: PermissionGate;
	private readonly hooks: SessionHooks | undefined;
	private readonly initOpts: SessionInit;
	private readonly spec: AcpAgentSpec;
	private readonly mapper: AcpMapper;
	private readonly listeners = new Set<(e: SessionEvent) => void>();
	private readonly opts: AcpSessionOptions;
	private conn: AcpConnection | undefined;
	private agentCaps: Record<string, any> = {};
	private busSession: BusSession | undefined;
	private grant: RelayGrant | undefined;
	private busTools: PluginTool[] = [];
	private model: ModelRef;
	private name: string | undefined;
	private gatewayChoice: GatewayChoice | undefined;
	private queue: UserInput[] = [];
	private idleWaiters: (() => void)[] = [];
	private readonly cancelWaiters = new Set<() => void>();
	private abortRequested = false;
	private pendingError: string | undefined;
	private closed = false;
	private rerouting = false;
	private starting: Promise<void> | undefined;
	/** The static context goes with the first prompt a process sees. */
	private staticSent = false;
	/** Earlier transcript for an agent that could not reload its own session. */
	private handoff: string | undefined;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	/** A session was opened by an earlier process of this object: its messages are current, not the saved ones. */
	private opened = false;

	constructor(opts: AcpSessionOptions) {
		this.opts = opts;
		this.id = opts.id;
		this.cwd = opts.cwd;
		this.services = opts.services;
		this.initOpts = opts.init;
		this.gate = opts.init.permission;
		this.hooks = opts.init.hooks;
		this.spec = opts.spec;
		this.model = opts.model;
		this.name = opts.name;
		this.gatewayChoice = opts.init.gateway;
		this.nativeSessionId = opts.sessionId ?? "";
		this.mapper = new AcpMapper({ provider: opts.model.provider, model: () => this.model.id, emit: (e) => this.emit(e), busTools: () => this.busTools.map((t) => t.name) });
		this.mapper.setMessages(opts.history ?? []);
	}

	get nativeId(): string {
		return this.nativeSessionId;
	}

	get isStreaming(): boolean {
		return this.mapper.running;
	}

	ref(): SessionRef {
		return { runtime: "acp", id: this.id, nativeId: this.nativeSessionId };
	}

	private emit(e: SessionEvent): void {
		this.hooks?.event?.(e);
		for (const l of this.listeners) {
			try {
				l(e);
			} catch {
				/* a listener must not break the stream */
			}
		}
		if (e.type === "agent_start") this.hooks?.sessionsChanged?.();
		if (e.type === "agent_settled") {
			this.scheduleSave();
			if (!this.mapper.running && !this.queue.length) for (const w of this.idleWaiters.splice(0)) w();
			this.hooks?.settled?.();
			this.hooks?.sessionsChanged?.();
		}
	}

	// ---------- transcript mirror ----------

	private scheduleSave(): void {
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => void this.save(), 300);
	}

	private async save(): Promise<void> {
		clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		const file = acpMirrorPath(this.services.dataDir, this.id);
		try {
			await mkdir(dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			await writeFile(tmp, JSON.stringify({ version: 1, agent: this.spec.id, nativeId: this.nativeSessionId, messages: this.mapper.messages }), "utf8");
			await rename(tmp, file);
		} catch (err) {
			this.services.log.warn(`[acp ${this.id}] could not save the transcript: ${errText(err)}`);
		}
	}

	private async loadMirror(): Promise<ChatMessage[] | undefined> {
		try {
			const data = JSON.parse(await readFile(acpMirrorPath(this.services.dataDir, this.id), "utf8"));
			return Array.isArray(data?.messages) ? (data.messages as ChatMessage[]) : undefined;
		} catch {
			return undefined;
		}
	}

	// ---------- context ----------

	private async externalTools(): Promise<PluginTool[]> {
		return [...(await this.services.plugins.externalView()).tools.map((t) => t.tool), this.gate.planExitTool()];
	}

	private async staticContext(): Promise<string> {
		const ctx = await this.services.plugins.collectContextExternal({ prompt: "", cwd: this.cwd, sessionId: this.id, runtime: "acp", permissionMode: this.gate.mode });
		const parts: string[] = [];
		for (const [key, value] of Object.entries(ctx.static.sections)) parts.push(`# ${key}\n${value}`);
		if (ctx.static.guidelines.length) parts.push(`# Guidelines\n${ctx.static.guidelines.map((g) => `- ${g}`).join("\n")}`);
		return parts.join("\n\n");
	}

	private async turnContext(prompt: string): Promise<string> {
		const ctx = await this.services.plugins.collectContextExternal({ prompt, cwd: this.cwd, sessionId: this.id, runtime: "acp", permissionMode: this.gate.mode });
		const draft = { systemPromptOptions: { promptGuidelines: [] as string[], sections: {} as Record<string, string> } };
		applyPermissionPrompt(draft, this.gate.mode, this.gate.unattended);
		return [...ctx.turn, ...Object.values(draft.systemPromptOptions.sections)].filter(Boolean).join("\n\n");
	}

	// ---------- start ----------

	/** The gateway route of this session: which gateway, which protocol, and how the agent is pointed at it. */
	private route(choice: GatewayChoice | undefined): { gatewayId: string; format: GatewayFormat; model: string; adapter: NonNullable<ReturnType<typeof acpGatewayAdapter>> } | undefined {
		if (choice?.mode !== "prometheus") return undefined;
		const adapter = acpGatewayAdapter(this.spec.command);
		if (!adapter) throw new Error(`${this.spec.name} cannot use a Prometheus gateway; pick one of its own models`);
		const gateway = this.services.gateway(choice.gatewayId);
		if (!gateway) throw new AppError("gatewayNotFound", { id: choice.gatewayId } as never);
		const format = pickGatewayFormat(gateway, adapter.formats);
		if (!format) throw new Error(`${gateway.name} does not offer a protocol ${this.spec.name} can use (${adapter.formats.join(", ")})`);
		return { gatewayId: choice.gatewayId, format, model: choice.model.id, adapter };
	}

	/** Starts the process and opens (or reloads) the agent's session. Called by the runtime before the session is handed out. */
	start(): Promise<void> {
		this.starting ??= this.doStart().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async doStart(): Promise<void> {
		const { services } = this;
		const route = this.route(this.gatewayChoice);
		this.busTools = await this.externalTools();
		this.busSession?.close();
		this.busSession = services.bus.open({
			sessionId: this.id,
			cwd: () => this.cwd,
			ui: this.toolUi(),
			hasUI: () => !this.gate.unattended,
			tools: () => this.externalTools(),
			beforeCall: async (call) => {
				const verdict = await this.gate.evaluate({ toolName: call.name, input: asObject(call.args), readOnly: this.busTools.find((t) => t.name === call.name)?.annotations?.readOnlyHint === true, cwd: this.cwd });
				return verdict ? { allow: false, reason: verdict.reason } : { allow: true };
			},
			onEvent: (e) => this.mapper.bus(e),
		});
		this.grant?.revoke();
		this.grant = undefined;
		let extraEnv: Record<string, string> = {};
		let extraArgs: string[] = [];
		if (route) {
			const { gatewayId, format } = route;
			this.grant = services.relay.grant(this.id, gatewayId, () => {
				const g = services.gateway(gatewayId);
				return g && gatewayAs(g, format);
			});
			({ env: extraEnv, args: extraArgs } = route.adapter.launch({ baseUrl: this.grant.baseUrl, token: this.grant.token, model: route.model, format }));
		}

		const env = withLoopbackNoProxy({ ...this.spec.env, ...extraEnv });
		const launch = resolveAcpCommand(this.spec.command, [...this.spec.args, ...extraArgs], env as NodeJS.ProcessEnv);
		const conn = new AcpConnection({
			launch,
			cwd: this.cwd,
			env,
			onNotification: (method, params) => this.onNotification(method, params),
			onRequest: (method, params) => this.onRequest(method, params),
			onExit: (code, stderr) => this.onExit(conn, code, stderr),
			onLog: (line) => services.log.info(`[acp ${this.spec.id} ${this.id}] ${line.slice(0, 500)}`),
		});
		this.conn = conn;
		this.staticSent = false;
		try {
			conn.start();
			const init = await conn.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "prometheus", title: "Prometheus", version: "1" } }, 90_000);
			this.agentCaps = asObject(init?.agentCapabilities);
			await this.openSession(await this.mcpServers());
		} catch (err) {
			this.conn = undefined;
			await conn.close();
			throw new Error(`${this.spec.name}: ${authHint(err)}`);
		}
	}

	/** The tool bus, as the agent can reach it: over HTTP when it supports that, else through the stdio bridge. */
	private async mcpServers(): Promise<unknown[]> {
		const bus = this.busSession!;
		if (asObject(this.agentCaps.mcpCapabilities).http) {
			return [{ type: "http", name: MCP_NAME, url: bus.url, headers: [{ name: "Authorization", value: `Bearer ${bus.token}` }] }];
		}
		const script = await mcpBridgeScript(this.services.dataDir);
		return [{ name: MCP_NAME, command: process.execPath, args: [script], env: [{ name: "PROMETHEUS_MCP_URL", value: bus.url }, { name: "PROMETHEUS_MCP_TOKEN", value: bus.token }] }];
	}

	private async openSession(mcpServers: unknown[]): Promise<void> {
		const conn = this.conn!;
		let result: any;
		if (this.nativeSessionId) {
			// What the user saw last time (it includes any history carried over from another agent).
			const mirror = this.opened ? undefined : await this.loadMirror();
			const shown = mirror?.length ? mirror : this.mapper.messages.length ? [...this.mapper.messages] : undefined;
			let loaded = false;
			if (this.agentCaps.loadSession) {
				// The agent replays the conversation as updates: rebuild it silently, show the mirror when there is one.
				this.mapper.silent = true;
				this.mapper.setMessages([]);
				try {
					result = await conn.request("session/load", { sessionId: this.nativeSessionId, cwd: this.cwd, mcpServers }, 120_000);
					loaded = true;
				} catch (err) {
					this.services.log.warn(`[acp ${this.id}] session/load failed, starting a new session: ${errText(err)}`);
				} finally {
					if (this.mapper.running) this.mapper.finish(false);
					this.mapper.silent = false;
				}
				const replayed = [...this.mapper.messages];
				this.mapper.setMessages(shown?.length ? shown : replayed);
			} else if (shown) {
				this.mapper.setMessages(shown);
			}
			if (!loaded) {
				// The agent does not know the conversation any more: hand the transcript over as hidden context.
				const handoff = buildHandoff(this.mapper.messages, this.spec.name);
				if (handoff) this.handoff = handoff;
				result = await conn.request("session/new", { cwd: this.cwd, mcpServers }, 120_000);
				this.nativeSessionId = String(result?.sessionId ?? "");
			}
		} else {
			result = await conn.request("session/new", { cwd: this.cwd, mcpServers }, 120_000);
			this.nativeSessionId = String(result?.sessionId ?? "");
		}
		if (!this.nativeSessionId) throw new Error("the agent did not return a session id");
		this.opened = true;
		await this.adoptSession(asObject(result));
	}

	/** Models and modes the agent announced for the session: report the models, keep the agent asking before it acts. */
	private async adoptSession(result: Record<string, any>): Promise<void> {
		const models = asObject(result.models);
		const available: any[] = Array.isArray(models.availableModels) ? models.availableModels : [];
		if (available.length) {
			this.opts.onModels?.(available.filter((m) => m?.modelId).map((m) => ({ id: String(m.modelId), name: String(m.name ?? m.modelId), ...(typeof m?._meta?.contextLimit === "number" ? { contextWindow: m._meta.contextLimit } : {}) })));
		}
		const modes = asObject(result.modes);
		const modeIds: string[] = (Array.isArray(modes.availableModes) ? modes.availableModes : []).map((m: any) => String(m?.id ?? ""));
		// Prometheus' gate decides; the agent must ask for everything, which is what its "default" mode does.
		if (modeIds.includes("default") && modes.currentModeId !== "default") {
			await this.conn!.request("session/set_mode", { sessionId: this.nativeSessionId, modeId: "default" }, 30_000).catch((err) => this.services.log.warn(`[acp ${this.id}] set_mode: ${errText(err)}`));
		}
		if (this.model.provider === ACP_PROVIDER && this.model.id !== ACP_DEFAULT_MODEL && models.currentModelId !== this.model.id) await this.applyModel(this.model.id).catch((err) => this.services.log.warn(`[acp ${this.id}] set_model: ${errText(err)}`));
	}

	private async applyModel(modelId: string): Promise<void> {
		const conn = this.conn;
		if (!conn) return;
		try {
			await conn.request("session/set_model", { sessionId: this.nativeSessionId, modelId }, 30_000);
		} catch (err) {
			if (!(err instanceof AcpError) || err.code !== -32601) throw err;
			await conn.request("session/set_config_option", { sessionId: this.nativeSessionId, configId: "model", value: modelId }, 30_000);
		}
	}

	private toolUi(): PluginToolContext["ui"] {
		const ui = this.initOpts.ui.context();
		return {
			confirm: (title, message, o) => ui.confirm(title, message, o),
			select: (title, options, o) => ui.select(title, options, o),
			input: (title, placeholder, o) => ui.input(title, placeholder, o),
			notify: (message, level) => ui.notify(message, level),
		};
	}

	// ---------- agent -> client ----------

	private onNotification(method: string, params: any): void {
		if (method !== "session/update") return;
		if (params?.sessionId && this.nativeSessionId && params.sessionId !== this.nativeSessionId) return;
		this.mapper.update(params?.update);
	}

	private async onRequest(method: string, params: any): Promise<unknown> {
		switch (method) {
			case "session/request_permission":
				return this.onPermission(params);
			default:
				// File system and terminal access were not offered in `initialize`.
				throw new AcpError(-32601, `Method not found: ${method}`);
		}
	}

	private async onPermission(p: any): Promise<unknown> {
		const options: any[] = Array.isArray(p?.options) ? p.options : [];
		const pick = (...kinds: string[]) => kinds.map((k) => options.find((o) => o?.kind === k)).find(Boolean);
		const select = (o: any) => (o?.optionId !== undefined ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } });
		const allow = pick("allow_once", "allow_always");
		const reject = pick("reject_once", "reject_always");
		const call = this.mapper.merge(asObject(p?.toolCall));
		if (!call) return select(reject);
		// Our own tools are checked by the tool bus when they run: asking here as well would ask twice.
		if (this.mapper.isBusCall(call.toolCallId)) return select(allow);
		this.mapper.reveal(call.toolCallId);
		const { name, args } = canonicalAcpTool(call);
		const readOnly = call.kind === "read" || call.kind === "search" || call.kind === "think";
		let cancel: () => void = () => {};
		const cancelled = new Promise<"cancelled">((resolve) => {
			cancel = () => resolve("cancelled");
			this.cancelWaiters.add(cancel);
		});
		try {
			const verdict = await Promise.race([this.gate.evaluate({ toolName: name, input: args, readOnly, cwd: this.cwd }), cancelled]);
			if (verdict === "cancelled") return { outcome: { outcome: "cancelled" } };
			return verdict ? select(reject) : select(allow);
		} catch (err) {
			this.services.log.warn(`[acp ${this.id}] permission check failed: ${errText(err)}`);
			return select(reject);
		} finally {
			this.cancelWaiters.delete(cancel);
		}
	}

	private onExit(conn: AcpConnection, code: number | null, stderr: string): void {
		if (this.conn !== conn) return;
		this.conn = undefined;
		if (this.closed || this.rerouting) return;
		const tail = stderr.trim().split(/\r?\n/).slice(-2).join(" ");
		const message = `${this.spec.name} exited (${code})${tail ? `: ${tail}` : ""}`;
		this.services.log.warn(`[acp ${this.id}] ${message}`);
		this.pendingError = message;
		if (this.mapper.running) this.mapper.finish(this.abortRequested, message);
	}

	// ---------- RuntimeSession ----------

	private async ensureConnection(): Promise<AcpConnection> {
		if (this.starting) await this.starting;
		if (this.conn?.running) return this.conn;
		// The process died (crash, killed): start a fresh one and reload the same session.
		await this.start();
		return this.conn!;
	}

	private emitQueue(): void {
		this.emit({ type: "queue_update", steering: [], followUp: this.queue.map((q) => q.text) });
	}

	async prompt(input: UserInput, _delivery: PromptDelivery): Promise<PromptDisposition> {
		if (this.closed) throw new AppError("sessionNotFound", { id: this.id });
		if (this.mapper.running) {
			// ACP has no way to add to a running turn: send it when this one ends.
			this.queue.push(input);
			this.emitQueue();
			return "queued";
		}
		const conn = await this.ensureConnection();
		await this.begin(conn, input);
		return "started";
	}

	/** Shows the user's message and sends the turn; the turn's end settles the run (and sends what was queued). */
	private async begin(conn: AcpConnection, input: UserInput): Promise<void> {
		const hidden: string[] = [];
		if (input.context) hidden.push(input.context);
		if (this.handoff) {
			hidden.push(handoffBlock(this.handoff));
			this.handoff = undefined;
		}
		if (!this.staticSent) {
			const s = await this.staticContext().catch(() => "");
			if (s) hidden.push(s);
		}
		const turn = await this.turnContext(input.text).catch(() => "");
		if (turn) hidden.push(turn);
		const blocks: any[] = [];
		if (hidden.length) blocks.push({ type: "text", text: `<${CONTEXT_TAG}>\n${hidden.join("\n\n")}\n</${CONTEXT_TAG}>\n\n` });
		if (input.text) blocks.push({ type: "text", text: input.text });
		const images = input.images ?? [];
		if (images.length) {
			if (asObject(this.agentCaps.promptCapabilities).image) for (const img of images) blocks.push({ type: "image", mimeType: img.mimeType, data: img.data });
			else blocks.push({ type: "text", text: `[${images.length} image(s) attached, but ${this.spec.name} does not accept images]` });
		}
		this.staticSent = true;
		this.pendingError = undefined;
		this.abortRequested = false;
		this.mapper.user(images.length ? [...(input.text ? [{ type: "text", text: input.text }] : []), ...images] : input.text);
		void conn.request("session/prompt", { sessionId: this.nativeSessionId, prompt: blocks }).then(
			(res: any) => {
				const stop = String(res?.stopReason ?? "end_turn");
				const error = stop === "refusal" ? `${this.spec.name} refused to continue` : stop === "max_tokens" ? `${this.spec.name} stopped: the reply hit the token limit` : stop === "max_turn_requests" ? `${this.spec.name} stopped: too many model requests in one turn` : undefined;
				this.settle(this.abortRequested || stop === "cancelled", error);
			},
			(err) => this.settle(this.abortRequested, errText(err)),
		);
	}

	private settle(aborted: boolean, error?: string): void {
		if (!this.mapper.running) return;
		if (error && !aborted) this.pendingError = error;
		this.abortRequested = false;
		this.mapper.finish(aborted, error);
		const next = this.queue.shift();
		if (!next) return;
		this.emitQueue();
		void this.ensureConnection()
			.then((conn) => this.begin(conn, next))
			.catch((err) => {
				this.services.log.warn(`[acp ${this.id}] queued prompt failed: ${errText(err)}`);
				this.pendingError = errText(err);
				this.queue = [];
				this.emitQueue();
				for (const w of this.idleWaiters.splice(0)) w();
			});
	}

	async abort(): Promise<void> {
		if (!this.mapper.running) return;
		this.abortRequested = true;
		if (this.queue.length) {
			this.queue = [];
			this.emitQueue();
		}
		for (const cancel of [...this.cancelWaiters]) cancel();
		this.conn?.notify("session/cancel", { sessionId: this.nativeSessionId });
	}

	waitForIdle(): Promise<void> {
		if (!this.mapper.running && !this.queue.length) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	async run(input: UserInput): Promise<void> {
		this.pendingError = undefined;
		await this.prompt(input, "send");
		await this.waitForIdle();
		if (this.pendingError) throw new Error(this.pendingError);
	}

	lastReply(): string {
		return this.mapper.lastReply();
	}

	async setModel(model: ModelRef): Promise<void> {
		const next: GatewayChoice = model.provider === ACP_PROVIDER ? { mode: "native" } : { mode: "prometheus", gatewayId: model.provider, model };
		const current = this.gatewayChoice;
		const changed = (current?.mode ?? "native") !== next.mode || next.mode === "prometheus";
		if (changed && this.mapper.running) throw new AppError("waitForReply");
		const before = { model: this.model, choice: this.gatewayChoice };
		this.model = model;
		this.gatewayChoice = next;
		if (changed) {
			// Another endpoint means another process: replace it, reloading the same session.
			this.rerouting = true;
			try {
				this.busSession?.close();
				this.grant?.revoke();
				this.grant = undefined;
				const old = this.conn;
				this.conn = undefined;
				await old?.close();
				await this.start();
			} catch (err) {
				this.model = before.model;
				this.gatewayChoice = before.choice;
				throw err;
			} finally {
				this.rerouting = false;
			}
		} else if (model.id !== ACP_DEFAULT_MODEL) {
			await this.applyModel(model.id);
		}
		this.emit({ type: "model_changed", model });
	}
	async setThinking(level: ThinkingLevel): Promise<void> {
		this.emit({ type: "thinking_level_changed", level });
	}
	async setPermissionMode(mode: PermissionMode): Promise<void> {
		this.gate.setMode(mode);
	}
	setName(name: string): void {
		this.name = name;
		this.emit({ type: "session_info_changed", name });
		this.hooks?.sessionsChanged?.();
	}
	async refreshTools(): Promise<void> {
		// The agent lists the bus' tools again on its next `tools/list`; the names here recognise its calls.
		this.busTools = await this.externalTools();
	}

	unqueue(kind: "steer" | "followUp", index: number, text: string): UserInput {
		const item = kind === "followUp" ? this.queue[index] : undefined;
		if (!item || item.text !== text) throw new AppError("messageChanged");
		this.queue.splice(index, 1);
		this.emitQueue();
		return item;
	}

	messages(): ChatMessage[] {
		return [...this.mapper.messages];
	}
	snapshotState(): RuntimeSnapshot {
		return {
			id: this.id,
			name: this.name,
			cwd: this.cwd,
			messages: this.messages(),
			model: this.model,
			thinkingLevel: "off",
			availableThinkingLevels: ACP_CAPABILITIES.thinkingLevels,
			isStreaming: this.isStreaming,
			queue: { steering: [], followUp: this.queue.map((q) => q.text) },
		} as RuntimeSnapshot;
	}
	commands(): CommandInfo[] {
		return this.mapper.commands.map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}), source: "prompt" as const }));
	}
	tools(): ToolInfo[] {
		return this.busTools.filter((t) => t.name !== "exit_plan_mode").map((t) => ({ name: t.name, description: t.description, active: true }));
	}
	usage(): SessionStats {
		const used = this.mapper.contextTokens;
		const window = this.mapper.contextWindow;
		const t = this.mapper.total;
		return {
			contextTokens: used,
			contextEstimated: used === 0,
			contextWindow: window,
			contextPercent: window > 0 ? Math.min(100, (used / window) * 100) : null,
			breakdown: { system: 0, tools: 0, user: 0, assistant: 0, toolResults: 0, other: 0 },
			totalCost: this.mapper.totalCost,
			inputTokens: t.input,
			outputTokens: t.output,
			cacheReadTokens: t.cacheRead,
			cacheWriteTokens: t.cacheWrite,
		};
	}

	subscribe(listener: (event: SessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const cancel of [...this.cancelWaiters]) cancel();
		if (this.nativeSessionId && this.mapper.messages.length) await this.save();
		clearTimeout(this.saveTimer);
		this.busSession?.close();
		this.grant?.revoke();
		const conn = this.conn;
		this.conn = undefined;
		await conn?.close();
		for (const w of this.idleWaiters.splice(0)) w();
		this.listeners.clear();
	}
}

/** Removes the transcript Prometheus kept for an ACP chat. */
export async function deleteAcpMirror(dataDir: string, id: string): Promise<void> {
	await rm(acpMirrorPath(dataDir, id), { force: true });
}

/** The agent's error, with a pointer to logging in when that is what it is about. */
function authHint(err: unknown): string {
	const message = errText(err);
	if (err instanceof AcpError && err.code === -32000) return `${message} (sign in with the agent's own CLI first, or set its API key in the agent's environment)`;
	return message;
}
