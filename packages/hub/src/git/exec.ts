import { spawn } from "node:child_process";

export class GitError extends Error {
	readonly code: number | null;
	readonly stderr: string;

	constructor(message: string, code: number | null, stderr: string) {
		super(message);
		this.name = "GitError";
		this.code = code;
		this.stderr = stderr;
	}
}

export interface GitRunOptions {
	/** Bare repository directory; becomes `--git-dir`. */
	gitDir?: string;
	cwd?: string;
	input?: Buffer | string;
	env?: Record<string, string>;
	timeoutMs?: number;
	/** Upper bound for captured stdout; the process is killed beyond it. */
	maxBuffer?: number;
	/** Exit codes other than 0 that are not errors (e.g. 1 for `merge-tree` conflicts). */
	okCodes?: readonly number[];
}

export interface GitResult {
	code: number;
	stdout: Buffer;
	stderr: string;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

/** Environment for non-interactive git: never prompt, stable English messages. */
export function baseGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...extra };
}

/** Runs `git` with an argument vector (never through a shell). Rejects with GitError on a non-zero exit outside `okCodes`. */
export function runGit(args: readonly string[], opts: GitRunOptions = {}): Promise<GitResult> {
	const full = opts.gitDir ? ["--git-dir", opts.gitDir, ...args] : [...args];
	return new Promise((resolve, reject) => {
		const child = spawn("git", full, { cwd: opts.cwd, env: baseGitEnv(opts.env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let outSize = 0;
		let failure: GitError | undefined;
		const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
		const timer = setTimeout(() => {
			failure = new GitError(`git ${args[0] ?? ""} 超时`, null, "");
			child.kill();
		}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		child.stdout.on("data", (chunk: Buffer) => {
			outSize += chunk.length;
			if (outSize > maxBuffer) {
				failure ??= new GitError(`git ${args[0] ?? ""} 输出过大`, null, "");
				child.kill();
				return;
			}
			out.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (err.reduce((n, b) => n + b.length, 0) < 64 * 1024) err.push(chunk);
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(new GitError(`无法运行 git: ${e.message}`, null, ""));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const stderr = Buffer.concat(err).toString("utf8").trim();
			if (failure) return reject(failure);
			const exit = code ?? -1;
			if (exit !== 0 && !(opts.okCodes ?? []).includes(exit)) {
				return reject(new GitError(`git ${args[0] ?? ""} 失败 (${exit}): ${stderr.split("\n")[0] ?? ""}`, exit, stderr));
			}
			resolve({ code: exit, stdout: Buffer.concat(out), stderr });
		});
		child.stdin.on("error", () => {});
		if (opts.input !== undefined) child.stdin.end(opts.input);
		else child.stdin.end();
	});
}

/** Convenience: stdout as trimmed UTF-8 text. */
export async function gitText(args: readonly string[], opts: GitRunOptions = {}): Promise<string> {
	return (await runGit(args, opts)).stdout.toString("utf8").trim();
}
