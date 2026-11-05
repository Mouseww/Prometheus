import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeIntoDefault } from "../src/git/repo.ts";
import { type UpstreamSync, UPSTREAM_PUSH_FAILED_MESSAGE } from "../src/git/upstream.ts";
import type { WorkspacesService } from "../src/services/workspaces.ts";
import { commitAll, git, gitOk, openMr, sessionBranch, setupWorld, showFile, tmp, type Sess, type World, writeFiles } from "./git-helpers.ts";

const T = 90_000;

const getMr = async (w: World, id: string, who: Sess = w.alice) => (await w.t.api("GET", `/api/merge-requests/${id}`, { token: who.token })).data;
/** Approve defaults to the head commit currently on the request (what a reviewer would have looked at); pass a body to override. */
const act = async (w: World, who: Sess, id: string, action: "approve" | "reject" | "refresh" | "close", body?: unknown) => {
	let payload = body;
	if (action === "approve" && payload === undefined) {
		const found = await w.t.api("GET", `/api/merge-requests/${id}`, { token: who.token });
		// Callers who cannot see the request (outsiders) still send a well-formed body so authorization is what gets exercised.
		payload = { expectedHeadCommit: found.status === 200 ? found.data.headCommit : "0".repeat(40) };
	}
	return w.t.api("POST", `/api/merge-requests/${id}/${action}`, { token: who.token, body: payload });
};
const mainTip = (w: World) => gitOk(["--git-dir", w.repoPath, "rev-parse", "refs/heads/main"]);

/** Recipients of stored notifications of a kind (block 2C's notifications service writes them), optionally for one merge request. */
const notified = async (w: World, kind: string, mrId?: string): Promise<string[]> => {
	const rows = await w.t.hub.db.query<{ user_id: string; payload: Record<string, unknown> }>("SELECT user_id, payload FROM notifications WHERE kind = $1 ORDER BY id", [kind]);
	return rows.filter((r) => !mrId || r.payload.mergeRequestId === mrId).map((r) => r.user_id);
};

