import { rm } from "node:fs/promises";
import { isUniqueViolation, toIso } from "../db/db.ts";
import type { Queryable } from "../db/db.ts";
import type { SecretBox } from "../crypto.ts";
import { badRequest, conflict, forbidden, HubError, notFound, validationError } from "../errors.ts";
import { cloneBare, initBare, lookupPath, readBlob, resolveCommit } from "../git/repo.ts";
import type { GitRuntime } from "../git/runtime.ts";
import { assertSafeRemoteUrl } from "../git/url-safety.ts";
import { ulid } from "../ids.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { AuditService } from "./audit.ts";
import { type ServiceDeps, scopeOf } from "./common.ts";
import type { TeamsService } from "./teams.ts";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export type UpstreamStatus = "ok" | "push_failed" | "fetch_failed" | "upstream_diverged";

export interface WorkspaceRecord {
	id: string;
	teamId: string;
	orgId: string | null;
	name: string;
	repoDir: string;
	defaultBranch: string;
	dailyReportTime: string;
	dailyReportTz: string;
	dailyReportEnabled: boolean;
	upstreamUrl: string | null;
	upstreamStatus: UpstreamStatus | null;
	upstreamError: string | null;
	upstreamCheckedAt: string | null;
	hasUpstreamToken: boolean;
	createdAt: string;
}

/** What the API returns: the record without the on-disk location. */
export type WorkspaceView = Omit<WorkspaceRecord, "repoDir">;

export interface CreateWorkspaceInput {
	name: string;
	importUrl?: string;
	upstreamUrl?: string;
	upstreamToken?: string;
}

export interface UpdateWorkspaceInput {
	name?: string;
	dailyReportTime?: string;
	dailyReportTz?: string;
	dailyReportEnabled?: boolean;
	/** null removes the upstream. */
	upstreamUrl?: string | null;
	/** null removes the stored token. */
	upstreamToken?: string | null;
}

export type FileListing =
	| { type: "dir"; ref: string; commit: string; path: string; entries: { name: string; type: "file" | "dir" | "submodule"; size: number | null }[] }
	| { type: "file"; ref: string; commit: string; path: string; size: number; binary: boolean; encoding: "base64"; content: string };

export interface WorkspacesService {
	listForTeam(actor: Actor, teamId: string): Promise<WorkspaceView[]>;
	create(actor: Actor, teamId: string, input: CreateWorkspaceInput): Promise<WorkspaceView>;
	get(actor: Actor, id: string): Promise<WorkspaceView>;
	update(actor: Actor, id: string, patch: UpdateWorkspaceInput): Promise<WorkspaceView>;
	/** Loads a workspace visible to the actor (RLS and team membership); 404 otherwise. Reusable by other blocks. */
	require(q: Queryable, actor: Actor, id: string): Promise<WorkspaceRecord>;
	/** Loads without authorization (git auth, schedulers). */
	loadSystem(id: string): Promise<WorkspaceRecord | undefined>;
	/** Workspaces that have an upstream configured (for the poller). */
	listWithUpstream(): Promise<WorkspaceRecord[]>;
	upstreamToken(id: string): Promise<string | undefined>;
	recordUpstream(id: string, status: UpstreamStatus, error: string | null): Promise<void>;
	repoPath(ws: Pick<WorkspaceRecord, "repoDir">): string;
	browse(actor: Actor, id: string, ref: string | undefined, path: string | undefined): Promise<FileListing>;
}

interface WorkspaceRow {
	id: string;
	team_id: string;
	org_id: string | null;
	name: string;
	repo_dir: string;
	default_branch: string;
	daily_report_time: string;
	daily_report_tz: string;
	daily_report_enabled: boolean;
	upstream_url: string | null;
	upstream_token_enc: string | null;
	upstream_status: UpstreamStatus | null;
	upstream_error: string | null;
	upstream_checked_at: Date | string | null;
	created_at: Date | string;
}

