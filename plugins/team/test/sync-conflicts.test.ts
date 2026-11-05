import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { gitOk } from "../../../packages/hub/test/git-helpers.ts";
import type { MemberEnv } from "../src/member/env.ts";
import { SyncManager } from "../src/sync/manager.ts";
import { type Member, socketPair, startMember, startTeamWorld, type TeamWorld } from "./harness.ts";

const T = 180_000;
vi.setConfig({ testTimeout: T });

let tw: TeamWorld;
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
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

async function startSession(title: string) {
	return (await local.ctx.call("session.start", { workspaceId: tw.world.wsId, title })) as { sessionId: string; hubSessionId: string; worktree: string; branch: string };
}

function managers() {
	const sockets = socketPair();
	const notes: { topic: string; data: any }[] = [];
	const teamEnv: MemberEnv = { ...team.api.env, side: "team" };
	const a = new SyncManager(local.api.env, { socket: sockets.a, notify: () => {}, barrierMs: 120_000 });
	const b = new SyncManager(teamEnv, { socket: sockets.b, notify: (topic, data) => void notes.push({ topic, data }), barrierMs: 120_000 });
	return { a, b, notes, stop: () => (a.dispose(), b.dispose()) };
}

/** The writer publishes `doc.txt = base`; the reader then edits while the writer moves on, which saves a conflict on the reader. */
async function makeConflict(title: string, reader: { doc?: string; mine?: string }, writerDoc: string) {
	const s = await startSession(title);
	const m = managers();
	await writeFile(join(s.worktree, "doc.txt"), "base\n");
	await m.a.barrier(s.hubSessionId);
	const replica = m.b.target(s.hubSessionId)!;
	if (reader.doc !== undefined) await writeFile(join(replica.worktree, "doc.txt"), reader.doc);
	if (reader.mine !== undefined) await writeFile(join(replica.worktree, "mine.txt"), reader.mine);
	await writeFile(join(s.worktree, "doc.txt"), writerDoc);
	await m.a.barrier(s.hubSessionId);
	const conflictRef = m.notes.find((n) => n.topic === "syncConflict")!.data.conflictRef as string;
	return { s, m, replica, conflictRef };
}