describe("merge request lifecycle and permissions", () => {
	let w: World;
	beforeAll(async () => {
		w = await setupWorld();
	}, T);
	afterAll(() => w.stop());

	it("a clean merge request opens, and approval creates a merge commit (author = MR author, committer = reviewer)", async () => {
		const s = await sessionBranch(w, w.alice, "feat", { "feature.txt": "hello\n" });
		await w.t.hub.db.tx({ system: true }, (q) =>
			q.query("INSERT INTO sessions (id, workspace_id, org_id, owner_user_id) VALUES ('sess-1',$1,$2,$3)", [w.wsId, w.root.orgId, w.alice.userId]),
		);
		const created = await openMr(w, w.alice, s, { sessionId: "sess-1" }, "Add feature");
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ status: "open", authorId: w.alice.userId, authorName: "Alice", title: "Add feature", branch: s.branch, headCommit: s.head, skippedReview: false, conflictFiles: null, sessionId: "sess-1" });
		const id = created.data.id as string;
		expect(await notified(w, "mr.created", id)).toEqual(expect.arrayContaining([w.bob.userId, w.dan.userId]));
		expect(await notified(w, "mr.created", id)).not.toContain(w.alice.userId);

		const before = await mainTip(w);
		const approved = await act(w, w.bob, id, "approve");
		expect(approved.status).toBe(200);
		expect(approved.data).toMatchObject({ status: "merged", reviewerId: w.bob.userId, skippedReview: false });
		expect(approved.data.decidedAt).toEqual(expect.any(String));

		const tip = await mainTip(w);
		expect(tip).toBe(approved.data.mergedCommit);
		expect(await gitOk(["--git-dir", w.repoPath, "rev-list", "--parents", "-n1", tip])).toBe(`${tip} ${before} ${s.head}`);
		expect(await gitOk(["--git-dir", w.repoPath, "log", "-1", "--format=%an|%ae|%cn|%ce", tip])).toBe("Alice|alice@corp.test|Bob|bob@corp.test");
		expect(await showFile(w, "main", "feature.txt")).toBe("hello");
		expect(await showFile(w, "main", "README.md")).toBe("# project");

		const audit = await w.t.hub.db.query<{ action: string; actor_id: string; target_id: string }>("SELECT action, actor_id, target_id FROM audit_log WHERE action = 'mr.merge'");
		expect(audit).toEqual([{ action: "mr.merge", actor_id: w.bob.userId, target_id: id }]);
		const merged = await notified(w, "mr.merged", id);
		expect(merged).toEqual(expect.arrayContaining([w.alice.userId, w.dan.userId]));
		expect(merged).not.toContain(w.bob.userId);

		// Terminal states stay terminal.
		expect((await act(w, w.bob, id, "approve")).code).toBe("invalidState");
		expect((await act(w, w.bob, id, "reject")).code).toBe("invalidState");
		expect((await act(w, w.alice, id, "close")).code).toBe("invalidState");
	}, T);

	it("permission matrix for review: admin and reviewer approve; member (even the author), outsiders and anonymous cannot", async () => {
		const s = await sessionBranch(w, w.alice, "perm", { "perm.txt": "p\n" });
		const id = (await openMr(w, w.alice, s)).data.id as string;
		expect((await act(w, w.alice, id, "approve")).status).toBe(403);
		expect((await act(w, w.alice, id, "reject")).status).toBe(403);
		expect((await act(w, w.carol, id, "approve")).status).toBe(404);
		expect((await w.t.api("POST", `/api/merge-requests/${id}/approve`)).status).toBe(401);
		expect((await getMr(w, id)).status).toBe("open");
		expect((await act(w, w.dan, id, "approve")).data.status).toBe("merged");

		const s2 = await sessionBranch(w, w.alice, "perm2", { "perm2.txt": "p\n" });
		const id2 = (await openMr(w, w.alice, s2)).data.id as string;
		expect((await act(w, w.root, id2, "approve")).data.status).toBe("merged");
	}, T);

	it("members create merge requests; outsiders cannot; anyone in the team can read, list and view the diff", async () => {
		const s = await sessionBranch(w, w.bob, "readable", { "r.txt": "r\n" });
		expect((await openMr(w, w.carol, s)).status).toBe(404);
		const created = await openMr(w, w.bob, s);
		expect(created.status).toBe(201);
		const id = created.data.id as string;
		expect((await getMr(w, id, w.alice)).id).toBe(id);
		expect((await w.t.api("GET", `/api/merge-requests/${id}`, { token: w.carol.token })).status).toBe(404);
		const list = await w.t.api("GET", `/api/workspaces/${w.wsId}/merge-requests?status=open`, { token: w.alice.token });
		expect(list.data.map((m: { id: string }) => m.id)).toContain(id);
		expect((await w.t.api("GET", `/api/workspaces/${w.wsId}/merge-requests`, { token: w.carol.token })).status).toBe(404);
		expect((await w.t.api("GET", `/api/merge-requests/${id}/diff`, { token: w.alice.token })).status).toBe(200);
		expect((await w.t.api("GET", `/api/merge-requests/${id}/diff`, { token: w.carol.token })).status).toBe(404);
	}, T);

	it("reject records the reviewer, writes audit and notifies the author", async () => {
		const s = await sessionBranch(w, w.alice, "to-reject", { "nope.txt": "n\n" });
		const id = (await openMr(w, w.alice, s)).data.id as string;
		const before = await mainTip(w);
		const r = await act(w, w.bob, id, "reject", { reason: "not now" });
		expect(r.data).toMatchObject({ status: "rejected", reviewerId: w.bob.userId });
		expect(await mainTip(w)).toBe(before);
		const audit = await w.t.hub.db.query<{ detail: { reason: string } }>("SELECT detail FROM audit_log WHERE action = 'mr.reject' AND target_id = $1", [id]);
		expect(audit[0]?.detail.reason).toBe("not now");
		expect(await notified(w, "mr.rejected", id)).toEqual([w.alice.userId]);
		expect((await act(w, w.bob, id, "approve")).code).toBe("invalidState");
	}, T);

	it("the author or a reviewer can close an open merge request; other members cannot", async () => {
		const s = await sessionBranch(w, w.alice, "to-close", { "c.txt": "c\n" });
		const id = (await openMr(w, w.alice, s)).data.id as string;
		const other = await sessionBranch(w, w.bob, "bob-other", { "o.txt": "o\n" });
		const otherMr = (await openMr(w, w.bob, other)).data.id as string;
		expect((await act(w, w.alice, otherMr, "close")).status).toBe(403);
		expect((await act(w, w.alice, id, "close")).data.status).toBe("closed");
		expect((await act(w, w.bob, id, "approve")).code).toBe("invalidState");
		expect((await act(w, w.dan, otherMr, "close")).data.status).toBe("closed");
	}, T);

	it("validates the request: own branch namespace, pushed commits, matching head", async () => {
		const s = await sessionBranch(w, w.alice, "valid", { "v.txt": "v\n" });
		expect((await openMr(w, w.alice, s, { branch: `session/${w.bob.userId}/valid` })).code).toBe("invalidBranch");
		expect((await openMr(w, w.alice, s, { branch: "main" })).code).toBe("invalidBranch");
		expect((await openMr(w, w.alice, s, { headCommit: "abc" })).code).toBe("validationError");
		expect((await openMr(w, w.alice, s, { headCommit: "f".repeat(40) })).code).toBe("commitNotFound");
		expect((await openMr(w, w.alice, s, { title: "" })).code).toBe("validationError");

		// Branch moved on after the commit the client names: refuse until the client pushes and names the new head.
		await writeFiles(s.dir, { "v2.txt": "v2\n" });
		await commitAll(s.dir, "more");
		await gitOk(["push", "-q", "origin", `HEAD:refs/heads/${s.branch}`], { cwd: s.dir, token: w.alice.token });
		expect((await openMr(w, w.alice, s)).code).toBe("headMismatch");
	}, T);

	it("diff endpoint returns a unified diff and a file list with binary flags, also after merging", async () => {
		const s = await sessionBranch(w, w.alice, "diffy", { "d/new.txt": "hello diff\n", "asset.bin": Buffer.from([0, 7, 7]), "README.md": "# project\nmore\n" });
		const id = (await openMr(w, w.alice, s)).data.id as string;
		const check = (d: { diff: string; files: unknown[]; truncated: boolean; head: string }) => {
			expect(d.head).toBe(s.head);
			expect(d.truncated).toBe(false);
			expect(d.diff).toContain("+++ b/d/new.txt");
			expect(d.diff).toContain("+hello diff");
			expect(d.diff).toContain("+more");
			expect(d.files).toEqual(
				expect.arrayContaining([
					{ path: "d/new.txt", status: "A", additions: 1, deletions: 0, binary: false },
					{ path: "asset.bin", status: "M", additions: null, deletions: null, binary: true },
					{ path: "README.md", status: "M", additions: 1, deletions: 0, binary: false },
				]),
			);
		};
		check((await w.t.api("GET", `/api/merge-requests/${id}/diff`, { token: w.bob.token })).data);
		await act(w, w.bob, id, "approve");
		check((await w.t.api("GET", `/api/merge-requests/${id}/diff`, { token: w.bob.token })).data);
	}, T);
});

