// ClaudeCodeRuntime: Claude Code through the Claude Agent SDK (docs/agent-runtime.md §12.1).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AppError, gatewayAs, type GatewayConfig, type ModelInfo, type UsageStats } from "@prometheus/protocol";
import type { AgentRuntime, GatewayChoice, NativeSessionInfo, ResumeInit, RuntimeHealth, RuntimeServices, RuntimeSession, SessionInit, SessionRef } from "../types.ts";
import { ClaudeCodeSession } from "./cc-session.ts";
import { transcriptToMessages } from "./transcript.ts";

/** Aliases Claude Code resolves itself when it uses its own login. */
const NATIVE_MODELS: ModelInfo[] = [
	{ provider: "claude-code", id: "sonnet", name: "Claude Sonnet", reasoning: true, vision: true, contextWindow: 200_000 },
	{ provider: "claude-code", id: "opus", name: "Claude Opus", reasoning: true, vision: true, contextWindow: 200_000 },
	{ provider: "claude-code", id: "haiku", name: "Claude Haiku", reasoning: false, vision: true, contextWindow: 200_000 },
];

async function sdk() {
	return import("@anthropic-ai/claude-agent-sdk");
}

let hasBundledBinary: boolean | undefined;
/**
 * Whether the Agent SDK ships a Claude Code binary for this platform. The desktop installer leaves them out (about
 * 280 MB); Claude Code is then installed from the settings page the first time it is used.
 */
