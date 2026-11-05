import { LOG } from "../types.ts";
import { hubGit, identityOf, type MemberEnv, requireUserId } from "../member/env.ts";
import { runGit } from "../member/git.ts";
import { createSnapshotCommit } from "../member/snapshot.ts";
import { BASELINE_TRAILER } from "./conflicts.ts";
import { conflictRef, legacySnapshotRef, snapshotRef } from "./refs.ts";
import { applyTree, currentTree, treeOf } from "./tree.ts";

export interface ApplyTarget {
	worktree: string;
	/** Tree the files were set to by the previous apply or publish; undefined before any (then HEAD's tree is the baseline). */
	lastApplied?: string;
}

export interface ApplyResult {
	status: "unchanged" | "applied" | "conflict";
	/** Tree the worktree holds afterwards; the caller stores it as `lastApplied`. */
	tree: string;
	conflictRef?: string;
	conflictCommit?: string;
}

/** Fetches the writer's newest snapshot ref (and clears an old-style leaf ref that would block it). */
export async function fetchSnapshot(env: MemberEnv, worktree: string, hubSessionId: string): Promise<void> {
	const userId = requireUserId(env);
	const ref = snapshotRef(userId, hubSessionId);
	const spec = `+${ref}:${ref}`;
	try {
		await hubGit(env, ["fetch", "--quiet", "origin", spec], worktree);
	} catch (err) {
		// A leaf ref from an older version occupies the name `latest` needs as a directory: drop it and retry once.
		const legacy = legacySnapshotRef(userId, hubSessionId);
		if ((await runGit(["rev-parse", "--verify", "--quiet", legacy], { cwd: worktree })).code !== 0) throw err;
		await runGit(["update-ref", "-d", legacy], { cwd: worktree });
		await hubGit(env, ["fetch", "--quiet", "origin", spec], worktree);
	}
}

/**
 * Makes the worktree match `commit` (spec 5). When the files changed since the last apply (the user edited here), the current state is first saved under
 * `refs/prometheus/snapshots/<user>/<session>/conflict-<time>` so nothing is lost, and the result says `conflict`.
 */
export async function applySnapshot(env: MemberEnv, target: ApplyTarget, hubSessionId: string, commit: string, now: () => number = Date.now): Promise<ApplyResult> {
	const identity = identityOf(env);
	const cwd = target.worktree;
	const have = await runGit(["cat-file", "-e", `${commit}^{commit}`], { cwd });
	if (have.code !== 0) await fetchSnapshot(env, cwd, hubSessionId);

	const snapTree = await treeOf(cwd, identity, commit);
	const cur = await currentTree(cwd, identity);
	if (cur === snapTree) return { status: "unchanged", tree: snapTree };

	const baseline = target.lastApplied ?? (await treeOf(cwd, identity, "HEAD"));
	let saved: { ref: string; commit: string } | undefined;
	if (cur !== baseline) {
		const userId = requireUserId(env);
		const ref = conflictRef(userId, hubSessionId, now());
		// The baseline trailer lets a later restore merge exactly the edits the user made on top of what the last sync left.
		const savedCommit = await createSnapshotCommit(cwd, identity, `Prometheus conflict snapshot\n\n${BASELINE_TRAILER}: ${baseline}`);
		await runGit(["update-ref", ref, savedCommit], { cwd });
		saved = { ref, commit: savedCommit };
		env.log.warn(`${LOG} 会话 ${hubSessionId} 的本地改动已另存到 ${ref}，随后用对端快照覆盖`);
	}
	await applyTree(cwd, identity, cur, snapTree);
	return saved ? { status: "conflict", tree: snapTree, conflictRef: saved.ref, conflictCommit: saved.commit } : { status: "applied", tree: snapTree };
}