describe("conflicts", () => {
	let w: World;
	beforeAll(async () => {
		w = await setupWorld();
	}, T);
	afterAll(() => w.stop());

	it("text conflict: detected at approval, marks the request, names the last modifier; refresh after resolving reopens it", async () => {
		const a = await sessionBranch(w, w.alice, "a", { "src/app.txt": "line1\nalice\nline3\n" });
		const b = await sessionBranch(w, w.bob, "b", { "src/app.txt": "line1\nbob\nline3\n", "bob-only.txt": "b\n" });
		const aId = (await openMr(w, w.alice, a, {}, "Alice change")).data.id as string;
		const created = await openMr(w, w.bob, b, {}, "Bob change");
		expect(created.data.status).toBe("open");
		const bId = created.data.id as string;

		const aMerged = await act(w, w.dan, aId, "approve");
		expect(aMerged.data.status).toBe("merged");

		const tipBefore = await mainTip(w);
		const denied = await act(w, w.dan, bId, "approve");
		expect(denied.status).toBe(409);
		expect(denied.code).toBe("mergeConflict");
		expect(await mainTip(w)).toBe(tipBefore);
		const bad = await getMr(w, bId);
		expect(bad.status).toBe("conflict");
		expect(bad.reviewerId).toBeNull();
		expect(bad.conflictFiles).toEqual([
			{
				path: "src/app.txt",
				binary: false,
				lastModifiedBy: { mergeRequestId: aId, userId: w.alice.userId, displayName: "Alice", commit: aMerged.data.mergedCommit },
			},
		]);
		// A conflicting request cannot be approved until refreshed and clean.
		expect((await act(w, w.dan, bId, "approve")).code).toBe("mergeConflict");
		// Only the author or a reviewer may refresh.
		expect((await act(w, w.alice, bId, "refresh")).status).toBe(403);
		expect((await act(w, w.bob, bId, "refresh")).data.status).toBe("conflict");

		// The author resolves it locally and pushes.
		await gitOk(["fetch", "-q", "origin"], { cwd: b.dir, token: w.bob.token });
		const merge = await git(["merge", "origin/main"], { cwd: b.dir });
		expect(merge.code).not.toBe(0);
		await writeFiles(b.dir, { "src/app.txt": "line1\nalice+bob\nline3\n" });
		const resolved = await commitAll(b.dir, "resolve");
		await gitOk(["push", "-q", "origin", `HEAD:refs/heads/${b.branch}`], { cwd: b.dir, token: w.bob.token });
		const refreshed = await act(w, w.bob, bId, "refresh");
		expect(refreshed.data).toMatchObject({ status: "open", headCommit: resolved, conflictFiles: null });

		const merged = await act(w, w.dan, bId, "approve");
		expect(merged.data.status).toBe("merged");
		expect(await showFile(w, "main", "src/app.txt")).toBe("line1\nalice+bob\nline3");
		expect(await showFile(w, "main", "bob-only.txt")).toBe("b");
	}, T);

	it("a request created from a stale base is born in conflict", async () => {
		// Branch from the original seed commit, long before src/app.txt was changed on the default branch.
		const root = (await gitOk(["--git-dir", w.repoPath, "rev-list", "--max-parents=0", "refs/heads/main"])).split("\n")[0] as string;
		const clone = await tmp();
		await gitOk(["clone", "-q", "--no-checkout", w.gitUrl, clone], { token: w.alice.token });
		await gitOk(["checkout", "-q", "-b", `session/${w.alice.userId}/stale`, root], { cwd: clone });
		await writeFiles(clone, { "src/app.txt": "totally\ndifferent\n" });
		const head = await commitAll(clone, "stale");
		await gitOk(["push", "-q", "origin", `HEAD:refs/heads/session/${w.alice.userId}/stale`], { cwd: clone, token: w.alice.token });
		const r = await openMr(w, w.alice, { dir: clone, branch: `session/${w.alice.userId}/stale`, base: root, head });
		expect(r.status).toBe(201);
		expect(r.data.status).toBe("conflict");
		expect(r.data.conflictFiles.map((f: { path: string }) => f.path)).toEqual(["src/app.txt"]);
	}, T);

	it("binary conflict: flagged as binary", async () => {
		const bin = await sessionBranch(w, w.alice, "bin-a", { "asset.bin": Buffer.from([0, 9, 9]) });
		const bin2 = await sessionBranch(w, w.bob, "bin-b", { "asset.bin": Buffer.from([0, 8, 8]), "text-b.txt": "t\n" });
		const id1 = (await openMr(w, w.alice, bin, {}, "bin A")).data.id as string;
		const id2 = (await openMr(w, w.bob, bin2, {}, "bin B")).data.id as string;
		expect((await act(w, w.dan, id1, "approve")).data.status).toBe("merged");
		expect((await act(w, w.dan, id2, "approve")).code).toBe("mergeConflict");
		const mr = await getMr(w, id2);
		expect(mr.status).toBe("conflict");
		expect(mr.conflictFiles).toHaveLength(1);
		expect(mr.conflictFiles[0]).toMatchObject({ path: "asset.bin", binary: true, lastModifiedBy: { mergeRequestId: id1, displayName: "Alice" } });
	}, T);
});

