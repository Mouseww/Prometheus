import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { GitError, gitText, runGit } from "./exec.ts";
import { ZERO_OID } from "./pktline.ts";

export interface GitCapabilities {
	available: boolean;
	version: string | null;
	/** `git merge-tree --write-tree` needs git 2.38 or newer. */
	mergeTree: boolean;
}

export const MIN_MERGE_TREE_VERSION = [2, 38] as const;

export function parseGitVersion(text: string): { major: number; minor: number } | undefined {
	const m = /git version (\d+)\.(\d+)/.exec(text);
	return m ? { major: Number(m[1]), minor: Number(m[2]) } : undefined;
}

export async function detectGit(): Promise<GitCapabilities> {
	try {
		const text = await gitText(["--version"], { timeoutMs: 15_000 });
		const v = parseGitVersion(text);
		if (!v) return { available: true, version: text, mergeTree: false };
		const [major, minor] = MIN_MERGE_TREE_VERSION;
		return { available: true, version: `${v.major}.${v.minor}`, mergeTree: v.major > major || (v.major === major && v.minor >= minor) };
	} catch {
		return { available: false, version: null, mergeTree: false };
	}
}

export async function initBare(dir: string, branch = "main"): Promise<void> {
	await mkdir(dirname(dir), { recursive: true });
	await runGit(["init", "--bare", "-b", branch, "--", dir]);
}

/** Clones all branches into a bare repository and drops the `origin` remote so no URL stays on disk. */
export async function cloneBare(url: string, dir: string, env: Record<string, string>): Promise<string> {
	await mkdir(dirname(dir), { recursive: true });
	try {
		await runGit(["clone", "--bare", "--quiet", "--", url, dir], { env, timeoutMs: 10 * 60 * 1000 });
		await runGit(["remote", "remove", "origin"], { gitDir: dir, okCodes: [1, 2] });
	} catch (err) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw err;
	}
	const head = await gitText(["symbolic-ref", "--short", "-q", "HEAD"], { gitDir: dir, okCodes: [1] }).catch(() => "");
	return head || "main";
}

/** Commit id for a ref/sha, or undefined when it does not resolve to a commit. */
export async function resolveCommit(gitDir: string, rev: string): Promise<string | undefined> {
	if (rev.startsWith("-")) return undefined;
	const r = await runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], { gitDir, okCodes: [1] });
	const out = r.stdout.toString("utf8").trim();
	return r.code === 0 && out ? out : undefined;
}

export async function isAncestor(gitDir: string, ancestor: string, descendant: string): Promise<boolean> {
	const r = await runGit(["merge-base", "--is-ancestor", ancestor, descendant], { gitDir, okCodes: [1] });
	return r.code === 0;
}

export interface MergeTreeResult {
	clean: boolean;
	tree: string;
	conflictPaths: string[];
}

/** `git merge-tree --write-tree` between two commits (no working tree needed). Output is NUL-framed (`-z`). */
export async function mergeTree(gitDir: string, ours: string, theirs: string): Promise<MergeTreeResult> {
	const r = await runGit(["merge-tree", "--write-tree", "--name-only", "--messages", "-z", ours, theirs], { gitDir, okCodes: [1] });
	const tokens = r.stdout.toString("utf8").split("\0");
	const tree = tokens[0] ?? "";
	if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new GitError("无法解析 merge-tree 输出", r.code, r.stderr);
	const conflictPaths: string[] = [];
	if (r.code === 1) {
		for (let i = 1; i < tokens.length; i++) {
			const t = tokens[i] as string;
			if (t === "") break;
			conflictPaths.push(t);
		}
	}
	return { clean: r.code === 0, tree, conflictPaths };
}

export interface Identity {
	name: string;
	email: string;
}

