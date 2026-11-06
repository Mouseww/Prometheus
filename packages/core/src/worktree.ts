import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createJsonStore, type JsonStore } from "@prometheus/plugin-sdk";
import { AppError, type GitDiff, type SessionWorktree, type WorktreeFile, type WorktreeStatus, type WorktreeStrategy } from "@prometheus/protocol";
import { normalizeDir, workspaceId } from "./workspaces.ts";

// Per-chat git worktrees (docs/worktree-mode.md): the agent works in its own checkout and the real project folder is
// only touched by an explicit merge, which never leaves the project folder in a conflicted state.

interface WorktreeFile_ {
	sessions: Record<string, SessionWorktree>;
}

interface GitOut {
	code: number;
	stdout: string;
	stderr: string;
}

const GIT_TIMEOUT_MS = 120_000;

function git(cwd: string, args: string[]): Promise<GitOut> {
	return new Promise((done, reject) => {
		const child = spawn("git", args, {
			cwd,
			windowsHide: true,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat", LC_ALL: "C" },
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new AppError("worktreeFailed", { error: (err as NodeJS.ErrnoException).code === "ENOENT" ? "git not found" : err.message }));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code: code ?? 1, stdout, stderr });
		});
	});
}

/** Runs git and returns trimmed stdout, or throws the failure as a readable error. */
async function must(cwd: string, args: string[]): Promise<string> {
	const r = await git(cwd, args);
	if (r.code !== 0) throw new AppError("worktreeFailed", { error: (r.stderr || r.stdout).trim().split("\n").slice(0, 4).join(" ").slice(0, 400) });
	return r.stdout.trim();
}

function same(a: string, b: string): boolean {
	const x = normalizeDir(a);
	const y = normalizeDir(b);
	return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Whether `path` is `dir` or inside it. */
function inside(path: string, dir: string): boolean {
	const rel = relative(normalizeDir(dir), normalizeDir(path));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function slugOf(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 24) || "chat"
	);
}

/** Commit identity only when the user has none configured, so a checkpoint can never fail on it. */
async function identity(cwd: string): Promise<string[]> {
	const email = await git(cwd, ["config", "user.email"]);
	return ["-c", "commit.gpgsign=false", ...(email.stdout.trim() ? [] : ["-c", "user.name=Prometheus", "-c", "user.email=prometheus@localhost"])];
}

function removeLink(path: string): void {
	try {
		if (!lstatSync(path).isSymbolicLink()) return;
	} catch {
		return;
	}
	try {
		unlinkSync(path);
	} catch {
		rmdirSync(path);
	}
}

interface ProjectConfig {
	link?: string[];
	copy?: string[];
}

function readProjectConfig(root: string): ProjectConfig {
	try {
		const raw = JSON.parse(readFileSync(join(root, ".prometheus", "worktree.json"), "utf8")) as ProjectConfig;
		const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "" && !x.includes("..")) : undefined);
		return { link: names(raw.link), copy: names(raw.copy) };
	} catch {
		return {};
	}
}

export type Inspection = { ok: true; repo: string; subdir: string; baseBranch: string; baseCommit: string } | { ok: false; code: "worktreeNotGit" | "worktreeNoCommit" | "worktreeFailed"; error?: string };

export class WorktreeManager {
	private readonly store: JsonStore<WorktreeFile_>;
	private cache: WorktreeFile_ = { sessions: {} };
	private readonly locks = new Map<string, Promise<unknown>>();
	readonly baseDir: string;

	constructor(dataDir: string) {
		this.store = createJsonStore<WorktreeFile_>(join(dataDir, "sessions", "worktrees.json"), () => ({ sessions: {} }));
		this.baseDir = join(dataDir, "worktrees");
	}

	async load(): Promise<void> {
		const raw = await this.store.read();
		this.cache = { sessions: raw.sessions ?? {} };
		const repos = new Set(Object.values(this.cache.sessions).map((w) => w.repo));
		for (const repo of repos) if (existsSync(repo)) await git(repo, ["worktree", "prune"]).catch(() => {});
	}

