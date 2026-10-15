import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { GitBranch, GitCommit, GitDiff, GitFileChange, GitStatus } from "@prometheus/protocol";

const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_DIFF = 200_000;
const TIMEOUT_MS = 60_000;

export class GitError extends Error {}

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs git without a shell, so paths and messages can never be interpreted as commands. */
export function runGit(cwd: string, args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<GitResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", args, {
			cwd,
			windowsHide: true,
			// Never block on a credential or editor prompt: there is no terminal to answer it.
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat", LC_ALL: "C" },
		});
		let stdout = "";
		let stderr = "";
		let truncated = false;
		const timer = setTimeout(() => child.kill(), options.timeoutMs ?? TIMEOUT_MS);
		child.stdout.on("data", (d: Buffer) => {
			if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf8");
			else truncated = true;
		});
		child.stderr.on("data", (d: Buffer) => {
			if (stderr.length < 64_000) stderr += d.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new GitError((err as NodeJS.ErrnoException).code === "ENOENT" ? "未找到 git，请先安装 Git 并确保它在 PATH 中" : err.message));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code: code ?? 1, stdout: truncated ? `${stdout}\n…(输出过长，已截断)` : stdout, stderr });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(options.input ?? "");
	});
}

async function git(cwd: string, args: string[], input?: string): Promise<string> {
	const r = await runGit(cwd, args, { input });
	if (r.code !== 0) throw new GitError((r.stderr || r.stdout).trim().split("\n").slice(0, 6).join("\n") || `git ${args[0]} 失败（退出码 ${r.code}）`);
	return r.stdout;
}

/** The directory must exist; relative paths are rejected so a request can't be tricked into the server's own cwd. */
export function checkDir(dir: unknown): string {
	if (typeof dir !== "string" || !dir.trim() || !isAbsolute(dir)) throw new GitError("需要提供工作区的绝对路径");
	const abs = resolve(dir);
	if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new GitError(`目录不存在：${abs}`);
	return abs;
}

/** A file path as git reports it, kept inside the repo and clear of option syntax. */
export function checkPathspec(p: unknown): string {
	if (typeof p !== "string" || !p || p.includes("\0")) throw new GitError("文件路径不合法");
	if (isAbsolute(p) || p.split(/[\\/]/).includes("..") || p.startsWith("-")) throw new GitError(`文件路径不合法：${p}`);
	return p;
}

