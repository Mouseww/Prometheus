import { hubGit, identityOf, type MemberEnv, requireUserId } from "../member/env.ts";
import { runGit } from "../member/git.ts";
import { createSnapshotCommit } from "../member/snapshot.ts";
import { legacySnapshotRef, snapshotRef } from "./refs.ts";
import { treeOf } from "./tree.ts";

export interface PublishedSnapshot {
	commit: string;
	tree: string;
}

async function push(env: MemberEnv, worktree: string, commit: string, ref: string): Promise<void> {
	await hubGit(env, ["push", "--quiet", "--force", "origin", `${commit}:${ref}`], worktree);
}

/**
 * Snapshots the worktree (temporary index, so the user's index and files stay as they are), pushes the commit to the
 * session's `latest` ref on the Hub and records it on the Hub session. Resolves with the commit and its tree.
 */
export async function publishSnapshot(env: MemberEnv, worktree: string, hubSessionId: string): Promise<PublishedSnapshot> {
	const userId = requireUserId(env);
	const identity = identityOf(env);
	const ref = snapshotRef(userId, hubSessionId);
	const commit = await createSnapshotCommit(worktree, identity);
	try {
		await push(env, worktree, commit, ref);
	} catch (err) {
		// A leaf ref from an older version blocks the `latest` name on the Hub: delete it and push again.
		const legacy = legacySnapshotRef(userId, hubSessionId);
		const exists = await hubGit(env, ["ls-remote", "origin", legacy], worktree).catch(() => "");
		if (!exists.trim()) throw err;
		await hubGit(env, ["push", "--quiet", "origin", `:${legacy}`], worktree);
		await push(env, worktree, commit, ref);
	}
	await env.client.call("PATCH", `/sessions/${hubSessionId}`, { snapshotCommit: commit });
	// Keep the local copy of the ref too, so a later conflict check on this side finds the commit without fetching.
	await runGit(["update-ref", ref, commit], { cwd: worktree });
	return { commit, tree: await treeOf(worktree, identity, commit) };
}
