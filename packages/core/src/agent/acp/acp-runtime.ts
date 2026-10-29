// AcpRuntime: any agent that speaks the Agent Client Protocol over stdio (Gemini CLI, Qwen Code, Goose, Kimi CLI,
// the Claude Code and Codex ACP adapters, ...). One runtime instance per agent profile; one process per chat.
import { randomUUID } from "node:crypto";
import { type GatewayConfig, type ModelInfo, pickGatewayFormat, type UsageStats } from "@prometheus/protocol";
import type { AgentRuntime, GatewayChoice, NativeSessionInfo, ResumeInit, RuntimeHealth, RuntimeServices, RuntimeSession, SessionInit, SessionRef } from "../types.ts";
import { AcpConnection, acpCommandExists, resolveAcpCommand } from "./acp-connection.ts";
import { acpGatewayAdapter } from "./acp-gateway.ts";
import { ACP_DEFAULT_MODEL, ACP_PROVIDER, type AcpAgentSpec, AcpSession, deleteAcpMirror } from "./acp-session.ts";

const PROBE_TTL = 5 * 60_000;

export class AcpRuntime implements AgentRuntime {
	readonly kind = "acp" as const;
	private readonly getServices: () => Promise<RuntimeServices>;
	private readonly spec: () => AcpAgentSpec;
	private health: { at: number; key: string; value: Promise<RuntimeHealth> } | undefined;
	/** Models the agent announced in its latest session (ACP has no way to ask without one). */
	private models: { id: string; name: string; contextWindow?: number }[] = [];

	constructor(getServices: () => Promise<RuntimeServices>, spec: () => AcpAgentSpec) {
		this.getServices = getServices;
		this.spec = spec;
	}

	/** Installed, and does it answer `initialize`? The handshake also tells its version; cached for a few minutes. */
	probe(): Promise<RuntimeHealth> {
		const spec = this.spec();
		const key = JSON.stringify([spec.command, spec.args, spec.env.PATH ?? spec.env.Path ?? ""]);
		if (this.health && this.health.key === key && Date.now() - this.health.at < PROBE_TTL) return this.health.value;
		const value = this.handshake(spec);
		this.health = { at: Date.now(), key, value };
		// A failure is retried sooner: the user is probably fixing it right now.
		void value.then((h) => {
			if (!h.available && this.health?.value === value) this.health.at = Date.now() - PROBE_TTL + 15_000;
		});
		return value;
	}

	private async handshake(spec: AcpAgentSpec): Promise<RuntimeHealth> {
		if (!spec.command) return { available: false, reason: "No command is set for this agent" };
		if (!acpCommandExists(spec.command, spec.env as NodeJS.ProcessEnv)) return { available: false, missing: true, reason: `\`${spec.command}\` was not found` };
		const conn = new AcpConnection({
			launch: resolveAcpCommand(spec.command, spec.args, spec.env as NodeJS.ProcessEnv),
			cwd: process.cwd(),
			env: spec.env,
			onNotification: () => {},
			onRequest: async () => null,
			onExit: () => {},
		});
		try {
			conn.start();
			const init = await conn.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "prometheus", version: "1" } }, 25_000);
			const info = init?.agentInfo ?? {};
			return { available: true, ...(info.version ? { version: String(info.version) } : {}) };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const hint = spec.args.includes("--acp") ? " Older versions use --experimental-acp instead of --acp: change the arguments under Edit." : "";
			return { available: false, reason: `${spec.name} did not start in ACP mode (${spec.command} ${spec.args.join(" ")}): ${message.split("\n")[0]}.${hint}` };
		} finally {
			await conn.close();
		}
	}

	private native(): ModelInfo[] {
		const name = this.spec().name;
		return [
			{ provider: ACP_PROVIDER, id: ACP_DEFAULT_MODEL, name: `${name} (configured default)`, reasoning: true, vision: true, contextWindow: 200_000 },
			...this.models.filter((m) => m.id !== ACP_DEFAULT_MODEL).map((m) => ({ provider: ACP_PROVIDER, id: m.id, name: m.name, reasoning: true, vision: true, contextWindow: m.contextWindow ?? 200_000 })),
		];
	}

	private fromGateway(g: GatewayConfig): ModelInfo[] {
		return g.models.map((m) => ({ provider: g.id, id: m.id, name: m.name?.trim() || m.id, reasoning: m.reasoning ?? false, vision: m.vision ?? false, contextWindow: m.contextWindow ?? 200_000 }));
	}

	async listAllModels(gateways: GatewayConfig[]): Promise<ModelInfo[]> {
		const out = this.native();
		const adapter = acpGatewayAdapter(this.spec().command);
		if (!adapter) return out;
		for (const g of gateways) {
			if (g.enabled === false || !pickGatewayFormat(g, adapter.formats)) continue;
			out.push(...this.fromGateway(g));
		}
		return out;
	}

	async listModels(gateway: GatewayChoice): Promise<ModelInfo[]> {
		if (gateway.mode !== "prometheus") return this.native();
		const adapter = acpGatewayAdapter(this.spec().command);
		const g = (await this.getServices()).gateway(gateway.gatewayId);
		return adapter && g && pickGatewayFormat(g, adapter.formats) ? this.fromGateway(g) : [];
	}

	private modelFor(init: { gateway?: GatewayChoice }): { provider: string; id: string } {
		return init.gateway?.mode === "prometheus" ? init.gateway.model : { provider: ACP_PROVIDER, id: ACP_DEFAULT_MODEL };
	}

	private onModels = (models: { id: string; name: string; contextWindow?: number }[]): void => {
		this.models = models;
	};

	async create(init: SessionInit): Promise<RuntimeSession> {
		const session = new AcpSession({ id: randomUUID(), cwd: init.cwd, init, services: await this.getServices(), spec: this.spec(), model: this.modelFor(init), history: init.history, onModels: this.onModels });
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
		const session = new AcpSession({ id: ref.id, cwd, init: { ...init, cwd }, services: await this.getServices(), spec: this.spec(), model: this.modelFor(init), sessionId: ref.nativeId, history: init.history, name: ref.name, onModels: this.onModels });
		init.hooks?.created?.(session);
		try {
			await session.start();
		} catch (err) {
			await session.dispose();
			throw err;
		}
		return session;
	}

	/** ACP chats are listed from Prometheus' own session index. */
	async listNative(): Promise<NativeSessionInfo[]> {
		return [];
	}

	async deleteNative(ref: SessionRef): Promise<void> {
		await deleteAcpMirror((await this.getServices()).dataDir, ref.id).catch(() => undefined);
	}

	async collectUsage(days: number): Promise<UsageStats> {
		return { days, sessions: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } as never, byModel: [], byDay: [] };
	}
}