export async function commitTree(gitDir: string, tree: string, parents: readonly string[], message: string, author: Identity, committer: Identity): Promise<string> {
	const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"];
	return gitText(args, {
		gitDir,
		input: message,
		env: {
			GIT_AUTHOR_NAME: author.name,
			GIT_AUTHOR_EMAIL: author.email,
			GIT_COMMITTER_NAME: committer.name,
			GIT_COMMITTER_EMAIL: committer.email,
		},
	});
}

/** Compare-and-swap ref update. False when the ref no longer holds `oldOid` (pass undefined to require that it does not exist). */
export async function updateRefCas(gitDir: string, ref: string, newOid: string, oldOid: string | undefined): Promise<boolean> {
	try {
		await runGit(["update-ref", ref, newOid, oldOid ?? ZERO_OID], { gitDir });
		return true;
	} catch (err) {
		if (err instanceof GitError && /cannot lock ref|but expected|reference already exists/i.test(err.stderr)) return false;
		throw err;
	}
}

export type MergeOutcome =
	| { kind: "merged"; commit: string }
	| { kind: "alreadyMerged"; commit: string }
	| { kind: "conflict"; files: string[]; tip: string }
	| { kind: "casFailed"; tip: string };

export interface MergeInput {
	defaultBranch: string;
	head: string;
	message: string;
	author: Identity;
	committer: Identity;
	/** Test seam: runs right before the ref update of each attempt, to provoke a compare-and-swap race. */
	beforeUpdate?: (attempt: number) => Promise<void>;
}

/**
 * Merges `head` into the default branch without a work tree: merge-tree, commit-tree (author = MR author, committer = reviewer),
 * then a CAS update-ref. A lost race is retried once against the new tip (spec 5.2). An empty repository simply adopts `head`.
 */
export async function mergeIntoDefault(gitDir: string, input: MergeInput): Promise<MergeOutcome> {
	const ref = `refs/heads/${input.defaultBranch}`;
	let lastTip = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		const tip = await resolveCommit(gitDir, ref);
		lastTip = tip ?? "";
		if (!tip) {
			await input.beforeUpdate?.(attempt);
			if (await updateRefCas(gitDir, ref, input.head, undefined)) return { kind: "merged", commit: input.head };
			continue;
		}
		if (await isAncestor(gitDir, input.head, tip)) return { kind: "alreadyMerged", commit: tip };
		const mt = await mergeTree(gitDir, tip, input.head);
		if (!mt.clean) return { kind: "conflict", files: mt.conflictPaths, tip };
		const commit = await commitTree(gitDir, mt.tree, [tip, input.head], input.message, input.author, input.committer);
		await input.beforeUpdate?.(attempt);
		if (await updateRefCas(gitDir, ref, commit, tip)) return { kind: "merged", commit };
	}
	return { kind: "casFailed", tip: lastTip };
}

export interface FileChange {
	path: string;
	status: string;
	additions: number | null;
	deletions: number | null;
	binary: boolean;
}

/** Changed files between two revisions (`a...b` semantics when `threeDot`), with binary flags from `--numstat` (`-\t-`). */
export async function changedFiles(gitDir: string, from: string, to: string, threeDot = true): Promise<FileChange[]> {
	const range = threeDot ? `${from}...${to}` : `${from}..${to}`;
	const [num, stat] = await Promise.all([
		runGit(["diff", "--no-renames", "--no-ext-diff", "--numstat", "-z", range], { gitDir }),
		runGit(["diff", "--no-renames", "--no-ext-diff", "--name-status", "-z", range], { gitDir }),
	]);
	const status = new Map<string, string>();
	const st = stat.stdout.toString("utf8").split("\0");
	for (let i = 0; i + 1 < st.length; i += 2) status.set(st[i + 1] as string, st[i] as string);
	const files: FileChange[] = [];
	for (const rec of num.stdout.toString("utf8").split("\0")) {
		if (!rec) continue;
		const [add, del, ...rest] = rec.split("\t");
		const path = rest.join("\t");
		const binary = add === "-" && del === "-";
		files.push({ path, status: status.get(path) ?? "M", additions: binary ? null : Number(add), deletions: binary ? null : Number(del), binary });
	}
	return files;
}

