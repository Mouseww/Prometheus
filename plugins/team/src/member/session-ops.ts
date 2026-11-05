import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { errorMessage, LOG, type SessionMapping, TeamError, type WorkspaceMapping } from "../types.ts";
import { ensureWorkspace, fetchDefault } from "./checkout.ts";
import { hubGit, identityOf, localGit, type MemberEnv, requireUserId } from "./env.ts";
import { runGit } from "./git.ts";
import { stageEverything } from "./snapshot.ts";
import { snapshotRef } from "../sync/refs.ts";

interface HubSession {
	id: string;
	workspaceId: string;
	ownerUserId: string;
	title: string;
	branch: string;
	baseCommit: string;
	snapshotCommit: string | null;
}

interface ForkReply {
	session: HubSession;
	transcript: { format: string; content: string } | null;
	snapshotCommit: string | null;
	branch: string;
	sourceBranch: string;
}

const shortId = (): string => randomBytes(5).toString("hex");
const workspaceLabel = (m: WorkspaceMapping, title: string): string => `${m.teamName}/${m.workspaceName}: ${title}`;

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new TeamError("invalidParams", `缺少参数 ${name}`);
	return value.trim();
}

async function addWorktree(env: MemberEnv, mapping: WorkspaceMapping, worktree: string, branch: string, startPoint: string): Promise<void> {
	await localGit(env, ["worktree", "add", "--no-track", "-b", branch, worktree, startPoint], mapping.repoDir);
}

async function removeWorktree(env: MemberEnv, mapping: WorkspaceMapping, worktree: string, branch: string): Promise<void> {
	await localGit(env, ["worktree", "remove", "--force", worktree], mapping.repoDir).catch(() => {});
	await localGit(env, ["branch", "-D", branch], mapping.repoDir).catch(() => {});
}

async function saveSession(env: MemberEnv, localId: string, mapping: SessionMapping): Promise<void> {
	await env.state.update((s) => ({ ...s, sessions: { ...s.sessions, [localId]: mapping } }));
}