	private async save(fn: (d: WorktreeFile_) => void): Promise<void> {
		this.cache = await this.store.update((cur) => {
			const next: WorktreeFile_ = { sessions: { ...(cur.sessions ?? {}) } };
			fn(next);
			return next;
		});
	}

	get(sessionId: string): SessionWorktree | undefined {
		return this.cache.sessions[sessionId];
	}

	private need(sessionId: string): SessionWorktree {
		const wt = this.get(sessionId);
		if (!wt) throw new AppError("sessionNotFound", { id: sessionId });
		if (wt.state !== "active") throw new AppError("worktreeGone");
		return wt;
	}

	/** The project folder a working directory belongs to: the folder itself, or the real project when it is a chat's checkout. */
	rootOf(cwd: string): string {
		if (!cwd) return cwd;
		for (const wt of Object.values(this.cache.sessions)) if (inside(cwd, wt.path)) return wt.root;
		return cwd;
	}

	/** Where writes made by this chat must not land: the repository, except the chat's own checkout. */
	guardOf(sessionId: string): { repo: string; keep: string } | undefined {
		const wt = this.get(sessionId);
		return wt && wt.state === "active" ? { repo: wt.repo, keep: wt.path } : undefined;
	}

	async inspect(dir: string): Promise<Inspection> {
		const top = await git(dir, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
		if (!top || top.code !== 0) return { ok: false, code: "worktreeNotGit" };
		const repo = normalizeDir(top.stdout.trim());
		const head = await git(dir, ["rev-parse", "HEAD"]);
		if (head.code !== 0) return { ok: false, code: "worktreeNoCommit" };
		const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
		if (!branch || branch === "HEAD") return { ok: false, code: "worktreeFailed", error: "detached HEAD" };
		return { ok: true, repo, subdir: relative(repo, normalizeDir(dir)), baseBranch: branch, baseCommit: head.stdout.trim() };
	}

	/** Creates the checkout for a new chat. The caller binds it to the chat's id once that exists. */
	async create(dir: string, opts: { withChanges?: boolean } = {}): Promise<SessionWorktree> {
		const info = await this.inspect(dir);
		if (!info.ok) throw new AppError(info.code, info.error ? { error: info.error } : {});
		const root = normalizeDir(dir);
		const id = randomBytes(4).toString("hex");
		const branch = `prometheus/${slugOf(basename(root))}-${id}`;
		const path = join(this.baseDir, workspaceId(root), id);
		mkdirSync(dirname(path), { recursive: true });
		try {
			await must(info.repo, ["worktree", "add", "-b", branch, path, info.baseCommit]);
			if (opts.withChanges) {
				const snap = (await git(info.repo, ["stash", "create"])).stdout.trim();
				if (snap) await must(path, ["stash", "apply", snap]);
			}
		} catch (err) {
			await git(info.repo, ["worktree", "remove", "--force", path]).catch(() => {});
			await git(info.repo, ["branch", "-D", branch]).catch(() => {});
			throw err;
		}
		const skip = this.prepare(info.repo, root, path);
		const wt: SessionWorktree = {
			root,
			path,
			cwd: info.subdir ? join(path, info.subdir) : path,
			repo: info.repo,
			branch,
			baseBranch: info.baseBranch,
			baseCommit: info.baseCommit,
			state: "active",
			createdAt: new Date().toISOString(),
		};
		if (skip.length) wt.skip = skip;
		return wt;
	}

	/** Gives the checkout what git does not track: dependency folders linked, env files copied. Returns the paths git must ignore. */
	private prepare(repo: string, root: string, path: string): string[] {
		const skip: string[] = [];
		const cfg = readProjectConfig(root);
		const link = cfg.link ?? ["node_modules"];
		const copy = cfg.copy;
		const bases = same(repo, root) ? [repo] : [repo, root];
		for (const base of bases) {
			const rel = relative(repo, base);
			const target = join(path, rel);
			for (const name of link) this.linkOne(join(base, name), join(target, name), join(rel, name), skip);
			const envs = copy ?? (existsSync(base) ? readdirSync(base).filter((f) => /^\.env(\..+)?$/.test(f)) : []);
			for (const name of envs) {
				const from = join(base, name);
				const to = join(target, name);
				try {
					if (existsSync(from) && statSync(from).isFile() && !existsSync(to)) {
						copyFileSync(from, to);
						skip.push(join(rel, name).split(sep).join("/"));
					}
				} catch {
					// A file that cannot be copied only means the project needs its own setup.
				}
			}
		}
		return skip;
	}

	private linkOne(from: string, to: string, relPath: string, skip: string[]): void {
		try {
			if (!existsSync(from) || existsSync(to) || !statSync(from).isDirectory()) return;
			symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
			skip.push(relPath.split(sep).join("/"));
		} catch {
			// Linking is a convenience; the chat still works without it.
		}
	}

	async bind(sessionId: string, wt: SessionWorktree): Promise<void> {
		await this.save((d) => {
			d.sessions[sessionId] = wt;
		});
	}

	/** The chat's checkout now belongs to another chat id (the agent was switched). */
	async move(from: string, to: string): Promise<void> {
		const wt = this.get(from);
		if (!wt) return;
		await this.save((d) => {
			delete d.sessions[from];
			d.sessions[to] = wt;
		});
	}

	/** Removes a checkout that never got a chat (creation failed after the checkout was made). */
	async dispose(wt: SessionWorktree): Promise<void> {
		await this.removeCheckout(wt, true);
	}

	private excludes(wt: SessionWorktree): string[] {
		const skip = wt.skip ?? [];
		return skip.map((p) => `:(exclude)${p}`);
	}

	private async removeCheckout(wt: SessionWorktree, dropBranch: boolean): Promise<void> {
		for (const p of wt.skip ?? []) removeLink(join(wt.path, p));
		await git(wt.repo, ["worktree", "remove", "--force", wt.path]).catch(() => {});
		await git(wt.repo, ["worktree", "prune"]).catch(() => {});
		if (dropBranch) await git(wt.repo, ["branch", "-D", wt.branch]).catch(() => {});
	}

	/** Brings a missing checkout back from its branch (the folder was deleted by hand); marks the chat orphaned when the branch is gone too. */
	async ensure(sessionId: string): Promise<void> {
		const wt = this.get(sessionId);
		if (!wt || wt.state !== "active" || existsSync(wt.path)) return;
		await git(wt.repo, ["worktree", "prune"]).catch(() => {});
		const branchOk = existsSync(wt.repo) && (await git(wt.repo, ["rev-parse", "--verify", `refs/heads/${wt.branch}`])).code === 0;
		if (branchOk) {
			mkdirSync(dirname(wt.path), { recursive: true });
			const r = await git(wt.repo, ["worktree", "add", wt.path, wt.branch]);
			if (r.code === 0) {
				this.prepare(wt.repo, wt.root, wt.path);
				return;
			}
		}
		await this.save((d) => {
			const cur = d.sessions[sessionId];
			if (cur) d.sessions[sessionId] = { ...cur, state: "orphaned" };
		});
	}

	/** Chat deleted: drop its checkout; keep the branch when it still holds commits nobody merged. */
	async release(sessionId: string): Promise<void> {
		const wt = this.get(sessionId);
		if (!wt) return;
		if (wt.state === "active") {
			const ahead = await this.aheadOf(wt).catch(() => 1);
			await this.removeCheckout(wt, ahead === 0);
		}
		await this.save((d) => {
			delete d.sessions[sessionId];
		});
	}

	private lock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.locks.get(repo) ?? Promise.resolve();
		const run = prev.catch(() => {}).then(fn);
		this.locks.set(repo, run);
		void run.finally(() => {
			if (this.locks.get(repo) === run) this.locks.delete(repo);
		}).catch(() => {});
		return run;
	}

