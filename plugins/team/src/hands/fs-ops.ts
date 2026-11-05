import { spawn } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { TeamError } from "../types.ts";

export const MAX_OUTPUT_CHARS = 200_000;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILES = 5000;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "target", ".venv", "__pycache__"]);
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_TIMEOUT_MS = 10 * 60_000;

const clip = (text: string): string => (text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[输出过长，已截断，共 ${text.length} 个字符]` : text);

export interface ResolvedPath {
	abs: string;
	/** Whether the path is inside the session's worktree (after symlinks). */
	inside: boolean;
}

const within = (root: string, abs: string): boolean => {
	const rel = relative(root, abs);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Resolves a tool path against the worktree root (relative paths) or as given (absolute). `inside` is decided on the real
 * path, so a symlink in the worktree that points elsewhere counts as outside.
 */
export async function resolvePath(root: string | undefined, path: string | undefined): Promise<ResolvedPath> {
	const raw = path === undefined || path === "" ? "." : path;
	if (raw.includes("\0")) throw new TeamError("invalidParams", "路径含有非法字符");
	if (!root && !isAbsolute(raw)) throw new TeamError("noWorkingCopy", "这台机器上没有该会话的工作副本，只能使用绝对路径");
	const abs = resolve(root ?? "", raw);
	if (!root) return { abs, inside: false };
	let real = abs;
	try {
		real = await realpath(abs);
	} catch {
		// Does not exist (yet): the lexical check is all there is.
	}
	const realRoot = await realpath(root).catch(() => root);
	return { abs, inside: within(root, abs) && within(realRoot, real) };
}

export async function readOp(abs: string, opts: { offset?: number; limit?: number }): Promise<string> {
	const info = await stat(abs).catch(() => undefined);
	if (!info) throw new TeamError("notFound", `文件不存在: ${abs}`, 404);
	if (!info.isFile()) throw new TeamError("notFile", `不是文件: ${abs}`);
	const text = await readFile(abs, "utf8");
	if (opts.offset === undefined && opts.limit === undefined) return clip(text);
	const lines = text.split("\n");
	const start = Math.max(0, Math.trunc(opts.offset ?? 0));
	const end = opts.limit === undefined ? lines.length : start + Math.max(0, Math.trunc(opts.limit));
	return clip(lines.slice(start, end).join("\n"));
}

export async function lsOp(abs: string): Promise<string> {
	const info = await stat(abs).catch(() => undefined);
	if (!info) throw new TeamError("notFound", `目录不存在: ${abs}`, 404);
	if (!info.isDirectory()) throw new TeamError("notDirectory", `不是目录: ${abs}`);
	const entries = await readdir(abs, { withFileTypes: true });
	const lines = entries.map((e) => `${e.isDirectory() ? "d" : e.isSymbolicLink() ? "l" : "-"} ${e.name}${e.isDirectory() ? "/" : ""}`).sort((a, b) => a.slice(2).localeCompare(b.slice(2)));
	return clip(lines.join("\n") || "(空目录)");
}

async function* walk(dir: string, budget: { files: number }): AsyncGenerator<string> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (budget.files <= 0) return;
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) yield* walk(full, budget);
		} else if (e.isFile()) {
			budget.files--;
			yield full;
		}
	}
}

/** Regex search over text files below `abs` (a file or a directory); at most 200 matches, as `path:line: text`. */
export async function grepOp(abs: string, pattern: string, opts: { ignoreCase?: boolean; base?: string }): Promise<string> {
	let re: RegExp;
	try {
		re = new RegExp(pattern, opts.ignoreCase ? "i" : "");
	} catch {
		throw new TeamError("invalidParams", "pattern 不是有效的正则表达式");
	}
	const info = await stat(abs).catch(() => undefined);
	if (!info) throw new TeamError("notFound", `路径不存在: ${abs}`, 404);
	const out: string[] = [];
	const files = info.isDirectory() ? walk(abs, { files: MAX_GREP_FILES }) : (async function* () { yield abs; })();
	for await (const file of files) {
		const size = (await stat(file).catch(() => undefined))?.size ?? 0;
		if (size > MAX_GREP_FILE_BYTES) continue;
		const buf = await readFile(file).catch(() => undefined);
		if (!buf || buf.subarray(0, 1024).includes(0)) continue;
		const lines = buf.toString("utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (!re.test(lines[i] as string)) continue;
			out.push(`${relative(opts.base ?? abs, file) || file}:${i + 1}: ${(lines[i] as string).slice(0, 300)}`);
			if (out.length >= MAX_GREP_MATCHES) return `${out.join("\n")}\n...[已达到 ${MAX_GREP_MATCHES} 条匹配上限]`;
		}
	}
	return out.length === 0 ? "(没有匹配)" : out.join("\n");
}

/** Runs a shell command and resolves with its combined output and exit status; a timeout kills it. */
export function execOp(command: string, cwd: string, timeoutMs: number): Promise<string> {
	return new Promise((resolveRun, reject) => {
		const limit = Math.min(Math.max(timeoutMs, 1000), MAX_EXEC_TIMEOUT_MS);
		const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, limit);
		const collect = (d: Buffer): void => {
			if (out.length <= MAX_OUTPUT_CHARS * 2) out += d.toString("utf8");
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new TeamError("execFailed", `无法启动命令: ${err.message}`, 500));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const status = timedOut ? `命令超时 (${Math.round(limit / 1000)} 秒) 被终止` : `退出码 ${code ?? "未知"}`;
			resolveRun(clip(`${out.trimEnd()}\n[${status}]`.trimStart()));
		});
	});
}
