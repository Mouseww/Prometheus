import type { HubLog } from "../log.ts";
import { LOG_PREFIX } from "../log.ts";
import type { WorkspaceRecord, WorkspacesService } from "../services/workspaces.ts";
import { runGit } from "./exec.ts";
import type { TeamNotifier } from "./notify.ts";
import { isAncestor, resolveCommit, updateRefCas } from "./repo.ts";
import type { GitRuntime } from "./runtime.ts";

export const UPSTREAM_POLL_INTERVAL_MS = 5 * 60 * 1000;

const ADMIN_ROLES = ["admin"] as const;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/** Full detail for the server log only: git's own message plus its stderr (never shown to the team, it can echo URLs and server paths). */
const detailOf = (err: unknown): string => {
	const stderr = (err as { stderr?: unknown } | undefined)?.stderr;
	return `${messageOf(err)}${typeof stderr === "string" && stderr ? ` | stderr: ${stderr.slice(0, 2000)}` : ""}`;
};

/** What the team sees in the workspace status and notifications. */
export const UPSTREAM_PUSH_FAILED_MESSAGE = "推送到上游失败，请检查上游地址与访问令牌";
export const UPSTREAM_FETCH_FAILED_MESSAGE = "拉取上游失败，请检查上游地址与访问令牌";

export type SyncResult = "unchanged" | "fastForwarded" | "localAhead" | "diverged" | "noUpstreamBranch" | "failed" | "skipped";

export interface UpstreamSync {
	/** Pushes the default branch to the upstream after a merge. Failures are logged and recorded, never thrown. */
	pushAfterMerge(ws: WorkspaceRecord): Promise<void>;
	/** Fetches the upstream default branch; fast-forwards the Hub copy when the upstream is ahead, flags divergence otherwise. */
	syncOne(ws: WorkspaceRecord): Promise<SyncResult>;
	syncAll(): Promise<void>;
}

export function createUpstreamSync(deps: { log: HubLog; workspaces: WorkspacesService; runtime: GitRuntime; notifier: TeamNotifier }): UpstreamSync {
	const { log, workspaces, runtime, notifier } = deps;
	const running = new Set<string>();

	const notifyAdmins = async (ws: WorkspaceRecord, kind: string, error: string | null): Promise<void> => {
		const admins = await notifier.teamUsers(ws.teamId, ADMIN_ROLES);
		await notifier.send(ws.orgId, admins, kind, { workspaceId: ws.id, workspaceName: ws.name, error });
	};

	const self: UpstreamSync = {
		async pushAfterMerge(ws) {
			if (!ws.upstreamUrl) return;
			const gitDir = runtime.repoPath(ws.repoDir);
			try {
				const token = await workspaces.upstreamToken(ws.id);
				const ref = `refs/heads/${ws.defaultBranch}`;
				await runGit(["push", "--quiet", "--", ws.upstreamUrl, `${ref}:${ref}`], { gitDir, env: runtime.networkEnv(token), timeoutMs: 5 * 60 * 1000 });
				await workspaces.recordUpstream(ws.id, "ok", null);
			} catch (err) {
				log.warn(`${LOG_PREFIX} 推送到上游失败 (工作区 ${ws.id}): ${detailOf(err)}`);
				await workspaces.recordUpstream(ws.id, "push_failed", UPSTREAM_PUSH_FAILED_MESSAGE).catch(() => {});
				await notifyAdmins(ws, "upstream.pushFailed", UPSTREAM_PUSH_FAILED_MESSAGE);
			}
		},

		async syncOne(ws) {
			if (!ws.upstreamUrl || running.has(ws.id)) return "skipped";
			running.add(ws.id);
			const gitDir = runtime.repoPath(ws.repoDir);
			const branch = ws.defaultBranch;
			const upstreamRef = `refs/prometheus/upstream/${branch}`;
			try {
				const token = await workspaces.upstreamToken(ws.id);
				try {
					await runGit(["fetch", "--quiet", "--", ws.upstreamUrl, `+refs/heads/${branch}:${upstreamRef}`], { gitDir, env: runtime.networkEnv(token), timeoutMs: 5 * 60 * 1000 });
				} catch (err) {
					if (/couldn't find remote ref/i.test(messageOf(err)) || /couldn't find remote ref/i.test((err as { stderr?: string }).stderr ?? "")) {
						await workspaces.recordUpstream(ws.id, "ok", null);
						return "noUpstreamBranch";
					}
					throw err;
				}
				const upstream = await resolveCommit(gitDir, upstreamRef);
				const local = await resolveCommit(gitDir, `refs/heads/${branch}`);
				if (!upstream) return "noUpstreamBranch";
				if (local === upstream) {
					await workspaces.recordUpstream(ws.id, "ok", null);
					return "unchanged";
				}
				if (!local) {
					if (await updateRefCas(gitDir, `refs/heads/${branch}`, upstream, undefined)) {
						await workspaces.recordUpstream(ws.id, "ok", null);
						return "fastForwarded";
					}
					return "failed";
				}
				if (await isAncestor(gitDir, upstream, local)) {
					await workspaces.recordUpstream(ws.id, "ok", null);
					return "localAhead";
				}
				if (await isAncestor(gitDir, local, upstream)) {
					if (await updateRefCas(gitDir, `refs/heads/${branch}`, upstream, local)) {
						await workspaces.recordUpstream(ws.id, "ok", null);
						log.info(`${LOG_PREFIX} 工作区 ${ws.id} 已从上游快进更新`);
						return "fastForwarded";
					}
					return "failed";
				}
				const message = "上游默认分支与 Hub 主副本已分叉，需要管理员手动处理";
				log.warn(`${LOG_PREFIX} 工作区 ${ws.id}: ${message}`);
				if (ws.upstreamStatus !== "upstream_diverged") await notifyAdmins(ws, "upstream.diverged", message);
				await workspaces.recordUpstream(ws.id, "upstream_diverged", message);
				return "diverged";
			} catch (err) {
				log.warn(`${LOG_PREFIX} 拉取上游失败 (工作区 ${ws.id}): ${detailOf(err)}`);
				await workspaces.recordUpstream(ws.id, "fetch_failed", UPSTREAM_FETCH_FAILED_MESSAGE).catch(() => {});
				return "failed";
			} finally {
				running.delete(ws.id);
			}
		},

		async syncAll() {
			const caps = await runtime.caps;
			if (!caps.available) return;
			for (const ws of await workspaces.listWithUpstream()) await self.syncOne(ws);
		},
	};
	return self;
}
