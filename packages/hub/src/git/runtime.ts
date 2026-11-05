import { join } from "node:path";
import type { HubConfig } from "../config.ts";
import { HubError } from "../errors.ts";
import { LOG_PREFIX, type HubLog } from "../log.ts";
import { detectGit, type GitCapabilities } from "./repo.ts";

/** Shared git settings for the workspace and merge request services, created once per Hub. */
export interface GitRuntime {
	/** Resolves once `git --version` has been checked (a Chinese log line is written for a missing or too old git). */
	readonly caps: Promise<GitCapabilities>;
	/** `<dataDir>/repos`, the `GIT_PROJECT_ROOT` of the smart HTTP backend. */
	readonly reposRoot: string;
	/** Tests only (explicit `HubOptions.allowLocalGitRemotes`): local paths and file:// remotes. */
	readonly allowLocalRemotes: boolean;
	repoPath(repoDir: string): string;
	/** Environment for git commands that talk to a remote: protocol allow-list, no prompts, optional token header (kept out of argv). */
	networkEnv(token?: string): Record<string, string>;
	requireGit(): Promise<GitCapabilities>;
	/** Throws 503 when merge-tree is unavailable (git older than 2.38). */
	requireMerge(): Promise<void>;
}

export function createGitRuntime(config: HubConfig, log: HubLog, allowLocalRemotes: boolean): GitRuntime {
	const caps = detectGit().then((c) => {
		if (!c.available) log.error(`${LOG_PREFIX} 未找到 git 命令，团队工作区与合并请求功能不可用`);
		else if (!c.mergeTree) log.error(`${LOG_PREFIX} git 版本 ${c.version ?? "未知"} 过低（合并请求需要 2.38 及以上），合并请求功能已禁用`);
		else log.info(`${LOG_PREFIX} 检测到 git ${c.version}`);
		return c;
	});
	const reposRoot = join(config.dataDir, "repos");
	return {
		caps,
		reposRoot,
		allowLocalRemotes,
		repoPath: (repoDir) => join(config.dataDir, repoDir),
		networkEnv(token) {
			const env: Record<string, string> = {
				GIT_ALLOW_PROTOCOL: allowLocalRemotes ? "https:ssh:file" : "https:ssh",
				GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
			};
			if (token) {
				env.GIT_CONFIG_COUNT = "1";
				env.GIT_CONFIG_KEY_0 = "http.extraHeader";
				env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
			}
			return env;
		},
		async requireGit() {
			const c = await caps;
			if (!c.available) throw new HubError(503, "gitUnavailable", "服务器未安装 git，无法使用团队工作区");
			return c;
		},
		async requireMerge() {
			const c = await this.requireGit();
			if (!c.mergeTree) throw new HubError(503, "mergeDisabled", `git 版本过低（${c.version ?? "未知"}），合并请求需要 2.38 及以上`);
		},
	};
}
