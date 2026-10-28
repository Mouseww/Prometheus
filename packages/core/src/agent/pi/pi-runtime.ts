// PiRuntime: the in-process PI agent behind the AgentRuntime interface. Owns everything PI-specific that
// used to sit in host.ts: the ModelRuntime, resource loading, session creation and native storage.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
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
import { parsePiModels, toProviderConfig } from "@prometheus/gateway";
import { AppError, encodeError, type ModelInfo, type UsageStats } from "@prometheus/protocol";
import { createPiRunner, type SubagentRuntime } from "@prometheus/subagents";
import { skipPiImageAutoResize } from "../../images.ts";
import type { PermissionGate } from "../../permission-gate.ts";
import { pluginBuilderExtension } from "../../plugin-tool.ts";
import type { Runtime } from "../../runtime.ts";
import { collectUsage } from "../../usage.ts";
import type { AgentRuntime, GatewayChoice, NativeSessionInfo, ResumeInit, RuntimeHealth, RuntimeSession, SessionInit, SessionRef } from "../types.ts";
import { PendingForks } from "./forks.ts";
import { raiseRetryBudget } from "./retry.ts";
import { PiRuntimeSession } from "./pi-session.ts";

// Mirrors PI's CLI built-ins (main() adds them for the TUI); names keep `builtin:<name>` settings working.
const builtInExtensions: InlineExtension[] = [
	{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
	{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
	{ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
];

export interface PiRuntimeOptions {
	/** The bootstrapped Prometheus runtime: plugins, dynamic extension and gateway config. */
	runtime: Runtime;
	/** Working directory for host-level settings. */
	cwd: string;
}

export class PiRuntime implements AgentRuntime {
	readonly kind = "pi" as const;
	readonly modelRuntime: ModelRuntime;
	readonly agentDir: string;
	private readonly runtime: Runtime;
	private readonly cwd: string;
	private registered = new Set<string>();
	private settingsManager: SettingsManager | undefined;
	/** Managers of forked sessions that have not been resumed yet; dropped when the session that made them is disposed. */
	private readonly forks = new PendingForks();

	private constructor(options: PiRuntimeOptions, agentDir: string, modelRuntime: ModelRuntime) {
		this.runtime = options.runtime;
		this.cwd = options.cwd;
		this.agentDir = agentDir;
		this.modelRuntime = modelRuntime;
	}

	static async start(options: PiRuntimeOptions): Promise<PiRuntime> {
		const agentDir = getAgentDir();
		// Shares PI's auth.json/models.json so `/login` credentials from the TUI work here too.
		const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
		return new PiRuntime(options, agentDir, modelRuntime);
	}

	get version(): string {
		return PI_VERSION;
	}

	async probe(): Promise<RuntimeHealth> {
		return { available: true, version: PI_VERSION };
	}

	// ---------- models & gateways ----------

	async listModels(gateway: GatewayChoice): Promise<ModelInfo[]> {
		const models = await this.modelRuntime.getAvailable();
		return models
			.filter((m) => gateway.mode === "native" || m.provider === gateway.gatewayId)
			.map(
				(m): ModelInfo => ({
					provider: m.provider,
					id: m.id,
					name: m.name,
					reasoning: Boolean(m.reasoning),
					vision: Array.isArray(m.input) && m.input.includes("image"),
					contextWindow: m.contextWindow,
				}),
			);
	}

	getModel(provider: string, id: string): ReturnType<ModelRuntime["getModel"]> {
		return this.modelRuntime.getModel(provider, id);
	}

	getModels(): ReturnType<ModelRuntime["getModels"]> {
		return this.modelRuntime.getModels();
	}

	completeSimple(...args: Parameters<ModelRuntime["completeSimple"]>): ReturnType<ModelRuntime["completeSimple"]> {
		return this.modelRuntime.completeSimple(...args);
	}

	/** Ids of the Prometheus gateways currently registered as PI providers. */
	get registeredGateways(): ReadonlySet<string> {
		return this.registered;
	}

	/** Gateways declared in the PI agent's own models.json (the file PI's /login and manual setups use). */
	async readPiGateways(): Promise<ReturnType<typeof parsePiModels>> {
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

	/** Registers the enabled Prometheus gateways as PI providers and drops the ones that went away. */
	syncGateways(): void {
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

	// ---------- host-level settings ----------

	private settings(): SettingsManager {
		this.settingsManager ??= SettingsManager.create(this.cwd, this.agentDir);
		return this.settingsManager;
	}

	autoCompaction(): boolean {
		return this.settings().getCompactionEnabled();
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		this.settings().setCompactionEnabled(enabled);
		await this.settings().flush();
	}

	// ---------- sessions ----------

	/** One loader per session: its extension runtime is invalidated when that session is disposed or reloaded, so sharing it would break sibling sessions. */
	private async loader(cwd: string, gate: PermissionGate, subagents: SubagentRuntime | undefined): Promise<DefaultResourceLoader> {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: this.agentDir,
			// PI's own built-ins (MCP client, codemode, tool search) come first, as in the TUI.
			extensionFactories: [...builtInExtensions, this.runtime.dynamicExtension(), pluginBuilderExtension(this.runtime.plugins), gate.extension(), ...(subagents ? [subagents.extension()] : [])],
			// The app has its own `subagent` tool; the pi-subagents package would register a second one under the same name.
			extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((x) => !/pi-subagents/i.test(`${x.path} ${x.resolvedPath}`)) }),
		});
		await loader.reload();
		return loader;
	}

	/**
	 * Runner for subagents that use PI. It inherits model and thinking level from the parent chat, read
	 * lazily because the parent session does not exist yet when its subagent runtime is built.
	 */
	subagentRunner(parent: () => RuntimeSession | undefined): ReturnType<typeof createPiRunner> {
		return createPiRunner({
			modelRuntime: this.modelRuntime,
			agentDir: this.agentDir,
			parentModel: () => {
				const s = parent();
				return s instanceof PiRuntimeSession ? s.inherited().model : undefined;
			},
			parentThinking: () => {
				const s = parent();
				return s instanceof PiRuntimeSession ? s.inherited().thinking : undefined;
			},
		});
	}

	create(init: SessionInit): Promise<RuntimeSession> {
		const manager = SessionManager.create(init.cwd);
		// A conversation continued from another runtime becomes real PI history: plain user text and assistant text, no tool traffic.
		for (const m of init.history ?? []) {
			const msg = m as any;
			if (msg.role === "user") {
				const content = typeof msg.content === "string" ? msg.content : (msg.content ?? []).filter((b: any) => b.type === "text");
				if (typeof content === "string" ? content.trim() : content.length) manager.appendMessage({ role: "user", content, timestamp: msg.timestamp } as never);
			} else if (msg.role === "assistant") {
				const content = (msg.content ?? []).filter((b: any) => b.type === "text" && String(b.text ?? "").trim());
				if (content.length) manager.appendMessage({ ...msg, content, stopReason: "stop" } as never);
			}
		}
		return this.attach(manager, init);
	}

	async resume(ref: SessionRef, init: ResumeInit): Promise<RuntimeSession> {
		const forked = this.forks.take(ref.id);
		if (forked) {
			return this.attach(forked, init);
		}
		if (!ref.path) throw new AppError("sessionNotFound", { id: ref.id });
		return this.attach(SessionManager.open(ref.path), init);
	}

	private async attach(sessionManager: SessionManager, init: ResumeInit): Promise<PiRuntimeSession> {
		const cwd = sessionManager.getCwd();
		const { permission: gate, ui: bridge, subagents, hooks } = init;
		const settingsManager = SettingsManager.create(cwd, this.agentDir);
		// PI auto-resize needs Photon WASM. A failed load drops every picture with
		// "Image omitted: could not be resized". The web UI already shrinks attachments.
		skipPiImageAutoResize(settingsManager);
		raiseRetryBudget(settingsManager);
		const { session } = await createAgentSession({
			cwd,
			agentDir: this.agentDir,
			modelRuntime: this.modelRuntime,
			sessionManager,
			settingsManager,
			resourceLoader: await this.loader(cwd, gate, subagents),
		});
		const adapter = new PiRuntimeSession({
			session,
			modelRuntime: this.modelRuntime,
			gate,
			hooks,
			notifyError: (message) => bridge.context().notify(message, "error"),
			keepFork: (manager) => this.forks.keep(session.sessionId, manager),
			onDispose: () => this.forks.dropFrom(session.sessionId),
		});
		hooks?.created?.(adapter);
		subagents?.restore(session.messages);
		gate.ask = (prompt, signal) => bridge.askPermission(prompt, signal);
		gate.onModeChange = (mode) => {
			bridge.auto = mode === "auto";
			if (bridge.auto) bridge.autoResolvePending();
			adapter.onPermissionMode(mode);
		};
		await session.bindExtensions({
			uiContext: bridge.context(),
			mode: "rpc",
			onError: (err) => bridge.context().notify(encodeError(new AppError("extensionError", { error: String(err.error) })), "error"),
		});
		return adapter;
	}

	// ---------- native storage ----------

	async listNative(): Promise<NativeSessionInfo[]> {
		const infos = await SessionManager.listAll();
		return infos.map((info) => ({
			ref: { runtime: "pi", id: info.id, nativeId: info.id, path: info.path },
			name: info.name,
			cwd: info.cwd,
			created: info.created.toISOString(),
			modified: info.modified.toISOString(),
			messageCount: info.messageCount,
			firstMessage: info.firstMessage,
		}));
	}

	async deleteNative(ref: SessionRef): Promise<void> {
		if (ref.path?.endsWith(".jsonl")) await rm(ref.path, { force: true });
	}

	async collectUsage(days: number): Promise<UsageStats> {
		const infos = await SessionManager.listAll();
		return collectUsage(infos.map((i) => i.path), Number.isInteger(days) && days > 0 ? days : 0);
	}
}