	private async mergeBase(wt: SessionWorktree): Promise<string> {
		const r = await git(wt.path, ["merge-base", wt.baseBranch, "HEAD"]);
		return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : wt.baseCommit;
	}

	private async aheadOf(wt: SessionWorktree): Promise<number> {
		return Number(await must(wt.path, ["rev-list", "--count", `${await this.mergeBase(wt)}..HEAD`])) || 0;
	}

	private async conflictsOf(wt: SessionWorktree): Promise<string[]> {
		const r = await git(wt.path, ["diff", "--name-only", "--diff-filter=U"]);
		return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
	}

	/** Marks unmerged files as resolved once they no longer contain conflict markers (edited by the user or the agent). */
	private async stageResolved(wt: SessionWorktree): Promise<void> {
		for (const f of await this.conflictsOf(wt)) {
			const abs = join(wt.path, f);
			if (!existsSync(abs)) {
				await git(wt.path, ["rm", "-q", "--cached", "--", f]);
				continue;
			}
			const text = readFileSync(abs, "utf8");
			if (!/^(<{7}|>{7})( |$)/m.test(text)) await git(wt.path, ["add", "--", f]);
		}
	}

	private async mergeInProgress(wt: SessionWorktree): Promise<boolean> {
		const r = await git(wt.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
		return r.code === 0;
	}

	/** Commits everything the agent changed on the chat's own branch; completes a merge whose conflicts were resolved. */
	async checkpoint(sessionId: string, message = "wip: checkpoint"): Promise<void> {
		const wt = this.get(sessionId);
		if (!wt || wt.state !== "active" || !existsSync(wt.path)) return;
		await this.lock(wt.repo, async () => {
			const id = await identity(wt.path);
			const merging = await this.mergeInProgress(wt);
			if (merging) await this.stageResolved(wt);
			if (merging && (await this.conflictsOf(wt)).length) return;
			await git(wt.path, ["add", "-A", "--", ".", ...this.excludes(wt)]);
			if ((await git(wt.path, ["diff", "--cached", "--quiet"])).code === 0 && !merging) return;
			await git(wt.path, [...id, "commit", "--no-verify", "-q", ...(merging ? ["--no-edit"] : ["-m", message])]);
		});
	}

	private async changedFiles(wt: SessionWorktree): Promise<WorktreeFile[]> {
		const base = await this.mergeBase(wt);
		const out = new Map<string, string>();
		const diff = await git(wt.path, ["diff", "--name-status", "-z", base]);
		const parts = diff.stdout.split("\0");
		for (let i = 0; i + 1 < parts.length; ) {
			const st = parts[i] ?? "";
			if (!st) break;
			const letter = st[0] ?? "M";
			if (letter === "R" || letter === "C") {
				out.set(parts[i + 2] ?? "", "R");
				i += 3;
			} else {
				out.set(parts[i + 1] ?? "", letter);
				i += 2;
			}
		}
		const untracked = await git(wt.path, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...this.excludes(wt)]);
		for (const f of untracked.stdout.split("\0")) if (f) out.set(f, "?");
		out.delete("");
		return [...out].map(([path, status]) => ({ path, status })).sort((a, b) => a.path.localeCompare(b.path));
	}

