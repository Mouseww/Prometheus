import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { ensureWorkspace, fetchDefault } from "../member/checkout.ts";
import { identityOf, localGit, type MemberEnv } from "../member/env.ts";
import type { HubSocket } from "../member/relay.ts";
import { errorMessage, LOG, type ReplicaMapping, TeamError } from "../types.ts";
import { type ApplyResult, applySnapshot, fetchSnapshot } from "./apply.ts";
import { type ConflictInfo, listConflicts, type RestoreMode, type RestoreResult, restoreConflict } from "./conflicts.ts";
import { publishSnapshot } from "./publish.ts";
import { snapshotRef } from "./refs.ts";
import { currentTree } from "./tree.ts";

/** A snapshot written by one side must be applied by the other within this long before a side switch is aborted (spec 5). */
export const BARRIER_TIMEOUT_MS = 30_000;
const MAX_RECEIPTS = 50;

export type SyncSocket = Pick<HubSocket, "sendFrame" | "onFrame">;

export interface SyncOptions {
	socket: SyncSocket;
	/** Pushes a message to the plugin's stream (`syncConflict`, `snapshotApplied`). */
	notify(topic: string, data: unknown): void;
	barrierMs?: number;
	now?: () => number;
}

/** A worktree that snapshots land in: the session's own, or a replica that only holds the other side's files. */
export interface SyncTarget {
	kind: "session" | "replica";
	/** Key in `state.sessions` (a local session id) or `state.replicas` (the Hub session id). */
	key: string;
	worktree: string;
	branch: string;
	workspaceId: string;
	teamId: string;
	lastApplied?: string;
	readOnly: boolean;
}

interface Waiter {
	hubSessionId: string;
	commit: string;
	resolve(): void;
	reject(err: Error): void;
	timer: NodeJS.Timeout;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const shortId = (): string => randomBytes(5).toString("hex");

/**
 * Single-writer replica sync of one user's team sessions between their local server and their tenant instance (spec 5): the
 * writer publishes snapshots, the other side applies them when its files are unchanged since the last apply (otherwise it
 * saves its own state first), and a barrier makes a side switch wait until the other side confirmed.
 */
export class SyncManager {
	private readonly env: MemberEnv;
	private readonly opts: SyncOptions;
	private readonly chains = new Map<string, Promise<unknown>>();
	private readonly receipts = new Map<string, string[]>();
	private readonly waiters = new Set<Waiter>();
	private readonly off: () => void;

	constructor(env: MemberEnv, opts: SyncOptions) {
		this.env = env;
		this.opts = opts;
		this.off = opts.socket.onFrame((frame) => this.handleFrame(frame));
	}

	dispose(): void {
		this.off();
		for (const w of this.waiters) {
			clearTimeout(w.timer);
			w.reject(new TeamError("syncStopped", "同步已停止"));
		}
		this.waiters.clear();
	}

	/** The worktree for a Hub session on this machine: the live session first, then a retired one, then a replica. */
	target(hubSessionId: string): SyncTarget | undefined {
		const state = this.env.state.get();
		const entries = Object.entries(state.sessions).filter(([, m]) => m.hubSessionId === hubSessionId);
		const pick = entries.find(([, m]) => !m.readOnly) ?? entries[0];
		if (pick) return { kind: "session", key: pick[0], worktree: pick[1].worktree, branch: pick[1].branch, workspaceId: pick[1].workspaceId, teamId: pick[1].teamId, lastApplied: pick[1].lastApplied, readOnly: Boolean(pick[1].readOnly) };
		const replica = state.replicas?.[hubSessionId];
		if (!replica) return undefined;
		return { kind: "replica", key: hubSessionId, worktree: replica.worktree, branch: replica.branch, workspaceId: replica.workspaceId, teamId: replica.teamId, lastApplied: replica.lastApplied, readOnly: false };
	}

	private async setLastApplied(target: SyncTarget, tree: string): Promise<void> {
		await this.env.state.update((s) => {
			if (target.kind === "session") {
				const current = s.sessions[target.key];
				return current ? { ...s, sessions: { ...s.sessions, [target.key]: { ...current, lastApplied: tree } } } : s;
			}
			const current = s.replicas?.[target.key];
			return current ? { ...s, replicas: { ...s.replicas, [target.key]: { ...current, lastApplied: tree } } } : s;
		});
	}

