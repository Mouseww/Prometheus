import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import type { SubagentStep } from "@prometheus/protocol";
import type { RunHooks, RunJob } from "./types.ts";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface Executable {
	command: string;
	/** Arguments that go before the real ones (a script run through node). */
	prefix: string[];
}

/**
 * Find a CLI on PATH. On Windows npm installs `.cmd` shims, which cannot be spawned without a shell
 * (and a shell mangles JSON arguments), so the shim is read to find the real binary or script.
 */
export function resolveExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Executable | undefined {
	const win = platform === "win32";
	const exts = win ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())] : [""];
	const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
	for (const dir of dirs) {
		for (const ext of exts) {
			const file = join(dir, name + ext);
			if (!existsSync(file)) continue;
			const e = extname(file).toLowerCase();
			if (win && (e === ".cmd" || e === ".bat")) {
				const target = shimTarget(file);
				if (target) return target;
				continue;
			}
			if (win && e !== ".exe" && e !== ".com") continue;
			return { command: file, prefix: [] };
		}
	}
	return undefined;
}

/** The binary or script an npm `.cmd` shim launches. */
function shimTarget(shim: string): Executable | undefined {
	let text: string;
	try {
		text = readFileSync(shim, "utf8");
	} catch {
		return undefined;
	}
	const hits = [...text.matchAll(/"%dp0%[\\/]+([^"]+)"/gi)].map((m) => m[1] as string);
	for (const rel of hits.reverse()) {
		const file = resolve(dirname(shim), rel.replace(/\\/g, "/"));
		if (!existsSync(file)) continue;
		return /\.(c|m)?js$/i.test(file) ? { command: process.execPath, prefix: [file] } : { command: file, prefix: [] };
	}
	return undefined;
}

export const CLI_BINARY = { "claude-code": "claude", codex: "codex" } as const;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\-[\]]{0,99}$/;

export function cliAvailable(kind: keyof typeof CLI_BINARY): boolean {
	return resolveExecutable(CLI_BINARY[kind]) !== undefined;
}

// ---------- argv ----------

const CLAUDE_READ_TOOLS = "Read,Grep,Glob";
const CLAUDE_WRITE_TOOLS = "Read,Grep,Glob,Edit,Write,Bash";

export function claudeArgs(job: RunJob): string[] {
	const args = ["-p", "--input-format", "text", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--disable-slash-commands"];
	if (job.def.writable) args.push("--permission-mode", "acceptEdits", "--tools", CLAUDE_WRITE_TOOLS, "--allowedTools", CLAUDE_WRITE_TOOLS);
	else args.push("--permission-mode", "plan", "--tools", CLAUDE_READ_TOOLS, "--allowedTools", CLAUDE_READ_TOOLS);
	const model = job.model?.trim();
	if (model) {
		if (!MODEL_RE.test(model)) throw new Error(`Claude Code 的模型名不合法: ${model}`);
		args.push("--model", model);
	}
	return args;
}

export function codexArgs(job: RunJob, lastMessageFile: string): string[] {
	const args = ["exec", "--json", "--color", "never", "--ephemeral", "--skip-git-repo-check", "-s", job.def.writable ? "workspace-write" : "read-only", "-c", 'approval_policy="never"'];
	const model = job.model?.trim();
	if (model) {
		if (!MODEL_RE.test(model)) throw new Error(`Codex 的模型名不合法: ${model}`);
		args.push("-m", model);
	}
	const level = job.thinking?.trim();
	if (level && ["minimal", "low", "medium", "high", "xhigh"].includes(level)) args.push("-c", `model_reasoning_effort="${level}"`);
	args.push("--output-last-message", lastMessageFile, "-");
	return args;
}

/** What the CLI is told: the agent's brief, then the task. */
export function composePrompt(job: RunJob): string {
	const brief = job.def.prompt.trim();
	return brief ? `${brief}\n\n# Task\n\n${job.task}\n` : `${job.task}\n`;
}

// ---------- event parsing ----------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const toolInput = (input: unknown): string => {
	const o = rec(input);
	if (!o) return "";
	const first = str(o.command) || str(o.file_path) || str(o.path) || str(o.pattern) || str(o.query);
	return first || clip(JSON.stringify(o), 300);
};

const resultText = (content: unknown): string => {
	if (typeof content === "string") return content;
	return arr(content)
		.map((b) => str(rec(b)?.text))
		.filter(Boolean)
		.join("\n");
};

export interface ClaudeOutcome {
	output?: string;
	error?: string;
}

/** Fold one `stream-json` line from Claude Code into the run's progress. */
export function readClaudeLine(line: string, hooks: RunHooks, open: Map<string, SubagentStep>): ClaudeOutcome | undefined {
	let event: Rec | undefined;
	try {
		event = rec(JSON.parse(line));
	} catch {
		return undefined;
	}
	if (!event) return undefined;
	if (event.type === "assistant") {
		const message = rec(event.message);
		for (const b of arr(message?.content)) {
			const block = rec(b);
			if (block?.type === "text" && str(block.text).trim()) hooks.step({ kind: "text", text: str(block.text) });
			else if (block?.type === "thinking" && str(block.thinking).trim()) hooks.step({ kind: "thinking", text: str(block.thinking) });
			else if (block?.type === "tool_use") {
				const step: SubagentStep = { kind: "tool", text: "", tool: str(block.name), args: toolInput(block.input) };
				open.set(str(block.id), step);
				hooks.step(step);
				hooks.tool(str(block.name));
			}
		}
		return undefined;
	}
	if (event.type === "user") {
		for (const b of arr(rec(event.message)?.content)) {
			const block = rec(b);
			if (block?.type !== "tool_result") continue;
			const step = open.get(str(block.tool_use_id));
			if (step) {
				step.result = clip(resultText(block.content), 4000);
				if (block.is_error === true) step.isError = true;
				hooks.touch();
			}
		}
		return undefined;
	}
	if (event.type === "result") {
		const usage = rec(event.usage);
		const tokens = (Number(usage?.input_tokens) || 0) + (Number(usage?.output_tokens) || 0);
		if (tokens) hooks.tokens(tokens);
		if (event.subtype === "success" && event.is_error !== true) return { output: str(event.result).trim() };
		return { error: str(event.result).trim() || `Claude Code 以 ${str(event.subtype) || "未知"} 状态结束` };
	}
	return undefined;
}