	private async dirtyInMain(wt: SessionWorktree): Promise<Set<string>> {
		const r = await git(wt.repo, ["status", "--porcelain", "-z", "--untracked-files=all"]);
		const parts = r.stdout.split("\0");
		const out = new Set<string>();
		for (let i = 0; i < parts.length; i++) {
			const p = parts[i] ?? "";
			if (p.length < 4) continue;
			out.add(p.slice(3));
			if (p[0] === "R" || p[1] === "R") i++;
		}
		return out;
	}

	async status(sessionId: string): Promise<WorktreeStatus> {
		const wt = this.get(sessionId);
		if (!wt) throw new AppError("sessionNotFound", { id: sessionId });
		if (wt.state !== "active" || !existsSync(wt.path)) return { worktree: wt, files: [], ahead: 0, behind: 0, conflicts: [], mainDirty: [], overlaps: [], blocked: "worktreeGone" };
		const [files, ahead, behind, conflicts, dirty, current] = await Promise.all([
			this.changedFiles(wt),
			this.aheadOf(wt),
			must(wt.path, ["rev-list", "--count", `HEAD..${wt.baseBranch}`]).then(Number).catch(() => 0),
			this.conflictsOf(wt),
			this.dirtyInMain(wt),
			git(wt.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).then((r) => r.stdout.trim()),
		]);
		const mine = new Set(files.map((f) => f.path));
		const mainDirty = [...dirty].filter((p) => mine.has(p));
		const overlaps: WorktreeStatus["overlaps"] = [];
		for (const [id, other] of Object.entries(this.cache.sessions)) {
			if (id === sessionId || other.state !== "active" || !same(other.repo, wt.repo) || !existsSync(other.path)) continue;
			const shared = (await this.changedFiles(other).catch(() => [])).map((f) => f.path).filter((p) => mine.has(p));
			if (shared.length) overlaps.push({ sessionId: id, files: shared });
		}
		await this.countLines(wt, files);
		const out: WorktreeStatus = { worktree: wt, files, ahead, behind, conflicts, mainDirty, overlaps };
		if (conflicts.length) {
			out.blocked = "worktreeConflict";
			out.blockedDetail = conflicts.slice(0, 8).join(", ");
		} else if (current !== wt.baseBranch) {
			out.blocked = "worktreeBaseMoved";
			out.blockedDetail = current;
		} else if (mainDirty.length) {
			out.blocked = "worktreeMainDirty";
			out.blockedDetail = mainDirty.slice(0, 8).join(", ");
		} else if (!files.length && ahead === 0) {
			out.blocked = "worktreeEmpty";
		}
		return out;
	}