	/** Runs `job` after everything queued for the same session (publishes and applies never overlap on one worktree). */
	private queue<T>(hubSessionId: string, job: () => Promise<T>): Promise<T> {
		const run = (this.chains.get(hubSessionId) ?? Promise.resolve()).catch(() => {}).then(job);
		this.chains.set(hubSessionId, run);
		return run;
	}

	/** Resolves when every publish and apply queued so far for the session has finished. */
	async settle(hubSessionId: string): Promise<void> {
		await (this.chains.get(hubSessionId) ?? Promise.resolve()).catch(() => {});
	}

	/** Writer side: snapshot, push, tell the other side. Resolves with the snapshot commit. */
	publish(hubSessionId: string): Promise<string> {
		return this.queue(hubSessionId, async () => {
			const target = this.target(hubSessionId);
			if (!target) throw new TeamError("notTeamSession", "这台机器上没有该会话的工作副本", 404);
			const { commit, tree } = await publishSnapshot(this.env, target.worktree, hubSessionId);
			await this.setLastApplied(target, tree);
			this.opts.socket.sendFrame({ type: "snapshot.updated", hubSessionId, side: this.env.side, commit });
			return commit;
		});
	}

	/** Publishes and waits for the other side's `snapshot.applied` receipt; throws `barrierTimeout` after 30 s (nothing is switched then). */
	async barrier(hubSessionId: string): Promise<string> {
		const commit = await this.publish(hubSessionId);
		await this.awaitApplied(hubSessionId, commit);
		return commit;
	}

	/**
	 * Like `barrier`, but does nothing while the files are exactly what the last publish or apply left (the other side already has them).
	 * Resolves with the snapshot commit, or undefined when no barrier was needed.
	 */
	async barrierIfDirty(hubSessionId: string): Promise<string | undefined> {
		await this.settle(hubSessionId);
		const target = this.target(hubSessionId);
		if (!target) throw new TeamError("notTeamSession", "这台机器上没有该会话的工作副本", 404);
		if (target.lastApplied !== undefined && (await currentTree(target.worktree, identityOf(this.env))) === target.lastApplied) return undefined;
		return this.barrier(hubSessionId);
	}

