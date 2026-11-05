import { toIso } from "../db/db.ts";
import type { Queryable } from "../db/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { mergeCommitMessage } from "../git/commit-message.ts";
import type { TeamNotifier } from "../git/notify.ts";
import { isPushableRef } from "../git/pktline.ts";
import {
	changedFiles,
	type FileChange,
	firstParentChanges,
	isAncestor,
	mergeIntoDefault,
	type MergeOutcome,
	mergeTree,
	resolveCommit,
	unifiedDiff,
} from "../git/repo.ts";
import type { GitRuntime } from "../git/runtime.ts";
import type { UpstreamSync } from "../git/upstream.ts";
import { ulid } from "../ids.ts";
import { LOG_PREFIX } from "../log.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { AuditService } from "./audit.ts";
import { type ServiceDeps, scopeOf } from "./common.ts";
import type { WorkspaceRecord, WorkspacesService } from "./workspaces.ts";

export type MergeRequestStatus = "open" | "approved" | "merged" | "rejected" | "conflict" | "closed";

export interface ConflictFile {
	path: string;
	binary: boolean;
	/** Who last changed this file on the default branch, so the UI can say "already modified by X". */
	lastModifiedBy: { mergeRequestId: string | null; userId: string | null; displayName: string; commit: string } | null;
}