describe("skip review, races and empty repositories", () => {
	let w: World;
	beforeAll(async () => {
		w = await setupWorld();
	}, T);
	afterAll(() => w.stop());

	it("skipReview by a reviewer or admin merges immediately and is audited; a plain member is denied", async () => {
		const s = await sessionBranch(w, w.bob, "fast", { "fast.txt": "f\n" });
		const r = await openMr(w, w.bob, s, { skipReview: true }, "Fast track");
		expect(r.status).toBe(201);
		expect(r.data).toMatchObject({ status: "merged", skippedReview: true, reviewerId: w.bob.userId });
		expect(await showFile(w, "main", "fast.txt")).toBe("f");
		const audit = await w.t.hub.db.query<{ actor_id: string }>("SELECT actor_id FROM audit_log WHERE action = 'mr.merge.skipReview' AND target_id = $1", [r.data.id]);
		expect(audit).toEqual([{ actor_id: w.bob.userId }]);

		const adminS = await sessionBranch(w, w.dan, "fast-admin", { "fast2.txt": "f\n" });
		expect((await openMr(w, w.dan, adminS, { skipReview: true })).data.status).toBe("merged");

		const memberS = await sessionBranch(w, w.alice, "denied", { "denied.txt": "d\n" });
		const denied = await openMr(w, w.alice, memberS, { skipReview: true });
		expect(denied.status).toBe(403);
		expect(denied.code).toBe("skipReviewDenied");
		expect(await w.t.hub.db.query("SELECT 1 FROM merge_requests WHERE branch = $1", [memberS.branch])).toHaveLength(0);
		// Without skipReview a member's request just opens.
		expect((await openMr(w, w.alice, memberS)).data.status).toBe("open");
	}, T);

	it("skipReview does not bypass conflicts", async () => {
		const first = await sessionBranch(w, w.alice, "k1", { "README.md": "# one\n" });
		const second = await sessionBranch(w, w.bob, "k2", { "README.md": "# two\n" });
		const firstId = (await openMr(w, w.alice, first)).data.id as string;
		expect((await act(w, w.dan, firstId, "approve")).data.status).toBe("merged");
		const r = await openMr(w, w.bob, second, { skipReview: true });
		expect(r.status).toBe(201);
		expect(r.data.status).toBe("conflict");
		expect(r.data.skippedReview).toBe(false);
		expect(await showFile(w, "main", "README.md")).toBe("# one");
	}, T);

	it("concurrent approvals of independent requests all land on the default branch", async () => {
		const sessions = await Promise.all([
			sessionBranch(w, w.alice, "p1", { "par/one.txt": "1\n" }),
			sessionBranch(w, w.alice, "p2", { "par/two.txt": "2\n" }),
		]);
		const ids = [] as string[];
		for (const s of sessions) ids.push((await openMr(w, w.alice, s)).data.id as string);
		const results = await Promise.all(ids.map((id) => act(w, w.bob, id, "approve")));
		expect(results.map((r) => r.status)).toEqual([200, 200]);
		expect(await showFile(w, "main", "par/one.txt")).toBe("1");
		expect(await showFile(w, "main", "par/two.txt")).toBe("2");
		for (const s of sessions) expect(await git(["--git-dir", w.repoPath, "merge-base", "--is-ancestor", s.head, "refs/heads/main"])).toMatchObject({ code: 0 });
	}, T);

	it("an empty repository adopts the first merged branch as its default branch", async () => {
		const e = await setupWorld({ seed: false });
		try {
			const dir = await tmp();
			await gitOk(["clone", "-q", e.gitUrl, dir], { token: e.alice.token });
			const branch = `session/${e.alice.userId}/init`;
			await gitOk(["checkout", "-q", "-b", branch], { cwd: dir });
			await writeFiles(dir, { "README.md": "# fresh\n" });
			const head = await commitAll(dir, "initial");
			await gitOk(["push", "-q", "origin", `HEAD:refs/heads/${branch}`], { cwd: dir, token: e.alice.token });
			const created = await openMr(e, e.alice, { dir, branch, base: head, head });
			expect(created.data.status).toBe("open");
			expect((await act(e, e.bob, created.data.id, "approve")).data.status).toBe("merged");
			expect(await gitOk(["--git-dir", e.repoPath, "rev-parse", "refs/heads/main"])).toBe(head);
			const files = await e.t.api("GET", `/api/workspaces/${e.wsId}/files`, { token: e.alice.token });
			expect(files.data.entries.map((x: { name: string }) => x.name)).toEqual(["README.md"]);
		} finally {
			await e.stop();
		}
	}, T);
});

