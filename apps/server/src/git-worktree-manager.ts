import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

const BRANCH_PREFIX = "prometheus/team/";
const MAX_PATCH_BYTES = 16 * 1024 * 1024;

export interface CreatedWorktree {
  repoRoot: string;
  worktreeRoot: string;
  workspaceRoot: string;
  branchName: string;
  baseCommit: string;
}

export interface WorktreeReview {
  status: "no_changes" | "pending" | "rejected";
  changedPaths: string[];
  disallowedPaths: string[];
  patchBytes: number;
}

export interface WorktreeApplyResult {
  status: "no_changes" | "applied" | "conflicted" | "rejected";
  changedPaths: string[];
  conflictPaths: string[];
  patchBytes: number;
}

export interface WorktreeCleanupResult {
  removed: boolean;
  branchDeleted: boolean;
}

interface PreparedChanges extends WorktreeReview {
  patch: Buffer;
}

interface ChangedPath {
  gitPath: string;
  displayPath: string;
}

export class GitWorktreeManager {
  readonly #workspaceRoot: string;
  readonly #storageRoot: string;

  constructor(workspaceRoot: string, storageRoot: string) {
    this.#workspaceRoot = canonicalDirectory(workspaceRoot, "workspace root");
    this.#storageRoot = resolve(storageRoot);
  }

  create(input: { taskId: string; label: string }): CreatedWorktree {
    if (!/^[0-9a-f-]{36}$/i.test(input.taskId)) {
      throw new GitWorktreeError("Task ID must be a UUID");
    }
    const repoRoot = this.#repoRoot(this.#workspaceRoot);
    const baseCommit = gitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[0-9a-f]{40}$/.test(baseCommit)) {
      throw new GitWorktreeError("Git repository does not have a usable HEAD commit");
    }
    const workspaceRelative = relative(repoRoot, this.#workspaceRoot);
    if (isOutside(workspaceRelative)) {
      throw new GitWorktreeError("Workspace root must be inside the Git repository");
    }

    mkdirSync(this.#storageRoot, { recursive: true });
    const storageRoot = canonicalDirectory(this.#storageRoot, "worktree storage root");
    const target = resolve(storageRoot, `${sanitizeLabel(input.label)}-${input.taskId}`);
    if (!isContained(storageRoot, target)) {
      throw new GitWorktreeError("Worktree target escapes the configured storage root");
    }
    if (existsSync(target)) throw new GitWorktreeError("Worktree target already exists");

    const branchName = `${BRANCH_PREFIX}${input.taskId}`;
    gitBuffer(repoRoot, ["worktree", "add", "-b", branchName, target, baseCommit]);
    const worktreeRoot = canonicalDirectory(target, "created worktree");
    const childWorkspace = workspaceRelative ? join(worktreeRoot, workspaceRelative) : worktreeRoot;
    const workspaceRoot = canonicalDirectory(childWorkspace, "created child workspace");
    return { repoRoot, worktreeRoot, workspaceRoot, branchName, baseCommit };
  }

  review(worktreeRoot: string, baseCommit: string, allowedPaths: string[]): WorktreeReview {
    const prepared = this.#prepare(worktreeRoot, baseCommit, allowedPaths);
    return {
      status: prepared.status,
      changedPaths: prepared.changedPaths,
      disallowedPaths: prepared.disallowedPaths,
      patchBytes: prepared.patchBytes,
    };
  }

  apply(worktreeRoot: string, baseCommit: string, allowedPaths: string[]): WorktreeApplyResult {
    const prepared = this.#prepare(worktreeRoot, baseCommit, allowedPaths);
    if (prepared.status === "no_changes") {
      return { status: "no_changes", changedPaths: [], conflictPaths: [], patchBytes: 0 };
    }
    if (prepared.status === "rejected") {
      return {
        status: "rejected",
        changedPaths: prepared.changedPaths,
        conflictPaths: prepared.disallowedPaths,
        patchBytes: 0,
      };
    }

    const parentRepoRoot = this.#repoRoot(this.#workspaceRoot);
    this.#assertSameRepository(parentRepoRoot, canonicalDirectory(worktreeRoot, "worktree root"));
    const check = tryGit(parentRepoRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], prepared.patch);
    if (!check.ok) {
      return {
        status: "conflicted",
        changedPaths: prepared.changedPaths,
        conflictPaths: prepared.changedPaths,
        patchBytes: prepared.patchBytes,
      };
    }
    const applied = tryGit(parentRepoRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], prepared.patch);
    if (!applied.ok) {
      return {
        status: "conflicted",
        changedPaths: prepared.changedPaths,
        conflictPaths: prepared.changedPaths,
        patchBytes: prepared.patchBytes,
      };
    }
    return {
      status: "applied",
      changedPaths: prepared.changedPaths,
      conflictPaths: [],
      patchBytes: prepared.patchBytes,
    };
  }

