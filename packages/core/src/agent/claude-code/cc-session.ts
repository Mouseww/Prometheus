// ClaudeCodeSession: one Claude Agent SDK `query` (streaming input) behind the runtime-neutral RuntimeSession.
// Model traffic goes through the gateway relay, Prometheus tools through the tool bus, permissions through
// the single PermissionGate (docs/agent-runtime.md §4, §6, §7, §12.1).
import { withLoopbackNoProxy } from "../loopback-env.ts";
import { type Options, query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AppError, gatewayAs, type ChatMessage, type CommandInfo, type ModelRef, type PermissionMode, type PromptDisposition, type SessionEvent, type SessionStats, type ThinkingLevel, type ToolInfo } from "@prometheus/protocol";
import type { PluginTool, PluginToolContext } from "@prometheus/plugin-sdk";
import type { PermissionGate } from "../../permission-gate.ts";
import { applyPermissionPrompt } from "../../permission-gate.ts";
import type { BusSession } from "../bus/tool-bus.ts";
import type { RelayGrant } from "../relay/gateway-relay.ts";
import type { PromptDelivery, RuntimeCapabilities, RuntimeServices, RuntimeSession, RuntimeSnapshot, SessionHooks, SessionInit, SessionRef, UserInput } from "../types.ts";
import { CcMapper } from "./event-map.ts";
import { canonicalTool, PROMETHEUS_MCP_SERVER } from "./tool-map.ts";

export const CC_CAPABILITIES: RuntimeCapabilities = {
	steering: true,
	followUpQueue: false,
	compaction: "auto",
	fork: false,
	treeNavigation: false,
	thinkingLevels: [],
	images: true,
	liveToolListChange: true,
	systemPromptReplace: "restart",
	contextBreakdown: false,
	permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions", "auto"],
	nativeTools: ["exec", "read", "edit", "write", "search", "fetch", "plan_exit"],
};

/** Tools Claude Code ships that Prometheus does not want (docs §4.4); the rest of the default set is allow-listed explicitly. */
const NATIVE_TOOLS = ["Bash", "Read", "Edit", "MultiEdit", "Write", "Grep", "Glob", "WebFetch", "WebSearch", "ExitPlanMode", "NotebookEdit"];
/**
 * Prometheus tools that Claude Code covers natively and that are therefore not exported on the bus. Empty on
 * purpose: Claude Code 2.1.310 disables TodoWrite (it moved to task tools), so the todo panel is fed by
 * Prometheus' own todo_write instead.
 */
const NATIVE_COVERED = new Set<string>();

export interface CcSessionOptions {
	id: string;
	/** Claude Code's session id (equal to `id`: it accepts a caller-chosen UUID). */
	nativeId: string;
	cwd: string;
	resume: boolean;
	init: SessionInit;
	services: RuntimeServices;
	model: ModelRef;
	history: ChatMessage[];
	name?: string;
	/** Absolute path of a specific Claude Code install; otherwise the SDK's bundled one. */
	executable?: string;
}

export class ClaudeCodeSession implements RuntimeSession {
	readonly capabilities = CC_CAPABILITIES;
	readonly id: string;
	readonly nativeId: string;
	readonly cwd: string;

	private readonly services: RuntimeServices;
	private readonly gate: PermissionGate;
	private readonly hooks: SessionHooks | undefined;
	private readonly mapper: CcMapper;
	private readonly listeners = new Set<(e: SessionEvent) => void>();
	private model: ModelRef;
	private name: string | undefined;
	private resume: boolean;
	private q: Query | undefined;
	private pump: Promise<void> | undefined;
	private busSession: BusSession | undefined;
	private grant: RelayGrant | undefined;
	private readonly inbox: SDKUserMessage[] = [];
	private wake: (() => void) | undefined;
	private closed = false;
	private abortRequested = false;
	private idleWaiters: (() => void)[] = [];
	private busTools: PluginTool[] = [];
	private readonly mode: () => PermissionMode;
	private pendingError: string | undefined;
	private pendingContext: string | undefined;
	private readonly initOpts: SessionInit;
	private readonly executable: string | undefined;

