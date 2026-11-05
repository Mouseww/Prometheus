import type { PluginContext, PluginLogger } from "@prometheus/plugin-sdk";
import { TeamError } from "../types.ts";
import { git, type GitIdentity, type GitRunOptions } from "./git.ts";
import type { HubClient } from "./hub-client.ts";
import type { StateStore } from "./state.ts";

/** The parts of the plugin context the member role needs; tests supply a small fake. */
export interface MemberHost {
	openSession: PluginContext["openSession"];
	sessions: PluginContext["sessions"];
}

/** Everything the member operations share. */
export interface MemberEnv {
	client: HubClient;
	state: StateStore;
	log: PluginLogger;
	/** Plugin settings from config.json (`teamRoot`). Read on every use so edits apply without a restart. */
	settings(): Record<string, unknown>;
	host: MemberHost;
	/** Which machine this plugin instance runs on: the user's own server ("local") or their tenant instance on the Hub host ("team"). */
	side: "local" | "team";
}

export function identityOf(env: MemberEnv): GitIdentity {
	const s = env.state.get();
	const id = s.userId ?? "member";
	return { name: s.displayName || id, email: s.email || `${id}@team.prometheus.invalid` };
}

/** git that talks to the Hub: a fresh token goes into the environment for this one command. */
export async function hubGit(env: MemberEnv, args: string[], cwd: string | undefined, extra: Partial<GitRunOptions> = {}): Promise<string> {
	const token = await env.client.ensureToken();
	return git(args, { cwd, token, identity: identityOf(env), ...extra });
}

/** git that stays on this machine (worktrees, commits). */
export function localGit(env: MemberEnv, args: string[], cwd: string | undefined, extra: Partial<GitRunOptions> = {}): Promise<string> {
	return git(args, { cwd, identity: identityOf(env), ...extra });
}

export function requireUserId(env: MemberEnv): string {
	const id = env.state.get().userId;
	if (!id || !env.client.loggedIn) throw new TeamError("notLoggedIn", "尚未登录团队 Hub", 401);
	return id;
}

export function gitUrl(hubUrl: string, workspaceId: string): string {
	return `${hubUrl}/plugins/team/git/${workspaceId}.git`;
}
