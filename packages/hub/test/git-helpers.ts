import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HubOptions } from "../src/config.ts";
import { startHub, type TestHub } from "./hub-helpers.ts";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface GitRunOpts {
	cwd?: string;
	/** Hub access token sent as a Bearer header (kept out of the URL). */
	token?: string;
	env?: Record<string, string>;
}

/** Runs the real git CLI; never rejects. Global config, credential helpers and prompts are neutralised. */
export function git(args: string[], opts: GitRunOpts = {}): Promise<RunResult> {
	const config: [string, string][] = [
		["core.autocrlf", "false"],
		["credential.helper", ""],
		["init.defaultBranch", "main"],
	];
	if (opts.token) config.push(["http.extraHeader", `Authorization: Bearer ${opts.token}`]);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "Tester",
		GIT_AUTHOR_EMAIL: "tester@corp.test",
		GIT_COMMITTER_NAME: "Tester",
		GIT_COMMITTER_EMAIL: "tester@corp.test",
		GIT_CONFIG_COUNT: String(config.length),
		...opts.env,
	};
	config.forEach(([k, v], i) => {
		env[`GIT_CONFIG_KEY_${i}`] = k;
		env[`GIT_CONFIG_VALUE_${i}`] = v;
	});
	return new Promise((resolve) => {
		execFile("git", args, { cwd: opts.cwd, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
			const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code as number | string) : 0;
			resolve({ code: typeof code === "number" ? code : 1, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

export async function gitOk(args: string[], opts: GitRunOpts = {}): Promise<string> {
	const r = await git(args, opts);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} 失败 (${r.code}): ${r.stderr}`);
	return r.stdout.trim();
}

export const tmp = (prefix = "git-test-"): Promise<string> => mkdtemp(join(tmpdir(), prefix));

export async function writeFiles(dir: string, files: Record<string, string | Buffer>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, path);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, content);
	}
}

export async function commitAll(dir: string, message: string): Promise<string> {
	await gitOk(["add", "-A"], { cwd: dir });
	await gitOk(["commit", "-q", "-m", message], { cwd: dir });
	return gitOk(["rev-parse", "HEAD"], { cwd: dir });
}

export interface Sess {
	token: string;
	userId: string;
}

export interface World {
	t: TestHub;
	root: Sess & { orgId: string };
	/** team member */
	alice: Sess;
	/** team reviewer */
	bob: Sess;
	/** organization member outside the team */
	carol: Sess;
	/** team admin */
	dan: Sess;
	teamId: string;
	wsId: string;
	repoPath: string;
	gitUrl: string;
	stop(): Promise<void>;
}

export interface WorldOptions {
	hub?: Partial<HubOptions>;
	/** Commit these files to the default branch (via a direct push to the bare repository). Default: a small project. */
	seed?: Record<string, string | Buffer> | false;
}

export const DEFAULT_SEED: Record<string, string | Buffer> = {
	"README.md": "# project\n",
	"src/app.txt": "line1\nline2\nline3\n",
	"asset.bin": Buffer.from([0, 1, 2, 3, 0]),
};

/** Hub with an organization, one team (alice member, bob reviewer, dan admin) and one workspace. */
export async function setupWorld(options: WorldOptions = {}): Promise<World> {
	const t = await startHub({ allowLocalGitRemotes: true, ...options.hub });
	const root = await t.bootstrap();
	const alice = await t.createUser(root.token, "alice@corp.test", "Alice", root.orgId);
	const bob = await t.createUser(root.token, "bob@corp.test", "Bob", root.orgId);
	const carol = await t.createUser(root.token, "carol@corp.test", "Carol", root.orgId);
	const dan = await t.createUser(root.token, "dan@corp.test", "Dan", root.orgId);
	const team = await t.api("POST", "/api/teams", { token: root.token, body: { name: "Platform", orgId: root.orgId } });
	const teamId = team.data.id as string;
	for (const [who, role] of [
		[alice, "member"],
		[bob, "reviewer"],
		[dan, "admin"],
	] as const) {
		const r = await t.api("POST", `/api/teams/${teamId}/members`, { token: root.token, body: { userId: who.userId, role } });
		if (r.status !== 201) throw new Error(`加入团队失败: ${JSON.stringify(r.body)}`);
	}
	const ws = await t.api("POST", `/api/teams/${teamId}/workspaces`, { token: dan.token, body: { name: "app" } });
	if (ws.status !== 201) throw new Error(`创建工作区失败: ${JSON.stringify(ws.body)}`);
	const wsId = ws.data.id as string;
	const repoPath = join(t.dataDir, "repos", `${wsId}.git`);
	const world: World = {
		t,
		root,
		alice,
		bob,
		carol,
		dan,
		teamId,
		wsId,
		repoPath,
		gitUrl: `${t.baseUrl}/git/${wsId}.git`,
		stop: () => t.stop(),
	};
	if (options.seed !== false) await seedMain(world, options.seed ?? DEFAULT_SEED);
	return world;
}

/** Puts a commit on the default branch directly in the bare repository (the Hub itself never accepts such a push). */
export async function seedMain(world: Pick<World, "repoPath">, files: Record<string, string | Buffer>, message = "seed"): Promise<string> {
	const dir = await tmp("seed-");
	await gitOk(["init", "-q", "-b", "main"], { cwd: dir });
	await writeFiles(dir, files);
	const commit = await commitAll(dir, message);
	await gitOk(["push", "-q", world.repoPath, "main:main"], { cwd: dir });
	return commit;
}

export interface SessionClone {
	dir: string;
	branch: string;
	base: string;
	head: string;
}

/** Clones over smart HTTP as `who`, commits `files` on `session/<userId>/<name>` and pushes the branch. */
export async function sessionBranch(world: World, who: Sess, name: string, files: Record<string, string | Buffer>, message = `work ${name}`): Promise<SessionClone> {
	const dir = await tmp("clone-");
	await gitOk(["clone", "-q", world.gitUrl, dir], { token: who.token });
	const branch = `session/${who.userId}/${name}`;
	const base = await gitOk(["rev-parse", "HEAD"], { cwd: dir });
	await gitOk(["checkout", "-q", "-b", branch], { cwd: dir });
	await writeFiles(dir, files);
	const head = await commitAll(dir, message);
	await gitOk(["push", "-q", "origin", `HEAD:refs/heads/${branch}`], { cwd: dir, token: who.token });
	return { dir, branch, base, head };
}

export async function openMr(world: World, who: Sess, s: SessionClone, extra: Record<string, unknown> = {}, title = "change") {
	return world.t.api("POST", `/api/workspaces/${world.wsId}/merge-requests`, {
		token: who.token,
		body: { title, description: "desc", branch: s.branch, baseCommit: s.base, headCommit: s.head, ...extra },
	});
}

/** Content of a file on a ref of the Hub's bare repository. */
export const showFile = (world: Pick<World, "repoPath">, ref: string, path: string): Promise<string> => gitOk(["--git-dir", world.repoPath, "show", `${ref}:${path}`]);