	constructor(opts: CcSessionOptions) {
		this.id = opts.id;
		this.nativeId = opts.nativeId;
		this.cwd = opts.cwd;
		this.services = opts.services;
		this.initOpts = opts.init;
		this.executable = opts.executable;
		this.gate = opts.init.permission;
		this.hooks = opts.init.hooks;
		this.model = opts.model;
		this.name = opts.name;
		this.resume = opts.resume;
		this.mode = () => this.gate.mode;
		this.mapper = new CcMapper({ provider: opts.model.provider, emit: (e) => this.emit(e) });
		this.mapper.setMessages(opts.history);
		this.mapper.model = opts.model.id;
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
		if (e.type === "agent_settled") {
			const waiters = this.idleWaiters.splice(0);
			for (const w of waiters) w();
			this.hooks?.settled?.();
			this.hooks?.sessionsChanged?.();
		}
		if (e.type === "agent_start") this.hooks?.sessionsChanged?.();
	}

	get isStreaming(): boolean {
		return this.mapper.running;
	}

	ref(): SessionRef {
		return { runtime: "claude-code", id: this.id, nativeId: this.nativeId };
	}

	// ---------- start ----------

	private async externalTools(): Promise<PluginTool[]> {
		const view = await this.services.plugins.externalView();
		return view.tools.map((t) => t.tool).filter((t) => !NATIVE_COVERED.has(t.name));
	}

	private async staticContext(): Promise<string> {
		const ctx = await this.services.plugins.collectContextExternal({ prompt: "", cwd: this.cwd, sessionId: this.id, runtime: "claude-code", permissionMode: this.mode() });
		const parts: string[] = [];
		for (const [key, value] of Object.entries(ctx.static.sections)) parts.push(`# ${key}\n${value}`);
		if (ctx.static.guidelines.length) parts.push(`# Guidelines\n${ctx.static.guidelines.map((g) => `- ${g}`).join("\n")}`);
		return parts.join("\n\n");
	}

	/** Context that changes per message: plugin hits plus the permission-mode reminders. */
	private async turnContext(prompt: string): Promise<string> {
		const ctx = await this.services.plugins.collectContextExternal({ prompt, cwd: this.cwd, sessionId: this.id, runtime: "claude-code", permissionMode: this.mode() });
		const draft = { systemPromptOptions: { promptGuidelines: [] as string[], sections: {} as Record<string, string> } };
		applyPermissionPrompt(draft, this.mode(), this.gate.unattended);
		const mode = Object.values(draft.systemPromptOptions.sections);
		return [...ctx.turn, ...mode].filter(Boolean).join("\n\n");
	}

	private async start(): Promise<Query> {
		if (this.q) return this.q;
		const { services } = this;
		this.busTools = await this.externalTools();
		this.busSession = services.bus.open({
			sessionId: this.id,
			cwd: () => this.cwd,
			ui: this.toolUi(),
			hasUI: () => !this.gate.unattended,
			tools: () => this.externalTools(),
			beforeCall: async (call) => {
				const verdict = await this.gate.evaluate({ toolName: call.name, input: asObject(call.args), readOnly: toolReadOnly(this.busTools, call.name), cwd: this.cwd });
				return verdict ? { allow: false, reason: verdict.reason } : { allow: true };
			},
			onEvent: (e) => this.mapper.bus(e),
		});

		const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "prometheus", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
		const options: Options = {
			cwd: this.cwd,
			model: this.model.id,
			includePartialMessages: true,
			permissionMode: this.gate.mode === "plan" ? "plan" : "default",
			tools: NATIVE_TOOLS,
			disallowedTools: ["Task", "Agent"],
			strictMcpConfig: true,
			mcpServers: { [PROMETHEUS_MCP_SERVER]: { type: "http", url: this.busSession.url, headers: { Authorization: `Bearer ${this.busSession.token}` }, alwaysLoad: true } as never },
			systemPrompt: { type: "preset", preset: "claude_code", append: await this.staticContext(), snapshot: false } as never,
			...(this.resume ? { resume: this.nativeId } : { sessionId: this.nativeId }),
			canUseTool: async (toolName, input, o) => this.canUseTool(toolName, input, o.signal),
			hooks: {
				PreToolUse: [{ hooks: [async (input: any) => this.preToolUse(input)] }],
				UserPromptSubmit: [{ hooks: [async (input: any) => this.userPromptSubmit(input)] }],
			},
			stderr: (data: string) => this.services.log.warn(`[claude-code ${this.id}] ${data.trimEnd()}`),
		};
		if (this.executable) options.pathToClaudeCodeExecutable = this.executable;

		const gateway = this.initOpts.gateway;
		if (gateway?.mode === "prometheus") {
			this.grant = services.relay.grant(this.id, gateway.gatewayId, () => {
				const g = services.gateway(gateway.gatewayId);
				return g && gatewayAs(g, "anthropic-messages");
			});
			env.ANTHROPIC_BASE_URL = this.grant.baseUrl;
			env.ANTHROPIC_AUTH_TOKEN = this.grant.token;
			delete env.ANTHROPIC_API_KEY;
			env.ANTHROPIC_MODEL = this.model.id;
			env.ANTHROPIC_SMALL_FAST_MODEL = this.model.id;
			// The user's ~/.claude/settings.json `env` would override the relay (docs §12.1).
			options.settingSources = ["project", "local"];
		}
		options.env = withLoopbackNoProxy(env);

		const q = query({ prompt: this.input(), options });
		this.q = q;
		this.pump = this.consume(q);
		return q;
	}

