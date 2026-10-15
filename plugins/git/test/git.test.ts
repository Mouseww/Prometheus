import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin from "../src/index.ts";
import * as g from "../src/git.ts";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "", GIT_CONFIG_NOSYSTEM: "1" } });

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "gitplug-"));
	run(dir, "init", "-b", "main");
	run(dir, "config", "user.email", "t@example.com");
	run(dir, "config", "user.name", "Tester");
	run(dir, "config", "commit.gpgsign", "false");
	writeFileSync(join(dir, "a.txt"), "one\n");
	run(dir, "add", ".");
	run(dir, "commit", "-m", "first");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseStatus", () => {
	it("reads branch info, renames, untracked and conflicts", () => {
		const out = [
			"# branch.oid abc",
			"# branch.head main",
			"# branch.upstream origin/main",
			"# branch.ab +2 -1",
			"1 .M N... 100644 100644 100644 h1 h2 src/a b.ts",
			"2 R. N... 100644 100644 100644 h1 h2 R100 new.ts",
			"old.ts",
			"u UU N... 100644 100644 100644 100644 h1 h2 h3 clash.ts",
			"? fresh.txt",
			"",
		].join("\0");
		const s = g.parseStatus(out);
		expect(s).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1, detached: false });
		expect(s.files).toEqual([
			{ path: "src/a b.ts", index: " ", worktree: "M" },
			{ path: "new.ts", origPath: "old.ts", index: "R", worktree: " " },
			{ path: "clash.ts", index: "U", worktree: "U" },
			{ path: "fresh.txt", index: "?", worktree: "?" },
		]);
	});

	it("flags a detached head", () => {
		const s = g.parseStatus("# branch.head (detached)\0");
		expect(s.detached).toBe(true);
		expect(s.branch).toBeUndefined();
	});
});

describe("against a real repository", () => {
	it("reports a clean tree, then edits and untracked files", async () => {
		expect((await g.status(dir)).files).toEqual([]);
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		writeFileSync(join(dir, "new file.txt"), "hello\n");
		const s = await g.status(dir);
		expect(s).toMatchObject({ isRepo: true, branch: "main" });
		expect(s.files).toEqual(expect.arrayContaining([{ path: "a.txt", index: " ", worktree: "M" }, { path: "new file.txt", index: "?", worktree: "?" }]));
	});

	it("shows diffs for tracked and untracked files", async () => {
		expect((await g.diff(dir, "a.txt", false, false)).text).toContain("+two");
		expect((await g.diff(dir, "new file.txt", false, true)).text).toContain("+hello");
	});

	it("stages, unstages and commits with a message that looks like an option", async () => {
		await g.stage(dir, ["a.txt"]);
		expect((await g.status(dir)).files.find((f) => f.path === "a.txt")).toMatchObject({ index: "M", worktree: " " });
		expect((await g.diff(dir, "a.txt", true, false)).text).toContain("+two");
		await g.unstage(dir, ["a.txt"]);
		expect((await g.status(dir)).files.find((f) => f.path === "a.txt")).toMatchObject({ index: " ", worktree: "M" });
		await g.stage(dir, ["a.txt"]);
		await g.commit(dir, "--amend -m evil\n\nbody line");
		const log = await g.log(dir, 10);
		expect(log.map((c) => c.subject)).toEqual(["--amend -m evil", "first"]);
		expect(log[0]?.short).toHaveLength(7);
	});

	it("rejects an empty commit message and nothing-to-commit", async () => {
		await expect(g.commit(dir, "  ")).rejects.toThrow(/不能为空/);
		await expect(g.commit(dir, "x")).rejects.toThrow();
	});

	it("discards tracked edits and untracked files", async () => {
		writeFileSync(join(dir, "a.txt"), "scribble\n");
		writeFileSync(join(dir, "junk.txt"), "x");
		await g.discard(dir, [{ path: "a.txt", untracked: false }, { path: "junk.txt", untracked: true }]);
		const files = (await g.status(dir)).files.map((f) => f.path);
		expect(files).not.toContain("a.txt");
		expect(files).not.toContain("junk.txt");
	});

	it("creates and switches branches, listing them", async () => {
		await g.checkout(dir, "feature/x", true);
		let list = await g.branches(dir);
		expect(list.find((b) => b.current)?.name).toBe("feature/x");
		await g.checkout(dir, "main", false);
		list = await g.branches(dir);
		expect(list.map((b) => b.name).sort()).toEqual(["feature/x", "main"]);
	});

	it("shows a commit", async () => {
		const [latest] = await g.log(dir, 1);
		const out = await g.show(dir, latest!.hash);
		expect(out.text).toContain("--amend -m evil");
		await expect(g.show(dir, "--output=x")).rejects.toThrow(/不合法/);
	});

	it("detects a plain folder and can init it", async () => {
		const plain = mkdtempSync(join(tmpdir(), "plain-"));
		expect(await g.status(plain)).toMatchObject({ isRepo: false, files: [] });
		await g.init(plain);
		expect((await g.status(plain)).isRepo).toBe(true);
		rmSync(plain, { recursive: true, force: true });
	});

	it("handles the very first commit and unstaging in an empty repository", async () => {
		const fresh = mkdtempSync(join(tmpdir(), "fresh-"));
		run(fresh, "init", "-b", "main");
		run(fresh, "config", "user.email", "t@example.com");
		run(fresh, "config", "user.name", "T");
		writeFileSync(join(fresh, "f.txt"), "x");
		await g.stage(fresh, ["f.txt"]);
		await g.unstage(fresh, ["f.txt"]);
		expect((await g.status(fresh)).files[0]).toMatchObject({ index: "?", worktree: "?" });
		await g.stage(fresh, ["f.txt"]);
		await g.commit(fresh, "init");
		expect((await g.log(fresh, 5)).map((c) => c.subject)).toEqual(["init"]);
		rmSync(fresh, { recursive: true, force: true });
	});
});