/** A new team session: worktree on its own branch, a PI session in it, and the Hub registration tying them together. */
export async function startSession(env: MemberEnv, params: Record<string, unknown>): Promise<{ sessionId: string; hubSessionId: string; worktree: string; branch: string }> {
	const userId = requireUserId(env);
	const workspaceId = requireString(params.workspaceId, "workspaceId");
	const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : "新会话";
	const mapping = await ensureWorkspace(env, workspaceId);
	await fetchDefault(env, mapping);

	const id = shortId();
	// The Hub assigns the session id on registration, after the local session exists, so the branch carries a local id instead.
	const branch = `session/${userId}/${id}`;
	const worktree = join(dirname(mapping.repoDir), "sessions", id);
	const base = await localGit(env, ["rev-parse", "--verify", `origin/${mapping.defaultBranch ?? "main"}`], mapping.repoDir);
	await addWorktree(env, mapping, worktree, branch, base);
	try {
		const opened = await env.host.openSession({ cwd: worktree, name: title, workspaceName: workspaceLabel(mapping, title), runtime: "pi" });
		const registered = await env.client.call<HubSession>("POST", `/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
			localSessionId: opened.sessionId,
			serverId: env.state.get().serverId,
			title,
			branch,
			baseCommit: base,
			// A session started inside the tenant instance runs on the team side from the beginning.
			...(env.side === "team" ? { execLocation: "team" } : {}),
		});
		await saveSession(env, opened.sessionId, { hubSessionId: registered.id, workspaceId, teamId: mapping.teamId ?? "", worktree, branch });
		return { sessionId: opened.sessionId, hubSessionId: registered.id, worktree, branch };
	} catch (err) {
		await removeWorktree(env, mapping, worktree, branch);
		throw err;
	}
}

/** Takes someone else's session over as a copy: their snapshot as the starting files, their transcript as the history. */
export async function forkSession(env: MemberEnv, params: Record<string, unknown>): Promise<{ sessionId: string; hubSessionId: string; worktree: string; branch: string }> {
	requireUserId(env);
	const sourceId = requireString(params.hubSessionId, "hubSessionId");
	const source = await env.client.call<HubSession & { ownerUserId: string }>("GET", `/sessions/${encodeURIComponent(sourceId)}`);
	const mapping = await ensureWorkspace(env, source.workspaceId);
	const fork = await env.client.call<ForkReply>("POST", `/sessions/${encodeURIComponent(sourceId)}/fork`, typeof params.title === "string" ? { title: params.title } : {});

	await fetchDefault(env, mapping);
	let start: string | undefined;
	if (fork.snapshotCommit) {
		const ref = snapshotRef(source.ownerUserId, source.id);
		await hubGit(env, ["fetch", "--quiet", "origin", `+${ref}:${ref}`], mapping.repoDir).catch((err: unknown) => env.log.warn(`${LOG} 获取原会话快照失败，改用其分支: ${errorMessage(err)}`));
		start = fork.snapshotCommit;
	}
	if (!start || !(await commitExists(mapping, start))) {
		const refspec = `+refs/heads/${fork.sourceBranch}:refs/remotes/origin/${fork.sourceBranch}`;
		await hubGit(env, ["fetch", "--quiet", "origin", refspec], mapping.repoDir).catch(() => {});
		start = (await commitExists(mapping, `origin/${fork.sourceBranch}`)) ? `origin/${fork.sourceBranch}` : fork.session.baseCommit;
	}

	const worktree = join(dirname(mapping.repoDir), "sessions", shortId());
	await addWorktree(env, mapping, worktree, fork.branch, start);
	try {
		const title = fork.session.title || source.title || "Fork";
		let localId: string;
		if (fork.transcript) {
			const content = gunzipSync(Buffer.from(fork.transcript.content, "base64")).toString("utf8");
			({ sessionId: localId } = await env.host.sessions.importTranscript({ cwd: worktree, content, name: title, workspaceName: workspaceLabel(mapping, title), runtime: "pi" }));
		} else {
			({ sessionId: localId } = await env.host.openSession({ cwd: worktree, name: title, workspaceName: workspaceLabel(mapping, title), runtime: "pi" }));
		}
		await env.client.call("PATCH", `/sessions/${fork.session.id}`, { localSessionId: localId, serverId: env.state.get().serverId });
		await saveSession(env, localId, { hubSessionId: fork.session.id, workspaceId: source.workspaceId, teamId: mapping.teamId ?? "", worktree, branch: fork.branch });
		return { sessionId: localId, hubSessionId: fork.session.id, worktree, branch: fork.branch };
	} catch (err) {
		await removeWorktree(env, mapping, worktree, fork.branch);
		throw err;
	}
}

async function commitExists(mapping: WorkspaceMapping, rev: string): Promise<boolean> {
	const r = await runGit(["cat-file", "-e", `${rev}^{commit}`], { cwd: mapping.repoDir });
	return r.code === 0;
}

function mappingOf(env: MemberEnv, localId: string): SessionMapping {
	const mapping = env.state.get().sessions[localId];
	if (!mapping) throw new TeamError("notTeamSession", "该会话不是团队会话", 404);
	return mapping;
}

/** Commits the worktree for real, pushes the session branch and opens a merge request. */
export async function submitSession(env: MemberEnv, params: Record<string, unknown>): Promise<unknown> {
	requireUserId(env);
	const localId = requireString(params.sessionId, "sessionId");
	const title = requireString(params.title, "title");
	const mapping = mappingOf(env, localId);

	await stageEverything(mapping.worktree, identityOf(env));
	const staged = await runGit(["diff", "--cached", "--quiet"], { cwd: mapping.worktree });
	if (staged.code === 1) await localGit(env, ["commit", "--quiet", "-m", title], mapping.worktree);
	const head = await localGit(env, ["rev-parse", "--verify", "HEAD"], mapping.worktree);
	await hubGit(env, ["push", "--quiet", "origin", `HEAD:refs/heads/${mapping.branch}`], mapping.worktree);

	const hubSession = await env.client.call<HubSession>("GET", `/sessions/${mapping.hubSessionId}`);
	return env.client.call("POST", `/workspaces/${encodeURIComponent(mapping.workspaceId)}/merge-requests`, {
		sessionId: mapping.hubSessionId,
		title,
		...(typeof params.description === "string" ? { description: params.description } : {}),
		branch: mapping.branch,
		baseCommit: hubSession.baseCommit,
		headCommit: head,
		...(params.skipReview === true ? { skipReview: true } : {}),
	});
}

/** Settles one binary conflict of a merge request in favour of the author's file or the team's, then re-checks the request. */
export async function resolveBinary(env: MemberEnv, params: Record<string, unknown>): Promise<unknown> {
	requireUserId(env);
	const mergeRequestId = requireString(params.mergeRequestId, "mergeRequestId");
	const path = requireString(params.path, "path");
	if (path.startsWith("-") || path.includes("\0") || path.split(/[\\/]/).includes("..") || /^([a-zA-Z]:|[\\/])/.test(path)) throw new TeamError("invalidParams", "文件路径无效");
	if (params.keep !== "mine" && params.keep !== "team") throw new TeamError("invalidParams", "keep 必须是 mine 或 team");

	const mr = await env.client.call<{ id: string; workspaceId: string; branch: string; sessionId: string | null }>("GET", `/merge-requests/${encodeURIComponent(mergeRequestId)}`);
	const [, mapping] = Object.entries(env.state.get().sessions).find(([, m]) => m.branch === mr.branch) ?? [];
	if (!mapping) throw new TeamError("notTeamSession", "找不到该合并请求对应的本地会话", 404);
	const ws = env.state.get().workspaces[mr.workspaceId] ?? (await ensureWorkspace(env, mr.workspaceId));
	await fetchDefault(env, ws);

	const dir = mapping.worktree;
	if (!existsSync(dir)) throw new TeamError("worktreeMissing", `会话目录不存在: ${dir}`, 404);
	const inMerge = (await runGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: dir })).code === 0;
	if (!inMerge) {
		const merged = await runGit(["merge", "--no-edit", `origin/${ws.defaultBranch ?? "main"}`], { cwd: dir, identity: identityOf(env) });
		if (merged.code !== 0 && !(await hasUnmerged(dir))) throw new TeamError("mergeFailed", `${LOG} 合并团队分支失败: ${merged.stderr.trim() || merged.stdout.trim()}`, 500);
	}
	// While merging the session branch, "ours" is the author's file and "theirs" is the team's.
	await localGit(env, ["checkout", `--${params.keep === "mine" ? "ours" : "theirs"}`, "--", path], dir);
	await localGit(env, ["add", "--", path], dir);

	const remaining = await unmergedPaths(dir);
	if (remaining.length > 0) return { committed: false, remaining };
	await localGit(env, ["commit", "--quiet", "--no-edit"], dir).catch(async (err: unknown) => {
		// Nothing to commit (the merge was already finished) is fine; anything else is not.
		if ((await runGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: dir })).code === 0) throw err;
	});
	await hubGit(env, ["push", "--quiet", "origin", `HEAD:refs/heads/${mapping.branch}`], dir);
	const mergeRequest = await env.client.call("POST", `/merge-requests/${encodeURIComponent(mergeRequestId)}/refresh`);
	return { committed: true, remaining: [], mergeRequest };
}

async function unmergedPaths(dir: string): Promise<string[]> {
	const r = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: dir });
	return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function hasUnmerged(dir: string): Promise<boolean> {
	return (await unmergedPaths(dir)).length > 0;
}