/** Ref names go after `--end-of-options`-style guards; this keeps obviously hostile names out regardless. */
export function checkRef(name: unknown): string {
	if (typeof name !== "string" || !name || name.startsWith("-") || /[\s~^:?*[\\\0]|\.\.|@\{|\/\/|\.lock$|\/$/.test(name)) throw new GitError(`分支或引用名不合法：${String(name)}`);
	return name;
}

// ---------- status ----------

/** Parses `git status --porcelain=v2 --branch -z`. Exported for tests. */
export function parseStatus(out: string): Omit<GitStatus, "isRepo" | "root"> {
	const status: Omit<GitStatus, "isRepo" | "root"> = { ahead: 0, behind: 0, files: [] };
	const parts = out.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const line = parts[i] ?? "";
		if (!line) continue;
		if (line.startsWith("# branch.head ")) {
			const head = line.slice(14);
			status.detached = head === "(detached)";
			status.branch = status.detached ? undefined : head;
		} else if (line.startsWith("# branch.upstream ")) {
			status.upstream = line.slice(18);
		} else if (line.startsWith("# branch.ab ")) {
			const m = /\+(\d+) -(\d+)/.exec(line);
			if (m) {
				status.ahead = Number(m[1]);
				status.behind = Number(m[2]);
			}
		} else if (line.startsWith("1 ")) {
			const f = line.split(" ");
			status.files.push({ path: f.slice(8).join(" "), index: f[1]?.[0] ?? ".", worktree: f[1]?.[1] ?? "." });
		} else if (line.startsWith("2 ")) {
			const f = line.split(" ");
			// A rename carries the original path as the next NUL-separated field.
			status.files.push({ path: f.slice(9).join(" "), origPath: parts[++i], index: f[1]?.[0] ?? ".", worktree: f[1]?.[1] ?? "." });
		} else if (line.startsWith("u ")) {
			const f = line.split(" ");
			status.files.push({ path: f.slice(10).join(" "), index: "U", worktree: "U" });
		} else if (line.startsWith("? ")) {
			status.files.push({ path: line.slice(2), index: "?", worktree: "?" });
		}
	}
	for (const f of status.files) {
		if (f.index === ".") f.index = " ";
		if (f.worktree === ".") f.worktree = " ";
	}
	return status;
}

export async function status(dir: string): Promise<GitStatus> {
	const probe = await runGit(dir, ["rev-parse", "--show-toplevel"]);
	if (probe.code !== 0) return { isRepo: false, ahead: 0, behind: 0, files: [] };
	const out = await git(dir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
	return { isRepo: true, root: probe.stdout.trim(), ...parseStatus(out) };
}

// ---------- history & branches ----------

const SEP = "\x1f";
const REC = "\x1e";

export function parseLog(out: string): GitCommit[] {
	return out
		.split(REC)
		.map((r) => r.replace(/^\n/, ""))
		.filter(Boolean)
		.map((r) => {
			const [hash = "", author = "", date = "", refs = "", subject = ""] = r.split(SEP);
			return { hash, short: hash.slice(0, 7), author, date, refs, subject };
		});
}

export async function log(dir: string, limit: number): Promise<GitCommit[]> {
	const n = Math.min(Math.max(Math.floor(limit) || 50, 1), 200);
	const r = await runGit(dir, ["log", `-n${n}`, `--format=%H${SEP}%an${SEP}%aI${SEP}%D${SEP}%s${REC}`]);
	if (r.code !== 0) return [];
	return parseLog(r.stdout);
}

export async function branches(dir: string): Promise<GitBranch[]> {
	const out = await git(dir, ["branch", "-a", "--format=%(HEAD)\t%(refname)\t%(refname:short)\t%(upstream:short)"]);
	const list: GitBranch[] = [];
	for (const line of out.split("\n")) {
		const [head, ref = "", short = "", upstream] = line.split("\t");
		if (!ref || ref.endsWith("/HEAD") || ref.includes("(")) continue;
		const remote = ref.startsWith("refs/remotes/");
		list.push({ name: short, current: head === "*", remote, ...(upstream ? { upstream } : {}) });
	}
	return list;
}

// ---------- diff ----------

function clip(text: string): GitDiff {
	return text.length > MAX_DIFF ? { text: text.slice(0, MAX_DIFF), truncated: true } : { text, truncated: false };
}

export async function diff(dir: string, path: string, staged: boolean, untracked: boolean): Promise<GitDiff> {
	checkPathspec(path);
	if (untracked) {
		// --no-index exits 1 when the files differ, which is the normal case here.
		const r = await runGit(dir, ["diff", "--no-index", "--no-color", "--", process.platform === "win32" ? "NUL" : "/dev/null", path]);
		return clip(r.stdout);
	}
	return clip(await git(dir, ["diff", "--no-color", ...(staged ? ["--cached"] : []), "--", path]));
}

export async function show(dir: string, hash: string): Promise<GitDiff> {
	if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new GitError("提交号不合法");
	return clip(await git(dir, ["show", "--no-color", "--stat", "--patch", "--format=fuller", hash, "--"]));
}

// ---------- mutations ----------

export async function stage(dir: string, paths: string[]): Promise<void> {
	await git(dir, ["add", "--", ...paths.map(checkPathspec)]);
}

export async function unstage(dir: string, paths: string[]): Promise<void> {
	// `restore --staged` fails on a repository with no commits yet; `rm --cached` is the fallback there.
	const specs = paths.map(checkPathspec);
	const r = await runGit(dir, ["restore", "--staged", "--", ...specs]);
	if (r.code !== 0) await git(dir, ["rm", "--cached", "-r", "-q", "--", ...specs]);
}

export async function discard(dir: string, files: { path: string; untracked: boolean }[]): Promise<void> {
	const tracked = files.filter((f) => !f.untracked).map((f) => checkPathspec(f.path));
	const fresh = files.filter((f) => f.untracked).map((f) => checkPathspec(f.path));
	if (tracked.length) await git(dir, ["restore", "--worktree", "--", ...tracked]);
	if (fresh.length) await git(dir, ["clean", "-f", "-q", "--", ...fresh]);
}

export async function commit(dir: string, message: string): Promise<string> {
	const msg = typeof message === "string" ? message.trim() : "";
	if (!msg) throw new GitError("提交说明不能为空");
	// The message goes through stdin so it can never be parsed as an option.
	await git(dir, ["commit", "-F", "-"], msg);
	return (await git(dir, ["rev-parse", "--short", "HEAD"])).trim();
}

export async function checkout(dir: string, name: string, create: boolean): Promise<void> {
	const ref = checkRef(name);
	await git(dir, create ? ["switch", "-c", ref] : ["switch", ref]);
}

export async function fetch(dir: string): Promise<string> {
	return (await git(dir, ["fetch", "--prune"])).trim();
}

export async function pull(dir: string): Promise<string> {
	return (await git(dir, ["pull", "--ff-only"])).trim() || "已是最新";
}

export async function push(dir: string): Promise<string> {
	const st = await status(dir);
	if (!st.branch) throw new GitError("当前不在任何分支上，无法推送");
	const args = st.upstream ? ["push"] : ["push", "-u", "origin", st.branch];
	const r = await runGit(dir, args);
	if (r.code !== 0) throw new GitError((r.stderr || r.stdout).trim().split("\n").slice(0, 6).join("\n"));
	return (r.stderr + r.stdout).trim() || "已推送";
}

export async function init(dir: string): Promise<void> {
	await git(dir, ["init"]);
}

export type { GitFileChange };
