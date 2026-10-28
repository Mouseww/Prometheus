// OpenCodeSession: one `opencode serve` process and one opencode session behind the runtime-neutral RuntimeSession.
// Model traffic goes through the gateway relay (as a custom provider), Prometheus tools through the tool bus (as a
// remote MCP server), permission requests through the single PermissionGate (docs/agent-runtime.md §4, §6, §7, §12.3).
import { withLoopbackNoProxy } from "../loopback-env.ts";
import type { PluginTool, PluginToolContext } from "@prometheus/plugin-sdk";
import { AppError, type ChatMessage, type CommandInfo, type GatewayConfig, type ModelRef, type PermissionMode, type PromptDisposition, type SessionEvent, type SessionStats, type ThinkingLevel, type ToolInfo, gatewayAs, pickGatewayFormat } from "@prometheus/protocol";
import type { PermissionGate } from "../../permission-gate.ts";
import { applyPermissionPrompt } from "../../permission-gate.ts";
import type { BusSession } from "../bus/tool-bus.ts";
import type { RelayGrant } from "../relay/gateway-relay.ts";
import type { GatewayChoice, PromptDelivery, RuntimeCapabilities, RuntimeServices, RuntimeSession, RuntimeSnapshot, SessionHooks, SessionInit, SessionRef, UserInput } from "../types.ts";
import { OpenCodeMapper, PROMETHEUS_MCP_SERVER, replaySession } from "./opencode-mapper.ts";
import { OpenCodeServer } from "./opencode-server.ts";

export const OPENCODE_CAPABILITIES: RuntimeCapabilities = {
	steering: true,
	followUpQueue: false,
	compaction: "manual+auto",
	fork: false,
	treeNavigation: false,
	thinkingLevels: [],
	images: true,
	liveToolListChange: false,
	systemPromptReplace: "none",
	contextBreakdown: false,
	permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions", "auto"],
	nativeTools: ["exec", "read", "edit", "write", "search", "fetch", "todo", "task"],
};

/** opencode picks the model from its own configuration when none is named. */
export const DEFAULT_MODEL = "default";
/** Provider id Prometheus' gateway is registered under inside opencode. */
const GATEWAY_PROVIDER = "prometheus";
/** The protocols opencode's bundled AI SDK providers speak, best first. */
export const OPENCODE_FORMATS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
const SDK_PACKAGE = { "openai-completions": "@ai-sdk/openai-compatible", "openai-responses": "@ai-sdk/openai", "anthropic-messages": "@ai-sdk/anthropic" } as const;
const CONTEXT_TAG = "prometheus-context";

export interface OpenCodeSessionOptions {
	id: string;
	cwd: string;
	init: SessionInit;
	services: RuntimeServices;
	model: ModelRef;
	/** Set when resuming an existing opencode session. */
	sessionId?: string;
	history?: ChatMessage[];
	name?: string;
	executable?: string;
	/** Extra environment from the agent profile. */
	env?: Record<string, string>;
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class OpenCodeSession implements RuntimeSession {
	readonly capabilities = OPENCODE_CAPABILITIES;
	readonly id: string;
	readonly cwd: string;
	private sessionId = "";
	private readonly services: RuntimeServices;
	private readonly gate: PermissionGate;
	private readonly hooks: SessionHooks | undefined;
	private readonly initOpts: SessionInit;
	private readonly mapper: OpenCodeMapper;
	private readonly listeners = new Set<(e: SessionEvent) => void>();
	private model: ModelRef;
	private name: string | undefined;
	private server: OpenCodeServer | undefined;
	private busSession: BusSession | undefined;
	private grant: RelayGrant | undefined;
	private busTools: PluginTool[] = [];
	private idleWaiters: (() => void)[] = [];
	private abortRequested = false;
	private pendingError: string | undefined;
	private closed = false;
	/** Set while the process is replaced on purpose, so its exit is not reported as a crash. */
	private rerouting = false;
	private gatewayChoice: GatewayChoice | undefined;
	private contextWindow = 0;
	private readonly opts: OpenCodeSessionOptions;

	constructor(opts: OpenCodeSessionOptions) {
		this.opts = opts;
		this.id = opts.id;
		this.cwd = opts.cwd;
		this.services = opts.services;
		this.initOpts = opts.init;
		this.gatewayChoice = opts.init.gateway;
		this.gate = opts.init.permission;
		this.hooks = opts.init.hooks;
		this.model = opts.model;
		this.name = opts.name;
		this.sessionId = opts.sessionId ?? "";
		this.mapper = new OpenCodeMapper({ provider: opts.model.provider, model: () => this.model.id, emit: (e) => this.emit(e) });
		this.mapper.setMessages(opts.history ?? []);
	}

	get nativeId(): string {
		return this.sessionId;
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
			for (const w of this.idleWaiters.splice(0)) w();
			this.hooks?.settled?.();
			this.hooks?.sessionsChanged?.();
		}
	}

