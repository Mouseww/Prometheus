import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, type GitIdentity } from "../member/git.ts";
import { DEFAULT_EXCLUDES } from "../member/snapshot.ts";

/**
 * Tree id of the worktree as it is right now (tracked, untracked and not ignored files), computed through a temporary
 * index so the user's own index and files are not touched. Same excludes as snapshots.
 */
export async function currentTree(worktree: string, identity: GitIdentity): Promise<string> {
	const scratch = await mkdtemp(join(tmpdir(), "prometheus-tree-"));
	try {
		const excludes = join(scratch, "excludes");
		await writeFile(excludes, `${DEFAULT_EXCLUDES.join("\n")}\n`);
		const env = { GIT_INDEX_FILE: join(scratch, "index") };
		await git(["-c", `core.excludesFile=${excludes}`, "add", "-A"], { cwd: worktree, identity, env });
		return await git(["write-tree"], { cwd: worktree, identity, env });
	} finally {
		await rm(scratch, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Brings the worktree's files from the state of `fromTree` to `toTree`: files that changed are rewritten, files only in `fromTree` are
 * removed, files neither tree knows (ignored build output, untracked leftovers) stay. A temporary index seeded with `fromTree`
 * makes `read-tree -u --reset` do exactly that without touching the real index.
 */
export async function applyTree(worktree: string, identity: GitIdentity, fromTree: string, toTree: string): Promise<void> {
	const scratch = await mkdtemp(join(tmpdir(), "prometheus-apply-"));
	try {
		const env = { GIT_INDEX_FILE: join(scratch, "index") };
		await git(["read-tree", fromTree], { cwd: worktree, identity, env });
		await git(["read-tree", "-u", "--reset", toTree], { cwd: worktree, identity, env });
	} finally {
		await rm(scratch, { recursive: true, force: true }).catch(() => {});
	}
}

/** Tree id of a commit or tree-ish. */
export function treeOf(worktree: string, identity: GitIdentity, rev: string): Promise<string> {
	return git(["rev-parse", "--verify", `${rev}^{tree}`], { cwd: worktree, identity });
}
