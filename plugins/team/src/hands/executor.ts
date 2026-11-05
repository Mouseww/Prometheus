import type { MemberEnv } from "../member/env.ts";
import type { SyncManager } from "../sync/manager.ts";
import { errorMessage, LOG, TeamError } from "../types.ts";
import type { ConfirmGate } from "./confirm.ts";
import { DEFAULT_EXEC_TIMEOUT_MS, execOp, grepOp, lsOp, readOp, resolvePath } from "./fs-ops.ts";
import { shellDisabled } from "./policy.ts";

export const LOCAL_TOOLS = ["local_read", "local_ls", "local_grep", "local_exec"] as const;
export const TEAM_TOOLS = ["team_read", "team_ls", "team_exec"] as const;

export interface IncomingCall {
	callId: string;
	/** Hub id of the session that asks (this machine finds its worktree by it). */
	fromSession: string;
	tool: string;
	input: Record<string, unknown>;
}

export interface ExecutorDeps {
	env: MemberEnv;
	sync: Pick<SyncManager, "target" | "publish">;
	gate: ConfirmGate;
	/** Whether the administrator's policy forbids running commands here (default: reads `PROMETHEUS_POLICY`). */
	shellDisabled?: () => Promise<boolean>;
}

const optString = (input: Record<string, unknown>, key: string): string | undefined => {
	const v = input[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string") throw new TeamError("invalidParams", `${key} 必须是字符串`);
	return v;
};
const reqString = (input: Record<string, unknown>, key: string): string => {
	const v = optString(input, key);
	if (!v || !v.trim()) throw new TeamError("invalidParams", `缺少参数 ${key}`);
	return v;
};
const optNumber = (input: Record<string, unknown>, key: string): number | undefined => {
	const v = input[key];
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v)) throw new TeamError("invalidParams", `${key} 必须是数字`);
	return v;
};

/**
 * The target end of a hand call (spec 4): runs `local_*` tools on the user's machine after they confirmed, and `team_*` tools in the
 * tenant instance's worktree (no question, but the tenant's own policy still applies).
 */
export class HandExecutor {
	private readonly deps: ExecutorDeps;

	constructor(deps: ExecutorDeps) {
		this.deps = deps;
	}

	async run(call: IncomingCall): Promise<string> {
		const { env } = this.deps;
		const onLocal = env.side === "local";
		const known: readonly string[] = onLocal ? LOCAL_TOOLS : TEAM_TOOLS;
		if (!known.includes(call.tool)) throw new TeamError("handTarget", `这台${onLocal ? "本机" : "团队 server"}不执行工具 ${call.tool}`);
		const op = call.tool.split("_")[1] as "read" | "ls" | "grep" | "exec";
		const target = this.deps.sync.target(call.fromSession);
		const root = target?.worktree;
		if (!onLocal && !root) throw new TeamError("noWorkingCopy", "团队 server 中还没有该会话的工作副本，请先让本机同步一次 (换手屏障) 再试", 409);
		if (!onLocal && op === "exec" && (await (this.deps.shellDisabled ?? shellDisabled)())) {
			throw new TeamError("toolDisabled", "团队 server 的策略禁用了命令执行 (受限模式)，team_exec 不可用", 403);
		}

		const pathArg = op === "exec" ? optString(call.input, "cwd") : optString(call.input, "path");
		const resolved = await resolvePath(root, pathArg);
		if (!onLocal && !resolved.inside) throw new TeamError("outsideWorkingCopy", "团队 server 上只能访问该会话的工作目录内的路径", 403);
		if (onLocal) await this.deps.gate.request({ callId: call.callId, tool: call.tool, input: call.input, session: call.fromSession }, resolved.inside);

		let output: string;
		switch (op) {
			case "read":
				output = await readOp(resolved.abs, { offset: optNumber(call.input, "offset"), limit: optNumber(call.input, "limit") });
				break;
			case "ls":
				output = await lsOp(resolved.abs);
				break;
			case "grep":
				output = await grepOp(resolved.abs, reqString(call.input, "pattern"), { ignoreCase: call.input.ignoreCase === true, base: root ?? resolved.abs });
				break;
			case "exec":
				output = await execOp(reqString(call.input, "command"), resolved.abs, optNumber(call.input, "timeoutMs") ?? DEFAULT_EXEC_TIMEOUT_MS);
				// Files may have changed: the other side gets them before it sees the answer.
				if (target) await this.deps.sync.publish(call.fromSession).catch((err: unknown) => env.log.warn(`${LOG} 命令执行后上传快照失败: ${errorMessage(err)}`));
				break;
		}
		return output;
	}
}