	/** Folds the base branch into the chat's checkout. Conflicts stay inside the checkout and show up in the status. */
	async sync(sessionId: string): Promise<WorktreeStatus> {
		await this.checkpoint(sessionId);
		const wt = this.need(sessionId);
		await this.lock(wt.repo, () => this.syncLocked(wt));
		return this.status(sessionId);
	}

	private async syncLocked(wt: SessionWorktree): Promise<void> {
		if (await this.mergeInProgress(wt)) return;
		const behind = Number(await must(wt.path, ["rev-list", "--count", `HEAD..${wt.baseBranch}`]));
		if (!behind) return;
		const r = await git(wt.path, [...(await identity(wt.path)), "merge", "--no-edit", wt.baseBranch]);
		if (r.code !== 0 && !(await this.conflictsOf(wt)).length) {
			await git(wt.path, ["merge", "--abort"]);
			throw new AppError("worktreeFailed", { error: (r.stderr || r.stdout).trim().slice(0, 400) });
		}
	}

	/** Lands the chat's changes in the project folder. Everything that can fail is checked, or resolved inside the checkout, first. */
	async merge(sessionId: string, strategy: WorktreeStrategy, message?: string): Promise<WorktreeStatus> {
		await this.checkpoint(sessionId);
		const wt = this.need(sessionId);
		await this.lock(wt.repo, async () => {
			const pre = await this.status(sessionId);
			if (pre.conflicts.length) throw new AppError("worktreeConflict", { files: pre.blockedDetail ?? "" });
			if (pre.blocked === "worktreeBaseMoved") throw new AppError("worktreeBaseMoved", { branch: pre.blockedDetail ?? "" });
			if (pre.blocked === "worktreeMainDirty") throw new AppError("worktreeMainDirty", { files: pre.blockedDetail ?? "" });
			if (pre.blocked === "worktreeEmpty") throw new AppError("worktreeEmpty");
			await this.syncLocked(wt);
			const conflicts = await this.conflictsOf(wt);
			if (conflicts.length) throw new AppError("worktreeConflict", { files: conflicts.slice(0, 8).join(", ") });
			const text = message?.trim() || `Merge changes from ${wt.branch}`;
			const id = await identity(wt.repo);
			if (strategy === "merge") {
				const r = await git(wt.repo, [...id, "merge", "--no-ff", "-m", text, wt.branch]);
				if (r.code !== 0) {
					await git(wt.repo, ["merge", "--abort"]);
					throw new AppError("worktreeFailed", { error: (r.stderr || r.stdout).trim().slice(0, 400) });
				}
			} else {
				const r = await git(wt.repo, ["merge", "--squash", wt.branch]);
				if (r.code !== 0) {
					await git(wt.repo, ["reset", "--merge"]);
					throw new AppError("worktreeFailed", { error: (r.stderr || r.stdout).trim().slice(0, 400) });
				}
				if (strategy === "squash" && (await git(wt.repo, ["diff", "--cached", "--quiet"])).code !== 0) {
					const c = await git(wt.repo, [...id, "commit", "-q", "-m", text]);
					if (c.code !== 0) {
						await git(wt.repo, ["reset", "--merge"]);
						throw new AppError("worktreeFailed", { error: (c.stderr || c.stdout).trim().slice(0, 400) });
					}
				}
			}
			// The chat carries on from where the project folder is now, so it can be merged again later.
			const head = await must(wt.repo, ["rev-parse", "HEAD"]);
			await must(wt.path, ["reset", "--hard", head]);
			await this.save((d) => {
				const cur = d.sessions[sessionId];
				if (cur) d.sessions[sessionId] = { ...cur, baseCommit: head };
			});
		});
		return this.status(sessionId);
	}

