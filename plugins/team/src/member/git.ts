import { spawn } from "node:child_process";
import { LOG, TeamError } from "../types.ts";

const MAX_OUTPUT = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface GitIdentity {
	name: string;
	email: string;
}

export interface GitRunOptions {
	cwd?: string;
	/** Hub access token. Sent as an `Authorization: Bearer` header through the environment, so it appears in neither argv, the URL nor any config file. */
	token?: string;
	identity?: GitIdentity;
	env?: Record<string, string>;
	input?: string;
	timeoutMs?: number;
}

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

function configEnv(token: string | undefined): Record<string, string> {
	// credential.helper="" stops git from consulting (or storing into) a credential helper; the token travels only as a header.
	// core.autocrlf=false: the Hub stores blobs byte for byte and replicas are compared by tree hash, so no machine may rewrite line endings
	// (Git for Windows defaults to autocrlf=true, which would check out CRLF and make other git tools, or a CRLF file's snapshot, disagree).
	// Repository .gitattributes still apply; only the per-user conversion is switched off. Command-line config outranks the user's own files.
	const entries: [string, string][] = [["credential.helper", ""], ["core.longpaths", "true"], ["core.quotepath", "false"], ["core.autocrlf", "false"]];
	if (token) entries.push(["http.extraHeader", `Authorization: Bearer ${token}`]);
	const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
	entries.forEach(([key, value], i) => {
		env[`GIT_CONFIG_KEY_${i}`] = key;
		env[`GIT_CONFIG_VALUE_${i}`] = value;
	});
	return env;
}

/** Runs git without a shell and never prompts. Resolves with the exit code instead of rejecting on a non-zero exit. */
export function runGit(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const identity = opts.identity;
		const child = spawn("git", args, {
			cwd: opts.cwd,
			windowsHide: true,
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
				GIT_EDITOR: "true",
				GIT_PAGER: "cat",
				LC_ALL: "C",
				...(identity ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : {}),
				...configEnv(opts.token),
				...opts.env,
			},
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let size = 0;
		const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		child.stdout.on("data", (d: Buffer) => {
			size += d.length;
			if (size <= MAX_OUTPUT) out.push(d);
		});
		child.stderr.on("data", (d: Buffer) => {
			if (err.length < 256) err.push(d);
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(new TeamError("gitMissing", (e as NodeJS.ErrnoException).code === "ENOENT" ? "未找到 git，请先安装 Git 并确保它在 PATH 中" : e.message, 500));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(opts.input ?? "");
	});
}

const redact = (text: string, token: string | undefined): string => (token ? text.split(token).join("***") : text);

/** Runs git and returns trimmed stdout; a non-zero exit becomes a TeamError carrying git's own message (token removed). */
export async function git(args: string[], opts: GitRunOptions = {}): Promise<string> {
	const r = await runGit(args, opts);
	if (r.code !== 0) {
		const detail = redact((r.stderr || r.stdout).trim(), opts.token).split("\n").slice(0, 8).join("\n");
		throw new TeamError("gitFailed", `${LOG} git ${args[0] ?? ""} 失败 (退出码 ${r.code}): ${detail}`, 500);
	}
	return r.stdout.trim();
}

/** A folder name for a team or workspace: no path separators, reserved characters or dot-only names. */
export function safeSegment(name: string): string {
	const cleaned = name
		// eslint-disable-next-line no-control-regex
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/g, "");
	return cleaned === "" || /^\.+$/.test(cleaned) ? "_" : cleaned.slice(0, 80);
}