	private async *input(): AsyncGenerator<SDKUserMessage> {
		while (!this.closed) {
			while (this.inbox.length) yield this.inbox.shift()!;
			await new Promise<void>((resolve) => (this.wake = resolve));
			this.wake = undefined;
		}
	}

	private async consume(q: Query): Promise<void> {
		try {
			for await (const msg of q) {
				this.mapper.handle(msg);
				const m = msg as any;
				if (m.type === "system" && m.subtype === "init" && typeof m.model === "string") this.mapper.model = m.model;
				if (m.type === "result") this.onResult(m);
			}
		} catch (err) {
			if (!this.closed) {
				const message = err instanceof Error ? err.message : String(err);
				this.services.log.warn(`[claude-code ${this.id}] ${message}`);
				this.pendingError = message;
				this.mapper.finish(this.abortRequested, message);
			}
		} finally {
			this.q = undefined;
			// A later prompt starts a fresh process that resumes the same session.
			this.resume = true;
			if (this.mapper.running) this.mapper.finish(this.abortRequested);
		}
	}

	private onResult(m: any): void {
		const aborted = this.abortRequested;
		this.abortRequested = false;
		let error: string | undefined;
		if (!aborted && m.subtype && m.subtype !== "success") {
			const errors = Array.isArray(m.errors) ? m.errors.join("; ") : "";
			error = errors || String(m.result ?? m.subtype);
		}
		if (!aborted && m.is_error === true && !error) error = String(m.result ?? "error");
		this.pendingError = error;
		this.mapper.finish(aborted, error);
	}

	// ---------- hooks ----------

	private toolUi(): PluginToolContext["ui"] {
		const ui = this.initOpts.ui.context();
		return {
			confirm: (title, message, o) => ui.confirm(title, message, o),
			select: (title, options, o) => ui.select(title, options, o),
			input: (title, placeholder, o) => ui.input(title, placeholder, o),
			notify: (message, level) => ui.notify(message, level),
		};
	}

