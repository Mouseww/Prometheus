// ClaudeCodeRuntime: Claude Code through the Claude Agent SDK (docs/agent-runtime.md §12.1).
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppError, type ModelInfo, type UsageStats } from "@prometheus/protocol";
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

export class ClaudeCodeRuntime implements AgentRuntime {
	readonly kind = "claude-code" as const;
	private readonly services: RuntimeServices;

	constructor(services: RuntimeServices) {
		this.services = services;
	}

	async probe(): Promise<RuntimeHealth> {
		try {
			const exe = this.services.executable?.();
			if (exe && !existsSync(exe)) return { available: false, reason: `Claude Code not found at ${exe}` };
			await sdk();
			// Login state is read from the credentials file only; probing never sends a request.
			const loggedIn = existsSync(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json")) || existsSync(join(homedir(), ".claude.json"));
			return { available: true, loggedIn };
		} catch (err) {
			return { available: false, reason: err instanceof Error ? err.message : String(err) };
		}
	}

	async listModels(gateway: GatewayChoice): Promise<ModelInfo[]> {
		if (gateway.mode === "native") return NATIVE_MODELS;
		const g = this.services.gateway(gateway.gatewayId);
		if (!g || g.format !== "anthropic-messages") return [];
		return g.models.map((m) => ({
			provider: g.id,
			id: m.id,
			name: m.name?.trim() || m.id,
			reasoning: m.reasoning ?? false,
			vision: m.vision ?? false,
			contextWindow: m.contextWindow ?? 200_000,
		}));
	}

	private modelFor(init: { gateway?: GatewayChoice }, fallback?: string): { provider: string; id: string } {
		const g = init.gateway;
		if (g?.mode === "prometheus") return g.model;
		return { provider: "claude-code", id: fallback ?? "sonnet" };
	}

	async create(init: SessionInit): Promise<RuntimeSession> {
		const id = randomUUID();
		const session = new ClaudeCodeSession({ id, nativeId: id, cwd: init.cwd, resume: false, init, services: this.services, model: this.modelFor(init), history: [] });
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
			services: this.services,
			model,
			history,
			name: info.customTitle,
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