	async discard(sessionId: string): Promise<void> {
		const wt = this.get(sessionId);
		if (!wt) throw new AppError("sessionNotFound", { id: sessionId });
		if (wt.state !== "active") return;
		await this.lock(wt.repo, () => this.removeCheckout(wt, true));
		await this.save((d) => {
			const cur = d.sessions[sessionId];
			if (cur) d.sessions[sessionId] = { ...cur, state: "discarded" };
		});
	}

	/** Active chats of one project folder. */
	pending(wsId: string): { sessionId: string; wt: SessionWorktree }[] {
		return Object.entries(this.cache.sessions)
			.filter(([, wt]) => wt.state === "active" && workspaceId(wt.root) === wsId)
			.map(([sessionId, wt]) => ({ sessionId, wt }));
	}

	private async countLines(wt: SessionWorktree, files: WorktreeFile[]): Promise<void> {
		const base = await this.mergeBase(wt);
		const r = await git(wt.path, ["diff", "--numstat", "--no-renames", "-z", base]);
		const counts = new Map<string, { added: number; deleted: number; binary: boolean }>();
		for (const rec of r.stdout.split("\0")) {
			const m = /^(\S+)\t(\S+)\t(.*)$/s.exec(rec);
			if (m) counts.set(m[3] ?? "", m[1] === "-" ? { added: 0, deleted: 0, binary: true } : { added: Number(m[1]), deleted: Number(m[2]), binary: false });
		}
		for (const f of files) {
			const c = counts.get(f.path);
			if (c) Object.assign(f, c);
			else if (f.status === "?") {
				try {
					const abs = join(wt.path, f.path);
					const buf = statSync(abs).size > 1_000_000 ? undefined : readFileSync(abs);
					const binary = !buf || buf.includes(0);
					f.binary = binary;
					f.added = binary || !buf?.length ? 0 : buf.toString("utf8").split("\n").length - (buf[buf.length - 1] === 0x0a ? 1 : 0);
					f.deleted = 0;
				} catch {}
			}
		}
	}

	/** One file's diff against where the chat started, committed checkpoints and loose edits alike. */
	async diff(sessionId: string, path: string): Promise<GitDiff> {
		const wt = this.need(sessionId);
		const rel = path.replace(/\\/g, "/");
		if (!rel || rel.startsWith("-") || isAbsolute(rel) || rel.split("/").includes("..")) throw new AppError("generic");
		const base = await this.mergeBase(wt);
		let text = (await git(wt.path, ["diff", "--no-color", "--no-renames", base, "--", rel])).stdout;
		if (!text) text = (await git(wt.path, ["diff", "--no-index", "--no-color", "--", process.platform === "win32" ? "NUL" : "/dev/null", rel])).stdout;
		const MAX = 400_000;
		return text.length > MAX ? { text: text.slice(0, MAX), truncated: true } : { text, truncated: false };
	}

	async fileCount(sessionId: string): Promise<number> {
		const wt = this.get(sessionId);
		if (!wt || wt.state !== "active" || !existsSync(wt.path)) return 0;
		return (await this.changedFiles(wt).catch(() => [])).length;
	}
}

/** True when a write to `target` would land in the repository but outside the chat's own checkout. */
export function escapesWorktree(target: string, cwd: string, guard: { repo: string; keep: string }): boolean {
	if (!target) return false;
	const abs = resolve(cwd, target.replace(/^@/, ""));
	return inside(abs, guard.repo) && !inside(abs, guard.keep);
}
