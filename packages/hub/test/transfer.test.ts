import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestHub } from "./hub-helpers.ts";
import { type PublicTestHub, startPublicHub } from "./p-helpers.ts";

type Session = { token: string; userId: string };
interface World {
	t: PublicTestHub;
	owner: Session;
	mate: Session;
	outsider: Session;
	orgId: string;
	teamId: string;
	workspaceId: string;
	sessionId: string;
}

const hubs: TestHub[] = [];
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((t) => t.stop()));
});

/** Tables whose org_id must follow a transferred team, with a query that lists the team's rows. */
const TEAM_TABLES = ["teams", "team_members", "workspaces", "merge_requests", "sessions", "session_events", "session_transcripts", "session_grants", "notifications", "daily_reports"];

async function seed(t: PublicTestHub, owner: Session, mate: Session, teamId: string): Promise<{ workspaceId: string; sessionId: string }> {
	const workspaceId = "ws-1";
	const sessionId = "se-1";
	await t.hub.db.tx({ system: true }, async (q) => {
		await q.query("INSERT INTO workspaces (id, team_id, name, repo_dir) VALUES ($1,$2,'main','repos/ws-1.git')", [workspaceId, teamId]);
		await q.query(
			"INSERT INTO merge_requests (id, workspace_id, author_id, title, branch, base_commit, head_commit, status) VALUES ('mr-1',$1,$2,'t','b','a','b','open')",
			[workspaceId, mate.userId],
		);
		await q.query("INSERT INTO sessions (id, workspace_id, owner_user_id) VALUES ($1,$2,$3)", [sessionId, workspaceId, owner.userId]);
		await q.query("INSERT INTO session_events (session_id, seq, kind) VALUES ($1,1,'x')", [sessionId]);
		await q.query("INSERT INTO session_transcripts (session_id, format, content) VALUES ($1,'jsonl','')", [sessionId]);
		await q.query("INSERT INTO session_grants (session_id, user_id, granted_by) VALUES ($1,$2,$3)", [sessionId, mate.userId, owner.userId]);
		await q.query("INSERT INTO notifications (id, user_id, kind, payload) VALUES ('n-1',$1,'mr',$2::jsonb)", [mate.userId, JSON.stringify({ workspaceId })]);
		await q.query("INSERT INTO notifications (id, user_id, kind, payload) VALUES ('n-2',$1,'other','{}'::jsonb)", [mate.userId]);
		await q.query("INSERT INTO daily_reports (id, workspace_id, report_date, content, generated_by) VALUES ('dr-1',$1,'2026-01-01','{}'::jsonb,'digest')", [workspaceId]);
	});
	return { workspaceId, sessionId };
}

async function world(): Promise<World> {
	const t = await startPublicHub();
	hubs.push(t);
	await t.api("PUT", "/api/admin/settings", { token: t.operator.token, body: { allowPersonalTeams: true } });
	const owner = await t.registerVerified("owner@example.com");
	const mate = await t.registerVerified("mate@example.com");
	const outsider = await t.registerVerified("outsider@example.com");
	const org = await t.api("POST", "/api/orgs", { token: owner.token, body: { name: "Acme" } });
	const team = await t.api("POST", "/api/teams", { token: owner.token, body: { name: "Solo" } });
	expect(team.data.orgId).toBeNull();
	// Direct add is not allowed on personal teams; join through the invitation flow.
	const inv = await t.api("POST", "/api/invitations", { token: owner.token, body: { scope: "team", scopeId: team.data.id, email: "mate@example.com", role: "member" } });
	await t.api("POST", `/api/invitations/${inv.data.token}/accept`, { token: mate.token });
	const ids = await seed(t, owner, mate, team.data.id);
	return { t, owner, mate, outsider, orgId: org.data.id, teamId: team.data.id, ...ids };
}

/** Counts rows the user can see through RLS in a table, restricted to the team's rows. */
const visibleTo = async (w: World, userId: string, table: string): Promise<number> => {
	const where: Record<string, string> = {
		teams: `id = '${w.teamId}'`,
		team_members: `team_id = '${w.teamId}'`,
		workspaces: `team_id = '${w.teamId}'`,
		merge_requests: `workspace_id = '${w.workspaceId}'`,
		sessions: `workspace_id = '${w.workspaceId}'`,
		session_events: `session_id = '${w.sessionId}'`,
		session_transcripts: `session_id = '${w.sessionId}'`,
		session_grants: `session_id = '${w.sessionId}'`,
		notifications: "id = 'n-1'",
		daily_reports: `workspace_id = '${w.workspaceId}'`,
	};
	const rows = await w.t.hub.db.tx({ userId }, (q) => q.query(`SELECT 1 FROM ${table} WHERE ${where[table]}`));
	return rows.length;
};

