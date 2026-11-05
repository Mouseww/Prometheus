import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { gitOk } from "../../../packages/hub/test/git-helpers.ts";
import type { MemberEnv } from "../src/member/env.ts";
import { SyncManager } from "../src/sync/manager.ts";
import { type Member, socketPair, startMember, startTeamWorld, type TeamWorld } from "./harness.ts";

const T = 180_000;
vi.setConfig({ testTimeout: T });

let tw: TeamWorld;
/** Alice's two servers: her local one and (as a stand-in for the tenant instance) a second member with its own state and clones. */
let local: Member;
let team: Member;

beforeAll(async () => {
	tw = await startTeamWorld();
	local = await startMember(tw, "alice@corp.test");
	team = await startMember(tw, "alice@corp.test");
}, T);
afterAll(async () => {
	await Promise.all([local.stop(), team.stop()]);
	await tw.stop();
});

const norm = (s: string): string => s.replace(/\r\n/g, "\n");

async function startSession(title: string) {
	return (await local.ctx.call("session.start", { workspaceId: tw.world.wsId, title })) as { sessionId: string; hubSessionId: string; worktree: string; branch: string };
}

/** Two sync managers (local writer, team reader) joined by an in-memory socket pair, on top of the real Hub and real git repositories. */
function managers(barrierMs = 120_000) {
	const sockets = socketPair();
	const notes: { topic: string; data: any }[] = [];
	const teamEnv: MemberEnv = { ...team.api.env, side: "team" };
	const a = new SyncManager(local.api.env, { socket: sockets.a, notify: () => {}, barrierMs });
	const b = new SyncManager(teamEnv, { socket: sockets.b, notify: (topic, data) => void notes.push({ topic, data }), barrierMs });
	return { a, b, notes, sockets, stop: () => (a.dispose(), b.dispose()) };
}