export function bundledClaudeBinary(): boolean {
	if (hasBundledBinary !== undefined) return hasBundledBinary;
	const require = createRequire(import.meta.url);
	const names = process.platform === "linux" ? [`${process.arch}`, `${process.arch}-musl`] : [process.arch];
	hasBundledBinary = names.some((n) => {
		try {
			require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${n}/package.json`);
			return true;
		} catch {
			return false;
		}
	});
	return hasBundledBinary;
}

let bundled: string | null | undefined;
/** Version of the Claude Code CLI bundled with the Agent SDK: what runs when no other executable is chosen. */
export function bundledClaudeVersion(): string | undefined {
	if (bundled !== undefined) return bundled ?? undefined;
	bundled = null;
	if (!bundledClaudeBinary()) return undefined;
	try {
		let dir = dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
		for (let i = 0; i < 4; i++) {
			const file = join(dir, "package.json");
			if (existsSync(file)) {
				const json = JSON.parse(readFileSync(file, "utf8"));
				if (json.name === "@anthropic-ai/claude-agent-sdk") {
					bundled = typeof json.claudeCodeVersion === "string" ? json.claudeCodeVersion : null;
					break;
				}
			}
			dir = dirname(dir);
		}
	} catch {
		/* unknown */
	}
	return bundled ?? undefined;
}

export class ClaudeCodeRuntime implements AgentRuntime {
	readonly kind = "claude-code" as const;
	private readonly getServices: () => Promise<RuntimeServices>;
	private readonly executable: () => string | undefined;
	private readonly env: () => Record<string, string>;
	private readonly version: () => string | undefined;

	/**
	 * Services start lazily: listing runtimes must not open the tool bus and relay. `version` is the version of the
	 * chosen executable when the host knows it (a copy Prometheus installed); without an executable it is the SDK's own.
	 */
	constructor(getServices: () => Promise<RuntimeServices>, executable: () => string | undefined = () => undefined, env: () => Record<string, string> = () => ({}), version: () => string | undefined = () => undefined) {
		this.getServices = getServices;
		this.executable = executable;
		this.env = env;
		this.version = version;
	}

	async probe(): Promise<RuntimeHealth> {
		try {
			const exe = this.executable();
			if (exe && !existsSync(exe)) return { available: false, reason: `Claude Code not found at ${exe}` };
			await sdk();
			if (!exe && !bundledClaudeBinary()) return { available: false, reason: "Claude Code is not installed" };
			// Login state is read from the credentials file only; probing never sends a request.
			const loggedIn = existsSync(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json")) || existsSync(join(homedir(), ".claude.json"));
			const version = exe ? this.version() : bundledClaudeVersion();
			return { available: true, loggedIn, ...(version ? { version } : {}) };
		} catch (err) {
			return { available: false, reason: err instanceof Error ? err.message : String(err) };
		}
	}

	async listModels(gateway: GatewayChoice): Promise<ModelInfo[]> {
		if (gateway.mode === "native") return NATIVE_MODELS;
		const g = (await this.getServices()).gateway(gateway.gatewayId);
		if (!g || !gatewayAs(g, "anthropic-messages")) return [];
		return g.models.map((m) => ({
			provider: g.id,
			id: m.id,
			name: m.name?.trim() || m.id,
			reasoning: m.reasoning ?? false,
			vision: m.vision ?? false,
			contextWindow: m.contextWindow ?? 200_000,
		}));
	}

	async listAllModels(gateways: GatewayConfig[]): Promise<ModelInfo[]> {
		const out = [...NATIVE_MODELS];
		for (const g of gateways) {
			if (g.enabled === false || !gatewayAs(g, "anthropic-messages")) continue;
			for (const m of g.models) out.push({ provider: g.id, id: m.id, name: m.name?.trim() || m.id, reasoning: m.reasoning ?? false, vision: m.vision ?? false, contextWindow: m.contextWindow ?? 200_000 });
		}
		return out;
	}

	private modelFor(init: { gateway?: GatewayChoice }, fallback?: string): { provider: string; id: string } {
		const g = init.gateway;
		if (g?.mode === "prometheus") return g.model;
		return { provider: "claude-code", id: fallback ?? "sonnet" };
	}

	async create(init: SessionInit): Promise<RuntimeSession> {
		const id = randomUUID();
		const session = new ClaudeCodeSession({ id, nativeId: id, cwd: init.cwd, resume: false, init, services: await this.getServices(), model: this.modelFor(init), history: init.history ?? [], executable: this.executable(), env: this.env() });
		init.hooks?.created?.(session);
		return session;
	}

	async resume(ref: SessionRef, init: ResumeInit): Promise<RuntimeSession> {
		const { getSessionMessages, getSessionInfo } = await sdk();
		const info = await getSessionInfo(ref.nativeId);
		if (!info) throw new AppError("sessionNotFound", { id: ref.id });
		const model = this.modelFor(init);
		const history = transcriptToMessages((await getSessionMessages(ref.nativeId)) as never, model.provider);
		const session = new ClaudeCodeSession({
			id: ref.id,
			nativeId: ref.nativeId,
			cwd: info.cwd ?? process.cwd(),
			resume: true,
			init: { ...init, cwd: info.cwd ?? process.cwd() },
			services: await this.getServices(),
			model,
			history: [...(init.history ?? []), ...history],
			name: info.customTitle,
			executable: this.executable(),
			env: this.env(),
		});
		init.hooks?.created?.(session);
		return session;
	}

	async listNative(): Promise<NativeSessionInfo[]> {
		const { listSessions } = await sdk();
		const sessions = await listSessions();
		return sessions.map((s) => ({
			ref: { runtime: "claude-code" as const, id: s.sessionId, nativeId: s.sessionId },
			name: s.customTitle,
			cwd: s.cwd ?? "",
			created: new Date(s.createdAt ?? s.lastModified).toISOString(),
			modified: new Date(s.lastModified).toISOString(),
			messageCount: 0,
			firstMessage: s.firstPrompt ?? s.summary ?? "",
		}));
	}

	async deleteNative(ref: SessionRef): Promise<void> {
		const { deleteSession } = await sdk();
		await deleteSession(ref.nativeId);
	}

	async collectUsage(days: number): Promise<UsageStats> {
		return { days, sessions: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } as never, byModel: [], byDay: [] };
	}
}