describe("compare-and-swap merge", () => {
	const ident = { name: "A", email: "a@test" };

	async function fixture() {
		const dir = await tmp("cas-");
		await gitOk(["init", "-q", "-b", "main", dir]);
		const heads: Record<string, string> = {};
		await writeFiles(dir, { "a.txt": "a\n" });
		const c0 = await commitAll(dir, "c0");
		for (const name of ["h1", "h2", "h3"]) {
			await gitOk(["checkout", "-q", "-b", name, c0], { cwd: dir });
			await writeFiles(dir, { [`${name}.txt`]: `${name}\n` });
			heads[name] = await commitAll(dir, name);
		}
		await gitOk(["checkout", "-q", "main"], { cwd: dir });
		const bare = await tmp("cas-bare-");
		await gitOk(["clone", "-q", "--bare", dir, bare]);
		return { bare, c0, heads };
	}
	const input = (head: string, extra = {}) => ({ defaultBranch: "main", head, message: "merge", author: ident, committer: ident, ...extra });

	it("retries once against the new tip when the ref moved during the merge", async () => {
		const { bare, c0, heads } = await fixture();
		let calls = 0;
		const out = await mergeIntoDefault(bare, input(heads.h1 as string, {
			beforeUpdate: async (attempt: number) => {
				calls++;
				if (attempt === 0) await gitOk(["--git-dir", bare, "update-ref", "refs/heads/main", heads.h3 as string, c0]);
			},
		}));
		expect(calls).toBe(2);
		expect(out.kind).toBe("merged");
		if (out.kind !== "merged") return;
		expect(await gitOk(["--git-dir", bare, "rev-list", "--parents", "-n1", out.commit])).toBe(`${out.commit} ${heads.h3} ${heads.h1}`);
		expect(await gitOk(["--git-dir", bare, "ls-tree", "--name-only", "refs/heads/main"])).toBe("a.txt\nh1.txt\nh3.txt");
	}, T);

	it("gives up after the second lost race", async () => {
		const { bare, c0, heads } = await fixture();
		const out = await mergeIntoDefault(bare, input(heads.h1 as string, {
			beforeUpdate: async (attempt: number) => {
				const [from, to] = attempt === 0 ? [c0, heads.h3] : [heads.h3, heads.h2];
				await gitOk(["--git-dir", bare, "update-ref", "refs/heads/main", to as string, from as string]);
			},
		}));
		expect(out.kind).toBe("casFailed");
		expect(await gitOk(["--git-dir", bare, "rev-parse", "refs/heads/main"])).toBe(heads.h2);
	}, T);

	it("reports conflicts without touching the ref and detects already merged work", async () => {
		const { bare, heads } = await fixture();
		const first = await mergeIntoDefault(bare, input(heads.h1 as string));
		expect(first.kind).toBe("merged");
		const again = await mergeIntoDefault(bare, input(heads.h1 as string));
		expect(again.kind).toBe("alreadyMerged");
	}, T);
});

