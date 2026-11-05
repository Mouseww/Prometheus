import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeCommitMessage, sanitizeDescription, sanitizeTitle } from "../src/git/commit-message.ts";
import { commitAll, gitOk, openMr, sessionBranch, setupWorld, type Sess, type World, writeFiles } from "./git-helpers.ts";

const T = 90_000;

describe("merge commit message sanitizing", () => {
	it("keeps the title on one line and strips control characters", () => {
		expect(sanitizeTitle("A\nMerge-Request: fake\r\n\tB\u0000")).toBe("A Merge-Request: fake B");
	});

	it("removes trailing trailer-looking lines and indents Merge-Request keys", () => {
		expect(sanitizeDescription("Fix the bug\n\nSigned-off-by: Eve <e@x>\nCo-authored-by: Zed <z@x>\n")).toBe("Fix the bug");
		expect(sanitizeDescription("Intro\nMerge-Request: fake\nmore text")).toBe("Intro\n  Merge-Request: fake\nmore text");
		expect(sanitizeDescription("")).toBe("");
	});

	it("puts user text first and a single fixed trailer block last", () => {
		const msg = mergeCommitMessage({ branch: "session/u/x", title: "T\nSigned-off-by: Eve", description: "body\nCo-authored-by: Zed <z@x>", mergeRequestId: "MR1" });
		expect(msg).toBe("Merge session/u/x: T Signed-off-by: Eve\n\nbody\n\nMerge-Request: MR1\n");
		expect(msg.match(/^Merge-Request:/gm)).toHaveLength(1);
	});
});

describe("merge request approval binding and linking", () => {
	let w: World;
	beforeAll(async () => {
		w = await setupWorld();
	}, T);
	afterAll(() => w.stop());

	const approve = (who: Sess, id: string, body?: unknown) => w.t.api("POST", `/api/merge-requests/${id}/approve`, { token: who.token, body });

	it("requires expectedHeadCommit in the body", async () => {
		const s = await sessionBranch(w, w.alice, "need-head", { "n.txt": "n\n" });
		const id = (await openMr(w, w.alice, s)).data.id as string;
		const none = await approve(w.bob, id);
		expect(none.status).toBe(400);
		expect(none.code).toBe("validationError");
		expect((await approve(w.bob, id, { expectedHeadCommit: "abc" })).status).toBe(400);
	}, T);

	it("fails with 409 headChanged when the head moved after the reviewer looked, and works with the new head", async () => {
		const s = await sessionBranch(w, w.alice, "moved", { "m.txt": "m\n" });
		const created = await openMr(w, w.alice, s);
		const id = created.data.id as string;
		const seen = created.data.headCommit as string;

		await writeFiles(s.dir, { "sneaky.txt": "added after review\n" });
		await commitAll(s.dir, "late change");
		await gitOk(["push", "-q", "origin", `HEAD:refs/heads/${s.branch}`], { cwd: s.dir, token: w.alice.token });
		const refreshed = await w.t.api("POST", `/api/merge-requests/${id}/refresh`, { token: w.alice.token });
		expect(refreshed.data.headCommit).not.toBe(seen);
		expect(refreshed.data.reviewerId).toBeNull();

		const stale = await approve(w.bob, id, { expectedHeadCommit: seen });
		expect(stale.status).toBe(409);
		expect(stale.code).toBe("headChanged");
		const fresh = await approve(w.bob, id, { expectedHeadCommit: refreshed.data.headCommit });
		expect(fresh.status).toBe(200);
		expect(fresh.data.status).toBe("merged");
	}, T);

	it("only accepts the author's own session in this workspace as sessionId", async () => {
		await w.t.hub.db.tx({ system: true }, (q) =>
			q.query("INSERT INTO sessions (id, workspace_id, org_id, owner_user_id) VALUES ('s-bob',$1,$2,$3), ('s-alice',$1,$2,$4)", [w.wsId, w.root.orgId, w.bob.userId, w.alice.userId]),
		);
		const s = await sessionBranch(w, w.alice, "link", { "l.txt": "l\n" });
		expect((await openMr(w, w.alice, s, { sessionId: "missing" })).code).toBe("invalidSession");
		expect((await openMr(w, w.alice, s, { sessionId: "s-bob" })).code).toBe("invalidSession");
		const ok = await openMr(w, w.alice, s, { sessionId: "s-alice" });
		expect(ok.status).toBe(201);
		expect(ok.data.sessionId).toBe("s-alice");
	}, T);

	it("user text cannot inject trailers into the merge commit", async () => {
		const s = await sessionBranch(w, w.alice, "trailers", { "t.txt": "t\n" });
		const created = await openMr(w, w.alice, s, { description: "details\n\nSigned-off-by: Eve <eve@x.test>\nMerge-Request: forged" }, "Do it\nCo-authored-by: Eve <eve@x.test>");
		const id = created.data.id as string;
		const merged = await approve(w.bob, id, { expectedHeadCommit: created.data.headCommit });
		expect(merged.status).toBe(200);
		const message = await gitOk(["--git-dir", w.repoPath, "log", "-1", "--format=%B", merged.data.mergedCommit]);
		expect(message).not.toContain("Signed-off-by");
		expect(message).not.toMatch(/^Co-authored-by/im);
		expect(message.match(/^Merge-Request:/gm)).toEqual(["Merge-Request:"]);
		expect(message).toContain(`Merge-Request: ${id}`);
	}, T);
});