	get isStreaming(): boolean {
		return this.mapper.running;
	}

	ref(): SessionRef {
		return { runtime: "opencode", id: this.id, nativeId: this.sessionId };
	}

	// ---------- start ----------

	private async externalTools(): Promise<PluginTool[]> {
		return [...(await this.services.plugins.externalView()).tools.map((t) => t.tool), this.gate.planExitTool()];
	}

	private async staticContext(): Promise<string> {
		const ctx = await this.services.plugins.collectContextExternal({ prompt: "", cwd: this.cwd, sessionId: this.id, runtime: "opencode", permissionMode: this.gate.mode });
		const parts: string[] = [];
		for (const [key, value] of Object.entries(ctx.static.sections)) parts.push(`# ${key}\n${value}`);
		if (ctx.static.guidelines.length) parts.push(`# Guidelines\n${ctx.static.guidelines.map((g) => `- ${g}`).join("\n")}`);
		return parts.join("\n\n");
	}

	private async turnContext(prompt: string): Promise<string> {
		const ctx = await this.services.plugins.collectContextExternal({ prompt, cwd: this.cwd, sessionId: this.id, runtime: "opencode", permissionMode: this.gate.mode });
		const draft = { systemPromptOptions: { promptGuidelines: [] as string[], sections: {} as Record<string, string> } };
		applyPermissionPrompt(draft, this.gate.mode, this.gate.unattended);
		return [...ctx.turn, ...Object.values(draft.systemPromptOptions.sections)].filter(Boolean).join("\n\n");
	}

	/** The gateway behind the current route and the protocol opencode talks to it. */
	private gatewayFor(choice: GatewayChoice | undefined): { gateway: GatewayConfig; format: (typeof OPENCODE_FORMATS)[number] } | undefined {
		if (choice?.mode !== "prometheus") return undefined;
		const gateway = this.services.gateway(choice.gatewayId);
		if (!gateway) throw new AppError("gatewayNotFound", { id: choice.gatewayId } as never);
		const format = pickGatewayFormat(gateway, OPENCODE_FORMATS) as (typeof OPENCODE_FORMATS)[number] | undefined;
		if (!format) throw new AppError("generic");
		return { gateway, format };
	}