	private async preToolUse(input: any): Promise<Record<string, unknown>> {
		const call = canonicalTool(String(input.tool_name), input.tool_input);
		// Our own tools are gated at the bus (one decision, one prompt).
		if (call.prometheus) return {};
		if (call.kind === "plan_exit") return this.planExit(call.args, input);
		const verdict = await this.gate.evaluate({ toolName: call.name, input: call.args, readOnly: call.readOnly, cwd: this.cwd });
		if (verdict) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason } };
		return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
	}

	private async planExit(args: Record<string, unknown>, _input: unknown): Promise<Record<string, unknown>> {
		const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
		if (this.gate.mode !== "plan") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
		// Claude Code strips the plan from the tool input and keeps it in a plan file; fall back to what the model wrote.
		const plan = String(args.plan ?? "").trim() || this.mapper.textSinceUser();
		const answer = await this.gate.ask?.({ kind: "plan", plan });
		if (answer === "acceptEdits" || answer === "default") {
			this.gate.setMode(answer);
			await this.syncNativeMode();
			return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
		}
		return deny("The user did not approve the plan yet. Stay in plan mode: ask what they want changed, or revise the plan and submit it again.");
	}

	/** Fallback for anything the hook let through to Claude Code's own permission check: ask the gate again. */
	private async canUseTool(toolName: string, input: Record<string, unknown>, signal: AbortSignal) {
		const call = canonicalTool(toolName, input);
		const verdict = await this.gate.evaluate({ toolName: call.name, input: call.args, readOnly: call.readOnly, cwd: this.cwd, signal });
		if (verdict) return { behavior: "deny" as const, message: verdict.reason };
		return { behavior: "allow" as const, updatedInput: input };
	}

	private async userPromptSubmit(input: any): Promise<Record<string, unknown>> {
		const extra = this.pendingContext;
		this.pendingContext = undefined;
		const additionalContext = [extra, await this.turnContext(String(input.prompt ?? "")).catch(() => "")].filter(Boolean).join("\n\n");
		if (!additionalContext) return {};
		return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
	}

	// ---------- RuntimeSession ----------

	async prompt(input: UserInput, delivery: PromptDelivery): Promise<PromptDisposition> {
		if (this.closed) throw new AppError("sessionNotFound", { id: this.id });
		const wasRunning = this.mapper.running;
		await this.start();
		if (input.context && !wasRunning) this.pendingContext = input.context;
		const content: any[] = [];
		if (input.text) content.push({ type: "text", text: input.text });
		for (const img of input.images ?? []) content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } });
		if (!wasRunning) this.mapper.user(input.images?.length ? [...(input.text ? [{ type: "text", text: input.text }] : []), ...input.images] : input.text);
		else this.mapper.user(input.text);
		this.inbox.push({ type: "user", message: { role: "user", content: content.length === 1 && content[0].type === "text" ? content[0].text : content }, parent_tool_use_id: null } as SDKUserMessage);
		this.wake?.();
		void delivery;
		return wasRunning ? "queued" : "started";
	}

	async abort(): Promise<void> {
		if (!this.q || !this.mapper.running) return;
		this.abortRequested = true;
		await this.q.interrupt().catch(() => undefined);
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
		this.model = model;
		this.mapper.model = model.id;
		await this.q?.setModel(model.id);
		this.emit({ type: "model_changed", model });
	}
	async setThinking(_level: ThinkingLevel): Promise<void> {}
	async setPermissionMode(mode: PermissionMode): Promise<void> {
		this.gate.setMode(mode);
		await this.syncNativeMode();
	}

	/**
	 * Claude Code only offers ExitPlanMode while it is itself in plan mode. Every other decision stays with the
	 * gate, so outside plan mode Claude Code runs in its default mode and defers to the pre-tool hook.
	 */
	private async syncNativeMode(): Promise<void> {
		await this.q?.setPermissionMode(this.gate.mode === "plan" ? "plan" : "default").catch(() => undefined);
	}
	setName(name: string): void {
		this.name = name;
		this.emit({ type: "session_info_changed", name });
		this.hooks?.sessionsChanged?.();
	}
	async refreshTools(): Promise<void> {
		// The bus reads the tool list per request; Claude Code re-lists on its own schedule.
		this.busTools = await this.externalTools();
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
			availableThinkingLevels: [],
			isStreaming: this.isStreaming,
			queue: { steering: [], followUp: [] },
		} as RuntimeSnapshot;
	}
	commands(): CommandInfo[] {
		return [];
	}
	tools(): ToolInfo[] {
		const native = NATIVE_TOOLS.map((n) => ({ name: canonicalTool(n, {}).name, description: `Claude Code ${n}`, active: true }));
		const ours = this.busTools.map((t) => ({ name: t.name, description: t.description, active: true }));
		return [...native, ...ours];
	}
	usage(): SessionStats {
		const t = this.mapper.total;
		return {
			contextTokens: t.totalTokens,
			contextEstimated: true,
			contextWindow: 0,
			contextPercent: null,
			breakdown: { system: 0, tools: 0, user: 0, assistant: 0, toolResults: 0, other: 0 },
			totalCost: 0,
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
		this.wake?.();
		try {
			this.q?.close();
		} catch {
			/* already closed */
		}
		this.busSession?.close();
		this.grant?.revoke();
		await this.pump?.catch(() => undefined);
		for (const w of this.idleWaiters.splice(0)) w();
		this.listeners.clear();
	}
}

function asObject(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function toolReadOnly(tools: PluginTool[], name: string): boolean {
	return tools.find((t) => t.name === name)?.annotations?.readOnlyHint === true;
}
