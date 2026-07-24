import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorktreeError, GitWorktreeManager } from "./git-worktree-manager.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitWorktreeManager", () => {
  it("creates an isolated branch worktree and audits tracked and untracked changes", () => {
    const fixture = createRepository();
    const manager = new GitWorktreeManager(fixture.workspaceRoot, fixture.storageRoot);
    const created = manager.create({ taskId: randomUUID(), label: "Builder" });

    expect(created.branchName).toMatch(/^prometheus\/team\//);
    expect(created.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(created.worktreeRoot.startsWith(fixture.storageRoot)).toBe(true);
    expect(readFileSync(join(created.workspaceRoot, "base.txt"), "utf8")).toBe("base\n");

    writeFileSync(join(created.workspaceRoot, "base.txt"), "changed\n", "utf8");
    writeFileSync(join(created.workspaceRoot, "new.txt"), "new\n", "utf8");
    const review = manager.review(created.worktreeRoot, created.baseCommit, ["."]);

    expect(review).toMatchObject({
      status: "pending",
      changedPaths: ["base.txt", "new.txt"],
      disallowedPaths: [],
    });
    expect(review.patchBytes).toBeGreaterThan(0);
  }, 15_000);

  it("applies an allowed binary patch without committing and cleans the worktree safely", () => {
    const fixture = createRepository();
    const manager = new GitWorktreeManager(fixture.workspaceRoot, fixture.storageRoot);
    const created = manager.create({ taskId: randomUUID(), label: "Writer" });
    writeFileSync(join(created.workspaceRoot, "base.txt"), "agent change\n", "utf8");
    writeFileSync(join(created.workspaceRoot, "new.txt"), "created\n", "utf8");

    const applied = manager.apply(created.worktreeRoot, created.baseCommit, ["."]);

    expect(applied.status).toBe("applied");
    expect(readFileSync(join(fixture.workspaceRoot, "base.txt"), "utf8")).toBe("agent change\n");
    expect(readFileSync(join(fixture.workspaceRoot, "new.txt"), "utf8")).toBe("created\n");
    expect(git(fixture.repoRoot, ["status", "--short"])).toContain("packages/app/base.txt");

    const cleaned = manager.cleanup({
      worktreeRoot: created.worktreeRoot,
      branchName: created.branchName,
      outcome: "applied",
    });
    expect(cleaned).toEqual({ removed: true, branchDeleted: true });
    expect(existsSync(created.worktreeRoot)).toBe(false);
  }, 15_000);

  it("rejects changes outside assigned paths without touching the parent workspace", () => {
    const fixture = createRepository();
    const manager = new GitWorktreeManager(fixture.workspaceRoot, fixture.storageRoot);
    const created = manager.create({ taskId: randomUUID(), label: "Scoped" });
    writeFileSync(join(created.worktreeRoot, "README.md"), "outside\n", "utf8");

    const result = manager.apply(created.worktreeRoot, created.baseCommit, ["base.txt"]);

    expect(result).toMatchObject({
      status: "rejected",
      changedPaths: ["@repo/README.md"],
      conflictPaths: ["@repo/README.md"],
      patchBytes: 0,
    });
    expect(readFileSync(join(fixture.repoRoot, "README.md"), "utf8")).toBe("repo\n");
    expect(existsSync(created.worktreeRoot)).toBe(true);
  }, 15_000);

  it("reports a conflict and preserves both parent content and the isolated worktree", () => {
    const fixture = createRepository();
    const manager = new GitWorktreeManager(fixture.workspaceRoot, fixture.storageRoot);
    const created = manager.create({ taskId: randomUUID(), label: "Conflicting" });
    writeFileSync(join(created.workspaceRoot, "base.txt"), "agent version\n", "utf8");
    writeFileSync(join(fixture.workspaceRoot, "base.txt"), "parent version\n", "utf8");

    const result = manager.apply(created.worktreeRoot, created.baseCommit, ["base.txt"]);

    expect(result.status).toBe("conflicted");
    expect(result.conflictPaths).toEqual(["base.txt"]);
    expect(readFileSync(join(fixture.workspaceRoot, "base.txt"), "utf8")).toBe("parent version\n");
    expect(readFileSync(join(created.workspaceRoot, "base.txt"), "utf8")).toBe("agent version\n");
  }, 15_000);

  it("refuses unborn repositories and cleanup targets outside its storage root", () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-unborn-worktree-"));
    tempRoots.push(root);
    git(root, ["init"]);
    const manager = new GitWorktreeManager(root, join(root, "worktrees"));
    expect(() => manager.create({ taskId: randomUUID(), label: "No head" })).toThrow(GitWorktreeError);

    const fixture = createRepository();
    const safeManager = new GitWorktreeManager(fixture.workspaceRoot, fixture.storageRoot);
    mkdirSync(fixture.storageRoot, { recursive: true });
    expect(() => safeManager.cleanup({
      worktreeRoot: fixture.repoRoot,
      branchName: "prometheus/team/not-a-worktree",
      outcome: "discarded",
    })).toThrow(/configured worktree storage root/);
  }, 15_000);
});

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), "prometheus-worktree-manager-"));
  tempRoots.push(root);
  const repoRoot = join(root, "repo");
  const workspaceRoot = join(repoRoot, "packages", "app");
  const storageRoot = join(root, "worktrees");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(repoRoot, "README.md"), "repo\n", "utf8");
  writeFileSync(join(workspaceRoot, "base.txt"), "base\n", "utf8");
  git(repoRoot, ["init"]);
  git(repoRoot, ["config", "core.autocrlf", "false"]);
  git(repoRoot, ["config", "user.email", "prometheus-test@example.com"]);
  git(repoRoot, ["config", "user.name", "Prometheus Test"]);
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "initial"]);
  return { root, repoRoot, workspaceRoot, storageRoot };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git exited ${result.status}`).trim());
  }
  return result.stdout.trim();
}