  cleanup(input: {
    worktreeRoot: string;
    branchName: string;
    outcome: "applied" | "no_changes" | "discarded";
  }): WorktreeCleanupResult {
    if (!input.branchName.startsWith(BRANCH_PREFIX)) {
      throw new GitWorktreeError("Refusing to delete a non-Prometheus team branch");
    }
    if (!existsSync(input.worktreeRoot)) return { removed: false, branchDeleted: false };

    const storageRoot = canonicalDirectory(this.#storageRoot, "worktree storage root");
    const worktreeRoot = canonicalDirectory(input.worktreeRoot, "worktree root");
    if (!isContained(storageRoot, worktreeRoot)) {
      throw new GitWorktreeError("Refusing to cleanup outside the configured worktree storage root");
    }
    const repoRoot = this.#repoRoot(this.#workspaceRoot);
    this.#assertSameRepository(repoRoot, worktreeRoot);
    const checkedOutBranch = gitText(worktreeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (checkedOutBranch !== input.branchName) {
      throw new GitWorktreeError("Worktree branch does not match the cleanup request");
    }

    gitBuffer(repoRoot, ["worktree", "remove", "--force", worktreeRoot]);
    const branchRef = `refs/heads/${input.branchName}`;
    const branchExists = tryGit(repoRoot, ["show-ref", "--verify", "--quiet", branchRef]).ok;
    if (branchExists) gitBuffer(repoRoot, ["branch", "-D", input.branchName]);
    return { removed: true, branchDeleted: branchExists };
  }

  #prepare(worktreeRootInput: string, baseCommit: string, allowedPaths: string[]): PreparedChanges {
    if (!/^[0-9a-f]{40}$/.test(baseCommit)) throw new GitWorktreeError("Invalid base commit");
    const worktreeRoot = canonicalDirectory(worktreeRootInput, "worktree root");
    const parentRepoRoot = this.#repoRoot(this.#workspaceRoot);
    this.#assertSameRepository(parentRepoRoot, worktreeRoot);
    if (!tryGit(worktreeRoot, ["cat-file", "-e", `${baseCommit}^{commit}`]).ok) {
      throw new GitWorktreeError("Base commit is not available in the worktree repository");
    }

    const changed = this.#collectChangedPaths(worktreeRoot, baseCommit);
    const changedPaths = changed.map((entry) => entry.displayPath).sort(comparePaths);
    if (changed.length === 0) {
      return { status: "no_changes", changedPaths: [], disallowedPaths: [], patchBytes: 0, patch: Buffer.alloc(0) };
    }
    const scopes = allowedPaths.map(normalizeScope);
    const disallowedPaths = changed
      .filter((entry) => !scopes.some((scope) => pathBelongsToScope(entry.displayPath, scope)))
      .map((entry) => entry.displayPath)
      .sort(comparePaths);
    if (disallowedPaths.length > 0) {
      return { status: "rejected", changedPaths, disallowedPaths, patchBytes: 0, patch: Buffer.alloc(0) };
    }

    const gitPaths = changed.map((entry) => entry.gitPath);
    let patch: Buffer;
    try {
      gitBuffer(worktreeRoot, ["reset", "-q", baseCommit, "--"]);
      gitBuffer(worktreeRoot, ["add", "-A", "--", ...gitPaths]);
      patch = gitBuffer(worktreeRoot, ["diff", "--cached", "--binary", baseCommit, "--"]);
    } finally {
      gitBuffer(worktreeRoot, ["reset", "-q", "HEAD", "--"]);
    }
    if (patch.length > MAX_PATCH_BYTES) {
      throw new GitWorktreeError(`Patch exceeds ${MAX_PATCH_BYTES} bytes`);
    }
    if (patch.length === 0) {
      return { status: "no_changes", changedPaths: [], disallowedPaths: [], patchBytes: 0, patch };
    }
    return { status: "pending", changedPaths, disallowedPaths: [], patchBytes: patch.length, patch };
  }

  #collectChangedPaths(worktreeRoot: string, baseCommit: string): ChangedPath[] {
    const tracked = splitNul(gitBuffer(worktreeRoot, [
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      baseCommit,
      "--",
    ]));
    const untracked = splitNul(gitBuffer(worktreeRoot, [
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]));
    const repoRoot = this.#repoRoot(this.#workspaceRoot);
    const workspaceRelative = relative(repoRoot, this.#workspaceRoot);
    const workspacePrefix = workspaceRelative ? normalizeGitPath(workspaceRelative) : "";
    const unique = new Map<string, ChangedPath>();
    for (const rawPath of [...tracked, ...untracked]) {
      const gitPath = normalizeGitPath(rawPath);
      const displayPath = toWorkspaceDisplayPath(gitPath, workspacePrefix);
      unique.set(gitPath.toLocaleLowerCase("en-US"), { gitPath, displayPath });
    }
    return [...unique.values()].sort((left, right) => comparePaths(left.displayPath, right.displayPath));
  }

  #repoRoot(cwd: string): string {
    const result = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (!result.ok) throw new GitWorktreeError("Workspace is not inside a Git repository");
    return canonicalDirectory(result.stdout.toString("utf8").trim(), "git repository root");
  }