	/** What opencode reads as its configuration for this process (OPENCODE_CONFIG_CONTENT, on top of the user's own). */
	private buildConfig(): Record<string, unknown> {
		const config: Record<string, unknown> = {
			autoupdate: false,
			share: "disabled",
			// Every action that changes something reaches the gate, which decides by Prometheus' permission mode.
			permission: { edit: "ask", bash: "ask", webfetch: "ask", external_directory: "ask", doom_loop: "ask" },
			mcp: { [PROMETHEUS_MCP_SERVER]: { type: "remote", url: this.busSession!.url, headers: { Authorization: "Bearer {env:PROMETHEUS_MCP_TOKEN}" }, enabled: true } },
		};
		const route = this.gatewayFor(this.gatewayChoice);
		if (route) {
			const models = Object.fromEntries(
				route.gateway.models.map((m) => [
					m.id,
					{
						name: m.name?.trim() || m.id,
						tool_call: true,
						reasoning: m.reasoning ?? false,
						attachment: m.vision ?? false,
						limit: { context: m.contextWindow ?? 200_000, output: m.maxTokens ?? 16_384 },
						...(m.vision ? { modalities: { input: ["text", "image"], output: ["text"] } } : {}),
					},
				]),
			);
			config.provider = {
				[GATEWAY_PROVIDER]: { npm: SDK_PACKAGE[route.format], name: "Prometheus", options: { baseURL: `${this.grant!.baseUrl}/v1`, apiKey: "{env:PROMETHEUS_GW_TOKEN}" }, models },
			};
			// Only the relay is reachable: the user's own providers must not be used for this chat.
			config.enabled_providers = [GATEWAY_PROVIDER];
			config.model = `${GATEWAY_PROVIDER}/${this.model.id}`;
			this.contextWindow = route.gateway.models.find((m) => m.id === this.model.id)?.contextWindow ?? 200_000;
		}
		return config;
	}