describe("team transfer into an organization", () => {
	let w: World;
	beforeEach(async () => {
		w = await world();
	});

	it("request -> accept moves every org_id column and flips RLS visibility", async () => {
		const { t, owner, mate, outsider, orgId, teamId } = w;
		for (const table of TEAM_TABLES) {
			// Personal data (org_id NULL) is visible only to the team members: an outsider sees nothing before the transfer.
			expect(await visibleTo(w, outsider.userId, table), `${table} before`).toBe(0);
		}
		const req = await t.api("POST", `/api/teams/${teamId}/transfer`, { token: owner.token, body: { orgId } });
		expect(req.status).toBe(201);
		expect(req.data).toMatchObject({ status: "pending", teamId, toOrgId: orgId, toOrgName: "Acme" });

		const accepted = await t.api("POST", `/api/transfers/${req.data.id}/accept`, { token: owner.token });
		expect(accepted.status).toBe(200);
		expect(accepted.data).toMatchObject({ status: "accepted", decidedBy: owner.userId, addedMembers: [mate.userId] });

		const db = t.hub.db;
		const team = await db.query<{ org_id: string; owner_user_id: string | null }>("SELECT org_id, owner_user_id FROM teams WHERE id = $1", [teamId]);
		expect(team[0]).toEqual({ org_id: orgId, owner_user_id: null });
		for (const table of TEAM_TABLES) {
			const clause: Record<string, string> = {
				teams: `id = '${teamId}'`,
				team_members: `team_id = '${teamId}'`,
				workspaces: `team_id = '${teamId}'`,
				merge_requests: "id = 'mr-1'",
				sessions: "id = 'se-1'",
				session_events: "session_id = 'se-1'",
				session_transcripts: "session_id = 'se-1'",
				session_grants: "session_id = 'se-1'",
				notifications: "id = 'n-1'",
				daily_reports: "id = 'dr-1'",
			};
			const rows = await db.query<{ org_id: string | null }>(`SELECT org_id FROM ${table} WHERE ${clause[table]}`);
			expect(rows.length, `${table} rows`).toBeGreaterThan(0);
			expect(
				rows.every((r) => r.org_id === orgId),
				`${table}.org_id`,
			).toBe(true);
		}
		// A notification that is not about the team is left alone.
		expect((await db.query<{ org_id: string | null }>("SELECT org_id FROM notifications WHERE id = 'n-2'"))[0]?.org_id).toBeNull();

		for (const table of TEAM_TABLES) {
			expect(await visibleTo(w, outsider.userId, table), `${table} outsider after`).toBe(0);
			const members = table === "team_members" ? 2 : 1;
			// Notifications belong to one user (the mate), not to every member of the organization.
			const ownerSees = table === "notifications" ? 0 : members;
			expect(await visibleTo(w, owner.userId, table), `${table} owner after`).toBe(ownerSees);
			expect(await visibleTo(w, mate.userId, table), `${table} mate after`).toBe(members);
		}
		const orgMembers = await t.api("GET", `/api/orgs/${orgId}/members`, { token: owner.token });
		expect(orgMembers.data.map((m: { email: string; role: string }) => `${m.email}:${m.role}`).sort()).toEqual(["mate@example.com:member", "owner@example.com:owner"]);
		expect((await t.api("GET", "/api/teams", { token: outsider.token })).data.some((x: { id: string }) => x.id === teamId)).toBe(false);
	});

	it("writes audit entries for the request, the auto-added member and the acceptance", async () => {
		const { t, owner, mate, orgId, teamId } = w;
		const req = await t.api("POST", `/api/teams/${teamId}/transfer`, { token: owner.token, body: { orgId } });
		await t.api("POST", `/api/transfers/${req.data.id}/accept`, { token: owner.token });
		const audit = await t.api("GET", `/api/admin/audit?orgId=${orgId}&limit=100`, { token: owner.token });
		const actions = audit.data.items.map((a: { action: string }) => a.action);
		expect(actions).toEqual(expect.arrayContaining(["team.transfer.request", "org.member.autoAdd", "team.transfer.accept"]));
		const auto = audit.data.items.find((a: { action: string }) => a.action === "org.member.autoAdd");
		expect(auto.detail.userIds).toEqual([mate.userId]);
	});

	it("a rejected request leaves the team personal and can be re-requested", async () => {
		const { t, owner, orgId, teamId } = w;
		const req = await t.api("POST", `/api/teams/${teamId}/transfer`, { token: owner.token, body: { orgId } });
		const rej = await t.api("POST", `/api/transfers/${req.data.id}/reject`, { token: owner.token });
		expect(rej.data.status).toBe("rejected");
		expect((await t.hub.db.query<{ org_id: string | null }>("SELECT org_id FROM teams WHERE id = $1", [teamId]))[0]?.org_id).toBeNull();
		expect((await t.api("POST", `/api/transfers/${req.data.id}/accept`, { token: owner.token })).code).toBe("transferNotPending");
		expect((await t.api("POST", `/api/teams/${teamId}/transfer`, { token: owner.token, body: { orgId } })).status).toBe(201);
	});

	it("only one pending request per team; the requester can cancel", async () => {
		const { t, owner, orgId, teamId } = w;
		const req = await t.api("POST", `/api/teams/${teamId}/transfer`, { token: owner.token, body: { orgId } });
		const dup = await t.api("POST", `/api/teams/${teamId}/transfer`, { token: owner.token, body: { orgId } });
		expect(dup.status).toBe(409);
		expect(dup.code).toBe("transferPending");
		const cancel = await t.api("POST", `/api/transfers/${req.data.id}/cancel`, { token: owner.token });
		expect(cancel.data.status).toBe("canceled");
		expect((await t.api("POST", `/api/transfers/${req.data.id}/accept`, { token: owner.token })).code).toBe("transferNotPending");
	});

	it("only the target org admins decide, only the requester cancels, strangers see nothing", async () => {
		const { t, owner, mate, outsider, orgId, teamId } = w;
		await t.api("PUT", `/api/orgs/${orgId}/members/${mate.userId}`, { token: owner.token, body: { role: "member" } });
		const req = await t.api("POST", `/api/teams/${teamId}/transfer`, { token: owner.token, body: { orgId } });
		const path = `/api/transfers/${req.data.id}`;
		expect((await t.api("POST", `${path}/accept`, { token: mate.token })).status).toBe(404);
		expect((await t.api("POST", `${path}/accept`, { token: outsider.token })).status).toBe(404);
		expect((await t.api("POST", `${path}/cancel`, { token: outsider.token })).status).toBe(404);
		// An org admin who is not the requester cannot cancel, but can reject.
		await t.api("PUT", `/api/orgs/${orgId}/members/${mate.userId}`, { token: owner.token, body: { role: "admin" } });
		expect((await t.api("POST", `${path}/cancel`, { token: mate.token })).status).toBe(403);
		expect((await t.api("GET", "/api/transfers", { token: mate.token })).data).toHaveLength(1);
		expect((await t.api("GET", "/api/transfers", { token: outsider.token })).data).toHaveLength(0);
		expect((await t.api("POST", `${path}/reject`, { token: mate.token })).data.status).toBe("rejected");
	});

	it("validates who may request and what may be transferred", async () => {
		const { t, owner, mate, outsider, orgId, teamId } = w;
		// A plain team member is not a team admin.
		expect((await t.api("POST", `/api/teams/${teamId}/transfer`, { token: mate.token, body: { orgId } })).status).toBe(403);
		// A stranger does not even see the team.
		expect((await t.api("POST", `/api/teams/${teamId}/transfer`, { token: outsider.token, body: { orgId } })).status).toBe(404);
		// The requester must belong to the target org (and unknown orgs look the same).
		const other = await t.api("POST", "/api/orgs", { token: outsider.token, body: { name: "Other" } });
		expect((await t.api("POST", `/api/teams/${teamId}/transfer`, { token: owner.token, body: { orgId: other.data.id } })).status).toBe(404);
		expect((await t.api("POST", `/api/teams/${teamId}/transfer`, { token: owner.token, body: { orgId: "nope" } })).status).toBe(404);
		// Organization teams cannot be transferred.
		const orgTeam = await t.api("POST", "/api/teams", { token: owner.token, body: { name: "Org team", orgId } });
		const r = await t.api("POST", `/api/teams/${orgTeam.data.id}/transfer`, { token: owner.token, body: { orgId } });
		expect(r.status).toBe(409);
		expect(r.code).toBe("notPersonalTeam");
	});

	it("keeps existing org members as they are and activates a pending membership", async () => {
		const { t, owner, mate, orgId, teamId } = w;
		await t.hub.db.tx({ system: true }, (q) => q.query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1,$2,'member','pending')", [orgId, mate.userId]));
		const req = await t.api("POST", `/api/teams/${teamId}/transfer`, { token: owner.token, body: { orgId } });
		const acc = await t.api("POST", `/api/transfers/${req.data.id}/accept`, { token: owner.token });
		expect(acc.data.addedMembers).toEqual([mate.userId]);
		const row = await t.hub.db.query<{ status: string; role: string }>("SELECT status, role FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, mate.userId]);
		expect(row[0]).toEqual({ status: "active", role: "member" });
	});
});
