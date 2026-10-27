// CodexRuntime: Codex through `codex app-server` (docs/agent-runtime.md §12.2). Prometheus gateway mode only for now.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppError, gatewayAs, type ModelInfo, type UsageStats } from "@prometheus/protocol";
import type { AgentRuntime, GatewayChoice, NativeSessionInfo, ResumeInit, RuntimeHealth, RuntimeServices, RuntimeSession, SessionInit, SessionRef } from "../types.ts";
import { resolveCodexCommand } from "./app-server.ts";
import { CodexSession } from "./codex-session.ts";

const run = promisify(execFile);

export class CodexRuntime implements AgentRuntime {
	readonly kind = "codex" as const;
	private readonly getServices: () => Promise<RuntimeServices>;
	private readonly executable: () => string | undefined;

	constructor(getServices: () => Promise<RuntimeServices>, executable: () => string | undefined = () => undefined) {
		this.getServices = getServices;
		this.executable = executable;
	}

	async probe(): Promise<RuntimeHealth> {
		const { command, args, shell } = resolveCodexCommand(this.executable());
		try {
			const { stdout } = await run(command, [...args.filter((a) => a !== "app-server"), "--version"], { shell, timeout: 15_000, windowsHide: true });
			return { available: true, version: stdout.trim().replace(/^codex-cli\s+/, "") };
		} catch (err) {
			return { available: false, reason: err instanceof Error ? err.message.split("\n")[0] : String(err) };
		}
	}

	async listModels(gateway: GatewayChoice): Promise<ModelInfo[]> {
		if (gateway.mode !== "prometheus") return [];
		const g = (await this.getServices()).gateway(gateway.gatewayId);
		if (!g || !gatewayAs(g, "openai-responses")) return [];
		return g.models.map((m) => ({
			provider: g.id,
			id: m.id,
			name: m.name?.trim() || m.id,
			reasoning: m.reasoning ?? false,
			vision: m.vision ?? false,
			contextWindow: m.contextWindow ?? 200_000,
			thinkingLevels: ["low", "medium", "high"],
		}));
	}

	private modelFor(init: { gateway?: GatewayChoice }): { provider: string; id: string } {
		if (init.gateway?.mode !== "prometheus") throw new AppError("generic");
		return init.gateway.model;
	}

	async create(init: SessionInit): Promise<RuntimeSession> {
		const session = new CodexSession({ id: randomUUID(), cwd: init.cwd, init, services: await this.getServices(), model: this.modelFor(init), history: init.history, executable: this.executable() });
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
		const session = new CodexSession({ id: ref.id, cwd, init: { ...init, cwd }, services: await this.getServices(), model: this.modelFor(init), threadId: ref.nativeId, history: init.history, name: ref.name, executable: this.executable() });
		init.hooks?.created?.(session);
		try {
			await session.start();
		} catch (err) {
			await session.dispose();
			throw err;
		}
		return session;
	}

	/** Prometheus' own session index lists Codex sessions: `thread/list` hides non-interactive threads (§12.2). */
	async listNative(): Promise<NativeSessionInfo[]> {
		return [];
	}

	async deleteNative(ref: SessionRef): Promise<void> {
		const services = await this.getServices();
		await rm(join(services.dataDir, "runtimes", "codex", ref.id), { recursive: true, force: true }).catch(() => {});
	}

	async collectUsage(days: number): Promise<UsageStats> {
		return { days, sessions: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } as never, byModel: [], byDay: [] };
	}
}
