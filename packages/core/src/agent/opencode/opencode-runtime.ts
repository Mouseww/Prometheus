// OpenCodeRuntime: opencode through `opencode serve` (docs/agent-runtime.md §12.3).
// Its own login and configuration (`opencode auth login`, opencode.json) work as they are; a Prometheus gateway is
// offered to it as a custom provider behind the local relay.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { type AgentServer, type GatewayConfig, type ModelInfo, pickGatewayFormat, type UsageStats } from "@prometheus/protocol";
import { withLoopbackNoProxy } from "../loopback-env.ts";
import type { AgentRuntime, GatewayChoice, NativeSessionInfo, ResumeInit, RuntimeHealth, RuntimeServices, RuntimeSession, SessionInit, SessionRef } from "../types.ts";
import { DEFAULT_MODEL, OPENCODE_FORMATS, OpenCodeSession } from "./opencode-session.ts";
import { basicAuth, checkServer, type OpenCodeEndpoint, OpenCodeServer, resolveOpenCodeCommand } from "./opencode-server.ts";

const run = promisify(execFile);

const DEFAULT_ENTRY: ModelInfo = { provider: "opencode", id: DEFAULT_MODEL, name: "OpenCode (configured default)", reasoning: true, vision: true, contextWindow: 200_000 };

export class OpenCodeRuntime implements AgentRuntime {
	readonly kind = "opencode" as const;
	private readonly getServices: () => Promise<RuntimeServices>;
	private readonly executable: () => string | undefined;
	private readonly env: () => Record<string, string>;
	private readonly serverConfig: () => AgentServer | undefined;
	private nativeModels: { at: number; key: string; models: ModelInfo[] } | undefined;
	/** The server Prometheus started on a fixed port and shares between this agent's chats (server mode). */
	private shared: { key: string; server?: OpenCodeServer; ready: Promise<OpenCodeEndpoint> } | undefined;

	constructor(
		getServices: () => Promise<RuntimeServices>,
		executable: () => string | undefined = () => undefined,
		env: () => Record<string, string> = () => ({}),
		server: () => AgentServer | undefined = () => undefined,
	) {
		this.getServices = getServices;
		this.executable = executable;
		this.env = env;
		this.serverConfig = server;
	}

	/** Server mode is on: chats use one long-lived server instead of a process each. */
	private get serverMode(): boolean {
		const cfg = this.serverConfig();
		return Boolean(cfg?.url || cfg?.port);
	}

	private authOf(cfg: AgentServer): { authorization?: string } {
		const authorization = basicAuth(cfg.password, cfg.username);
		return authorization ? { authorization } : {};
	}

	/**
	 * The server chats attach to in server mode: the configured URL, or the one shared on the configured port (started
	 * on first use; an opencode server that already answers there with the same credentials is used as it is).
	 */
	private async endpoint(): Promise<OpenCodeEndpoint | undefined> {
		const cfg = this.serverConfig();
		if (!cfg) return undefined;
		if (cfg.url) return { url: cfg.url, ...this.authOf(cfg) };
		if (!cfg.port) return undefined;
		const key = JSON.stringify([cfg.port, cfg.username ?? "", cfg.password ?? "", this.executable() ?? ""]);
		if (this.shared?.key === key && (!this.shared.server || this.shared.server.running)) return this.shared.ready;
		const previous = this.shared?.server;
		this.shared = undefined;
		await previous?.close();
		const entry: { key: string; server?: OpenCodeServer; ready: Promise<OpenCodeEndpoint> } = { key, ready: Promise.resolve({ url: "" }) };
		entry.ready = (async () => {
			const existing: OpenCodeEndpoint = { url: `http://127.0.0.1:${cfg.port}`, ...this.authOf(cfg) };
			if (await checkServer(existing, 3000).then(() => true, () => false)) return existing;
			const server = new OpenCodeServer({
				env: withLoopbackNoProxy({ ...process.env, ...this.env(), OPENCODE_DISABLE_AUTOUPDATE: "1" }),
				cwd: homedir(),
				executable: this.executable(),
				port: cfg.port,
				username: cfg.username,
				secret: cfg.password,
				events: false,
				onEvent: () => {},
				onExit: (code, output) => {
					if (this.shared === entry) this.shared = undefined;
					console.warn(`[opencode server :${cfg.port}] exited (${code})${output ? `: ${output.trim().split("\n").at(-1)}` : ""}`);
				},
			});
			entry.server = server;
			await server.start();
			return server.endpoint;
		})();
		this.shared = entry;
		entry.ready.catch(() => {
			if (this.shared === entry) this.shared = undefined;
		});
		return entry.ready;
	}

	/** A client for one-off requests to the server-mode server. */
	private async client(): Promise<OpenCodeServer | undefined> {
		const endpoint = await this.endpoint();
		if (!endpoint) return undefined;
		const client = new OpenCodeServer({ env: {}, cwd: homedir(), attach: endpoint, events: false, onEvent: () => {}, onExit: () => {} });
		await client.start();
		return client;
	}

	async dispose(): Promise<void> {
		const shared = this.shared;
		this.shared = undefined;
		await shared?.server?.close();
	}

	private async cli(args: string[], timeout = 15_000): Promise<string> {
		const env = { ...process.env, ...this.env() };
		// The agent's PATH (Prometheus-installed CLIs first), so an updated copy wins over an older one.
		const { command, args: base, shell } = resolveOpenCodeCommand(this.executable(), { env });
		const { stdout } = await run(command, [...base, ...args], { shell, timeout, windowsHide: true, env });
		return stdout;
	}