export interface CodexOutcome {
	error?: string;
	done?: boolean;
}

/** Fold one `exec --json` line from Codex into the run's progress. */
export function readCodexLine(line: string, hooks: RunHooks, open: Map<string, SubagentStep>): CodexOutcome | undefined {
	let event: Rec | undefined;
	try {
		event = rec(JSON.parse(line));
	} catch {
		return undefined;
	}
	if (!event) return undefined;
	const type = str(event.type);
	const item = rec(event.item);
	if ((type === "item.started" || type === "item.completed") && item) {
		const kind = str(item.type);
		const id = str(item.id);
		if (kind === "command_execution") {
			let step = open.get(id);
			if (!step) {
				step = { kind: "tool", text: "", tool: "bash", args: clip(str(item.command), 400) };
				open.set(id, step);
				hooks.step(step);
				hooks.tool("bash");
			}
			if (type === "item.completed") {
				step.result = clip(str(item.aggregated_output), 4000);
				if (typeof item.exit_code === "number" && item.exit_code !== 0) step.isError = true;
				hooks.touch();
			}
		} else if (type === "item.completed" && kind === "agent_message" && str(item.text).trim()) {
			hooks.step({ kind: "text", text: str(item.text) });
		} else if (type === "item.completed" && kind === "reasoning" && str(item.text).trim()) {
			hooks.step({ kind: "thinking", text: str(item.text) });
		} else if (type === "item.started" && kind === "file_change") {
			hooks.step({ kind: "tool", text: "", tool: "edit", args: clip(JSON.stringify(item.changes ?? ""), 300) });
			hooks.tool("edit");
		}
		return undefined;
	}
	if (type === "turn.completed") {
		const usage = rec(event.usage);
		const tokens = (Number(usage?.input_tokens) || 0) + (Number(usage?.output_tokens) || 0);
		if (tokens) hooks.tokens(tokens);
		return { done: true };
	}
	if (type === "turn.failed") return { error: str(rec(event.error)?.message) || "Codex 运行失败" };
	if (type === "error") return { error: str(event.message) || "Codex 报错" };
	return undefined;
}

// ---------- process ----------

function killTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) return;
	if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
	else child.kill("SIGTERM");
}

interface Spawned {
	code: number | null;
	stderr: string;
}

/** Run a CLI, feed it `input`, hand every stdout line to `onLine`. */
function runProcess(exe: Executable, args: string[], input: string, cwd: string, signal: AbortSignal, onLine: (line: string) => void): Promise<Spawned> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(exe.command, [...exe.prefix, ...args], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: process.env });
		let stderr = "";
		let buffer = "";
		const abort = () => killTree(child);
		if (signal.aborted) abort();
		signal.addEventListener("abort", abort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let i = buffer.indexOf("\n");
			while (i >= 0) {
				const line = buffer.slice(0, i).trim();
				buffer = buffer.slice(i + 1);
				if (line) onLine(line);
				i = buffer.indexOf("\n");
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
		});
		child.on("error", (err) => {
			signal.removeEventListener("abort", abort);
			reject(err);
		});
		child.on("close", (code) => {
			signal.removeEventListener("abort", abort);
			if (buffer.trim()) onLine(buffer.trim());
			resolveRun({ code, stderr });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

const MISSING = (name: string) => `找不到 ${name} 命令行工具。请先安装并登录，或把该子代理的运行器改回 PI`;

export async function runClaude(job: RunJob, hooks: RunHooks, signal: AbortSignal): Promise<string> {
	const exe = resolveExecutable(CLI_BINARY["claude-code"]);
	if (!exe) throw new Error(MISSING("claude"));
	const open = new Map<string, SubagentStep>();
	let outcome: ClaudeOutcome | undefined;
	const res = await runProcess(exe, claudeArgs(job), composePrompt(job), job.cwd, signal, (line) => {
		outcome = readClaudeLine(line, hooks, open) ?? outcome;
	});
	if (signal.aborted) throw new Error("已停止");
	if (outcome?.error) throw new Error(outcome.error);
	if (outcome?.output !== undefined) return outcome.output;
	throw new Error(res.stderr.trim() || `Claude Code 退出码 ${res.code}，没有返回结果`);
}

export async function runCodex(job: RunJob, hooks: RunHooks, signal: AbortSignal): Promise<string> {
	const exe = resolveExecutable(CLI_BINARY.codex);
	if (!exe) throw new Error(MISSING("codex"));
	const dir = await mkdtemp(join(tmpdir(), "prom-codex-"));
	const file = join(dir, "last.txt");
	try {
		const open = new Map<string, SubagentStep>();
		let failure: string | undefined;
		const res = await runProcess(exe, codexArgs(job, file), composePrompt(job), job.cwd, signal, (line) => {
			failure = readCodexLine(line, hooks, open)?.error ?? failure;
		});
		if (signal.aborted) throw new Error("已停止");
		const last = existsSync(file) ? (await readFile(file, "utf8")).trim() : "";
		if (last) return last;
		throw new Error(failure || res.stderr.trim() || `Codex 退出码 ${res.code}，没有返回结果`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