describe("listing and restoring saved sync conflicts", () => {
	it("lists the saved conflicts with the files the user changed", async () => {
		const { s, m, conflictRef } = await makeConflict("conflicts list", { doc: "reader edit\n", mine: "only here\n" }, "writer edit\n");
		try {
			const items = await m.b.conflicts(s.hubSessionId);
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({ conflictRef, commit: expect.stringMatching(/^[0-9a-f]{40}$/), savedAt: expect.any(Number), worktree: m.b.target(s.hubSessionId)!.worktree });
			expect([...items[0]!.files].sort()).toEqual(["doc.txt", "mine.txt"]);
			// The writer saved nothing, and the RPC answers with the same shape.
			expect(await m.a.conflicts(s.hubSessionId)).toEqual([]);
			expect(await local.ctx.call("sync.conflicts", { hubSessionId: s.hubSessionId })).toEqual({ conflicts: [] });
		} finally {
			m.stop();
		}
	});

	it("apply: merges the saved edits back as uncommitted changes when the files do not clash", async () => {
		const { s, m, replica, conflictRef } = await makeConflict("restore apply", { mine: "only here\n" }, "writer edit\n");
		try {
			expect(await exists(join(replica.worktree, "mine.txt"))).toBe(false);
			const result = await m.b.restoreConflict(s.hubSessionId, conflictRef);
			expect(result).toMatchObject({ mode: "apply", conflictRef, worktree: replica.worktree, files: ["mine.txt"] });
			expect(norm(await readFile(join(replica.worktree, "mine.txt"), "utf8"))).toBe("only here\n");
			// The writer's newer file is kept, the restored file is only an uncommitted change, and the backup ref stays.
			expect(norm(await readFile(join(replica.worktree, "doc.txt"), "utf8"))).toBe("writer edit\n");
			expect(await gitOk(["status", "--porcelain"], { cwd: replica.worktree })).toContain("mine.txt");
			expect(await gitOk(["rev-parse", "--verify", conflictRef], { cwd: replica.worktree })).toMatch(/^[0-9a-f]{40}$/);
			expect(m.notes.some((n) => n.topic === "conflictRestored")).toBe(true);
		} finally {
			m.stop();
		}
	});

	it("apply: refuses, and touches nothing, when a file was changed differently on both sides", async () => {
		const { s, m, replica, conflictRef } = await makeConflict("restore clash", { doc: "reader edit\n", mine: "only here\n" }, "writer edit\n");
		try {
			await expect(m.b.restoreConflict(s.hubSessionId, conflictRef)).rejects.toMatchObject({ code: "restoreConflict", status: 409, message: expect.stringContaining("doc.txt") });
			expect(norm(await readFile(join(replica.worktree, "doc.txt"), "utf8"))).toBe("writer edit\n");
			expect(await exists(join(replica.worktree, "mine.txt"))).toBe(false);
		} finally {
			m.stop();
		}
	});

	it("apply: refuses while the worktree holds edits made since the last sync", async () => {
		const { s, m, replica, conflictRef } = await makeConflict("restore dirty", { mine: "only here\n" }, "writer edit\n");
		try {
			await writeFile(join(replica.worktree, "scratch.txt"), "work in progress\n");
			await expect(m.b.restoreConflict(s.hubSessionId, conflictRef)).rejects.toMatchObject({ code: "worktreeDirty", status: 409 });
			expect(await exists(join(replica.worktree, "mine.txt"))).toBe(false);
			expect(norm(await readFile(join(replica.worktree, "scratch.txt"), "utf8"))).toBe("work in progress\n");
		} finally {
			m.stop();
		}
	});

	it("branch: puts the saved state on a new branch in its own worktree and leaves the session alone", async () => {
		const { s, m, replica, conflictRef } = await makeConflict("restore branch", { doc: "reader edit\n", mine: "only here\n" }, "writer edit\n");
		try {
			// Works even when the session worktree is dirty.
			await writeFile(join(replica.worktree, "scratch.txt"), "wip\n");
			const result = await m.b.restoreConflict(s.hubSessionId, conflictRef, "branch");
			expect(result.mode).toBe("branch");
			expect(result.branch).toMatch(/^restore\/conflict-\d+-[0-9a-f]{6}$/);
			expect(result.worktree).not.toBe(replica.worktree);
			expect(norm(await readFile(join(result.worktree, "doc.txt"), "utf8"))).toBe("reader edit\n");
			expect(norm(await readFile(join(result.worktree, "mine.txt"), "utf8"))).toBe("only here\n");
			expect(await gitOk(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: result.worktree })).toBe(result.branch);
			expect(norm(await readFile(join(replica.worktree, "doc.txt"), "utf8"))).toBe("writer edit\n");
			expect(await exists(join(replica.worktree, "mine.txt"))).toBe(false);
		} finally {
			m.stop();
		}
	});

	it("rejects refs that are not this session's conflict backups, and missing ones", async () => {
		const { s, m, conflictRef } = await makeConflict("restore invalid", { mine: "only here\n" }, "writer edit\n");
		try {
			const userId = tw.world.alice.userId;
			const bad = [
				"refs/heads/main",
				`refs/prometheus/snapshots/${userId}/${s.hubSessionId}/latest`,
				`refs/prometheus/snapshots/${userId}/other-session/conflict-1`,
				`${conflictRef}/../latest`,
				"--upload-pack=x",
			];
			for (const ref of bad) await expect(m.b.restoreConflict(s.hubSessionId, ref)).rejects.toMatchObject({ code: "invalidConflictRef", status: 400 });
			await expect(m.b.restoreConflict(s.hubSessionId, `refs/prometheus/snapshots/${userId}/${s.hubSessionId}/conflict-1`)).rejects.toMatchObject({ code: "conflictNotFound", status: 404 });
			await expect(m.b.restoreConflict("unknown-session", conflictRef)).rejects.toMatchObject({ code: "notTeamSession" });
			// Nothing was changed by the failed attempts.
			expect(await m.b.conflicts(s.hubSessionId)).toHaveLength(1);
		} finally {
			m.stop();
		}
	});

	it("validates the RPC parameters", async () => {
		const s = await startSession("restore rpc");
		await expect(local.ctx.call("sync.restoreConflict", { hubSessionId: s.hubSessionId })).rejects.toMatchObject({ code: "invalidParams" });
		await expect(local.ctx.call("sync.restoreConflict", { hubSessionId: s.hubSessionId, conflictRef: "x", mode: "force" })).rejects.toMatchObject({ code: "invalidParams" });
		await expect(local.ctx.call("sync.restoreConflict", { hubSessionId: s.hubSessionId, conflictRef: "x" })).rejects.toMatchObject({ code: "invalidConflictRef" });
		await expect(local.ctx.call("sync.conflicts", {})).rejects.toMatchObject({ code: "invalidParams" });
	});
});
