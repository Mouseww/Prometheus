import { isAbsolute, relative, resolve } from "node:path";
import { OPEN_FILE_TOOL, type PermissionMode, TODO_TOOL } from "@prometheus/protocol";

export const EXIT_PLAN_MODE = "exit_plan_mode";
/** Installs code that runs with the app's own permissions, so every use is confirmed and no answer is remembered. */
export const INSTALL_PLUGIN_TOOL = "prometheus_plugin_install";

export type ToolKind = "read" | "edit" | "exec" | "safe" | "other";

const READ = new Set(["read", "grep", "find", "ls"]);
const EDIT = new Set(["edit", "write"]);
const EXEC = new Set(["bash", "powershell"]);
// codemode only forwards to other tools, and every nested call passes through the gate itself.
const SAFE = new Set(["codemode", "tool_search", "knowledge_search", "memory_search", "memory_save", "memory_forget", EXIT_PLAN_MODE, TODO_TOOL, OPEN_FILE_TOOL]);

export function toolKind(name: string): ToolKind {
	if (READ.has(name)) return "read";
	if (EDIT.has(name)) return "edit";
	if (EXEC.has(name)) return "exec";
	if (SAFE.has(name)) return "safe";
	return "other";
}

// Redirections, substitutions and brace groups can hide writes or nested commands; anything using them is asked about.
const UNSAFE_SYNTAX = /[<>`{]|\$[({]/;
const SEPARATORS = /&&|\|\||[;|&\r\n]/;

const READ_ONLY_COMMANDS = new Set([
	"ls", "dir", "pwd", "cat", "head", "tail", "wc", "echo", "which", "where", "type", "whoami", "grep", "rg", "stat", "du", "df", "uname",
	"get-childitem", "get-content", "get-location", "select-string", "get-item", "test-path", "get-date", "write-output", "measure-object",
	"select-object", "sort-object", "resolve-path", "split-path", "format-table", "format-list",
]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "blame", "rev-parse", "ls-files", "describe", "shortlog"]);
// Running these through "always allow" would amount to allowing everything.
const WRAPPERS = new Set(["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh", "sudo", "su", "env", "xargs", "eval", "exec", "ssh", "start", "invoke-expression", "iex"]);

function words(segment: string): string[] {
	return segment.trim().split(/\s+/).filter(Boolean);
}

/** Lower-cased program name, or undefined when it is a path or an env-var prefix (`FOO=1 cmd`). */
function program(word: string | undefined): string | undefined {
	if (!word || /[\\/=]/.test(word)) return undefined;
	return word.toLowerCase().replace(/\.exe$/, "");
}

function segmentIsReadOnly(segment: string): boolean {
	const [first, ...args] = words(segment);
	const name = program(first);
	if (!name) return false;
	if (name === "git") {
		const sub = args[0];
		return !!sub && READ_ONLY_GIT.has(sub) && !args.some((a) => a.startsWith("--output"));
	}
	if (!READ_ONLY_COMMANDS.has(name)) return false;
	// ripgrep can run an arbitrary preprocessor.
	return !(name === "rg" && args.some((a) => a.startsWith("--pre") || a.startsWith("--hostname-bin")));
}

/** True only when every part of the command is on a short allowlist of non-mutating programs. */
export function isReadOnlyCommand(command: string): boolean {
	if (!command.trim() || UNSAFE_SYNTAX.test(command)) return false;
	return command.split(SEPARATORS).every((s) => !s.trim() || segmentIsReadOnly(s));
}

/** Program name when the command is one plain invocation (no chaining, redirection or substitution). */
export function simpleCommandKey(command: string): string | undefined {
	if (!command.trim() || UNSAFE_SYNTAX.test(command)) return undefined;
	const parts = command.split(SEPARATORS).filter((s) => s.trim());
	if (parts.length !== 1) return undefined;
	const name = program(words(parts[0] ?? "")[0]);
	return name && !WRAPPERS.has(name) ? name : undefined;
}

/** Whether `path` stays inside `cwd` and avoids directories that hold repository or agent configuration. */
export function isProjectPath(path: string, cwd: string): boolean {
	const rel = relative(cwd, resolve(cwd, path.replace(/^@/, "")));
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
	return !rel.split(/[\\/]/).some((s) => s === ".git" || s === ".pi");
}

export type Verdict = { type: "allow" } | { type: "block"; reason: string } | { type: "ask" };

export const PLAN_BLOCK_REASON =
	`Plan mode is active: only read-only tools may run. Investigate with read, grep, find and ls, then call ${EXIT_PLAN_MODE} with your plan so the user can approve it before anything is changed.`;

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Key under which an "always allow" answer is remembered for this call, if the call is eligible for one. */
export function ruleKey(toolName: string, input: Record<string, unknown>): string | undefined {
	const kind = toolKind(toolName);
	if (kind === "exec") {
		const key = simpleCommandKey(str(input.command));
		return key && `exec:${key}`;
	}
	return kind === "other" && toolName !== INSTALL_PLUGIN_TOOL ? `tool:${toolName}` : undefined;
}

export function decide(
	mode: PermissionMode,
	call: { toolName: string; input: Record<string, unknown>; /** Tool declares itself read-only (MCP annotation). */ readOnly?: boolean },
	env: { cwd: string; allowed: ReadonlySet<string> },
): Verdict {
	// A plugin outlives the chat and runs with the app's own rights, so even "bypass" does not skip this question.
	if (call.toolName === INSTALL_PLUGIN_TOOL) return mode === "plan" ? { type: "block", reason: PLAN_BLOCK_REASON } : { type: "ask" };
	if (mode === "bypassPermissions" || mode === "auto") return { type: "allow" };
	const kind = toolKind(call.toolName);
	if (kind === "read" || kind === "safe" || (kind === "other" && call.readOnly)) return { type: "allow" };
	if (kind === "exec" && isReadOnlyCommand(str(call.input.command))) return { type: "allow" };
	if (mode === "plan") return { type: "block", reason: PLAN_BLOCK_REASON };
	const key = ruleKey(call.toolName, call.input);
	if (key && env.allowed.has(key)) return { type: "allow" };
	if (kind === "edit" && mode === "acceptEdits" && isProjectPath(str(call.input.path), env.cwd)) return { type: "allow" };
	return { type: "ask" };
}