export async function unifiedDiff(gitDir: string, from: string, to: string, maxBytes: number): Promise<{ diff: string; truncated: boolean }> {
	const r = await runGit(["diff", "--no-color", "--no-renames", "--no-ext-diff", `${from}...${to}`], { gitDir, maxBuffer: 64 * 1024 * 1024 });
	const truncated = r.stdout.length > maxBytes;
	return { diff: r.stdout.subarray(0, maxBytes).toString("utf8"), truncated };
}

export interface PathHistoryEntry {
	commit: string;
	authorName: string;
	files: Set<string>;
}

/** Newest-first commits on the first-parent line of `tip` with the files each changed (merge commits count against their first parent). */
export async function firstParentChanges(gitDir: string, tip: string, limit = 500): Promise<PathHistoryEntry[]> {
	const r = await runGit(["log", "--first-parent", "-m", "--name-only", "-z", `-n${limit}`, "--format=%x01%H%x02%an%x02", tip], { gitDir, maxBuffer: 32 * 1024 * 1024 });
	const entries: PathHistoryEntry[] = [];
	let current: PathHistoryEntry | undefined;
	for (const tok of r.stdout.toString("utf8").split("\0")) {
		const start = tok.indexOf("\u0001");
		let name = tok;
		if (start >= 0) {
			const [, rest = ""] = tok.split("\u0001");
			const [commit = "", authorName = "", firstPath = ""] = rest.split("\u0002");
			current = { commit, authorName, files: new Set() };
			entries.push(current);
			name = firstPath;
		}
		// The first file name of each commit follows the header after a newline.
		name = name.replace(/^\n+/, "");
		if (current && name) current.files.add(name);
	}
	return entries;
}

export interface TreeEntry {
	name: string;
	type: "blob" | "tree" | "commit";
	mode: string;
	oid: string;
	size: number | null;
}

export type PathLookup = { kind: "tree"; entries: TreeEntry[] } | { kind: "blob"; oid: string; size: number } | { kind: "commit" };

/** Looks `path` up in `commit`: directory listing or blob metadata. Undefined when the path does not exist. */
export async function lookupPath(gitDir: string, commit: string, path: string): Promise<PathLookup | undefined> {
	const spec = path === "" ? `${commit}^{tree}` : `${commit}:${path}`;
	const t = await runGit(["cat-file", "-t", "--", spec], { gitDir, okCodes: [128] });
	if (t.code !== 0) return undefined;
	const type = t.stdout.toString("utf8").trim();
	if (type === "tree") {
		const r = await runGit(["ls-tree", "-z", "-l", "--", path === "" ? commit : `${commit}:${path}`], { gitDir });
		const entries: TreeEntry[] = [];
		for (const rec of r.stdout.toString("utf8").split("\0")) {
			if (!rec) continue;
			const tab = rec.indexOf("\t");
			const [mode = "", kind = "", oid = "", size = "-"] = rec.slice(0, tab).trim().split(/\s+/);
			entries.push({ name: rec.slice(tab + 1), type: kind as TreeEntry["type"], mode, oid, size: size === "-" ? null : Number(size) });
		}
		return { kind: "tree", entries };
	}
	if (type === "blob") {
		const s = await gitText(["cat-file", "-s", "--", spec], { gitDir });
		// `spec` starts with a resolved commit id, so it cannot be mistaken for an option.
		const oid = await gitText(["rev-parse", "--verify", spec], { gitDir });
		return { kind: "blob", oid, size: Number(s) };
	}
	return { kind: "commit" };
}

export async function readBlob(gitDir: string, oid: string): Promise<Buffer> {
	return (await runGit(["cat-file", "blob", oid], { gitDir, maxBuffer: 16 * 1024 * 1024 })).stdout;
}
