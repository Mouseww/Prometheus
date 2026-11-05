import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LOG, TeamError, type WorkspaceMapping } from "../types.ts";
import { gitUrl, hubGit, type MemberEnv, requireUserId } from "./env.ts";
import { safeSegment } from "./git.ts";

interface HubWorkspace {
	id: string;
	teamId: string;
	name: string;
	defaultBranch: string;
}

export function teamRootOf(env: MemberEnv): string {
	const configured = env.settings().teamRoot;
	return typeof configured === "string" && configured.trim() ? configured.trim() : join(homedir(), "PrometheusTeams");
}

/** Refspec that mirrors the Hub's default branch into `origin/<branch>`. */
export const defaultBranchRefspec = (branch: string): string => `+refs/heads/${branch}:refs/remotes/origin/${branch}`;

export async function fetchDefault(env: MemberEnv, mapping: WorkspaceMapping): Promise<void> {
	const branch = mapping.defaultBranch ?? "main";
	await hubGit(env, ["fetch", "--quiet", "origin", defaultBranchRefspec(branch)], mapping.repoDir);
}

/**
 * Clones (or refreshes) the workspace's source copy at `<teamRoot>/<team>/<workspace>/.repo`. The clone is only a source of
 * worktrees: it is not registered as a Prometheus workspace and its remote URL never contains the token.
 */
export async function checkoutWorkspace(env: MemberEnv, workspaceId: string): Promise<WorkspaceMapping & { workspaceId: string }> {
	requireUserId(env);
	const hubUrl = env.client.hubUrl as string;
	const ws = await env.client.call<HubWorkspace>("GET", `/workspaces/${encodeURIComponent(workspaceId)}`);
	const me = await env.client.call<{ teams: { id: string; name: string }[] }>("GET", "/me");
	const teamName = me.teams.find((t) => t.id === ws.teamId)?.name ?? ws.teamId;

	const repoDir = join(teamRootOf(env), safeSegment(teamName), safeSegment(ws.name), ".repo");
	if (existsSync(join(repoDir, ".git"))) {
		await hubGit(env, ["fetch", "--quiet", "origin", defaultBranchRefspec(ws.defaultBranch)], repoDir);
	} else {
		if (existsSync(repoDir)) throw new TeamError("checkoutBlocked", `${LOG} 目录 ${repoDir} 已存在但不是 git 仓库，请先移走它`, 409);
		await mkdir(dirname(repoDir), { recursive: true });
		await hubGit(env, ["clone", "--quiet", gitUrl(hubUrl, ws.id), repoDir], undefined);
	}

	const mapping: WorkspaceMapping = { repoDir, teamName, workspaceName: ws.name, teamId: ws.teamId, defaultBranch: ws.defaultBranch };
	await env.state.update((s) => ({ ...s, workspaces: { ...s.workspaces, [ws.id]: mapping } }));
	return { ...mapping, workspaceId: ws.id };
}

/** The workspace's mapping, cloning it first when this machine has not checked it out yet. */
export async function ensureWorkspace(env: MemberEnv, workspaceId: string): Promise<WorkspaceMapping> {
	const known = env.state.get().workspaces[workspaceId];
	if (known && existsSync(join(known.repoDir, ".git"))) return known;
	return checkoutWorkspace(env, workspaceId);
}