const COLUMNS =
	"id, team_id, org_id, name, repo_dir, default_branch, daily_report_time, daily_report_tz, daily_report_enabled, upstream_url, upstream_token_enc, upstream_status, upstream_error, upstream_checked_at, created_at";

const toRecord = (r: WorkspaceRow): WorkspaceRecord => ({
	id: r.id,
	teamId: r.team_id,
	orgId: r.org_id,
	name: r.name,
	repoDir: r.repo_dir,
	defaultBranch: r.default_branch,
	dailyReportTime: r.daily_report_time,
	dailyReportTz: r.daily_report_tz,
	dailyReportEnabled: r.daily_report_enabled,
	upstreamUrl: r.upstream_url,
	upstreamStatus: r.upstream_status,
	upstreamError: r.upstream_error,
	upstreamCheckedAt: toIso(r.upstream_checked_at),
	hasUpstreamToken: r.upstream_token_enc !== null,
	createdAt: toIso(r.created_at) as string,
});

const toView = ({ repoDir: _repoDir, ...rest }: WorkspaceRecord): WorkspaceView => rest;

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

function assertTimeZone(tz: string): void {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
	} catch {
		throw validationError("时区无效，应为 IANA 时区名，如 Asia/Shanghai");
	}
}

/** Ref names a client may browse: no option-like or traversal forms. */
const SAFE_REF = /^[A-Za-z0-9._@{}/+-]{1,200}$/;

function cleanPath(path: string | undefined): string {
	const p = (path ?? "").replace(/^\/+|\/+$/g, "");
	if (p === "") return "";
	if (p.includes("\0") || p.includes("\\") || p.split("/").some((s) => s === ".." || s === "." || s === "")) throw badRequest("路径无效", "invalidPath");
	return p;
}