  #assertSameRepository(parentRepoRoot: string, worktreeRoot: string): void {
    const parentCommon = gitCommonDirectory(parentRepoRoot);
    const worktreeCommon = gitCommonDirectory(worktreeRoot);
    if (pathKey(parentCommon) !== pathKey(worktreeCommon)) {
      throw new GitWorktreeError("Worktree does not belong to the workspace Git repository");
    }
  }
}

export class GitWorktreeError extends Error {}

function gitCommonDirectory(cwd: string): string {
  const raw = gitText(cwd, ["rev-parse", "--git-common-dir"]);
  return canonicalDirectory(isAbsolute(raw) ? raw : resolve(cwd, raw), "git common directory");
}

function gitText(cwd: string, args: string[]): string {
  return gitBuffer(cwd, args).toString("utf8").trim();
}

function gitBuffer(cwd: string, args: string[], input?: Buffer): Buffer {
  const result = tryGit(cwd, args, input);
  if (!result.ok) throw new GitWorktreeError(result.message);
  return result.stdout;
}

function tryGit(
  cwd: string,
  args: string[],
  input?: Buffer,
): { ok: true; stdout: Buffer } | { ok: false; stdout: Buffer; message: string } {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: null,
    windowsHide: true,
    maxBuffer: MAX_PATCH_BYTES * 2,
  });
  const stdout = result.stdout ?? Buffer.alloc(0);
  if (!result.error && result.status === 0) return { ok: true, stdout };
  const stderr = (result.stderr ?? Buffer.alloc(0)).toString("utf8").trim();
  const output = stdout.toString("utf8").trim();
  return {
    ok: false,
    stdout,
    message: stderr || output || result.error?.message || `git exited with status ${result.status}`,
  };
}

function canonicalDirectory(path: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(path));
  } catch {
    throw new GitWorktreeError(`${label} must be an existing directory: ${path}`);
  }
  if (!statSync(canonical).isDirectory()) throw new GitWorktreeError(`${label} must be a directory: ${path}`);
  return canonical;
}

function splitNul(value: Buffer): string[] {
  return value.toString("utf8").split("\0").filter(Boolean);
}

function normalizeGitPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new GitWorktreeError(`Unsafe Git path: ${value}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment === "")) {
    throw new GitWorktreeError(`Unsafe Git path: ${value}`);
  }
  return normalized;
}

function toWorkspaceDisplayPath(gitPath: string, workspacePrefix: string): string {
  if (!workspacePrefix) return gitPath;
  if (pathKey(gitPath).startsWith(`${pathKey(workspacePrefix)}/`)) {
    return gitPath.slice(workspacePrefix.length + 1);
  }
  return `@repo/${gitPath}`;
}

function normalizeScope(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if (normalized === ".") return normalized;
  return normalizeGitPath(normalized);
}

function pathBelongsToScope(path: string, scope: string): boolean {
  if (path.startsWith("@repo/")) return false;
  if (scope === ".") return true;
  const candidate = pathKey(path);
  const owner = pathKey(scope);
  return candidate === owner || candidate.startsWith(`${owner}/`);
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !isOutside(rel);
}

function isOutside(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativePath);
}

function sanitizeLabel(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const candidate = (normalized || "agent").slice(0, 48);
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(candidate) ? `${candidate}-agent` : candidate;
}

function pathKey(value: string): string {
  return value.replace(/\\/g, "/").toLocaleLowerCase("en-US");
}

function comparePaths(left: string, right: string): number {
  return pathKey(left).localeCompare(pathKey(right));
}