	/** Starts the process and the session. Called by the runtime before the session is handed out. */
	async start(): Promise<void> {
		const { services } = this;
		const choice = this.gatewayChoice;
		const route = this.gatewayFor(choice);

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
		if (route && choice?.mode === "prometheus") {
			this.grant = services.relay.grant(this.id, choice.gatewayId, () => {
				const g = services.gateway(choice.gatewayId);
				return g && gatewayAs(g, route.format);
			});
		}

		this.server = new OpenCodeServer({
			env: withLoopbackNoProxy({
				...process.env,
				...(this.opts.env ?? {}),
				OPENCODE_CONFIG_CONTENT: JSON.stringify(this.buildConfig()),
				OPENCODE_DISABLE_AUTOUPDATE: "1",
				PROMETHEUS_MCP_TOKEN: this.busSession.token,
				...(this.grant ? { PROMETHEUS_GW_TOKEN: this.grant.token } : {}),
			}),
			cwd: this.cwd,
			executable: this.opts.executable,
			onEvent: (e) => this.onEvent(e),
			onReconnect: () => void this.syncStatus(),
			onExit: (code, output) => this.onExit(code, output),
			onLog: (line) => services.log.warn(`[opencode ${this.id}] ${line}`),
		});
		await this.server.start();

		if (this.sessionId) {
			const found = await this.server.request("GET", `/session/${this.sessionId}`).catch(() => undefined);
			if (!found?.id) throw new AppError("sessionNotFound", { id: this.id });
			if (!this.mapper.messages.length) {
				const list = await this.server.request("GET", `/session/${this.sessionId}/message`).catch(() => undefined);
				if (Array.isArray(list)) this.mapper.setMessages(replaySession(list, this.model.provider, this.model.id));
			}
		} else {
			const created = await this.server.request("POST", "/session", this.name ? { title: this.name } : {});
			this.sessionId = String(created?.id ?? "");
			if (!this.sessionId) throw new Error("opencode did not return a session id");
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

	// ---------- server events ----------

	private onEvent(event: { type: string; properties: any }): void {
		const p = event.properties;
		const sid = p?.sessionID ?? p?.info?.sessionID ?? p?.part?.sessionID;
		if (sid !== undefined && sid !== this.sessionId) return;
		switch (event.type) {
			case "permission.asked":
				return void this.onPermission(p);
			case "question.asked":
				return void this.onQuestion(p);
			case "session.status":
				if (p?.status?.type === "idle") return this.onIdle();
				if (p?.status?.type === "retry") this.emit({ type: "auto_retry_start", attempt: p.status.attempt ?? 1, maxAttempts: p.status.attempt ?? 1, delayMs: Math.max(0, (p.status.next ?? 0) - Date.now()), errorMessage: String(p.status.message ?? "retrying") });
				return;
			case "session.idle":
				return this.onIdle();
			default:
				this.mapper.handle(event.type, p);
		}
	}

	private onIdle(): void {
		if (!this.mapper.running) return;
		const aborted = this.abortRequested;
		this.abortRequested = false;
		this.mapper.finish(aborted, this.pendingError);
		this.pendingError = undefined;
	}

	/** After the event stream dropped and came back, a run that ended in between would never settle. */
	private async syncStatus(): Promise<void> {
		if (!this.mapper.running || !this.server?.running) return;
		const all = await this.server.request("GET", "/session/status").catch(() => undefined);
		const status = all?.[this.sessionId];
		if (!status || status.type === "idle") this.onIdle();
	}

	private async onPermission(p: any): Promise<void> {
		const server = this.server;
		if (!server) return;
		const meta = asObject(p.metadata);
		const patterns: string[] = Array.isArray(p.patterns) ? p.patterns.map(String) : [];
		let toolName: string = String(p.permission);
		let input: Record<string, unknown> = { patterns };
		let readOnly = false;
		switch (p.permission) {
			case "bash":
				input = { command: typeof meta.command === "string" ? meta.command : patterns.join(" ") };
				break;
			case "edit":
				input = { path: String(meta.filepath ?? patterns[0] ?? ""), edits: [{ oldText: "", newText: typeof meta.diff === "string" ? meta.diff : "" }] };
				break;
			case "webfetch":
				toolName = "web_fetch";
				input = { url: patterns[0] ?? "" };
				break;
			case "read":
			case "list":
			case "glob":
			case "grep":
				readOnly = true;
				input = { path: patterns[0] ?? "" };
				break;
		}
		let allow = false;
		try {
			allow = !(await this.gate.evaluate({ toolName, input, readOnly, cwd: this.cwd }));
		} catch (err) {
			this.services.log.warn(`[opencode ${this.id}] permission check failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		await server.request("POST", `/permission/${p.id}/reply`, allow ? { reply: "once" } : { reply: "reject", message: "The user did not allow this action." }).catch((err) => this.services.log.warn(`[opencode ${this.id}] permission reply failed: ${err instanceof Error ? err.message : String(err)}`));
	}

	/** opencode's `question` tool: ask the user, or take the first option when nobody can answer. */
	private async onQuestion(p: any): Promise<void> {
		const server = this.server;
		if (!server) return;
		const questions: any[] = Array.isArray(p.questions) ? p.questions : [];
		const ui = this.initOpts.ui.context();
		const answers: string[][] = [];
		try {
			for (const q of questions) {
				const labels: string[] = (Array.isArray(q.options) ? q.options : []).map((o: any) => String(o?.label ?? ""));
				const unattended = this.gate.unattended || this.gate.mode === "auto";
				if (unattended || !labels.length) {
					answers.push(labels.length ? [labels[0]!] : []);
					continue;
				}
				const picked = await ui.select(String(q.question ?? q.header ?? ""), labels);
				if (picked === undefined) throw new Error("cancelled");
				answers.push([picked]);
			}
		} catch {
			await server.request("POST", `/question/${p.id}/reject`).catch(() => undefined);
			return;
		}
		await server.request("POST", `/question/${p.id}/reply`, { answers }).catch((err) => this.services.log.warn(`[opencode ${this.id}] question reply failed: ${err instanceof Error ? err.message : String(err)}`));
	}

	private onExit(code: number | null, output: string): void {
		if (this.closed || this.rerouting) return;
		const message = `opencode exited (${code})${output ? `: ${output.trim().split("\n").at(-1)}` : ""}`;
		this.services.log.warn(`[opencode ${this.id}] ${message}`);
		this.server = undefined;
		this.pendingError = message;
		if (this.mapper.running) this.mapper.finish(this.abortRequested, message);
	}

	// ---------- RuntimeSession ----------

	private async ensureServer(): Promise<OpenCodeServer> {
		if (this.server?.running) return this.server;
		// The process died (crash, killed): start a fresh one on the same session.
		await this.start();
		return this.server!;
	}

	/** `providerID/modelID` of the model to name in a request; undefined lets opencode use its configured default. */
	private modelArg(): { providerID: string; modelID: string } | undefined {
		if (this.gatewayChoice?.mode === "prometheus") return { providerID: GATEWAY_PROVIDER, modelID: this.model.id };
		if (this.model.id === DEFAULT_MODEL) return undefined;
		const i = this.model.id.indexOf("/");
		return i > 0 ? { providerID: this.model.id.slice(0, i), modelID: this.model.id.slice(i + 1) } : undefined;
	}

	async prompt(input: UserInput, _delivery: PromptDelivery): Promise<PromptDisposition> {
		if (this.closed) throw new AppError("sessionNotFound", { id: this.id });
		const server = await this.ensureServer();
		const wasRunning = this.mapper.running;
		const parts: any[] = [];
		const context = wasRunning ? "" : await this.turnContext(input.text).catch(() => "");
		if (input.context && !wasRunning) parts.push({ type: "text", text: input.context, synthetic: true });
		if (context) parts.push({ type: "text", text: `<${CONTEXT_TAG}>\n${context}\n</${CONTEXT_TAG}>`, synthetic: true });
		if (input.text) parts.push({ type: "text", text: input.text });
		for (const img of input.images ?? []) parts.push({ type: "file", mime: img.mimeType, url: `data:${img.mimeType};base64,${img.data}`, filename: "image" });
		const system = await this.staticContext().catch(() => "");
		this.mapper.user(input.images?.length ? [...(input.text ? [{ type: "text", text: input.text }] : []), ...input.images] : input.text);
		this.pendingError = undefined;
		const model = this.modelArg();
		// `/name args` runs one of opencode's own commands or skills; it answers when the run ends, so it is not awaited.
		const slash = !wasRunning && !input.images?.length ? /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input.text.trim()) : null;
		if (slash && (await this.knownCommand(server, slash[1]!))) {
			void server
				.request("POST", `/session/${this.sessionId}/command`, { command: slash[1], arguments: slash[2] ?? "", agent: "build", ...(model ? { model: `${model.providerID}/${model.modelID}` } : {}) })
				.catch((err) => this.mapper.finish(false, err instanceof Error ? err.message : String(err)));
			return "started";
		}
		try {
			await server.request("POST", `/session/${this.sessionId}/prompt_async`, {
				parts,
				agent: "build",
				...(model ? { model } : {}),
				...(system ? { system } : {}),
			});
		} catch (err) {
			// The run never started: settle it so the chat does not hang.
			if (!wasRunning) this.mapper.finish(false, err instanceof Error ? err.message : String(err));
			throw err;
		}
		return wasRunning ? "queued" : "started";
	}

	async abort(): Promise<void> {
		if (!this.server?.running || !this.mapper.running) return;
		this.abortRequested = true;
		await this.server.request("POST", `/session/${this.sessionId}/abort`).catch(() => undefined);
	}

	waitForIdle(): Promise<void> {
		if (!this.mapper.running) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	async run(input: UserInput): Promise<void> {
		this.pendingError = undefined;
		const idle = new Promise<void>((resolve) => this.idleWaiters.push(resolve));
		await this.prompt(input, "send");
		await idle;
		if (this.pendingError) throw new Error(this.pendingError);
	}

	lastReply(): string {
		return this.mapper.lastReply();
	}

	async setModel(model: ModelRef): Promise<void> {
		const next: GatewayChoice = model.provider === "opencode" ? { mode: "native" } : { mode: "prometheus", gatewayId: model.provider, model };
		const current = this.gatewayChoice;
		const changed = (current?.mode ?? "native") !== next.mode || (current?.mode === "prometheus" && next.mode === "prometheus" && current.gatewayId !== next.gatewayId);
		if (changed && this.mapper.running) throw new AppError("waitForReply");
		this.model = model;
		this.gatewayChoice = next;
		if (changed) {
			// Another route means another provider config: replace the process, resuming the same session.
			this.rerouting = true;
			try {
				this.busSession?.close();
				this.grant?.revoke();
				this.grant = undefined;
				await this.server?.close();
				this.server = undefined;
				await this.start();
			} finally {
				this.rerouting = false;
			}
		} else if (next.mode === "prometheus") {
			this.contextWindow = this.services.gateway(next.gatewayId)?.models.find((m) => m.id === model.id)?.contextWindow ?? this.contextWindow;
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
		if (this.server?.running && this.sessionId) void this.server.request("PATCH", `/session/${this.sessionId}`, { title: name }).catch(() => undefined);
	}
	async refreshTools(): Promise<void> {
		this.busTools = await this.externalTools();
		// opencode caches an MCP server's tool list: reconnecting makes it ask again.
		if (!this.server?.running || this.mapper.running) return;
		await this.server.request("POST", `/mcp/${PROMETHEUS_MCP_SERVER}/disconnect`).catch(() => undefined);
		await this.server.request("POST", `/mcp/${PROMETHEUS_MCP_SERVER}/connect`).catch(() => undefined);
	}

	/** The model a summary is made with: the chat's own, or the one opencode would pick by default. */
	private async summaryModel(server: OpenCodeServer): Promise<{ providerID: string; modelID: string }> {
		const named = this.modelArg();
		if (named) return named;
		const config = await server.request("GET", "/config").catch(() => undefined);
		const configured = typeof config?.model === "string" ? config.model : "";
		const i = configured.indexOf("/");
		if (i > 0) return { providerID: configured.slice(0, i), modelID: configured.slice(i + 1) };
		const providers = await server.request("GET", "/config/providers").catch(() => undefined);
		const first = Object.entries(asObject(providers?.default))[0];
		if (!first) throw new Error("opencode has no model configured (run `opencode auth login`)");
		return { providerID: first[0], modelID: String(first[1]) };
	}

	async compact(): Promise<void> {
		if (!this.server?.running || this.mapper.running) return;
		this.mapper.compactionStart("manual");
		try {
			const model = await this.summaryModel(this.server);
			await this.server.request("POST", `/session/${this.sessionId}/summarize`, { ...model, auto: false });
			this.mapper.compactionEnd(undefined, "manual");
		} catch (err) {
			this.mapper.compactionEnd(err instanceof Error ? err.message : String(err), "manual");
		}
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
			availableThinkingLevels: OPENCODE_CAPABILITIES.thinkingLevels,
			isStreaming: this.isStreaming,
			queue: { steering: [], followUp: [] },
		} as RuntimeSnapshot;
	}
	private async listCommands(server: OpenCodeServer): Promise<CommandInfo[]> {
		const list = await server.request<any[]>("GET", "/command");
		const out: CommandInfo[] = [];
		for (const c of Array.isArray(list) ? list : []) {
			if (!c?.name) continue;
			out.push({ name: String(c.name), description: c.description ? String(c.description) : undefined, source: c.source === "skill" ? "skill" : c.source === "mcp" ? "extension" : "prompt" });
		}
		return out;
	}

	private async knownCommand(server: OpenCodeServer, name: string): Promise<boolean> {
		try {
			return (await this.listCommands(server)).some((c) => c.name === name);
		} catch {
			return false;
		}
	}

	async commands(): Promise<CommandInfo[]> {
		if (this.closed) return [];
		try {
			return await this.listCommands(await this.ensureServer());
		} catch (err) {
			this.services.log.warn(`[opencode ${this.id}] commands: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}
	tools(): ToolInfo[] {
		return this.busTools.filter((t) => t.name !== "exit_plan_mode").map((t) => ({ name: t.name, description: t.description, active: true }));
	}
	usage(): SessionStats {
		const t = this.mapper.total;
		const used = this.mapper.contextTokens;
		return {
			contextTokens: used,
			contextEstimated: used === 0,
			contextWindow: this.contextWindow,
			contextPercent: this.contextWindow > 0 ? Math.min(100, (used / this.contextWindow) * 100) : null,
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
		this.busSession?.close();
		this.grant?.revoke();
		await this.server?.close();
		for (const w of this.idleWaiters.splice(0)) w();
		this.listeners.clear();
	}
}
