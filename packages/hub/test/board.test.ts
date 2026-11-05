import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulid } from "../src/ids.ts";
import { connectWs, type Collab, startCollab } from "./s-helpers.ts";

let c: Collab;
beforeAll(async () => {
	c = await startCollab();
});
afterAll(async () => {
	await c.stop();
});

async function insertMr(status: string, title: string, authorId: string, decided = false): Promise<string> {
	const id = ulid();
	await c.t.hub.db.tx({ system: true }, (q) =>
		q.query(
			`INSERT INTO merge_requests (id, workspace_id, org_id, author_id, title, branch, base_commit, head_commit, status, decided_at)
			 VALUES ($1,$2,$3,$4,$5,'session/x','a','b',$6, ${decided ? "now()" : "NULL"})`,
			[id, c.workspaceId, c.root.orgId, authorId, title, status],
		),
	);
	return id;
}

describe("GET /api/workspaces/:id/board", () => {
	it("returns one card per team member with sessions, online flag and last activity, plus merge requests", async () => {
		const s1 = await c.registerSession(c.alice, { title: "Alice A" });
		const s2 = await c.registerSession(c.alice, { title: "Alice B" });
		await c.t.api("POST", `/api/sessions/${s1.id}/events`, { token: c.alice.token, body: { events: [{ seq: 0, kind: "agent_start", payload: {} }] } });
		await c.t.api("PATCH", `/api/sessions/${s2.id}`, { token: c.alice.token, body: { lastActivity: "2020-01-01T00:00:00Z" } });
		await insertMr("open", "Open one", c.alice.userId);
		await insertMr("conflict", "Conflicted", c.bob.userId);
		await insertMr("rejected", "Rejected one", c.bob.userId, true);
		await insertMr("merged", "Merged one", c.bob.userId, true);
		const aliceWs = await connectWs(c.t.baseUrl, c.alice.token);

		const r = await c.t.api("GET", `/api/workspaces/${c.workspaceId}/board`, { token: c.bob.token });
		expect(r.status).toBe(200);
		const { members, openMergeRequests, recentMerges } = r.data;

		// Root created the team, so root, Alice and Bob are members.
		expect(members.map((m: any) => m.user.id).sort()).toEqual([c.root.userId, c.alice.userId, c.bob.userId].sort());
		const alice = members.find((m: any) => m.user.id === c.alice.userId);
		expect(alice).toMatchObject({ user: { displayName: "Alice", email: "alice@corp.test" }, role: "member", online: true });
		expect(alice.sessions.map((s: any) => s.title)).toEqual(["Alice A", "Alice B"]);
		expect(alice.sessions[0]).toEqual({ id: s1.id, title: "Alice A", status: "running", lastActivityAt: expect.any(String) });
		expect(alice.lastActivityAt).toBe(alice.sessions[0].lastActivityAt);
		const bob = members.find((m: any) => m.user.id === c.bob.userId);
		expect(bob).toMatchObject({ online: false, sessions: [], lastActivityAt: null });
		expect(members.find((m: any) => m.user.id === c.root.userId).role).toBe("admin");

		expect(openMergeRequests.map((m: any) => m.title).sort()).toEqual(["Conflicted", "Open one"]);
		expect(openMergeRequests[0]).toEqual({
			id: expect.any(String),
			title: expect.any(String),
			authorId: expect.any(String),
			authorName: expect.any(String),
			branch: "session/x",
			status: expect.any(String),
			sessionId: null,
			createdAt: expect.any(String),
			decidedAt: null,
		});
		expect(recentMerges.map((m: any) => m.title)).toEqual(["Merged one"]);
		expect(recentMerges[0]).toMatchObject({ authorName: "Bob", status: "merged", decidedAt: expect.any(String) });
		await aliceWs.close();
	});

	it("is limited to team members", async () => {
		expect((await c.t.api("GET", `/api/workspaces/${c.workspaceId}/board`, { token: c.carol.token })).status).toBe(404);
		expect((await c.t.api("GET", "/api/workspaces/missing/board", { token: c.bob.token })).status).toBe(404);
		expect((await c.t.api("GET", `/api/workspaces/${c.workspaceId}/board`)).status).toBe(401);
	});

	it("shows only the five most recent sessions per member", async () => {
		for (let i = 0; i < 7; i++) await c.registerSession(c.bob, { title: `Bob ${i}` });
		const r = await c.t.api("GET", `/api/workspaces/${c.workspaceId}/board`, { token: c.alice.token });
		expect(r.data.members.find((m: any) => m.user.id === c.bob.userId).sessions).toHaveLength(5);
	});
});
