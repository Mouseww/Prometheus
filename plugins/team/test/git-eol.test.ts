import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, runGit } from "../src/member/git.ts";

const identity = { name: "Tester", email: "tester@corp.test" };
const KEYS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"] as const;

let root: string;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "team-eol-"));
	// A Windows user's setup: Git for Windows ships core.autocrlf=true. Reproduced through a global config file so it holds on every OS.
	const global = join(root, "gitconfig");
	await writeFile(global, "[core]\n\tautocrlf = true\n");
	for (const k of KEYS) saved[k] = process.env[k];
	process.env.GIT_CONFIG_GLOBAL = global;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	delete process.env.GIT_CONFIG_SYSTEM;
});

afterAll(async () => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	await rm(root, { recursive: true, force: true });
});

describe("plugin git ignores the user's core.autocrlf", () => {
	it("checks out, adds worktrees and snapshots byte for byte, so nothing looks modified and trees match across machines", async () => {
		// Hub-side seed: LF blobs, as the Hub stores them.
		const seed = join(root, "seed");
		await git(["init", "-q", "-b", "main", seed], { identity });
		await writeFile(join(seed, "a.txt"), "one\ntwo\n");
		await git(["add", "-A"], { cwd: seed, identity, env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" } });
		await git(["commit", "-q", "-m", "seed"], { cwd: seed, identity });

		const clone = join(root, "clone");
		await git(["clone", "-q", seed, clone], { identity });
		expect((await readFile(join(clone, "a.txt"))).includes(13)).toBe(false);

		const wt = join(root, "wt");
		await git(["worktree", "add", "--no-track", "-b", "s1", wt, "main"], { cwd: clone, identity });
		expect((await readFile(join(wt, "a.txt"))).includes(13)).toBe(false);
		expect(await git(["status", "--porcelain"], { cwd: wt, identity })).toBe("");

		// A CRLF file written by the user must be stored as is, not rewritten to LF.
		await writeFile(join(wt, "win.txt"), "x\r\ny\r\n");
		await git(["add", "-A"], { cwd: wt, identity });
		const blob = await runGit(["cat-file", "blob", ":win.txt"], { cwd: wt, identity });
		expect(blob.stdout).toBe("x\r\ny\r\n");
	});
});