	async probe(): Promise<RuntimeHealth> {
		const cfg = this.serverConfig();
		if (cfg?.url) {
			try {
				const version = await checkServer({ url: cfg.url, ...this.authOf(cfg) }, 5000);
				return { available: true, version: `${version} @ ${cfg.url}` };
			} catch (err) {
				return { available: false, reason: err instanceof Error ? err.message : String(err) };
			}
		}
		try {
			return { available: true, version: (await this.cli(["--version"])).trim() };
		} catch (err) {
			return { available: false, reason: err instanceof Error ? err.message.split("\n")[0] : String(err) };
		}
	}

	/** The models the user's own opencode configuration offers (`opencode models`), after the "configured default" entry. */
	private async native(): Promise<ModelInfo[]> {
		const key = JSON.stringify(this.serverConfig() ?? null);
		if (this.nativeModels && this.nativeModels.key === key && Date.now() - this.nativeModels.at < 60_000) return this.nativeModels.models;
		const models: ModelInfo[] = [DEFAULT_ENTRY];
		if (this.serverMode) {
			// The server's configured providers, not the local CLI's: the server may run with another configuration.
			let client: OpenCodeServer | undefined;
			try {
				client = await this.client();
				const data = await client?.request("GET", "/config/providers");
				for (const p of Array.isArray(data?.providers) ? data.providers : []) {
					for (const m of Object.values(p?.models ?? {}) as any[]) {
						if (!m?.id) continue;
						const id = `${p.id}/${m.id}`;
						models.push({ provider: "opencode", id, name: m.name ? `${m.name} (${p.name ?? p.id})` : id, reasoning: m.reasoning !== false, vision: m.attachment !== false, contextWindow: Number(m.limit?.context) || 200_000 });
					}
				}
			} catch {
				/* only the default entry */
			} finally {
				await client?.close();
			}
			this.nativeModels = { at: Date.now(), key, models };
			return models;
		}
		try {
			for (const line of (await this.cli(["models"], 30_000)).split(/\r?\n/)) {
				const id = line.trim();
				if (!/^[\w.-]+\/\S+$/.test(id)) continue;
				models.push({ provider: "opencode", id, name: id, reasoning: true, vision: true, contextWindow: 200_000 });
			}
		} catch {
			/* only the default entry */
		}
		this.nativeModels = { at: Date.now(), key, models };
		return models;
	}

	private fromGateway(g: GatewayConfig): ModelInfo[] {
		return g.models.map((m) => ({ provider: g.id, id: m.id, name: m.name?.trim() || m.id, reasoning: m.reasoning ?? false, vision: m.vision ?? false, contextWindow: m.contextWindow ?? 200_000 }));
	}

	async listAllModels(gateways: GatewayConfig[]): Promise<ModelInfo[]> {
		const out = [...(await this.native())];
		// A server's providers come from its own configuration; gateways cannot be added to it per chat.
		if (this.serverMode) return out;
		for (const g of gateways) {
			if (g.enabled === false || !pickGatewayFormat(g, OPENCODE_FORMATS)) continue;
			out.push(...this.fromGateway(g));
		}
		return out;
	}

	async listModels(gateway: GatewayChoice): Promise<ModelInfo[]> {
		if (gateway.mode !== "prometheus") return this.native();
		if (this.serverMode) return [];
		const g = (await this.getServices()).gateway(gateway.gatewayId);
		return g && pickGatewayFormat(g, OPENCODE_FORMATS) ? this.fromGateway(g) : [];
	}

	private modelFor(init: { gateway?: GatewayChoice }): { provider: string; id: string } {
		return init.gateway?.mode === "prometheus" ? init.gateway.model : { provider: "opencode", id: DEFAULT_MODEL };
	}

	private sessionEndpoint(): { endpoint?: () => Promise<OpenCodeEndpoint> } {
		if (!this.serverMode) return {};
		return {
			endpoint: async () => {
				const ep = await this.endpoint();
				if (!ep) throw new Error("the OpenCode server is not configured");
				return ep;
			},
		};
	}

	async create(init: SessionInit): Promise<RuntimeSession> {
		const session = new OpenCodeSession({ id: randomUUID(), cwd: init.cwd, init, services: await this.getServices(), model: this.modelFor(init), history: init.history, executable: this.executable(), env: this.env(), ...this.sessionEndpoint() });
		init.hooks?.created?.(session);
		try {
			await session.start();
		} catch (err) {
			await session.dispose();
			throw err;
		}
		return session;
	}

	async resume(ref: SessionRef, init: ResumeInit): Promise<RuntimeSession> {
		const cwd = ref.cwd ?? process.cwd();
		const session = new OpenCodeSession({ id: ref.id, cwd, init: { ...init, cwd }, services: await this.getServices(), model: this.modelFor(init), sessionId: ref.nativeId, history: init.history, name: ref.name, executable: this.executable(), env: this.env(), ...this.sessionEndpoint() });
		init.hooks?.created?.(session);
		try {
			await session.start();
		} catch (err) {
			await session.dispose();
			throw err;
		}
		return session;
	}

	/** Prometheus' own session index lists opencode sessions: they are stored per project in opencode's database. */
	async listNative(): Promise<NativeSessionInfo[]> {
		return [];
	}

	async deleteNative(ref: SessionRef): Promise<void> {
		if (!ref.nativeId) return;
		if (this.serverMode) {
			const client = await this.client().catch(() => undefined);
			await client?.request("DELETE", `/session/${ref.nativeId}`).catch(() => undefined);
			await client?.close();
			return;
		}
		await this.cli(["session", "delete", ref.nativeId], 30_000).catch(() => undefined);
	}

	async collectUsage(days: number): Promise<UsageStats> {
		return { days, sessions: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } as never, byModel: [], byDay: [] };
	}
}