export interface MergeRequestView {
	id: string;
	workspaceId: string;
	sessionId: string | null;
	authorId: string;
	authorName: string;
	title: string;
	description: string;
	branch: string;
	baseCommit: string;
	headCommit: string;
	status: MergeRequestStatus;
	reviewerId: string | null;
	skippedReview: boolean;
	conflictFiles: ConflictFile[] | null;
	mergedCommit: string | null;
	decidedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CreateMergeRequestInput {
	sessionId?: string;
	title: string;
	description?: string;
	branch: string;
	baseCommit: string;
	headCommit: string;
	skipReview?: boolean;
}

export interface MergeRequestDiff {
	mergeRequestId: string;
	base: string;
	head: string;
	diff: string;
	truncated: boolean;
	files: FileChange[];
}

export interface MergeRequestsService {
	create(actor: Actor, workspaceId: string, input: CreateMergeRequestInput): Promise<MergeRequestView>;
	list(actor: Actor, workspaceId: string, filter?: { status?: MergeRequestStatus }): Promise<MergeRequestView[]>;
	get(actor: Actor, id: string): Promise<MergeRequestView>;
	/** Approves and merges exactly the commit the reviewer looked at: 409 `headChanged` when the head moved since. */
	approve(actor: Actor, id: string, expectedHeadCommit: string): Promise<MergeRequestView>;
	reject(actor: Actor, id: string, reason?: string): Promise<MergeRequestView>;
	refresh(actor: Actor, id: string): Promise<MergeRequestView>;
	close(actor: Actor, id: string): Promise<MergeRequestView>;
	diff(actor: Actor, id: string): Promise<MergeRequestDiff>;
	/** Startup recovery: merges interrupted mid-flight go back to `open`. */
	resetInterrupted(): Promise<number>;
}

interface MrRow {
	id: string;
	workspace_id: string;
	org_id: string | null;
	session_id: string | null;
	author_id: string;
	author_name: string;
	title: string;
	description: string;
	branch: string;
	base_commit: string;
	head_commit: string;
	status: MergeRequestStatus;
	reviewer_id: string | null;
	skipped_review: boolean;
	conflict_files: ConflictFile[] | string | null;
	merged_commit: string | null;
	decided_at: Date | string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

const SELECT = `SELECT m.id, m.workspace_id, m.org_id, m.session_id, m.author_id, u.display_name AS author_name, m.title, m.description, m.branch,
	m.base_commit, m.head_commit, m.status, m.reviewer_id, m.skipped_review, m.conflict_files, m.merged_commit, m.decided_at, m.created_at, m.updated_at
	FROM merge_requests m JOIN users u ON u.id = m.author_id`;

const OID = /^[0-9a-f]{40}$/;

function toView(r: MrRow): MergeRequestView {
	const files = typeof r.conflict_files === "string" ? (JSON.parse(r.conflict_files) as ConflictFile[]) : r.conflict_files;
	return {
		id: r.id,
		workspaceId: r.workspace_id,
		sessionId: r.session_id,
		authorId: r.author_id,
		authorName: r.author_name,
		title: r.title,
		description: r.description,
		branch: r.branch,
		baseCommit: r.base_commit,
		headCommit: r.head_commit,
		status: r.status,
		reviewerId: r.reviewer_id,
		skippedReview: r.skipped_review,
		conflictFiles: files,
		mergedCommit: r.merged_commit,
		decidedAt: toIso(r.decided_at),
		createdAt: toIso(r.created_at) as string,
		updatedAt: toIso(r.updated_at) as string,
	};
}

const DIFF_CAP_BYTES = 2 * 1024 * 1024;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface MergeRequestsDeps {
	base: ServiceDeps;
	audit: AuditService;
	workspaces: WorkspacesService;
	runtime: GitRuntime;
	notifier: TeamNotifier;
	upstream: UpstreamSync;
}

export function createMergeRequestsService(deps: MergeRequestsDeps): MergeRequestsService {
	const { base, audit, workspaces, runtime, notifier, upstream } = deps;
	const { db } = base;

	const loadRow = async (q: Queryable, id: string): Promise<MrRow> => {
		const rows = await q.query<MrRow>(`${SELECT} WHERE m.id = $1`, [id]);
		if (!rows[0]) throw notFound("合并请求不存在");
		return rows[0];
	};

	/** MR plus its workspace; outsiders get 404 for both. */
	const load = async (q: Queryable, actor: Actor, id: string): Promise<{ row: MrRow; ws: WorkspaceRecord }> => {
		const row = await loadRow(q, id);
		const ws = await workspaces.require(q, actor, row.workspace_id);
		return { row, ws };
	};

	/** Binary flags and last-modifier information for conflicting paths. */
	const describeConflicts = async (ws: WorkspaceRecord, tip: string, head: string, paths: readonly string[]): Promise<ConflictFile[]> => {
		if (paths.length === 0) return [];
		const gitDir = runtime.repoPath(ws.repoDir);
		const [mine, theirs, history] = await Promise.all([changedFiles(gitDir, tip, head, true), changedFiles(gitDir, head, tip, true), firstParentChanges(gitDir, tip)]);
		const binary = new Set([...mine, ...theirs].filter((f) => f.binary).map((f) => f.path));
		const commitFor = new Map<string, (typeof history)[number]>();
		for (const path of paths) {
			const hit = history.find((h) => h.files.has(path));
			if (hit) commitFor.set(path, hit);
		}
		const commits = [...new Set([...commitFor.values()].map((h) => h.commit))];
		const owners = new Map<string, { id: string; author_id: string; display_name: string }>();
		if (commits.length > 0) {
			const rows = await db.tx({ system: true }, (q) =>
				q.query<{ id: string; merged_commit: string; author_id: string; display_name: string }>(
					`SELECT m.id, m.merged_commit, m.author_id, u.display_name FROM merge_requests m JOIN users u ON u.id = m.author_id
					 WHERE m.workspace_id = $1 AND m.merged_commit = ANY($2::text[])`,
					[ws.id, commits],
				),
			);
			for (const r of rows) owners.set(r.merged_commit, { id: r.id, author_id: r.author_id, display_name: r.display_name });
		}
		return paths.map((path) => {
			const hit = commitFor.get(path);
			const owner = hit ? owners.get(hit.commit) : undefined;
			return {
				path,
				binary: binary.has(path),
				lastModifiedBy: hit ? { mergeRequestId: owner?.id ?? null, userId: owner?.author_id ?? null, displayName: owner?.display_name ?? hit.authorName, commit: hit.commit } : null,
			};
		});
	};

	/** Merge-tree check of `head` against the current default branch tip. */
	const check = async (ws: WorkspaceRecord, head: string): Promise<{ clean: boolean; files: ConflictFile[] }> => {
		const gitDir = runtime.repoPath(ws.repoDir);
		const tip = await resolveCommit(gitDir, `refs/heads/${ws.defaultBranch}`);
		if (!tip || (await isAncestor(gitDir, head, tip))) return { clean: true, files: [] };
		const mt = await mergeTree(gitDir, tip, head);
		if (mt.clean) return { clean: true, files: [] };
		return { clean: false, files: await describeConflicts(ws, tip, head, mt.conflictPaths) };
	};

	/**
	 * Records a fresh check. Any earlier approval is reset (`reviewer_id` cleared), and the update only applies while the request is still
	 * open or in conflict: a merge claimed meanwhile (`approved`) is never overwritten.
	 */
	const setCheckResult = async (q: Queryable, id: string, headCommit: string, result: { clean: boolean; files: ConflictFile[] }): Promise<void> => {
		const updated = await q.query(
			`UPDATE merge_requests SET head_commit = $2, status = $3, conflict_files = $4::text::jsonb, reviewer_id = NULL, skipped_review = false, updated_at = now()
			 WHERE id = $1 AND status IN ('open', 'conflict') RETURNING id`,
			[id, headCommit, result.clean ? "open" : "conflict", result.clean ? null : JSON.stringify(result.files)],
		);
		if (updated.length === 0) throw conflict("合并请求状态已变化，无法刷新", "invalidState");
	};

	/** Tells everyone watching the workspace (`workspace:<id>`) that a merge request changed. */
	const publishChange = (view: MergeRequestView): MergeRequestView => {
		notifier.publish(`workspace:${view.workspaceId}`, { kind: "mergeRequest", mergeRequest: view });
		return view;
	};

	const requireOpenish = (row: MrRow): void => {
		if (row.status !== "open" && row.status !== "conflict") throw conflict(`合并请求已是 ${row.status} 状态`, "invalidState");
	};

	/** Claims an open MR, runs the git merge, and records the outcome. Used by approve and by skipReview creation. */
	const executeMerge = async (actor: Actor, id: string, skipped: boolean, expectedHead: string): Promise<{ view: MergeRequestView; merged: boolean }> => {
		const { row, ws } = await db.tx(scopeOf(actor), async (q) => {
			const loaded = await load(q, actor, id);
			// The claim is bound to the commit the reviewer saw, so a refresh that moved the head in between cannot be merged unreviewed.
			if (loaded.row.head_commit !== expectedHead) throw conflict("合并请求的提交已变化，请重新查看后再批准", "headChanged");
			const claimed = await q.query(
				"UPDATE merge_requests SET status = 'approved', reviewer_id = $2, skipped_review = $3, updated_at = now() WHERE id = $1 AND status = 'open' AND head_commit = $4 RETURNING id",
				[id, actor.userId, skipped, expectedHead],
			);
			if (claimed.length === 0) throw conflict("合并请求状态已变化，无法合并", "invalidState");
			return loaded;
		});
		const gitDir = runtime.repoPath(ws.repoDir);
		let outcome: MergeOutcome;
		try {
			const people = await db.tx({ system: true }, (q) =>
				q.query<{ id: string; email: string; display_name: string }>("SELECT id, email, display_name FROM users WHERE id = ANY($1::text[])", [[row.author_id, actor.userId]]),
			);
			const author = people.find((p) => p.id === row.author_id);
			const reviewer = people.find((p) => p.id === actor.userId);
			if (!author || !reviewer) throw new Error("找不到作者或审核人账号");
			outcome = await mergeIntoDefault(gitDir, {
				defaultBranch: ws.defaultBranch,
				head: row.head_commit,
				message: mergeCommitMessage({ branch: row.branch, title: row.title, description: row.description, mergeRequestId: row.id }),
				author: { name: author.display_name, email: author.email },
				committer: { name: reviewer.display_name, email: reviewer.email },
			});
		} catch (err) {
			await db
				.tx({ system: true }, (q) => q.query("UPDATE merge_requests SET status = 'open', reviewer_id = NULL, skipped_review = false WHERE id = $1 AND status = 'approved'", [id]))
				.catch(() => {});
			throw err;
		}

		if (outcome.kind === "conflict" || outcome.kind === "casFailed") {
			let files: ConflictFile[] = [];
			if (outcome.kind === "conflict") {
				const mt = await mergeTree(gitDir, outcome.tip, row.head_commit).catch(() => undefined);
				files = await describeConflicts(ws, outcome.tip, row.head_commit, mt?.conflictPaths ?? outcome.files).catch(() => outcome.files.map((path) => ({ path, binary: false, lastModifiedBy: null })));
			}
			const view = await db.tx({ system: true }, async (q) => {
				await q.query(
					"UPDATE merge_requests SET status = 'conflict', reviewer_id = NULL, skipped_review = false, conflict_files = $2::text::jsonb, updated_at = now() WHERE id = $1",
					[id, JSON.stringify(files)],
				);
				return toView(await loadRow(q, id));
			});
			return { view: publishChange(view), merged: false };
		}

		const mergedCommit = outcome.commit;
		const view = await db.tx({ system: true }, async (q) => {
			await q.query(
				"UPDATE merge_requests SET status = 'merged', merged_commit = $2, reviewer_id = $3, skipped_review = $4, conflict_files = NULL, decided_at = $5, updated_at = now() WHERE id = $1",
				[id, mergedCommit, actor.userId, skipped, new Date(base.now())],
			);
			await audit.write(q, {
				actorId: actor.userId,
				orgId: ws.orgId,
				action: skipped ? "mr.merge.skipReview" : "mr.merge",
				targetType: "merge_request",
				targetId: id,
				detail: { workspaceId: ws.id, branch: row.branch, headCommit: row.head_commit, mergedCommit, authorId: row.author_id },
			});
			return toView(await loadRow(q, id));
		});
		await upstream.pushAfterMerge(ws);
		const members = await notifier.teamUsers(ws.teamId);
		await notifier.send(ws.orgId, [row.author_id, ...members].filter((u) => u !== actor.userId), "mr.merged", {
			mergeRequestId: id,
			workspaceId: ws.id,
			title: row.title,
			skippedReview: skipped,
			mergedBy: actor.userId,
		});
		return { view: publishChange(view), merged: true };
	};

	return {
		async create(actor, workspaceId, input) {
			await runtime.requireMerge();
			const ws = await db.tx(scopeOf(actor), async (q) => {
				const found = await workspaces.require(q, actor, workspaceId);
				if (!can(actor, "mr.create", { teamId: found.teamId, orgId: found.orgId })) throw forbidden();
				if (input.skipReview && !can(actor, "mr.skipReview", { teamId: found.teamId, orgId: found.orgId })) {
					throw forbidden("只有团队管理员或审核人可以跳过审核", "skipReviewDenied");
				}
				if (input.sessionId) {
					// The link must point at the author's own session in this workspace (the session list is not shared with a forged id).
					const owned = await q.query("SELECT 1 FROM sessions WHERE id = $1 AND workspace_id = $2 AND owner_user_id = $3", [input.sessionId, found.id, actor.userId]);
					if (owned.length === 0) throw badRequest("sessionId 必须是你在该工作区下的会话", "invalidSession");
				}
				return found;
			});
			if (!OID.test(input.baseCommit) || !OID.test(input.headCommit)) throw badRequest("baseCommit 与 headCommit 必须是 40 位提交号", "invalidCommit");
			if (!isPushableRef(`refs/heads/${input.branch}`, actor.userId)) throw badRequest("branch 必须位于 session/<你的用户 id>/ 之下", "invalidBranch");
			const gitDir = runtime.repoPath(ws.repoDir);
			const [tipOfBranch, baseOid, head] = await Promise.all([
				resolveCommit(gitDir, `refs/heads/${input.branch}`),
				resolveCommit(gitDir, input.baseCommit),
				resolveCommit(gitDir, input.headCommit),
			]);
			if (!head || !baseOid) throw badRequest("提交尚未推送到 Hub", "commitNotFound");
			if (tipOfBranch !== head) throw conflict("会话分支的最新提交与 headCommit 不一致，请先推送", "headMismatch");

			const result = await check(ws, head);
			const id = ulid(base.now());
			const created = await db.tx(scopeOf(actor), async (q) => {
				await q.query(
					`INSERT INTO merge_requests (id, workspace_id, org_id, session_id, author_id, title, description, branch, base_commit, head_commit, status, conflict_files)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text::jsonb)`,
					[
						id,
						ws.id,
						ws.orgId,
						input.sessionId ?? null,
						actor.userId,
						input.title,
						input.description ?? "",
						input.branch,
						input.baseCommit,
						head,
						result.clean ? "open" : "conflict",
						result.clean ? null : JSON.stringify(result.files),
					],
				);
				await audit.write(q, {
					actorId: actor.userId,
					orgId: ws.orgId,
					action: "mr.create",
					targetType: "merge_request",
					targetId: id,
					detail: { workspaceId: ws.id, branch: input.branch, status: result.clean ? "open" : "conflict", skipReview: input.skipReview === true },
				});
				return toView(await loadRow(q, id));
			});

			if (input.skipReview && result.clean) return (await executeMerge(actor, id, true, head)).view;
			const reviewers = await notifier.teamUsers(ws.teamId, ["admin", "reviewer"]);
			await notifier.send(ws.orgId, reviewers.filter((u) => u !== actor.userId), "mr.created", { mergeRequestId: id, workspaceId: ws.id, title: input.title, status: created.status });
			return publishChange(created);
		},

		async list(actor, workspaceId, filter = {}) {
			return db.tx(scopeOf(actor), async (q) => {
				const ws = await workspaces.require(q, actor, workspaceId);
				if (!can(actor, "team.view", { teamId: ws.teamId, orgId: ws.orgId })) throw forbidden();
				const rows = filter.status
					? await q.query<MrRow>(`${SELECT} WHERE m.workspace_id = $1 AND m.status = $2 ORDER BY m.created_at DESC, m.id DESC LIMIT 200`, [workspaceId, filter.status])
					: await q.query<MrRow>(`${SELECT} WHERE m.workspace_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT 200`, [workspaceId]);
				return rows.map(toView);
			});
		},

		async get(actor, id) {
			return db.tx(scopeOf(actor), async (q) => {
				const { row, ws } = await load(q, actor, id);
				if (!can(actor, "team.view", { teamId: ws.teamId, orgId: ws.orgId })) throw forbidden();
				return toView(row);
			});
		},

		async approve(actor, id, expectedHeadCommit) {
			await runtime.requireMerge();
			if (!OID.test(expectedHeadCommit)) throw badRequest("expectedHeadCommit 必须是 40 位提交号", "invalidCommit");
			const row = await db.tx(scopeOf(actor), async (q) => {
				const { row: found, ws } = await load(q, actor, id);
				if (!can(actor, "mr.review", { teamId: ws.teamId, orgId: ws.orgId })) throw forbidden();
				if (found.status === "conflict") throw conflict("合并请求存在冲突，请作者解决后刷新", "mergeConflict");
				if (found.status !== "open") throw conflict(`合并请求已是 ${found.status} 状态`, "invalidState");
				if (found.head_commit !== expectedHeadCommit) throw conflict("合并请求的提交已变化，请重新查看后再批准", "headChanged");
				return found;
			});
			const { view, merged } = await executeMerge(actor, row.id, false, expectedHeadCommit);
			if (!merged) throw conflict("合并请求与默认分支存在冲突，已标记为冲突", "mergeConflict");
			return view;
		},

		async reject(actor, id, reason) {
			const { view, row, ws } = await db.tx(scopeOf(actor), async (q) => {
				const { row, ws } = await load(q, actor, id);
				if (!can(actor, "mr.review", { teamId: ws.teamId, orgId: ws.orgId })) throw forbidden();
				requireOpenish(row);
				await q.query("UPDATE merge_requests SET status = 'rejected', reviewer_id = $2, decided_at = $3, updated_at = now() WHERE id = $1", [id, actor.userId, new Date(base.now())]);
				await audit.write(q, {
					actorId: actor.userId,
					orgId: ws.orgId,
					action: "mr.reject",
					targetType: "merge_request",
					targetId: id,
					detail: { workspaceId: ws.id, reason: reason ?? null, authorId: row.author_id },
				});
				return { view: toView(await loadRow(q, id)), row, ws };
			});
			await notifier.send(ws.orgId, [row.author_id].filter((u) => u !== actor.userId), "mr.rejected", { mergeRequestId: id, workspaceId: ws.id, title: row.title, reason: reason ?? null });
			return publishChange(view);
		},

		async refresh(actor, id) {
			await runtime.requireMerge();
			const { row, ws } = await db.tx(scopeOf(actor), async (q) => {
				const loaded = await load(q, actor, id);
				const isAuthor = loaded.row.author_id === actor.userId;
				if (!isAuthor && !can(actor, "mr.review", { teamId: loaded.ws.teamId, orgId: loaded.ws.orgId })) throw forbidden();
				requireOpenish(loaded.row);
				return loaded;
			});
			const gitDir = runtime.repoPath(ws.repoDir);
			const head = await resolveCommit(gitDir, `refs/heads/${row.branch}`);
			if (!head) throw conflict("会话分支已不存在", "branchMissing");
			const result = await check(ws, head);
			const refreshed = await db.tx(scopeOf(actor), async (q) => {
				await setCheckResult(q, id, head, result);
				return toView(await loadRow(q, id));
			});
			return publishChange(refreshed);
		},

		async close(actor, id) {
			const closed = await db.tx(scopeOf(actor), async (q) => {
				const { row, ws } = await load(q, actor, id);
				if (row.author_id !== actor.userId && !can(actor, "mr.review", { teamId: ws.teamId, orgId: ws.orgId })) throw forbidden();
				requireOpenish(row);
				await q.query("UPDATE merge_requests SET status = 'closed', decided_at = $2, updated_at = now() WHERE id = $1", [id, new Date(base.now())]);
				return toView(await loadRow(q, id));
			});
			return publishChange(closed);
		},

		async diff(actor, id) {
			const { row, ws } = await db.tx(scopeOf(actor), async (q) => {
				const loaded = await load(q, actor, id);
				if (!can(actor, "team.view", { teamId: loaded.ws.teamId, orgId: loaded.ws.orgId })) throw forbidden();
				return loaded;
			});
			await runtime.requireGit();
			const gitDir = runtime.repoPath(ws.repoDir);
			const fallback = await resolveCommit(gitDir, `refs/heads/${ws.defaultBranch}`);
			const from = (await resolveCommit(gitDir, row.base_commit)) ?? fallback;
			const head = await resolveCommit(gitDir, row.head_commit);
			if (!from || !head) throw conflict("无法计算差异：提交不在 Hub 仓库中", "commitNotFound");
			try {
				const [text, files] = await Promise.all([unifiedDiff(gitDir, from, head, DIFF_CAP_BYTES), changedFiles(gitDir, from, head, true)]);
				return { mergeRequestId: id, base: from, head, diff: text.diff, truncated: text.truncated, files };
			} catch (err) {
				base.log.warn(`${LOG_PREFIX} 计算合并请求差异失败 (${id}): ${messageOf(err)}`);
				throw conflict("无法计算差异", "diffFailed");
			}
		},

		async resetInterrupted() {
			const rows = await db.tx({ system: true }, (q) =>
				q.query("UPDATE merge_requests SET status = 'open', reviewer_id = NULL, skipped_review = false WHERE status = 'approved' RETURNING id"),
			);
			return rows.length;
		},
	};
}