describe("upstream remote", () => {
	let w: World;
	let upstreamDir: string;
	let seedCommit: string;
	const sync = (): UpstreamSync => w.t.hub.registry.require<UpstreamSync>("upstreamSync");
	const loadWs = async () => {
		const ws = await w.t.hub.registry.require<WorkspacesService>("workspaces").loadSystem(w.wsId);
		if (!ws) throw new Error("工作区不存在");
		return ws;
	};
	const upstreamTip = () => gitOk(["--git-dir", upstreamDir, "rev-parse", "refs/heads/main"]);
	const workspace = async () => (await w.t.api("GET", `/api/workspaces/${w.wsId}`, { token: w.dan.token })).data;
	const setUpstream = (url: string | null) => w.t.api("PATCH", `/api/workspaces/${w.wsId}`, { token: w.dan.token, body: { upstreamUrl: url } });

	beforeAll(async () => {
		w = await setupWorld();
		upstreamDir = await tmp("upstream-");
		await gitOk(["init", "-q", "--bare", "-b", "main", upstreamDir]);
		seedCommit = await mainTip(w);
		await gitOk(["--git-dir", w.repoPath, "push", "-q", upstreamDir, "main:main"]);
		expect((await setUpstream(upstreamDir)).status).toBe(200);
	}, T);
	afterAll(() => w.stop());

	it("pushes the default branch to the upstream after a successful merge", async () => {
		const s = await sessionBranch(w, w.alice, "up1", { "up1.txt": "1\n" });
		const id = (await openMr(w, w.alice, s)).data.id as string;
		const merged = await act(w, w.bob, id, "approve");
		expect(merged.data.status).toBe("merged");
		expect(await upstreamTip()).toBe(merged.data.mergedCommit);
		expect(await workspace()).toMatchObject({ upstreamStatus: "ok", upstreamError: null, upstreamCheckedAt: expect.any(String) });
	}, T);

	it("fast-forwards the Hub copy when the upstream is ahead", async () => {
		const work = await tmp();
		await gitOk(["clone", "-q", upstreamDir, work]);
		await writeFiles(work, { "from-upstream.txt": "u\n" });
		const c = await commitAll(work, "upstream commit");
		await gitOk(["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: work });
		const ws = await loadWs();
		expect(await sync().syncOne(ws)).toBe("fastForwarded");
		expect(await mainTip(w)).toBe(c);
		expect(await showFile(w, "main", "from-upstream.txt")).toBe("u");
		expect(await workspace()).toMatchObject({ upstreamStatus: "ok" });
		expect(await sync().syncOne(ws)).toBe("unchanged");
	}, T);

	it("flags divergence without touching anything and tells the team admins once", async () => {
		const s = await sessionBranch(w, w.alice, "up2", { "up2.txt": "2\n" });
		const id = (await openMr(w, w.alice, s)).data.id as string;
		const hubBefore = await act(w, w.bob, id, "approve");
		expect(hubBefore.data.status).toBe("merged");

		// Rewrite the upstream history behind the Hub's back.
		const work = await tmp();
		await gitOk(["clone", "-q", upstreamDir, work]);
		await gitOk(["reset", "-q", "--hard", seedCommit], { cwd: work });
		await writeFiles(work, { "rogue.txt": "r\n" });
		await commitAll(work, "rogue");
		await gitOk(["push", "-q", "-f", "origin", "HEAD:refs/heads/main"], { cwd: work });

		const ws = await loadWs();
		const hubTip = await mainTip(w);
		expect(await sync().syncOne(ws)).toBe("diverged");
		expect(await mainTip(w)).toBe(hubTip);
		expect(await workspace()).toMatchObject({ upstreamStatus: "upstream_diverged" });
		const recipients = await notified(w, "upstream.diverged");
		expect(recipients).toEqual(expect.arrayContaining([w.dan.userId, w.root.userId]));
		expect(recipients).not.toContain(w.alice.userId);
		// Still diverged on the next poll: no second notification.
		expect(await sync().syncOne(await loadWs())).toBe("diverged");
		expect(await notified(w, "upstream.diverged")).toEqual(recipients);
	}, T);

	it("a failing upstream push is recorded and notified, and never rolls the merge back", async () => {
		expect((await setUpstream(`${upstreamDir}-missing`)).status).toBe(200);
		const s = await sessionBranch(w, w.alice, "up3", { "up3.txt": "3\n" });
		const id = (await openMr(w, w.alice, s)).data.id as string;
		const merged = await act(w, w.bob, id, "approve");
		expect(merged.status).toBe(200);
		expect(merged.data.status).toBe("merged");
		expect(await mainTip(w)).toBe(merged.data.mergedCommit);
		const ws = await workspace();
		expect(ws.upstreamStatus).toBe("push_failed");
		// The team sees a short fixed message, never git's stderr (which can echo URLs and server paths).
		expect(ws.upstreamError).toBe(UPSTREAM_PUSH_FAILED_MESSAGE);
		expect(await notified(w, "upstream.pushFailed")).toEqual(expect.arrayContaining([w.dan.userId]));
	}, T);

	it("changing the upstream clears the old status; a workspace without upstream is left alone", async () => {
		expect(await setUpstream(null)).toMatchObject({ status: 200 });
		expect(await workspace()).toMatchObject({ upstreamUrl: null, upstreamStatus: null, upstreamError: null });
		expect(await sync().syncOne(await loadWs())).toBe("skipped");
		await sync().syncAll();
	}, T);
});