export function createWorkspacesService(deps: ServiceDeps, audit: AuditService, teams: TeamsService, runtime: GitRuntime, secretBox: SecretBox): WorkspacesService {
	const remoteOpts = { allowLocal: runtime.allowLocalRemotes };

	const requireWorkspace = async (q: Queryable, actor: Actor, id: string): Promise<WorkspaceRecord> => {
		const rows = await q.query<WorkspaceRow>(`SELECT ${COLUMNS} FROM workspaces WHERE id = $1`, [id]);
		const ws = rows[0] ? toRecord(rows[0]) : undefined;
		if (!ws) throw notFound("工作区不存在");
		// Reuses the team lookup so outsiders get the same 404 as for a missing workspace.
		await teams.require(q, actor, ws.teamId).catch(() => {
			throw notFound("工作区不存在");
		});
		return ws;
	};

	const readOne = async (q: Queryable, id: string): Promise<WorkspaceRecord> => {
		const rows = await q.query<WorkspaceRow>(`SELECT ${COLUMNS} FROM workspaces WHERE id = $1`, [id]);
		if (!rows[0]) throw notFound("工作区不存在");
		return toRecord(rows[0]);
	};

	return {
		async listForTeam(actor, teamId) {
			return deps.db.tx(scopeOf(actor), async (q) => {
				const team = await teams.require(q, actor, teamId);
				if (!can(actor, "team.view", { teamId, orgId: team.orgId })) throw forbidden();
				const rows = await q.query<WorkspaceRow>(`SELECT ${COLUMNS} FROM workspaces WHERE team_id = $1 ORDER BY created_at, id`, [teamId]);
				return rows.map((r) => toView(toRecord(r)));
			});
		},

		async create(actor, teamId, input) {
			const team = await deps.db.tx(scopeOf(actor), (q) => teams.require(q, actor, teamId));
			if (!can(actor, "workspace.create", { teamId, orgId: team.orgId })) throw forbidden();
			if (input.upstreamToken && !input.upstreamUrl) throw validationError("设置 upstreamToken 需要同时提供 upstreamUrl");
			await runtime.requireGit();
			if (input.importUrl) await assertSafeRemoteUrl(input.importUrl, remoteOpts);
			if (input.upstreamUrl) await assertSafeRemoteUrl(input.upstreamUrl, { ...remoteOpts, httpsOnly: true });

			const id = ulid(deps.now());
			const repoDir = `repos/${id}.git`;
			const gitDir = runtime.repoPath(repoDir);
			let defaultBranch = "main";
			if (input.importUrl) {
				try {
					defaultBranch = await cloneBare(input.importUrl, gitDir, runtime.networkEnv());
				} catch (err) {
					deps.log.warn(`[prometheus-hub] 导入仓库失败: ${err instanceof Error ? err.message : String(err)}`);
					throw badRequest("无法从该地址导入仓库，请检查地址与访问权限", "importFailed");
				}
			} else {
				await initBare(gitDir, defaultBranch);
			}
			try {
				return await deps.db
					.tx(scopeOf(actor), async (q) => {
						await q.query(
							`INSERT INTO workspaces (id, team_id, org_id, name, repo_dir, default_branch, upstream_url, upstream_token_enc)
							 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
							[id, teamId, team.orgId, input.name, repoDir, defaultBranch, input.upstreamUrl ?? null, input.upstreamToken ? secretBox.seal(input.upstreamToken) : null],
						);
						await audit.write(q, {
							actorId: actor.userId,
							orgId: team.orgId,
							action: "workspace.create",
							targetType: "workspace",
							targetId: id,
							detail: { teamId, name: input.name, imported: input.importUrl !== undefined, upstream: input.upstreamUrl !== undefined },
						});
						return toView(await readOne(q, id));
					})
					.catch((err: unknown) => {
						if (isUniqueViolation(err)) throw conflict("该团队下已有同名工作区", "workspaceNameTaken");
						throw err;
					});
			} catch (err) {
				await rm(gitDir, { recursive: true, force: true }).catch(() => {});
				throw err;
			}
		},

		async get(actor, id) {
			return deps.db.tx(scopeOf(actor), async (q) => {
				const ws = await requireWorkspace(q, actor, id);
				if (!can(actor, "team.view", { teamId: ws.teamId, orgId: ws.orgId })) throw forbidden();
				return toView(ws);
			});
		},

		async update(actor, id, patch) {
			if (Object.keys(patch).length === 0) throw validationError("没有需要更新的字段");
			if (patch.dailyReportTime !== undefined && !TIME_OF_DAY.test(patch.dailyReportTime)) throw validationError("dailyReportTime 应为 HH:MM");
			if (patch.dailyReportTz !== undefined) assertTimeZone(patch.dailyReportTz);
			if (patch.upstreamUrl) await assertSafeRemoteUrl(patch.upstreamUrl, { ...remoteOpts, httpsOnly: true });
			return deps.db
				.tx(scopeOf(actor), async (q) => {
					const ws = await requireWorkspace(q, actor, id);
					if (!can(actor, "workspace.manage", { teamId: ws.teamId, orgId: ws.orgId })) throw forbidden();
					const sets: string[] = [];
					const params: unknown[] = [id];
					const set = (column: string, value: unknown): void => {
						params.push(value);
						sets.push(`${column} = $${params.length}`);
					};
					if (patch.name !== undefined) set("name", patch.name);
					if (patch.dailyReportTime !== undefined) set("daily_report_time", patch.dailyReportTime);
					if (patch.dailyReportTz !== undefined) set("daily_report_tz", patch.dailyReportTz);
					if (patch.dailyReportEnabled !== undefined) set("daily_report_enabled", patch.dailyReportEnabled);
					if (patch.upstreamUrl !== undefined) {
						set("upstream_url", patch.upstreamUrl);
						// A changed or removed upstream invalidates the old status and token unless a new token comes with it.
						sets.push("upstream_status = NULL", "upstream_error = NULL", "upstream_checked_at = NULL");
						if (patch.upstreamUrl === null && patch.upstreamToken === undefined) sets.push("upstream_token_enc = NULL");
					}
					if (patch.upstreamToken !== undefined) {
						if (patch.upstreamToken !== null && !(patch.upstreamUrl ?? ws.upstreamUrl)) throw validationError("设置 upstreamToken 需要先配置 upstreamUrl");
						set("upstream_token_enc", patch.upstreamToken === null ? null : secretBox.seal(patch.upstreamToken));
					}
					sets.push("updated_at = now()");
					await q.query(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = $1`, params);
					await audit.write(q, {
						actorId: actor.userId,
						orgId: ws.orgId,
						action: "workspace.update",
						targetType: "workspace",
						targetId: id,
						detail: { fields: Object.keys(patch) },
					});
					return toView(await readOne(q, id));
				})
				.catch((err: unknown) => {
					if (isUniqueViolation(err)) throw conflict("该团队下已有同名工作区", "workspaceNameTaken");
					throw err;
				});
		},

		require: requireWorkspace,

		async loadSystem(id) {
			const rows = await deps.db.tx({ system: true }, (q) => q.query<WorkspaceRow>(`SELECT ${COLUMNS} FROM workspaces WHERE id = $1`, [id]));
			return rows[0] ? toRecord(rows[0]) : undefined;
		},

		async listWithUpstream() {
			const rows = await deps.db.tx({ system: true }, (q) => q.query<WorkspaceRow>(`SELECT ${COLUMNS} FROM workspaces WHERE upstream_url IS NOT NULL ORDER BY id`));
			return rows.map(toRecord);
		},

		async upstreamToken(id) {
			const rows = await deps.db.tx({ system: true }, (q) => q.query<{ upstream_token_enc: string | null }>("SELECT upstream_token_enc FROM workspaces WHERE id = $1", [id]));
			const sealed = rows[0]?.upstream_token_enc;
			return sealed ? secretBox.open(sealed) : undefined;
		},

		async recordUpstream(id, status, error) {
			await deps.db.tx({ system: true }, (q) =>
				q.query("UPDATE workspaces SET upstream_status = $2, upstream_error = $3, upstream_checked_at = $4 WHERE id = $1", [id, status, error, new Date(deps.now())]),
			);
		},

		repoPath: (ws) => runtime.repoPath(ws.repoDir),

		async browse(actor, id, ref, path) {
			const ws = await deps.db.tx(scopeOf(actor), async (q) => {
				const found = await requireWorkspace(q, actor, id);
				if (!can(actor, "team.view", { teamId: found.teamId, orgId: found.orgId })) throw forbidden();
				return found;
			});
			await runtime.requireGit();
			const wanted = ref && ref !== "" ? ref : ws.defaultBranch;
			if (!SAFE_REF.test(wanted) || wanted.startsWith("-") || wanted.includes("..")) throw badRequest("ref 无效", "invalidRef");
			const gitDir = runtime.repoPath(ws.repoDir);
			const commit = await resolveCommit(gitDir, wanted);
			if (!commit) throw notFound("引用不存在");
			const clean = cleanPath(path);
			const found = await lookupPath(gitDir, commit, clean);
			if (!found) throw notFound("路径不存在");
			if (found.kind === "tree") {
				const entries = found.entries.map((e) => ({
					name: e.name,
					type: e.type === "tree" ? ("dir" as const) : e.type === "commit" ? ("submodule" as const) : ("file" as const),
					size: e.size,
				}));
				return { type: "dir", ref: wanted, commit, path: clean, entries };
			}
			if (found.kind === "commit") throw badRequest("该路径是子模块，无法浏览", "isSubmodule");
			if (found.size > MAX_FILE_BYTES) throw new HubError(413, "fileTooLarge", `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`);
			const data = await readBlob(gitDir, found.oid);
			const binary = data.subarray(0, 8000).includes(0);
			return { type: "file", ref: wanted, commit, path: clean, size: found.size, binary, encoding: "base64", content: data.toString("base64") };
		},
	};
}
