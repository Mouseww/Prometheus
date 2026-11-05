import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, type GitIdentity } from "./git.ts";

/** Kept out of snapshots and submitted commits (on top of the repository's own .gitignore). */
export const DEFAULT_EXCLUDES: readonly string[] = ["node_modules/", "dist/", "build/", "target/", "bin/", "obj/", ".venv/", "__pycache__/", "*.log"];

/**
 * Commits the worktree's current state (uncommitted and untracked files included) without touching the user's own index or
 * working tree: a temporary index file takes `git add -A`, then `write-tree` and `commit-tree -p HEAD` build the commit.
 * Resolves with the commit id; it is not referenced by any ref until the caller pushes it.
 */
export async function createSnapshotCommit(worktree: string, identity: GitIdentity, message = "Prometheus session snapshot"): Promise<string> {
	const scratch = await mkdtemp(join(tmpdir(), "prometheus-snapshot-"));
	try {
		const excludes = join(scratch, "excludes");
		await writeFile(excludes, `${DEFAULT_EXCLUDES.join("\n")}\n`);
		const env = { GIT_INDEX_FILE: join(scratch, "index") };
		await git(["-c", `core.excludesFile=${excludes}`, "add", "-A"], { cwd: worktree, identity, env });
		const tree = await git(["write-tree"], { cwd: worktree, identity, env });
		const parent = await git(["rev-parse", "--verify", "HEAD"], { cwd: worktree, identity });
		return await git(["commit-tree", tree, "-p", parent, "-m", message], { cwd: worktree, identity, env });
	} finally {
		await rm(scratch, { recursive: true, force: true }).catch(() => {});
	}
}

/** `git add -A` on the real index with the same default excludes, for the commit a merge request is made from. */
export function stageEverything(worktree: string, identity: GitIdentity): Promise<string> {
	return writeExcludesThen(async (excludes) => git(["-c", `core.excludesFile=${excludes}`, "add", "-A"], { cwd: worktree, identity }));
}

async function writeExcludesThen<T>(run: (excludesFile: string) => Promise<T>): Promise<T> {
	const scratch = await mkdtemp(join(tmpdir(), "prometheus-excludes-"));
	try {
		const excludes = join(scratch, "excludes");
		await writeFile(excludes, `${DEFAULT_EXCLUDES.join("\n")}\n`);
		return await run(excludes);
	} finally {
		await rm(scratch, { recursive: true, force: true }).catch(() => {});
	}
}
