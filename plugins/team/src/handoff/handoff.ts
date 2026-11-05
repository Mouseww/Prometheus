import { gunzipSync } from "node:zlib";
import type { MemberEnv } from "../member/env.ts";
import type { SessionMirror } from "../member/mirror.ts";
import type { TurnUploader } from "../member/turn-upload.ts";
import type { SyncManager } from "../sync/manager.ts";
import { type SessionMapping, TeamError } from "../types.ts";

/** How long a forced handoff waits for an aborted agent run to settle. */
const ABORT_WAIT_MS = 10_000;

export interface HandoffDeps {
	env: MemberEnv;
	sync: Pick<SyncManager, "publish" | "ensureTarget" | "applyIncoming" | "target">;
	mirror: Pick<SessionMirror, "flush">;
	uploader: Pick<TurnUploader, "uploadTranscript">;
	/** `ctx.stream.publish`: topic `execChanged` tells the UI which side is active now. */
	notify(topic: string, data: unknown): void;
	abortWaitMs?: number;
}

export interface ExportResult {
	snapshotCommit: string;
	nextSeq: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const requireString = (params: Record<string, unknown>, key: string): string => {
	const v = params[key];
	if (typeof v !== "string" || !v) throw new TeamError("invalidParams", `缺少参数 ${key}`);
	return v;
};

const BADGE = {
	team: { text: "此会话在团队 server 执行中", tone: "info" },
	local: { text: "此会话已移回本机执行", tone: "info" },
	active: { text: "团队 server 执行中", tone: "info" },
} as const;

/** The three steps a Hub-driven handoff asks of a side (spec 6): export the session, import it on the other side, retire the source. */
export class Handoff {
	private readonly deps: HandoffDeps;

	constructor(deps: HandoffDeps) {
		this.deps = deps;
	}

	private mappingOf(sessionId: string, hubSessionId: string): SessionMapping {
		const mapping = this.deps.env.state.get().sessions[sessionId];
		if (!mapping || mapping.hubSessionId !== hubSessionId) throw new TeamError("notTeamSession", "这个会话不是该 Hub 会话在本机的映射", 404);
		if (mapping.readOnly) throw new TeamError("sessionReadOnly", "这个会话已经移交到另一端", 409);
		return mapping;
	}

	/**
	 * Source side: stop the agent (or refuse while it runs), push everything the target needs, and report where the event numbering
	 * stands. Nothing is switched yet: a failure anywhere leaves the session exactly where it was.
	 */
	async export(params: Record<string, unknown>): Promise<ExportResult> {
		const { env, sync, mirror, uploader } = this.deps;
		const hubSessionId = requireString(params, "hubSessionId");
		const sessionId = requireString(params, "sessionId");
		const mapping = this.mappingOf(sessionId, hubSessionId);

		if ((await env.host.sessions.info(sessionId))?.running) {
			if (params.force !== true) throw new TeamError("agentBusy", "会话的 Agent 仍在运行，请等它结束，或选择中断后再移交", 409);
			await env.host.sessions.abort(sessionId);
			const end = Date.now() + (this.deps.abortWaitMs ?? ABORT_WAIT_MS);
			while ((await env.host.sessions.info(sessionId))?.running) {
				if (Date.now() > end) throw new TeamError("agentBusy", "中断 Agent 后它仍未停止，请稍后重试", 409);
				await sleep(100);
			}
		}
		await mirror.flush(sessionId);
		await uploader.uploadTranscript(sessionId, mapping);
		const snapshotCommit = await sync.publish(hubSessionId);
		return { snapshotCommit, nextSeq: env.state.get().sessions[sessionId]?.nextSeq ?? 0 };
	}

	/** Target side: get the worktree at the source's snapshot, import the transcript as a new session here and start mirroring it. */
	async import(params: Record<string, unknown>): Promise<{ sessionId: string; serverId: string }> {
		const { env, sync } = this.deps;
		const hubSessionId = requireString(params, "hubSessionId");
		const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : "团队会话";
		const live = Object.values(env.state.get().sessions).find((m) => m.hubSessionId === hubSessionId && !m.readOnly);
		if (live) throw new TeamError("alreadyActive", "这一端已经有该会话的活动副本", 409);

		const copy = await sync.ensureTarget(hubSessionId);
		if (typeof params.snapshotCommit === "string" && params.snapshotCommit) await sync.applyIncoming(hubSessionId, params.snapshotCommit);

		const reply = await env.client.call<{ format: string; content: string } | null>("GET", `/sessions/${encodeURIComponent(hubSessionId)}/transcript`);
		if (!reply) throw new TeamError("noTranscript", "Hub 上还没有该会话的转写，无法导入", 409);
		const content = gunzipSync(Buffer.from(reply.content, "base64")).toString("utf8");
		const workspace = env.state.get().workspaces[copy.workspaceId];
		const workspaceName = workspace ? `${workspace.teamName}/${workspace.workspaceName}: ${title}` : undefined;
		const { sessionId } = await env.host.sessions.importTranscript({ cwd: copy.worktree, content, name: title, ...(workspaceName ? { workspaceName } : {}), runtime: "pi" });

		const lastApplied = sync.target(hubSessionId)?.lastApplied;
		const nextSeq = typeof params.nextSeq === "number" && Number.isInteger(params.nextSeq) && params.nextSeq >= 0 ? params.nextSeq : undefined;
		const mapping: SessionMapping = {
			hubSessionId,
			workspaceId: copy.workspaceId,
			teamId: copy.teamId,
			worktree: copy.worktree,
			branch: copy.branch,
			...(nextSeq !== undefined ? { nextSeq } : {}),
			...(lastApplied ? { lastApplied } : {}),
		};
		await env.state.update((s) => ({ ...s, sessions: { ...s.sessions, [sessionId]: mapping } }));
		if (env.side === "team") await env.host.sessions.setBadge(sessionId, BADGE.active).catch(() => {});
		this.deps.notify("execChanged", { hubSessionId, sessionId, activeSide: env.side, readOnly: false });
		return { sessionId, serverId: env.state.get().serverId };
	}

	/** Source side, after the target took over: this copy only mirrors from now on and refuses prompts. */
	async finish(params: Record<string, unknown>): Promise<Record<string, never>> {
		const { env } = this.deps;
		const hubSessionId = requireString(params, "hubSessionId");
		const sessionId = requireString(params, "sessionId");
		const activeSessionId = requireString(params, "activeSessionId");
		const to = params.to === "team" ? "team" : "local";
		const mapping = env.state.get().sessions[sessionId];
		if (!mapping || mapping.hubSessionId !== hubSessionId) throw new TeamError("notTeamSession", "这个会话不是该 Hub 会话在本机的映射", 404);
		await env.state.update((s) => {
			const current = s.sessions[sessionId];
			return current ? { ...s, sessions: { ...s.sessions, [sessionId]: { ...current, readOnly: { to, activeSessionId } } } } : s;
		});
		await env.host.sessions.setBadge(sessionId, BADGE[to]).catch(() => {});
		this.deps.notify("execChanged", { hubSessionId, sessionId, activeSide: to, activeSessionId, readOnly: true });
		return {};
	}

	/** Dispatches one `cmd` frame of the Hub (`handoff.export`, `handoff.import`, `handoff.finish`). */
	run(cmd: string, params: Record<string, unknown>): Promise<unknown> {
		switch (cmd) {
			case "handoff.export":
				return this.export(params);
			case "handoff.import":
				return this.import(params);
			case "handoff.finish":
				return this.finish(params);
			default:
				return Promise.reject(new TeamError("unknownCommand", `不支持的命令 ${cmd}`));
		}
	}
}
