// CodexSession: one `codex app-server` process and one thread behind the runtime-neutral RuntimeSession.
// Model traffic goes through the gateway relay, Prometheus tools through the tool bus (as an MCP server),
// approvals through the single PermissionGate (docs/agent-runtime.md §4, §6, §7, §12.2).
import { copyFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { withLoopbackNoProxy } from "../loopback-env.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginTool, PluginToolContext } from "@prometheus/plugin-sdk";
import { AppError, gatewayAs, type ChatMessage, type CommandInfo, type ModelRef, type PermissionMode, type PromptDisposition, type SessionEvent, type SessionStats, type ThinkingLevel, type ToolInfo } from "@prometheus/protocol";
import type { PermissionGate } from "../../permission-gate.ts";
import { applyPermissionPrompt } from "../../permission-gate.ts";
import type { BusSession } from "../bus/tool-bus.ts";
import type { RelayGrant } from "../relay/gateway-relay.ts";
import type { GatewayChoice, PromptDelivery, RuntimeCapabilities, RuntimeServices, RuntimeSession, RuntimeSnapshot, SessionHooks, SessionInit, SessionRef, UserInput } from "../types.ts";
import { AppServer } from "./app-server.ts";
import { CodexMapper, replayThread } from "./codex-mapper.ts";

export const CODEX_CAPABILITIES: RuntimeCapabilities = {
	steering: true,
	followUpQueue: false,
	compaction: "manual+auto",
	fork: false,
	treeNavigation: false,
	thinkingLevels: ["low", "medium", "high"],
	images: true,
	liveToolListChange: false,
	systemPromptReplace: "none",
	contextBreakdown: false,
	permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions", "auto"],
	nativeTools: ["exec", "edit", "write", "fetch", "todo"],
};

const CONTEXT_TAG = "prometheus-context";

export interface CodexSessionOptions {
	id: string;
	cwd: string;
	init: SessionInit;
	services: RuntimeServices;
	model: ModelRef;
	/** Set when resuming an existing thread. */
	threadId?: string;
	history?: ChatMessage[];
	name?: string;
	executable?: string;
	/** Extra environment from the agent profile. */
	env?: Record<string, string>;
}

type Sandbox = { type: "dangerFullAccess" } | { type: "readOnly"; networkAccess: boolean } | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

const tomlString = (s: string) => JSON.stringify(s);

export class CodexSession implements RuntimeSession {
	readonly capabilities = CODEX_CAPABILITIES;
	readonly id: string;
	readonly cwd: string;
	private threadId = "";
	private readonly services: RuntimeServices;
	private readonly gate: PermissionGate;
	private readonly hooks: SessionHooks | undefined;
	private readonly initOpts: SessionInit;
	private readonly mapper: CodexMapper;
	private readonly listeners = new Set<(e: SessionEvent) => void>();
	private model: ModelRef;
	private effort: "low" | "medium" | "high" | undefined;
	private name: string | undefined;
	private server: AppServer | undefined;
	private busSession: BusSession | undefined;
	private grant: RelayGrant | undefined;
	private busTools: PluginTool[] = [];
	/** Skill name -> SKILL.md path, filled by `commands()`. */
	private readonly skills = new Map<string, string>();
	private idleWaiters: (() => void)[] = [];
	private abortRequested = false;
	private pendingError: string | undefined;
	private closed = false;
	/** Set while the process is replaced on purpose, so its exit is not reported as a crash. */
	private rerouting = false;
	private gatewayChoice: GatewayChoice | undefined;
	private readonly fileItems = new Map<string, any[]>();
	private readonly opts: CodexSessionOptions;

	constructor(opts: CodexSessionOptions) {
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
		this.threadId = opts.threadId ?? "";
		this.mapper = new CodexMapper({ provider: opts.model.provider, model: () => this.model.id, emit: (e) => this.emit(e) });
		this.mapper.setMessages(opts.history ?? []);
	}

	get nativeId(): string {
		return this.threadId;
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
		return { runtime: "codex", id: this.id, nativeId: this.threadId };
	}

	// ---------- start ----------

	private async externalTools(): Promise<PluginTool[]> {
		return [...(await this.services.plugins.externalView()).tools.map((t) => t.tool), this.gate.planExitTool()];
	}

	private async staticContext(): Promise<string> {
		const ctx = await this.services.plugins.collectContextExternal({ prompt: "", cwd: this.cwd, sessionId: this.id, runtime: "codex", permissionMode: this.gate.mode });
		const parts: string[] = [];
		for (const [key, value] of Object.entries(ctx.static.sections)) parts.push(`# ${key}\n${value}`);
		if (ctx.static.guidelines.length) parts.push(`# Guidelines\n${ctx.static.guidelines.map((g) => `- ${g}`).join("\n")}`);
		return parts.join("\n\n");
	}

	private async turnContext(prompt: string): Promise<string> {
		const ctx = await this.services.plugins.collectContextExternal({ prompt, cwd: this.cwd, sessionId: this.id, runtime: "codex", permissionMode: this.gate.mode });
		const draft = { systemPromptOptions: { promptGuidelines: [] as string[], sections: {} as Record<string, string> } };
		applyPermissionPrompt(draft, this.gate.mode, this.gate.unattended);
		return [...ctx.turn, ...Object.values(draft.systemPromptOptions.sections)].filter(Boolean).join("\n\n");
	}

	/** Starts the process and the thread. Called by the runtime before the session is handed out. */
	async start(): Promise<void> {
		const { services } = this;
		const choice = this.gatewayChoice;
		if (choice?.mode === "prometheus") {
			const gateway = services.gateway(choice.gatewayId);
			if (!gateway) throw new AppError("gatewayNotFound", { id: choice.gatewayId } as never);
			if (!gatewayAs(gateway, "openai-responses")) throw new AppError("generic");
		}

		this.busTools = await this.externalTools();
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
		if (choice?.mode === "prometheus") {
			this.grant = services.relay.grant(this.id, choice.gatewayId, () => {
				const g = services.gateway(choice.gatewayId);
				return g && gatewayAs(g, "openai-responses");
			});
		}

		// Codex reads its provider and MCP server from its own config; a per-session home keeps tokens and threads apart.
		const home = join(services.dataDir, "runtimes", "codex", this.id);
		await mkdir(home, { recursive: true });
		// With its own login Codex keeps the account's auth and config; they are copied into the per-session home.
		const native = choice?.mode !== "prometheus";
		const userHome = process.env.CODEX_HOME || join(homedir(), ".codex");
		const userConfig = native ? await readFile(join(userHome, "config.toml"), "utf8").catch(() => "") : "";
		if (native) await copyFile(join(userHome, "auth.json"), join(home, "auth.json")).catch(() => undefined);
		const toml = [
			...(native ? [userConfig.trimEnd()] : [
				`model = ${tomlString(this.model.id)}`,
				`model_provider = "prometheus"`,
				`check_for_update_on_startup = false`,
				``,
				`[model_providers.prometheus]`,
				`name = "Prometheus"`,
				`base_url = ${tomlString(`${this.grant?.baseUrl}/v1`)}`,
				`env_key = "PROMETHEUS_GW_TOKEN"`,
				`wire_api = "responses"`,
			]),
			``,
			`[mcp_servers.prometheus]`,
			`url = ${tomlString(this.busSession.url)}`,
			`bearer_token_env_var = "PROMETHEUS_MCP_TOKEN"`,
			`default_tools_approval_mode = "approve"`,
			``,
		].join("\n");
		await writeFile(join(home, "config.toml"), toml, "utf8");

		this.server = new AppServer({
			env: withLoopbackNoProxy({ ...process.env, ...(this.opts.env ?? {}), CODEX_HOME: home, ...(this.grant ? { PROMETHEUS_GW_TOKEN: this.grant.token } : {}), PROMETHEUS_MCP_TOKEN: this.busSession.token }),
			cwd: this.cwd,
			executable: this.opts.executable,
			onNotification: (method, params) => this.onNotification(method, params),
			onRequest: (method, params) => this.onServerRequest(method, params),
			onExit: (code, stderr) => this.onExit(code, stderr),
			onLog: (line) => services.log.warn(`[codex ${this.id}] ${line}`),
		});
		await this.server.start();

		const policy = this.policy();
		const developerInstructions = (await this.staticContext()) || null;
		if (this.threadId) {
			await this.server.request("thread/resume", { threadId: this.threadId, cwd: this.cwd, ...this.modelArg(), approvalPolicy: policy.approval, developerInstructions });
			if (!this.mapper.messages.length) {
				const read = await this.server.request("thread/read", { threadId: this.threadId, includeTurns: true }).catch(() => undefined);
				const turns = read?.thread?.turns;
				if (Array.isArray(turns)) this.mapper.setMessages(replayThread(turns, this.model.provider, this.model.id));
			}
		} else {
			const res = await this.server.request("thread/start", { cwd: this.cwd, ...this.modelArg(), approvalPolicy: policy.approval, sandbox: sandboxMode(policy.sandbox), developerInstructions });
			this.threadId = String(res?.thread?.id ?? "");
			if (!this.threadId) throw new Error("codex did not return a thread id");
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

	/**
	 * Every non-trivial action reaches the gate: Codex asks for anything it does not consider safe ("untrusted"),
	 * and the gate decides by Prometheus' permission mode. Only the modes that allow everything skip the questions.
	 */
	private policy(): { approval: "untrusted" | "never"; sandbox: Sandbox } {
		const mode = this.gate.mode;
		if (!this.gate.unattended && (mode === "bypassPermissions" || mode === "auto")) return { approval: "never", sandbox: { type: "dangerFullAccess" } };
		// On Windows Codex' sandbox needs elevated setup; the gate is the guard there.
		if (process.platform === "win32") return { approval: "untrusted", sandbox: { type: "dangerFullAccess" } };
		// Plan mode needs no read-only sandbox: the gate refuses changes, and the sandbox cannot be widened once the plan is approved mid-turn.
		return { approval: "untrusted", sandbox: { type: "workspaceWrite", writableRoots: [this.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
	}

	// ---------- server messages ----------

	private onNotification(method: string, params: any): void {
		if (params?.threadId && params.threadId !== this.threadId) return;
		if (method === "item/started" && params?.item?.type === "fileChange") this.fileItems.set(params.item.id, params.item.changes ?? []);
		this.mapper.handle(method, params);
		if (method === "turn/completed") {
			const turn = params?.turn ?? {};
			const aborted = turn.status === "interrupted" || this.abortRequested;
			this.abortRequested = false;
			let error: string | undefined;
			if (turn.status === "failed") error = String(turn.error?.message ?? "turn failed");
			this.pendingError = error;
			this.mapper.finish(aborted, error);
		}
	}

	private async onServerRequest(method: string, params: any): Promise<unknown> {
		switch (method) {
			case "item/commandExecution/requestApproval": {
				const v = await this.gate.evaluate({ toolName: "bash", input: { command: String(params?.command ?? "") }, readOnly: false, cwd: this.cwd });
				return { decision: v ? "decline" : "accept" };
			}
			case "item/fileChange/requestApproval": {
				const changes = this.fileItems.get(String(params?.itemId)) ?? [];
				const first = changes[0];
				const add = changes.length === 1 && first?.kind?.type === "add";
				const input = add ? { path: String(first.path), content: String(first.diff ?? "") } : { path: changes.map((c) => c.path).join(", "), edits: [{ oldText: "", newText: changes.map((c) => c.diff).join("\n") }] };
				const v = await this.gate.evaluate({ toolName: add ? "write" : "edit", input, readOnly: false, cwd: this.cwd });
				return { decision: v ? "decline" : "accept" };
			}
			case "applyPatchApproval":
			case "execCommandApproval": {
				const command = Array.isArray(params?.command) ? params.command.join(" ") : String(params?.command ?? "");
				const v = await this.gate.evaluate({ toolName: method === "execCommandApproval" ? "bash" : "edit", input: method === "execCommandApproval" ? { command } : { path: "", edits: [] }, readOnly: false, cwd: this.cwd });
				return { decision: v ? "denied" : "approved" };
			}
			case "item/permissions/requestApproval":
				return { decision: "decline" };
			case "mcpServer/elicitation/request":
				return { action: "decline" };
			default:
				throw new Error(`unsupported request ${method}`);
		}
	}

	private onExit(code: number | null, stderr: string): void {
		if (this.closed || this.rerouting) return;
		const message = `codex exited (${code})${stderr ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`;
		this.services.log.warn(`[codex ${this.id}] ${message}`);
		this.server = undefined;
		this.pendingError = message;
		if (this.mapper.running) this.mapper.finish(this.abortRequested, message);
	}

	// ---------- RuntimeSession ----------

	private async ensureServer(): Promise<AppServer> {
		if (this.server?.running) return this.server;
		// The process died (crash, killed): start a fresh one on the same thread.
		await this.start();
		return this.server!;
	}

	async prompt(input: UserInput, _delivery: PromptDelivery): Promise<PromptDisposition> {
		if (this.closed) throw new AppError("sessionNotFound", { id: this.id });
		const server = await this.ensureServer();
		const wasRunning = this.mapper.running && Boolean(this.mapper.turnId);
		const items: any[] = [];
		const context = wasRunning ? "" : await this.turnContext(input.text).catch(() => "");
		if (input.context && !wasRunning) items.push({ type: "text", text: input.context, text_elements: [] });
		if (context) items.push({ type: "text", text: `<${CONTEXT_TAG}>\n${context}\n</${CONTEXT_TAG}>`, text_elements: [] });
		// `/skill-name args` selects a skill the way Codex's own UI does.
		const slash = /^\/(\S+)/.exec(input.text.trimStart())?.[1];
		if (slash && !this.skills.size) await this.commands();
		const skillPath = slash ? this.skills.get(slash) : undefined;
		if (slash && skillPath) items.push({ type: "skill", name: slash, path: skillPath });
		if (input.text) items.push({ type: "text", text: input.text, text_elements: [] });
		for (const img of input.images ?? []) items.push({ type: "image", url: `data:${img.mimeType};base64,${img.data}` });
		this.mapper.user(input.images?.length ? [...(input.text ? [{ type: "text", text: input.text }] : []), ...input.images] : input.text);
		if (wasRunning) {
			await server.request("turn/steer", { threadId: this.threadId, input: items, expectedTurnId: this.mapper.turnId });
			return "queued";
		}
		const policy = this.policy();
		this.pendingError = undefined;
		await server.request("turn/start", {
			threadId: this.threadId,
			input: items,
			cwd: this.cwd,
			...this.modelArg(),
			approvalPolicy: policy.approval,
			sandboxPolicy: policy.sandbox,
			...(this.effort ? { effort: this.effort } : {}),
		});
		return "started";
	}

	async abort(): Promise<void> {
		if (!this.server?.running || !this.mapper.running) return;
		this.abortRequested = true;
		const turnId = this.mapper.turnId;
		if (turnId) await this.server.request("turn/interrupt", { threadId: this.threadId, turnId }).catch(() => undefined);
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

	/** `model` is left out for the account default, so Codex uses what its own configuration says. */
	private modelArg(): { model?: string } {
		return this.model.provider === "codex" && this.model.id === DEFAULT_MODEL ? {} : { model: this.model.id };
	}

	async setModel(model: ModelRef): Promise<void> {
		const next: GatewayChoice = model.provider === "codex" ? { mode: "native" } : { mode: "prometheus", gatewayId: model.provider, model };
		const current = this.gatewayChoice;
		const changed = (current?.mode ?? "native") !== next.mode || (current?.mode === "prometheus" && next.mode === "prometheus" && current.gatewayId !== next.gatewayId);
		if (changed && this.mapper.running) throw new AppError("waitForReply");
		this.model = model;
		if (changed) {
			// Another route means another provider config: replace the process, resuming the same thread.
			this.gatewayChoice = next;
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
		}
		this.emit({ type: "model_changed", model });
	}
	async setThinking(level: ThinkingLevel): Promise<void> {
		this.effort = level === "low" || level === "medium" || level === "high" ? level : level === "off" || level === "minimal" ? "low" : "high";
		this.emit({ type: "thinking_level_changed", level });
	}
	async setPermissionMode(mode: PermissionMode): Promise<void> {
		this.gate.setMode(mode);
	}
	setName(name: string): void {
		this.name = name;
		this.emit({ type: "session_info_changed", name });
		this.hooks?.sessionsChanged?.();
		if (this.server?.running && this.threadId) void this.server.request("thread/name/set", { threadId: this.threadId, name }).catch(() => undefined);
	}
	async refreshTools(): Promise<void> {
		this.busTools = await this.externalTools();
		// Codex does not react to list_changed (§12.2): ask it to reload its MCP servers before the next turn.
		await this.server?.request("config/mcpServer/reload", {}).catch(() => undefined);
	}

	async compact(): Promise<void> {
		if (!this.server?.running) return;
		this.emit({ type: "compaction_start", reason: "manual" });
		try {
			await this.server.request("thread/compact/start", { threadId: this.threadId });
			this.emit({ type: "compaction_end", reason: "manual", aborted: false });
		} catch (err) {
			this.emit({ type: "compaction_end", reason: "manual", aborted: false, errorMessage: err instanceof Error ? err.message : String(err) });
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
			thinkingLevel: this.effort ?? "medium",
			availableThinkingLevels: CODEX_CAPABILITIES.thinkingLevels,
			isStreaming: this.isStreaming,
			queue: { steering: [], followUp: [] },
		} as RuntimeSnapshot;
	}
	/** Codex has no slash commands over the app-server; its skills are what `/` offers. */
	async commands(): Promise<CommandInfo[]> {
		if (this.closed) return [];
		try {
			const server = await this.ensureServer();
			const res = await server.request("skills/list", { cwds: [this.cwd] });
			this.skills.clear();
			const out: CommandInfo[] = [];
			for (const entry of Array.isArray(res?.data) ? res.data : []) {
				for (const s of Array.isArray(entry?.skills) ? entry.skills : []) {
					if (!s?.name || s.enabled === false || this.skills.has(s.name)) continue;
					this.skills.set(s.name, String(s.path));
					out.push({ name: s.name, description: String(s.interface?.shortDescription ?? s.shortDescription ?? s.description ?? ""), source: "skill" });
				}
			}
			return out;
		} catch (err) {
			this.services.log.warn(`[codex ${this.id}] skills: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}
	tools(): ToolInfo[] {
		return this.busTools.filter((t) => t.name !== "exit_plan_mode").map((t) => ({ name: t.name, description: t.description, active: true }));
	}
	usage(): SessionStats {
		const t = this.mapper.total;
		return {
			contextTokens: this.mapper.contextTokens,
			contextEstimated: this.mapper.contextTokens === 0,
			contextWindow: this.mapper.contextWindow,
			contextPercent: this.mapper.contextWindow > 0 && this.mapper.contextTokens > 0 ? Math.min(100, (this.mapper.contextTokens / this.mapper.contextWindow) * 100) : null,
			breakdown: { system: 0, tools: 0, user: 0, assistant: 0, toolResults: 0, other: 0 },
			totalCost: 0,
			inputTokens: t.input,
			outputTokens: t.output,
			cacheReadTokens: t.cacheRead,
			cacheWriteTokens: 0,
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

function sandboxMode(s: Sandbox): "danger-full-access" | "read-only" | "workspace-write" {
	return s.type === "dangerFullAccess" ? "danger-full-access" : s.type === "readOnly" ? "read-only" : "workspace-write";
}

function asObject(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Codex picks the model from the account's own configuration when none is named. */
export const DEFAULT_MODEL = "default";

export { CONTEXT_TAG };
