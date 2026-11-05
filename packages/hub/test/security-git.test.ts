import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MAX_PUSH_MB, maxPushBytes } from "../src/git/http-backend.ts";
import { createGitRuntime } from "../src/git/runtime.ts";
import { silentLog } from "../src/log.ts";
import { commitAll, git, gitOk, setupWorld, tmp, type World, writeFiles } from "./git-helpers.ts";

const T = 90_000;
const MB = 1024 * 1024;

describe("HUB_GIT_MAX_PUSH_MB", () => {
	it("parses a positive integer and falls back to 512 otherwise", () => {
		expect(DEFAULT_MAX_PUSH_MB).toBe(512);
		expect(maxPushBytes(undefined)).toBe(512 * MB);
		expect(maxPushBytes("")).toBe(512 * MB);
		expect(maxPushBytes("0")).toBe(512 * MB);
		expect(maxPushBytes("-5")).toBe(512 * MB);
		expect(maxPushBytes("abc")).toBe(512 * MB);
		expect(maxPushBytes("64")).toBe(64 * MB);
	});
});

describe("git runtime network environment", () => {
	const runtime = createGitRuntime({ dataDir: "unused" } as never, silentLog, false);
	it("disables redirects, with and without a token, and keeps the token header out of argv", () => {
		const bare = runtime.networkEnv();
		expect(bare.GIT_CONFIG_COUNT).toBe("1");
		expect(bare.GIT_CONFIG_KEY_0).toBe("http.followRedirects");
		expect(bare.GIT_CONFIG_VALUE_0).toBe("false");
		const withToken = runtime.networkEnv("tok");
		expect(withToken.GIT_CONFIG_COUNT).toBe("2");
		expect(withToken.GIT_CONFIG_KEY_0).toBe("http.followRedirects");
		expect(withToken.GIT_CONFIG_KEY_1).toBe("http.extraHeader");
		expect(withToken.GIT_CONFIG_VALUE_1).toContain("Authorization: Basic ");
	});
});

describe("push size cap and fsck", () => {
	let w: World;
	beforeAll(async () => {
		w = await setupWorld({ hub: { env: { HUB_GIT_MAX_PUSH_MB: "1" } } });
	}, T);
	afterAll(() => w.stop());

	const clone = async (): Promise<string> => {
		const dir = await tmp("clone-");
		await gitOk(["clone", "-q", w.gitUrl, dir], { token: w.alice.token });
		return dir;
	};

	it("refuses a push whose body is larger than the cap and accepts a small one", async () => {
		const dir = await clone();
		const branch = `session/${w.alice.userId}/big`;
		await gitOk(["checkout", "-q", "-b", branch], { cwd: dir });
		await writeFiles(dir, { "big.bin": randomBytes(3 * MB) });
		await commitAll(dir, "big");
		const big = await git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`], { cwd: dir, token: w.alice.token });
		expect(big.code).not.toBe(0);
		expect(`${big.stderr}`).toMatch(/413|too large|RPC failed|unexpected disconnect/i);

		const small = await clone();
		const smallBranch = `session/${w.alice.userId}/small`;
		await gitOk(["checkout", "-q", "-b", smallBranch], { cwd: small });
		await writeFiles(small, { "small.txt": "ok\n" });
		await commitAll(small, "small");
		expect((await git(["push", "-q", "origin", `HEAD:refs/heads/${smallBranch}`], { cwd: small, token: w.alice.token })).code).toBe(0);
	}, T);

	it("rejects objects that fail fsck", async () => {
		const dir = await clone();
		const branch = `session/${w.alice.userId}/bad`;
		// An author line with an unterminated email is malformed; --literally lets the client create it without checking.
		const content = "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@x 0 +0000\ncommitter C <c@x.test> 0 +0000\n\nbroken\n";
		await writeFiles(dir, { "bad-commit.txt": content });
		const oid = (await git(["hash-object", "-t", "commit", "-w", "--literally", "bad-commit.txt"], { cwd: dir })).stdout.trim();
		expect(oid).toMatch(/^[0-9a-f]{40}$/);
		const pushed = await git(["push", "origin", `${oid}:refs/heads/${branch}`], { cwd: dir, token: w.alice.token });
		expect(pushed.code).not.toBe(0);
		expect(pushed.stderr).toMatch(/fsck|missingAuthor|missing author|unpack-objects|rejected|failed/i);
		const refs = await gitOk(["--git-dir", w.repoPath, "for-each-ref", `refs/heads/${branch}`]);
		expect(refs).toBe("");
	}, T);
});