describe("replica sync", () => {
	it("a clean reader gets the writer's files (new replica), then later changes, deletions and a barrier receipt", async () => {
		const s = await startSession("sync clean");
		const m = managers();
		try {
			await writeFile(join(s.worktree, "notes.txt"), "one\n");
			const first = await m.a.barrier(s.hubSessionId);
			const replica = m.b.target(s.hubSessionId)!;
			expect(replica.kind).toBe("replica");
			expect(replica.worktree).not.toBe(s.worktree);
			expect(norm(await readFile(join(replica.worktree, "notes.txt"), "utf8"))).toBe("one\n");
			expect(replica.lastApplied).toBeDefined();
			expect(m.notes.find((n) => n.topic === "snapshotApplied")?.data).toMatchObject({ hubSessionId: s.hubSessionId, commit: first, status: "unchanged" });
			expect(m.notes.some((n) => n.topic === "syncConflict")).toBe(false);

			// The Hub knows the newest snapshot, under the `latest` ref.
			expect((await tw.world.t.api("GET", `/api/sessions/${s.hubSessionId}`, { token: tw.world.alice.token })).data.snapshotCommit).toBe(first);
			expect(await gitOk(["--git-dir", tw.world.repoPath, "rev-parse", `refs/prometheus/snapshots/${tw.world.alice.userId}/${s.hubSessionId}/latest`])).toBe(first);

			// Next rounds: an edit, an added file and then a deletion on the writer all arrive without a conflict.
			await writeFile(join(s.worktree, "notes.txt"), "two\n");
			await writeFile(join(s.worktree, "extra.txt"), "x\n");
			await m.a.barrier(s.hubSessionId);
			expect(m.notes.filter((n) => n.topic === "snapshotApplied").at(-1)?.data).toMatchObject({ status: "applied" });
			expect(norm(await readFile(join(replica.worktree, "notes.txt"), "utf8"))).toBe("two\n");
			expect(norm(await readFile(join(replica.worktree, "extra.txt"), "utf8"))).toBe("x\n");

			await rm(join(s.worktree, "extra.txt"));
			await m.a.barrier(s.hubSessionId);
			await expect(readFile(join(replica.worktree, "extra.txt"), "utf8")).rejects.toThrow();
			expect(m.notes.filter((n) => n.topic === "syncConflict")).toHaveLength(0);
		} finally {
			m.stop();
		}
	});

	it("barrierIfDirty skips the round trip when nothing changed since the last publish or apply", async () => {
		const s = await startSession("sync dirty");
		const m = managers();
		try {
			await writeFile(join(s.worktree, "a.txt"), "a\n");
			expect(await m.a.barrierIfDirty(s.hubSessionId)).toMatch(/^[0-9a-f]{40}$/);
			const sent = m.sockets.sent[0].length;
			expect(await m.a.barrierIfDirty(s.hubSessionId)).toBeUndefined();
			expect(m.sockets.sent[0]).toHaveLength(sent);
			await writeFile(join(s.worktree, "a.txt"), "b\n");
			expect(await m.a.barrierIfDirty(s.hubSessionId)).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			m.stop();
		}
	});

	it("when the reader edited files since the last apply, its state is saved under a conflict ref before it is overwritten", async () => {
		const s = await startSession("sync conflict");
		const m = managers();
		try {
			await writeFile(join(s.worktree, "doc.txt"), "base\n");
			await m.a.barrier(s.hubSessionId);
			const replica = m.b.target(s.hubSessionId)!;

			// The reader's user edits while the writer moves on.
			await writeFile(join(replica.worktree, "doc.txt"), "reader edit\n");
			await writeFile(join(replica.worktree, "mine.txt"), "only here\n");
			await writeFile(join(s.worktree, "doc.txt"), "writer edit\n");
			const commit = await m.a.barrier(s.hubSessionId);

			expect(norm(await readFile(join(replica.worktree, "doc.txt"), "utf8"))).toBe("writer edit\n");
			const conflict = m.notes.find((n) => n.topic === "syncConflict");
			expect(conflict?.data).toMatchObject({ hubSessionId: s.hubSessionId, worktree: replica.worktree });
			expect(conflict?.data.conflictRef).toMatch(new RegExp(`/${s.hubSessionId}/conflict-\\d+$`));
			expect(m.notes.filter((n) => n.topic === "snapshotApplied").at(-1)?.data).toMatchObject({ commit, status: "conflict" });

			// The saved commit holds the reader's version of the files.
			const saved = conflict!.data.conflictRef as string;
			expect(norm(await gitOk(["show", `${saved}:doc.txt`], { cwd: replica.worktree }))).toBe("reader edit");
			expect(norm(await gitOk(["show", `${saved}:mine.txt`], { cwd: replica.worktree }))).toBe("only here");
			// The conflict ref stays local: the Hub never sees it.
			expect(await gitOk(["--git-dir", tw.world.repoPath, "for-each-ref", "--format=%(refname)", "refs/prometheus/snapshots/*/*/conflict-*"])).toBe("");
		} finally {
			m.stop();
		}
	});

	it("a barrier fails with barrierTimeout when the other side never confirms, and a late receipt does not revive it", async () => {
		const s = await startSession("sync barrier");
		const sockets = socketPair();
		const a = new SyncManager(local.api.env, { socket: sockets.a, notify: () => {}, barrierMs: 150 });
		try {
			await writeFile(join(s.worktree, "t.txt"), "t\n");
			await expect(a.barrier(s.hubSessionId)).rejects.toMatchObject({ code: "barrierTimeout", status: 504 });
			// The snapshot itself was published (the next attempt can reuse it) and the sync state is not stuck.
			expect(sockets.sent[0].some((f) => f.type === "snapshot.updated")).toBe(true);
			await expect(a.barrier(s.hubSessionId)).rejects.toMatchObject({ code: "barrierTimeout" });
		} finally {
			a.dispose();
		}
	});

	it("handles a snapshot ref left behind by an older version (leaf ref blocks `latest`) on both push and fetch", async () => {
		const s = await startSession("sync legacy");
		const m = managers();
		const userId = tw.world.alice.userId;
		try {
			const base = await gitOk(["--git-dir", tw.world.repoPath, "rev-parse", "HEAD"]);
			await gitOk(["--git-dir", tw.world.repoPath, "update-ref", `refs/prometheus/snapshots/${userId}/${s.hubSessionId}`, base]);
			await writeFile(join(s.worktree, "legacy.txt"), "legacy\n");
			const commit = await m.a.barrier(s.hubSessionId);
			expect(await gitOk(["--git-dir", tw.world.repoPath, "rev-parse", `refs/prometheus/snapshots/${userId}/${s.hubSessionId}/latest`])).toBe(commit);
			expect(norm(await readFile(join(m.b.target(s.hubSessionId)!.worktree, "legacy.txt"), "utf8"))).toBe("legacy\n");
		} finally {
			m.stop();
		}
	});

	it("ignores its own frames and malformed frames", async () => {
		const sockets = socketPair();
		const a = new SyncManager(local.api.env, { socket: sockets.a, notify: () => {}, barrierMs: 100 });
		try {
			expect(a.handleFrame({ type: "snapshot.updated", hubSessionId: "x", commit: "c", side: "local" })).toBe(true);
			expect(a.handleFrame({ type: "snapshot.updated", hubSessionId: 5, commit: "c", side: "team" })).toBe(true);
			expect(a.handleFrame({ type: "something.else" })).toBe(false);
			// Object ids and session ids from the Hub are validated before they can reach a git command line.
			for (const commit of ["--upload-pack=evil", "HEAD", "abc123", "A".repeat(40), `${"a".repeat(40)} --x`, "a".repeat(41)]) {
				await expect(a.applyIncoming("sess-1", commit)).rejects.toMatchObject({ code: "invalidParams" });
				expect(a.handleFrame({ type: "snapshot.updated", hubSessionId: "sess-1", commit, side: "team" })).toBe(true);
			}
			await expect(a.applyIncoming("../evil", "a".repeat(40))).rejects.toMatchObject({ code: "invalidParams" });
			expect(a.target("sess-1")).toBeUndefined();
			expect(a.target("unknown-session")).toBeUndefined();
			await expect(a.publish("unknown-session")).rejects.toMatchObject({ code: "notTeamSession" });
		} finally {
			a.dispose();
		}
	});
});