	awaitApplied(hubSessionId: string, commit: string): Promise<void> {
		if (this.receipts.get(hubSessionId)?.includes(commit)) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new TeamError("barrierTimeout", "对端没有在 30 秒内确认已应用最新文件快照，已中止切换。请确认另一端在线后重试", 504));
			}, this.opts.barrierMs ?? BARRIER_TIMEOUT_MS);
			timer.unref();
			const waiter: Waiter = { hubSessionId, commit, resolve, reject, timer };
			this.waiters.add(waiter);
		});
	}

	private recordReceipt(hubSessionId: string, commit: string): void {
		const list = [...(this.receipts.get(hubSessionId) ?? []), commit].slice(-MAX_RECEIPTS);
		this.receipts.set(hubSessionId, list);
		for (const w of [...this.waiters]) {
			if (w.hubSessionId !== hubSessionId || w.commit !== commit) continue;
			clearTimeout(w.timer);
			this.waiters.delete(w);
			w.resolve();
		}
	}

	/** Frames from the Hub: `snapshot.updated` (apply it) and `snapshot.applied` (a receipt for a barrier). */
	handleFrame(frame: Record<string, unknown>): boolean {
		if (frame.type !== "snapshot.updated" && frame.type !== "snapshot.applied") return false;
		const { hubSessionId, commit, side } = frame;
		if (typeof hubSessionId !== "string" || typeof commit !== "string" || side === this.env.side) return true;
		if (frame.type === "snapshot.applied") {
			this.recordReceipt(hubSessionId, commit);
			return true;
		}
		void this.applyIncoming(hubSessionId, commit).catch((err: unknown) => this.env.log.warn(`${LOG} 应用对端快照失败 (${hubSessionId}): ${errorMessage(err)}`));
		return true;
	}

	/** Reader side: make the files match the writer's snapshot, then confirm. */
	applyIncoming(hubSessionId: string, commit: string): Promise<ApplyResult> {
		return this.queue(hubSessionId, async () => {
			const target = this.target(hubSessionId) ?? (await this.ensureReplica(hubSessionId));
			const result = await applySnapshot(this.env, target, hubSessionId, commit, this.opts.now);
			await this.setLastApplied(target, result.tree);
			this.opts.socket.sendFrame({ type: "snapshot.applied", hubSessionId, side: this.env.side, commit, ...(result.conflictRef ? { conflictRef: result.conflictRef } : {}) });
			this.opts.notify("snapshotApplied", { hubSessionId, commit, status: result.status });
			if (result.status === "conflict") {
				this.opts.notify("syncConflict", { hubSessionId, conflictRef: result.conflictRef, conflictCommit: result.conflictCommit, worktree: target.worktree, message: "你的本地改动已另存，未丢失" });
			}
			return result;
		});
	}

	/**
	 * A worktree for a session this machine has no copy of yet (the other side started or moved it): cloned from the team repository
	 * at the snapshot, on a branch of its own so it cannot clash with a branch a session here already uses.
	 */
	private async ensureReplica(hubSessionId: string): Promise<SyncTarget> {
		const session = await this.env.client.call<{ id: string; workspaceId: string; branch: string }>("GET", `/sessions/${encodeURIComponent(hubSessionId)}`);
		const workspace = await ensureWorkspace(this.env, session.workspaceId);
		await fetchDefault(this.env, workspace);
		await fetchSnapshot(this.env, workspace.repoDir, hubSessionId);
		const ref = snapshotRef(this.env.state.get().userId as string, hubSessionId);
		const start = await localGit(this.env, ["rev-parse", "--verify", ref], workspace.repoDir);
		const worktree = join(dirname(workspace.repoDir), "sessions", `replica-${shortId()}`);
		await localGit(this.env, ["worktree", "add", "--no-track", "-b", `replica/${hubSessionId}-${shortId()}`, worktree, start], workspace.repoDir);
		const replica: ReplicaMapping = { hubSessionId, workspaceId: session.workspaceId, teamId: workspace.teamId ?? "", worktree, branch: session.branch };
		await this.env.state.update((s) => ({ ...s, replicas: { ...s.replicas, [hubSessionId]: replica } }));
		const created = this.target(hubSessionId);
		if (!created) throw new TeamError("syncFailed", "创建对端会话的工作副本失败", 500);
		return created;
	}

	/** Conflict snapshots saved on this machine for the session (RPC `sync.conflicts`), newest first. */
	async conflicts(hubSessionId: string): Promise<ConflictInfo[]> {
		await this.settle(hubSessionId);
		const target = this.target(hubSessionId);
		if (!target) throw new TeamError("notTeamSession", "这台机器上没有该会话的工作副本", 404);
		return listConflicts(this.env, target.worktree, hubSessionId);
	}

	/** Restores a saved conflict without overwriting anything (RPC `sync.restoreConflict`); runs after queued publishes and applies, never between them. */
	restoreConflict(hubSessionId: string, conflictRef: string, mode?: RestoreMode): Promise<RestoreResult> {
		return this.queue(hubSessionId, async () => {
			const target = this.target(hubSessionId);
			if (!target) throw new TeamError("notTeamSession", "这台机器上没有该会话的工作副本", 404);
			const result = await restoreConflict(this.env, target, hubSessionId, conflictRef, mode, this.opts.now);
			this.opts.notify("conflictRestored", { hubSessionId, ...result });
			return result;
		});
	}

	/** Makes sure this machine has a worktree for the session (used by the handoff import), at `commit` when it has to be created. */
	async ensureTarget(hubSessionId: string): Promise<SyncTarget> {
		return this.target(hubSessionId) ?? (await this.queue(hubSessionId, async () => this.target(hubSessionId) ?? this.ensureReplica(hubSessionId)));
	}
}
