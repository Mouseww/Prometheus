// OpenCodeRuntime: opencode through `opencode serve` (docs/agent-runtime.md §12.3).
// Its own login and configuration (`opencode auth login`, opencode.json) work as they are; a Prometheus gateway is
// offered to it as a custom provider behind the local relay.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { type GatewayConfig, type ModelInfo, pickGatewayFormat, type UsageStats } from "@prometheus/protocol";
import type { AgentRuntime, GatewayChoice, NativeSessionInfo, ResumeInit, RuntimeHealth, RuntimeServices, RuntimeSession, SessionInit, SessionRef } from "../types.ts";
import { DEFAULT_MODEL, OPENCODE_FORMATS, OpenCodeSession } from "./opencode-session.ts";
import { resolveOpenCodeCommand } from "./opencode-server.ts";

const run = promisify(execFile);

const DEFAULT_ENTRY: ModelInfo = { provider: "opencode", id: DEFAULT_MODEL, name: "OpenCode (configured default)", reasoning: true, vision: true, contextWindow: 200_000 };

export class OpenCodeRuntime implements AgentRuntime {
	readonly kind = "opencode" as const;
	private readonly getServices: () => Promise<RuntimeServices>;
	private readonly executable: () => string | undefined;
	private readonly env: () => Record<string, string>;
	private nativeModels: { at: number; models: ModelInfo[] } | undefined;

	constructor(getServices: () => Promise<RuntimeServices>, executable: () => string | undefined = () => undefined, env: () => Record<string, string> = () => ({})) {
		this.getServices = getServices;
		this.executable = executable;
		this.env = env;
	}

	private async cli(args: string[], timeout = 15_000): Promise<string> {
		const { command, args: base, shell } = resolveOpenCodeCommand(this.executable());
		const { stdout } = await run(command, [...base, ...args], { shell, timeout, windowsHide: true, env: { ...process.env, ...this.env() } });
		return stdout;
	}

	async probe(): Promise<RuntimeHealth> {
		try {
			return { available: true, version: (await this.cli(["--version"])).trim() };
		} catch (err) {
			return { available: false, reason: err instanceof Error ? err.message.split("\n")[0] : String(err) };
		}
	}

	/** The models the user's own opencode configuration offers (`opencode models`), after the "configured default" entry. */
	private async native(): Promise<ModelInfo[]> {
		if (this.nativeModels && Date.now() - this.nativeModels.at < 60_000) return this.nativeModels.models;
		const models: ModelInfo[] = [DEFAULT_ENTRY];
		try {
			for (const line of (await this.cli(["models"], 30_000)).split(/\r?\n/)) {
				const id = line.trim();
				if (!/^[\w.-]+\/\S+$/.test(id)) continue;
				models.push({ provider: "opencode", id, name: id, reasoning: true, vision: true, contextWindow: 200_000 });
			}
		} catch {
			/* only the default entry */
		}
		this.nativeModels = { at: Date.now(), models };
		return models;
	}

	private fromGateway(g: GatewayConfig): ModelInfo[] {
		return g.models.map((m) => ({ provider: g.id, id: m.id, name: m.name?.trim() || m.id, reasoning: m.reasoning ?? false, vision: m.vision ?? false, contextWindow: m.contextWindow ?? 200_000 }));
	}

	async listAllModels(gateways: GatewayConfig[]): Promise<ModelInfo[]> {
		const out = [...(await this.native())];
		for (const g of gateways) {
			if (g.enabled === false || !pickGatewayFormat(g, OPENCODE_FORMATS)) continue;
			out.push(...this.fromGateway(g));
		}
		return out;
	}

	async listModels(gateway: GatewayChoice): Promise<ModelInfo[]> {
		if (gateway.mode !== "prometheus") return this.native();
		const g = (await this.getServices()).gateway(gateway.gatewayId);
		return g && pickGatewayFormat(g, OPENCODE_FORMATS) ? this.fromGateway(g) : [];
	}

	private modelFor(init: { gateway?: GatewayChoice }): { provider: string; id: string } {
		return init.gateway?.mode === "prometheus" ? init.gateway.model : { provider: "opencode", id: DEFAULT_MODEL };
	}

	async create(init: SessionInit): Promise<RuntimeSession> {
		const session = new OpenCodeSession({ id: randomUUID(), cwd: init.cwd, init, services: await this.getServices(), model: this.modelFor(init), history: init.history, executable: this.executable(), env: this.env() });
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
		const session = new OpenCodeSession({ id: ref.id, cwd, init: { ...init, cwd }, services: await this.getServices(), model: this.modelFor(init), sessionId: ref.nativeId, history: init.history, name: ref.name, executable: this.executable(), env: this.env() });
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
		await this.cli(["session", "delete", ref.nativeId], 30_000).catch(() => undefined);
	}

	async collectUsage(days: number): Promise<UsageStats> {
		return { days, sessions: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } as never, byModel: [], byDay: [] };
	}
}
