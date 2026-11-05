import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { identityOf, type MemberEnv, requireUserId } from "../member/env.ts";
import { git, runGit } from "../member/git.ts";
import { TeamError } from "../types.ts";
import { conflictRefPattern, conflictRefPrefix } from "./refs.ts";
import { applyTree, currentTree, treeOf } from "./tree.ts";

/** Trailer written into the conflict snapshot commit: the tree the files had at the last sync, i.e. what the saved edits were made against. */
export const BASELINE_TRAILER = "Baseline-Tree";
const MAX_LISTED_FILES = 200;

export interface ConflictInfo {
	conflictRef: string;
	commit: string;
	/** When the conflict was saved (milliseconds, from the ref name). */
	savedAt: number;
	/** Paths the user changed here compared with what the last sync left (capped). */
	files: string[];
	/** The session worktree the ref lives in, so a client can rebuild the `git -C` command after a reload. */
	worktree: string;
}

export interface RestoreTarget {
	worktree: string;
	lastApplied?: string;
	readOnly: boolean;
}

export type RestoreMode = "apply" | "branch";

export interface RestoreResult {
	mode: RestoreMode;
	conflictRef: string;
	/** `apply`: the saved edits are now uncommitted changes in the session worktree. `branch`: they are on `branch`, checked out at `worktree`. */
	worktree: string;
	branch?: string;
	files: string[];
}

const hex = /^[0-9a-f]{40,64}$/;

/** The tree the saved edits were made against: the recorded baseline, or (older conflict commits) the tree of the commit's parent. */
async function baseTreeOf(env: MemberEnv, worktree: string, commit: string): Promise<string> {
	const identity = identityOf(env);
	const body = await git(["log", "-1", "--format=%B", commit], { cwd: worktree, identity });
	const found = new RegExp(`^${BASELINE_TRAILER}: ([0-9a-f]{40,64})$`, "m").exec(body)?.[1];
	if (found && hex.test(found) && (await runGit(["cat-file", "-e", `${found}^{tree}`], { cwd: worktree })).code === 0) return found;
	return treeOf(worktree, identity, `${commit}^`);
}

async function changedFiles(env: MemberEnv, worktree: string, base: string, tree: string): Promise<string[]> {
	const out = await git(["diff", "--name-only", "--no-renames", base, tree], { cwd: worktree, identity: identityOf(env) });
	return out === "" ? [] : out.split("\n").slice(0, MAX_LISTED_FILES);
}

/** The conflict snapshots this machine saved for a Hub session, newest first. */
export async function listConflicts(env: MemberEnv, worktree: string, hubSessionId: string): Promise<ConflictInfo[]> {
	const userId = requireUserId(env);
	const pattern = conflictRefPattern(userId, hubSessionId);
	const out = await git(["for-each-ref", "--format=%(refname) %(objectname)", `${conflictRefPrefix(userId, hubSessionId)}*`], { cwd: worktree, identity: identityOf(env) });
	const items: ConflictInfo[] = [];
	for (const line of out === "" ? [] : out.split("\n")) {
		const [ref, commit] = line.split(" ");
		const match = ref ? pattern.exec(ref) : null;
		if (!ref || !commit || !match) continue;
		const base = await baseTreeOf(env, worktree, commit);
		items.push({ conflictRef: ref, commit, savedAt: Number(match[1]), files: await changedFiles(env, worktree, base, await treeOf(worktree, identityOf(env), commit)), worktree });
	}
	return items.sort((a, b) => b.savedAt - a.savedAt);
}

async function resolveConflict(env: MemberEnv, worktree: string, hubSessionId: string, conflictRef: string): Promise<string> {
	const userId = requireUserId(env);
	// Only this user's conflict refs of this session: the parameter is never handed to git as an arbitrary ref.
	if (!conflictRefPattern(userId, hubSessionId).test(conflictRef)) throw new TeamError("invalidConflictRef", "conflictRef 不是该会话的冲突备份", 400);
	const r = await runGit(["rev-parse", "--verify", "--quiet", `${conflictRef}^{commit}`], { cwd: worktree });
	const commit = r.stdout.trim();
	if (r.code !== 0 || !hex.test(commit)) throw new TeamError("conflictNotFound", "找不到这个冲突备份，可能已被清理", 404);
	return commit;
}

/**
 * Brings a saved conflict back. Never overwrites anything:
 * - `apply` (default): only when the session worktree has no edits since the last sync. The saved edits are merged three-way (what they were made
 *   against, what the files are now, what was saved) in a scratch index; if any file was changed differently on both sides nothing is touched and the
 *   paths are reported. Otherwise the result becomes uncommitted changes.
 * - `branch`: the saved state is checked out on a new branch in a new worktree next to the session's, which is left alone.
 */
export async function restoreConflict(env: MemberEnv, target: RestoreTarget, hubSessionId: string, conflictRef: string, mode: RestoreMode = "apply", now: () => number = Date.now): Promise<RestoreResult> {
	const identity = identityOf(env);
	const cwd = target.worktree;
	const commit = await resolveConflict(env, cwd, hubSessionId, conflictRef);
	const savedTree = await treeOf(cwd, identity, commit);
	const base = await baseTreeOf(env, cwd, commit);
	const files = await changedFiles(env, cwd, base, savedTree);

	if (mode === "branch") {
		const suffix = `${Math.trunc(now())}-${randomBytes(3).toString("hex")}`;
		const branch = `restore/conflict-${suffix}`;
		const worktree = join(dirname(cwd), `conflict-${suffix}`);
		await git(["worktree", "add", "--no-track", "-b", branch, worktree, commit], { cwd, identity });
		return { mode, conflictRef, worktree, branch, files };
	}

	if (target.readOnly) throw new TeamError("sessionReadOnly", "这个会话已经移交到另一端，请在执行端恢复，或使用 mode=branch", 409);
	const current = await currentTree(cwd, identity);
	const clean = target.lastApplied ?? (await treeOf(cwd, identity, "HEAD"));
	if (current !== clean) {
		throw new TeamError("worktreeDirty", "会话工作区有尚未同步的改动，不能直接恢复。请先提交或另存这些改动，或使用 mode=branch 恢复到新分支", 409);
	}
	if (base === savedTree) throw new TeamError("nothingToRestore", "这个冲突备份没有相对基线的改动", 409);

	const scratch = await mkdtemp(join(tmpdir(), "prometheus-restore-"));
	try {
		const env2 = { GIT_INDEX_FILE: join(scratch, "index") };
		await git(["read-tree", "-m", "--aggressive", base, current, savedTree], { cwd, identity, env: env2 });
		// `ls-files -u` lines look like `<mode> <object> <stage>\t<path>`.
		const unmerged = await git(["ls-files", "-u"], { cwd, identity, env: env2 });
		if (unmerged !== "") {
			const paths = [...new Set(unmerged.split("\n").map((line) => line.slice(line.indexOf("\t") + 1)))].slice(0, 20);
			throw new TeamError("restoreConflict", `这些文件在对端和你另存的版本里被不同地修改，无法自动合并，未改动任何文件：${paths.join("、")}。可使用 mode=branch 恢复到新分支后手动合并`, 409);
		}
		const merged = await git(["write-tree"], { cwd, identity, env: env2 });
		await applyTree(cwd, identity, current, merged);
	} finally {
		await rm(scratch, { recursive: true, force: true }).catch(() => {});
	}
	return { mode, conflictRef, worktree: cwd, files };
}
