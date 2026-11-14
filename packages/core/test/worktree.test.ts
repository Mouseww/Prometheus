import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { escapesWorktree, WorktreeManager } from "../src/worktree.ts";
import { workspaceId } from "../src/workspaces.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let tmp: string;
let repo: string;
let mgr: WorktreeManager;

beforeEach(async () => {
	tmp = realpathSync(mkdtempSync(join(tmpdir(), "wt-")));
	repo = join(tmp, "proj");
	mkdirSync(repo);
	sh(repo, "init", "-q", "-b", "main");
	sh(repo, "config", "user.email", "t@t");
	sh(repo, "config", "user.name", "t");
	sh(repo, "config", "commit.gpgsign", "false");
	sh(repo, "config", "core.autocrlf", "false");
	writeFileSync(join(repo, "a.txt"), "a1\n");
	writeFileSync(join(repo, "b.txt"), "b1\n");
	writeFileSync(join(repo, ".gitignore"), "node_modules\n.env\n");
	sh(repo, "add", "-A");
	sh(repo, "commit", "-q", "-m", "init");
	mgr = new WorktreeManager(join(tmp, "data"));
	await mgr.load();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

async function open(id: string) {
	const wt = await mgr.create(repo);
	await mgr.bind(id, wt);
	return wt;
}

describe("worktree mode", () => {
	it("keeps the project folder untouched while the chat edits its checkout", async () => {
		const wt = await open("s1");
		expect(wt.path.startsWith(join(tmp, "data", "worktrees"))).toBe(true);
		writeFileSync(join(wt.cwd, "a.txt"), "changed\n");
		writeFileSync(join(wt.cwd, "new.txt"), "n\n");
		expect(sh(repo, "status", "--porcelain")).toBe("");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a1\n");
		const st = await mgr.status("s1");
		expect(st.files.map((f) => `${f.status}:${f.path}`)).toEqual(["M:a.txt", "?:new.txt"]);
		expect(st.blocked).toBeUndefined();
	});

	it("carries uncommitted and untracked edits of the project folder into a new checkout", async () => {
		writeFileSync(join(repo, "a.txt"), "dirty\n");
		writeFileSync(join(repo, "loose.txt"), "loose\n");
		const wt = await open("s1");
		expect(readFileSync(join(wt.cwd, "a.txt"), "utf8")).toBe("dirty\n");
		expect(readFileSync(join(wt.cwd, "loose.txt"), "utf8")).toBe("loose\n");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("dirty\n");
	});

	it("drops files whose content already landed on the base branch some other way", async () => {
		const wt = await open("s1");
		writeFileSync(join(wt.cwd, "a.txt"), "same\n");
		writeFileSync(join(wt.cwd, "b.txt"), "mine\n");
		await mgr.checkpoint("s1");
		// The same edit to a.txt reaches the project folder outside the panel (direct commit on the base branch).
		writeFileSync(join(repo, "a.txt"), "same\n");
		sh(repo, "commit", "-q", "-am", "direct");
		const st = await mgr.status("s1");
		expect(st.files.map((f) => f.path)).toEqual(["b.txt"]);
		// Once every file has landed, nothing is left to merge.
		writeFileSync(join(repo, "b.txt"), "mine\n");
		sh(repo, "commit", "-q", "-am", "direct 2");
		const done = await mgr.status("s1");
		expect(done.files).toEqual([]);
		expect(done.blocked).toBe("worktreeEmpty");
	});

	it("rejects non-git folders and empty repos with a code", async () => {
		const plain = join(tmp, "plain");
		mkdirSync(plain);
		await expect(mgr.create(plain)).rejects.toMatchObject({ code: "worktreeNotGit" });
		const empty = join(tmp, "empty");
		mkdirSync(empty);
		sh(empty, "init", "-q");
		await expect(mgr.create(empty)).rejects.toMatchObject({ code: "worktreeNoCommit" });
	});

	it("squash-merges into the project folder, then the chat can go on and merge again", async () => {
		const wt = await open("s1");
		writeFileSync(join(wt.cwd, "a.txt"), "changed\n");
		await mgr.checkpoint("s1");
		writeFileSync(join(wt.cwd, "c.txt"), "c\n");
		await mgr.merge("s1", "squash", "feat: x");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
		expect(readFileSync(join(repo, "c.txt"), "utf8")).toBe("c\n");
		expect(sh(repo, "log", "--format=%s", "-n", "1")).toBe("feat: x");
		expect(sh(repo, "rev-list", "--count", "HEAD")).toBe("2");
		expect(sh(repo, "status", "--porcelain")).toBe("");
		expect((await mgr.status("s1")).blocked).toBe("worktreeEmpty");
		writeFileSync(join(wt.cwd, "d.txt"), "d\n");
		await mgr.merge("s1", "squash", "feat: y");
		expect(readFileSync(join(repo, "d.txt"), "utf8")).toBe("d\n");
	});

	it("apply leaves the changes uncommitted", async () => {
		const wt = await open("s1");
		writeFileSync(join(wt.cwd, "a.txt"), "changed\n");
		await mgr.merge("s1", "apply");
		expect(sh(repo, "rev-list", "--count", "HEAD")).toBe("1");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
	});

	it("two chats on different files merge one after the other; the second folds in the first", async () => {
		const w1 = await open("s1");
		const w2 = await open("s2");
		writeFileSync(join(w1.cwd, "a.txt"), "one\n");
		writeFileSync(join(w2.cwd, "b.txt"), "two\n");
		await mgr.merge("s1", "squash", "one");
		expect((await mgr.status("s2")).behind).toBe(1);
		await mgr.merge("s2", "squash", "two");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
		expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("two\n");
		expect(sh(repo, "status", "--porcelain")).toBe("");
	});

	it("reports chats that changed the same file", async () => {
		const w1 = await open("s1");
		const w2 = await open("s2");
		writeFileSync(join(w1.cwd, "a.txt"), "one\n");
		writeFileSync(join(w2.cwd, "a.txt"), "two\n");
		expect((await mgr.status("s1")).overlaps).toEqual([{ sessionId: "s2", files: ["a.txt"] }]);
	});

	it("a conflict stays in the checkout; the project folder never sees conflict markers", async () => {
		const w1 = await open("s1");
		const w2 = await open("s2");
		writeFileSync(join(w1.cwd, "a.txt"), "one\n");
		writeFileSync(join(w2.cwd, "a.txt"), "two\n");
		await mgr.merge("s1", "squash", "one");
		await expect(mgr.merge("s2", "squash", "two")).rejects.toMatchObject({ code: "worktreeConflict" });
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
		expect(sh(repo, "status", "--porcelain")).toBe("");
		expect((await mgr.status("s2")).conflicts).toEqual(["a.txt"]);
		// Resolving it in the checkout makes the merge go through.
		writeFileSync(join(w2.cwd, "a.txt"), "resolved\n");
		await mgr.merge("s2", "squash", "two");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("resolved\n");
	});

	it("counts changed lines and diffs a file against where the chat started", async () => {
		const wt = await open("s1");
		writeFileSync(join(wt.cwd, "a.txt"), "x\ny\n");
		writeFileSync(join(wt.cwd, "fresh.txt"), "1\n2\n3\n");
		await mgr.checkpoint("s1");
		writeFileSync(join(wt.cwd, "loose.txt"), "l\n");
		const st = await mgr.status("s1");
		const by = Object.fromEntries(st.files.map((f) => [f.path, f]));
		expect(by["fresh.txt"]?.added).toBe(3);
		expect(by["loose.txt"]).toMatchObject({ status: "?", added: 1, deleted: 0 });
		expect((await mgr.diff("s1", "fresh.txt")).text).toContain("+3");
		expect((await mgr.diff("s1", "loose.txt")).text).toContain("+l");
		await expect(mgr.diff("s1", "../x")).rejects.toBeTruthy();
	});

	it("blocks the merge while the project folder has uncommitted edits in the same files, and allows it otherwise", async () => {
		const wt = await open("s1");
		writeFileSync(join(wt.cwd, "a.txt"), "chat\n");
		writeFileSync(join(repo, "a.txt"), "mine\n");
		await expect(mgr.merge("s1", "squash")).rejects.toMatchObject({ code: "worktreeMainDirty" });
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("mine\n");
		sh(repo, "checkout", "--", "a.txt");
		writeFileSync(join(repo, "b.txt"), "unrelated edit\n");
		await mgr.merge("s1", "squash");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("chat\n");
		expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("unrelated edit\n");
	});

	it("blocks the merge when the remote already holds the chat's changes but the project folder has not pulled", async () => {
		const bare = join(tmp, "remote.git");
		sh(tmp, "init", "-q", "--bare", "-b", "main", bare);
		sh(repo, "remote", "add", "origin", bare);
		sh(repo, "push", "-q", "-u", "origin", "main");
		const wt = await open("s1");
		writeFileSync(join(wt.cwd, "a.txt"), "remote-merged\n");
		await mgr.checkpoint("s1");
		// Someone merges the same change on the remote (pull request); the project folder has not pulled.
		const other = join(tmp, "other");
		sh(tmp, "clone", "-q", bare, other);
		sh(other, "config", "user.email", "o@o");
		sh(other, "config", "user.name", "o");
		sh(other, "config", "commit.gpgsign", "false");
		writeFileSync(join(other, "a.txt"), "remote-merged\n");
		sh(other, "commit", "-qam", "pr merged");
		sh(other, "push", "-q", "origin", "main");
		const st = await mgr.status("s1", true);
		expect(st.remote).toMatchObject({ ref: "origin/main", behind: 1, landed: true });
		expect(st.blocked).toBe("worktreeLanded");
		await expect(mgr.merge("s1", "squash")).rejects.toMatchObject({ code: "worktreeLanded" });
		// After pulling, the changes are no longer pending at all.
		sh(repo, "pull", "-q", "--ff-only");
		const after = await mgr.status("s1", true);
		expect(after.files).toEqual([]);
		expect(after.remote?.behind).toBe(0);
	});

	it("blocks when the remote changed the same files the chat did", async () => {
		const bare = join(tmp, "remote.git");
		sh(tmp, "init", "-q", "--bare", "-b", "main", bare);
		sh(repo, "remote", "add", "origin", bare);
		sh(repo, "push", "-q", "-u", "origin", "main");
		const wt = await open("s1");
		writeFileSync(join(wt.cwd, "a.txt"), "mine\n");
		const other = join(tmp, "other");
		sh(tmp, "clone", "-q", bare, other);
		sh(other, "config", "user.email", "o@o");
		sh(other, "config", "user.name", "o");
		sh(other, "config", "commit.gpgsign", "false");
		writeFileSync(join(other, "a.txt"), "theirs\n");
		sh(other, "commit", "-qam", "remote edit");
		sh(other, "push", "-q", "origin", "main");
		const st = await mgr.status("s1", true);
		expect(st.blocked).toBe("worktreeRemoteMoved");
		expect(st.remote?.overlap).toEqual(["a.txt"]);
	});

	it("blocks when the project folder left the base branch", async () => {
		const wt = await open("s1");
		writeFileSync(join(wt.cwd, "a.txt"), "chat\n");
		sh(repo, "checkout", "-q", "-b", "other");
		await expect(mgr.merge("s1", "squash")).rejects.toMatchObject({ code: "worktreeBaseMoved", params: { branch: "other" } });
	});

	it("discard removes the checkout and the branch; a deleted checkout is restored from its branch", async () => {
		const wt = await open("s1");
		writeFileSync(join(wt.cwd, "a.txt"), "x\n");
		await mgr.checkpoint("s1");
		rmSync(wt.path, { recursive: true, force: true });
		await mgr.ensure("s1");
		expect(readFileSync(join(wt.cwd, "a.txt"), "utf8")).toBe("x\n");
		await mgr.discard("s1");
		expect(existsSync(wt.path)).toBe(false);
		expect(sh(repo, "branch", "--list", wt.branch)).toBe("");
		expect(mgr.get("s1")?.state).toBe("discarded");
	});

	it("links node_modules and copies .env without ever committing them, and deleting the chat spares the original", async () => {
		mkdirSync(join(repo, "node_modules"));
		writeFileSync(join(repo, "node_modules", "dep.js"), "dep\n");
		writeFileSync(join(repo, ".env"), "KEY=1\n");
		const wt = await open("s1");
		expect(lstatSync(join(wt.path, "node_modules")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(wt.path, ".env"), "utf8")).toBe("KEY=1\n");
		writeFileSync(join(wt.cwd, "a.txt"), "x\n");
		await mgr.checkpoint("s1");
		expect(sh(wt.path, "ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(/node_modules|\.env$/);
		await mgr.release("s1");
		expect(existsSync(wt.path)).toBe(false);
		expect(readFileSync(join(repo, "node_modules", "dep.js"), "utf8")).toBe("dep\n");
	});

	it("also links the node_modules of workspace packages", async () => {
		mkdirSync(join(repo, "apps", "web", "node_modules"), { recursive: true });
		writeFileSync(join(repo, "apps", "web", "package.json"), "{}\n");
		sh(repo, "add", "-A");
		sh(repo, "commit", "-qm", "pkg");
		const wt = await open("s1");
		expect(lstatSync(join(wt.path, "apps", "web", "node_modules")).isSymbolicLink()).toBe(true);
		writeFileSync(join(wt.cwd, "a.txt"), "x\n");
		await mgr.checkpoint("s1");
		expect(sh(wt.path, "ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(/node_modules/);
	});

	it("maps a checkout back to its project, so chats do not make up new projects", async () => {
		const wt = await open("s1");
		expect(mgr.rootOf(wt.cwd)).toBe(wt.root);
		expect(mgr.rootOf(join(wt.cwd, "deep", "dir"))).toBe(wt.root);
		expect(workspaceId(mgr.rootOf(wt.cwd))).toBe(workspaceId(repo));
		expect(mgr.rootOf(repo)).toBe(repo);
		expect(mgr.pending(workspaceId(repo)).map((p) => p.sessionId)).toEqual(["s1"]);
	});

	it("works from a sub-folder of the repository", async () => {
		mkdirSync(join(repo, "pkg"));
		writeFileSync(join(repo, "pkg", "p.txt"), "p\n");
		sh(repo, "add", "-A");
		sh(repo, "commit", "-q", "-m", "pkg");
		const wt = await mgr.create(join(repo, "pkg"));
		await mgr.bind("s1", wt);
		expect(wt.cwd).toBe(join(wt.path, "pkg"));
		writeFileSync(join(wt.cwd, "p.txt"), "q\n");
		await mgr.merge("s1", "squash");
		expect(readFileSync(join(repo, "pkg", "p.txt"), "utf8")).toBe("q\n");
	});

	it("deleting a chat keeps a branch that still holds unmerged commits", async () => {
		const wt = await open("s1");
		writeFileSync(join(wt.cwd, "a.txt"), "x\n");
		await mgr.checkpoint("s1");
		await mgr.release("s1");
		expect(sh(repo, "branch", "--list", wt.branch)).not.toBe("");
	});

	it("flags writes that land in the repository outside the checkout", async () => {
		const wt = await open("s1");
		const guard = { repo: wt.repo, keep: wt.path };
		expect(escapesWorktree(join(repo, "a.txt"), wt.cwd, guard)).toBe(true);
		expect(escapesWorktree("a.txt", wt.cwd, guard)).toBe(false);
		expect(escapesWorktree(join(wt.path, "x.ts"), wt.cwd, guard)).toBe(false);
		expect(escapesWorktree(join(tmp, "elsewhere.txt"), wt.cwd, guard)).toBe(false);
	});
});