describe("input checks", () => {
	it("refuses hostile paths, refs and directories", () => {
		for (const p of ["../x", "/etc/passwd", "-rf", "a/../b", "", "a\0b"]) expect(() => g.checkPathspec(p), p).toThrow();
		for (const r of ["--detach", "a b", "a..b", "x.lock", "a~1", "a:b", "-x", ""]) expect(() => g.checkRef(r), r).toThrow();
		expect(g.checkRef("feature/ok-1")).toBe("feature/ok-1");
		expect(() => g.checkDir("relative/dir")).toThrow(/绝对路径/);
		expect(() => g.checkDir(join(tmpdir(), "definitely-not-here-xyz"))).toThrow(/不存在/);
	});
});

describe("git plugin rpc", () => {
	async function register(workspaces: { id: string; path: string; name: string }[]) {
		const rpcs = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
		await plugin.setup({ workspaces: async () => workspaces, rpc: (m: string, h: never) => rpcs.set(m, h) } as never);
		return rpcs;
	}

	it("only operates on registered workspaces", async () => {
		const rpcs = await register([{ id: "w", path: dir, name: "w" }]);
		expect(((await rpcs.get("status")!({ workspace: dir })) as { isRepo: boolean }).isRepo).toBe(true);
		const other = mkdtempSync(join(tmpdir(), "other-"));
		await expect(rpcs.get("status")!({ workspace: other })).rejects.toThrow(/不是已添加的工作区/);
		await expect(rpcs.get("init")!({ workspace: other })).rejects.toThrow(/不是已添加的工作区/);
		rmSync(other, { recursive: true, force: true });
	});

	it("tolerates a trailing separator and passes stage requests through", async () => {
		mkdirSync(join(dir, "sub"), { recursive: true });
		writeFileSync(join(dir, "sub", "z.txt"), "z");
		const rpcs = await register([{ id: "w", path: `${dir}/`, name: "w" }]);
		await rpcs.get("stage")!({ workspace: dir, paths: ["sub/z.txt"] });
		const st = (await rpcs.get("status")!({ workspace: dir })) as { files: { path: string; index: string }[] };
		expect(st.files.find((f) => f.path === "sub/z.txt")?.index).toBe("A");
	});
});
