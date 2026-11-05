import type { PluginTool, PluginToolResult } from "@prometheus/plugin-sdk";
import type { MemberEnv } from "../member/env.ts";
import type { SyncManager } from "../sync/manager.ts";
import { errorMessage, TeamError } from "../types.ts";
import type { HandCaller } from "./caller.ts";

type Param = Record<string, unknown>;
const str = (description: string): Param => ({ type: "string", description });
const obj = (properties: Record<string, Param>, required: string[] = []): Param => ({ type: "object", properties, required, additionalProperties: false });

interface ToolSpec {
	name: string;
	label: string;
	description: string;
	snippet: string;
	parameters: Param;
	readOnly: boolean;
}

/** Tools of the tenant instance: they reach the user's own machine (the user confirms each kind of request). */
const LOCAL_SPECS: ToolSpec[] = [
	{
		name: "local_read",
		label: "读取本机文件",
		description: "在【用户本机】上读取文件，而不是在这台团队 server 上。路径相对于该会话在本机的工作副本，也可以是绝对路径。每次访问前用户需要在自己的界面上确认。",
		snippet: "local_read: 读取用户本机上的文件 (需要用户确认)",
		parameters: obj({ path: str("文件路径"), offset: { type: "number", description: "起始行 (从 0 开始)" }, limit: { type: "number", description: "最多读取的行数" } }, ["path"]),
		readOnly: true,
	},
	{
		name: "local_ls",
		label: "列出本机目录",
		description: "在【用户本机】上列出目录内容，而不是在这台团队 server 上。路径相对于该会话在本机的工作副本，也可以是绝对路径。需要用户确认。",
		snippet: "local_ls: 列出用户本机上的目录 (需要用户确认)",
		parameters: obj({ path: str("目录路径，默认是工作副本根目录") }),
		readOnly: true,
	},
	{
		name: "local_grep",
		label: "在本机搜索",
		description: "在【用户本机】上用正则表达式搜索文本文件内容，而不是在这台团队 server 上。需要用户确认。",
		snippet: "local_grep: 在用户本机上搜索文件内容 (需要用户确认)",
		parameters: obj({ pattern: str("正则表达式"), path: str("搜索的目录或文件，默认是工作副本根目录"), ignoreCase: { type: "boolean" } }, ["pattern"]),
		readOnly: true,
	},
	{
		name: "local_exec",
		label: "在本机执行命令",
		description: "在【用户本机】上执行 shell 命令，而不是在这台团队 server 上，适合需要本机环境、设备或内网资源的操作。命令在该会话的本机工作副本中运行，每次都需要用户确认。",
		snippet: "local_exec: 在用户本机上执行命令 (需要用户确认)",
		parameters: obj({ command: str("要执行的命令"), cwd: str("工作目录，默认是工作副本根目录"), timeoutMs: { type: "number", description: "超时毫秒数，默认 120000" } }, ["command"]),
		readOnly: false,
	},
];

/** Tools of the user's local server: they reach their isolated instance on the team server. */
const TEAM_SPECS: ToolSpec[] = [
	{
		name: "team_read",
		label: "读取团队 server 文件",
		description: "在【团队 server 上你的隔离实例】中读取文件，而不是在本机。路径相对于该会话在团队 server 上的工作目录。调用前本机的最新文件会先同步过去。",
		snippet: "team_read: 读取团队 server 实例中的文件",
		parameters: obj({ path: str("文件路径"), offset: { type: "number", description: "起始行 (从 0 开始)" }, limit: { type: "number", description: "最多读取的行数" } }, ["path"]),
		readOnly: true,
	},
	{
		name: "team_ls",
		label: "列出团队 server 目录",
		description: "在【团队 server 上你的隔离实例】中列出目录内容，而不是在本机。路径相对于该会话在团队 server 上的工作目录。",
		snippet: "team_ls: 列出团队 server 实例中的目录",
		parameters: obj({ path: str("目录路径，默认是工作目录根") }),
		readOnly: true,
	},
	{
		name: "team_exec",
		label: "在团队 server 执行命令",
		description:
			"在【团队 server 上你的隔离实例】中执行 shell 命令，而不是在本机，适合更强的算力、团队内网或需要长时间运行的任务。命令的文件改动会同步回本机。受限模式的实例不允许执行命令。",
		snippet: "team_exec: 在团队 server 实例中执行命令",
		parameters: obj({ command: str("要执行的命令"), cwd: str("工作目录，默认是工作目录根"), timeoutMs: { type: "number", description: "超时毫秒数，默认 120000" } }, ["command"]),
		readOnly: false,
	},
];

const text = (value: string, isError = false): PluginToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

export interface ToolDeps {
	env: MemberEnv;
	caller: Pick<HandCaller, "call">;
	sync: Pick<SyncManager, "barrierIfDirty" | "settle">;
}

/**
 * Builds the hand tools of this side. A plugin cannot register a tool for one session only, so the tools exist everywhere on this server
 * and refuse politely in sessions that are not (or no longer) active team sessions.
 */
export function buildHandTools(deps: ToolDeps): PluginTool[] {
	const { env } = deps;
	const specs = env.side === "local" ? TEAM_SPECS : LOCAL_SPECS;
	const target: "local" | "team" = env.side === "local" ? "team" : "local";
	return specs.map((spec) => ({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		promptSnippet: spec.snippet,
		parameters: spec.parameters,
		annotations: { readOnlyHint: spec.readOnly },
		async execute(_id, params, _signal, _update, ctx): Promise<PluginToolResult> {
			try {
				const mapping = ctx.sessionId ? env.state.get().sessions[ctx.sessionId] : undefined;
				if (!mapping) throw new TeamError("notTeamSession", "这个工具只能在团队会话中使用 (会话的目录必须在团队工作区的 worktree 内)");
				if (mapping.readOnly) throw new TeamError("sessionReadOnly", "这个会话已经移交到另一端执行，请在那一端继续");
				const input = typeof params === "object" && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
				await deps.sync.barrierIfDirty(mapping.hubSessionId);
				const output = await deps.caller.call(target, spec.name, input, mapping.hubSessionId);
				// Files a command changed over there arrive before the model sees the result.
				await deps.sync.settle(mapping.hubSessionId);
				return text(output);
			} catch (err) {
				const code = err instanceof TeamError ? ` (${err.code})` : "";
				return text(`${errorMessage(err)}${code}`, true);
			}
		},
	}));
}

export const HAND_TOOL_NAMES = { local: TEAM_SPECS.map((s) => s.name), team: LOCAL_SPECS.map((s) => s.name) } as const;
