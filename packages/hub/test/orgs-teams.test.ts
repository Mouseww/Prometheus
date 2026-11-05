import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, startHub, type TestHub } from "./hub-helpers.ts";

type Sess = { token: string; userId: string };

describe("invitations", () => {
	let t: TestHub;
	let root: Sess & { orgId: string };
	beforeAll(async () => {
		t = await startHub({ publicUrl: "https://hub.corp.test/" });
		root = await t.bootstrap();
	});
	afterAll(() => t.stop());

	const registerWith = (email: string, inviteToken: string) =>
		t.api("POST", "/api/auth/register", { body: { email, password: PASSWORD, displayName: "Invitee", inviteToken } });

	it("an org invite registers an active member even when self registration is closed", async () => {
		const created = await t.api("POST", "/api/invitations", { token: root.token, body: { scope: "org", scopeId: root.orgId, email: "Ivy@Outside.test", role: "admin" } });
		expect(created.status).toBe(201);
		const { link, token, invitation } = created.data;
		expect(link).toBe(`https://hub.corp.test/invite/${token}`);
		expect(invitation).toMatchObject({ scope: "org", email: "ivy@outside.test", role: "admin" });

		const lookup = await t.api("GET", `/api/invitations/${token}`);
		expect(lookup.data).toMatchObject({ scopeId: root.orgId, email: "ivy@outside.test", role: "admin" });

		const r = await registerWith("ivy@outside.test", token);
		expect(r.status).toBe(201);
		expect(r.data.status).toBe("active");
		const login = await t.login("ivy@outside.test");
		const me = await t.api("GET", "/api/me", { token: login.token });
		expect(me.data.orgs).toEqual([{ id: root.orgId, name: expect.any(String), role: "admin" }]);

		// Single use.
		expect((await t.api("GET", `/api/invitations/${token}`)).status).toBe(404);
		expect((await registerWith("other@outside.test", token)).code).toBe("invalidInvite");
	});

	it("rejects email mismatch, unknown and expired tokens", async () => {
		const c = await t.api("POST", "/api/invitations", { token: root.token, body: { scope: "org", scopeId: root.orgId, email: "jan@outside.test", role: "member" } });
		expect((await registerWith("someone-else@outside.test", c.data.token)).code).toBe("inviteEmailMismatch");
		expect((await registerWith("jan@outside.test", "nope")).code).toBe("invalidInvite");
		await t.hub.db.query("UPDATE invitations SET expires_at = now() - interval '1 hour'");
		expect((await registerWith("jan@outside.test", c.data.token)).code).toBe("invalidInvite");
		expect((await t.api("GET", `/api/invitations/${c.data.token}`)).status).toBe(404);
	});

	it("honours allow_invite=false at platform and organization level", async () => {
		const c = await t.api("POST", "/api/invitations", { token: root.token, body: { scope: "org", scopeId: root.orgId, email: "kim@outside.test", role: "member" } });
		const base = { allowOpen: false, allowedDomains: [], requireApproval: true, closed: false };
		await t.api("PUT", "/api/admin/registration", { token: root.token, body: { ...base, allowInvite: false } });
		expect((await registerWith("kim@outside.test", c.data.token)).code).toBe("inviteDisabled");
		await t.api("PUT", "/api/admin/registration", { token: root.token, body: { ...base, allowInvite: true } });
		await t.api("PUT", `/api/orgs/${root.orgId}/registration`, { token: root.token, body: { ...base, allowInvite: false } });
		expect((await registerWith("kim@outside.test", c.data.token)).code).toBe("inviteDisabled");
		await t.api("PUT", `/api/orgs/${root.orgId}/registration`, { token: root.token, body: { ...base, allowInvite: true } });
		expect((await registerWith("kim@outside.test", c.data.token)).status).toBe(201);
	});

	it("a team invite adds org membership and team membership", async () => {
		const team = await t.api("POST", "/api/teams", { token: root.token, body: { name: "Platform", orgId: root.orgId } });
		const c = await t.api("POST", "/api/invitations", { token: root.token, body: { scope: "team", scopeId: team.data.id, email: "lee@outside.test", role: "reviewer" } });
		expect((await registerWith("lee@outside.test", c.data.token)).status).toBe(201);
		const lee = await t.login("lee@outside.test");
		const me = await t.api("GET", "/api/me", { token: lee.token });
		expect(me.data.orgs[0]).toMatchObject({ id: root.orgId, role: "member" });
		expect(me.data.teams).toEqual([{ id: team.data.id, name: "Platform", role: "reviewer", orgId: root.orgId }]);
	});

	it("validates roles and permissions when creating invitations", async () => {
		const bad = await t.api("POST", "/api/invitations", { token: root.token, body: { scope: "org", scopeId: root.orgId, email: "m@x.test", role: "owner" } });
		expect(bad.code).toBe("invalidRole");
		const member = await t.createUser(root.token, "plain@corp.test");
		const denied = await t.api("POST", "/api/invitations", { token: member.token, body: { scope: "org", scopeId: root.orgId, email: "m@x.test", role: "member" } });
		expect(denied.status).toBe(403);
		expect((await t.api("POST", "/api/invitations", { token: root.token, body: { scope: "org", scopeId: "missing", email: "m@x.test", role: "member" } })).status).toBe(404);
	});
});

describe("admin users", () => {
	let t: TestHub;
	let root: Sess & { orgId: string };
	let orgB: string;
	let adminA: Sess;
	let adminB: Sess;
	beforeAll(async () => {
		t = await startHub();
		root = await t.bootstrap();
		orgB = (await t.api("POST", "/api/orgs", { token: root.token, body: { name: "Beta Corp" } })).data.id;
		adminA = await t.createUser(root.token, "admin-a@corp.test");
		await t.api("PUT", `/api/orgs/${root.orgId}/members/${adminA.userId}`, { token: root.token, body: { role: "admin" } });
		adminB = await t.createUser(root.token, "admin-b@corp.test", "Bea", orgB);
		await t.api("PUT", `/api/orgs/${orgB}/members/${adminB.userId}`, { token: root.token, body: { role: "admin" } });
	});
	afterAll(() => t.stop());

	it("org admins list only users of organizations they manage; operators list everyone", async () => {
		const mineA = await t.api("GET", "/api/admin/users", { token: adminA.token });
		expect(mineA.data.map((u: any) => u.email).sort()).toEqual(["admin-a@corp.test", "root@corp.test"].sort());
		const mineB = await t.api("GET", "/api/admin/users", { token: adminB.token });
		// root owns Beta (the operator created it), so root is visible there too, but admin-a is not.
		expect(mineB.data.map((u: any) => u.email).sort()).toEqual(["admin-b@corp.test", "root@corp.test"]);
		const all = await t.api("GET", "/api/admin/users", { token: root.token });
		expect(all.data.length).toBe(3);
		const filtered = await t.api("GET", "/api/admin/users?q=ADMIN-B", { token: root.token });
		expect(filtered.data.map((u: any) => u.email)).toEqual(["admin-b@corp.test"]);
	});

	it("plain members cannot use the admin API", async () => {
		const m = await t.createUser(root.token, "plain@corp.test");
		expect((await t.api("GET", "/api/admin/users", { token: m.token })).status).toBe(403);
		expect((await t.api("GET", "/api/admin/registration", { token: adminA.token })).status).toBe(403);
		expect((await t.api("PUT", "/api/admin/registration", { token: adminA.token, body: { allowOpen: true, allowedDomains: [], requireApproval: false, allowInvite: true, closed: false } })).status).toBe(403);
		expect((await t.api("POST", "/api/orgs", { token: adminA.token, body: { name: "Nope" } })).status).toBe(403);
	});

	it("an org admin cannot act on users of another organization (404) nor on operators (403)", async () => {
		expect((await t.api("POST", `/api/admin/users/${adminB.userId}/disable`, { token: adminA.token })).status).toBe(404);
		const disableOperator = await t.api("POST", `/api/admin/users/${root.userId}/disable`, { token: adminA.token });
		expect(disableOperator.status).toBe(403);
		expect((await t.api("POST", `/api/admin/users/${adminA.userId}/disable`, { token: adminA.token })).code).toBe("cannotActOnSelf");
	});

	it("an org admin approves pending users of their org and creates users there", async () => {
		await t.api("PUT", "/api/admin/registration", { token: root.token, body: { allowOpen: true, allowedDomains: [], requireApproval: true, allowInvite: true, closed: false } });
		const reg = await t.api("POST", "/api/auth/register", { body: { email: "newbie@corp.test", password: PASSWORD, displayName: "Newbie" } });
		const approved = await t.api("POST", `/api/admin/users/${reg.data.user.id}/approve`, { token: adminA.token });
		expect(approved.data.status).toBe("active");
		const created = await t.api("POST", "/api/admin/users", { token: adminA.token, body: { email: "made@corp.test", displayName: "Made", password: PASSWORD } });
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ email: "made@corp.test", status: "active" });
		expect((await t.api("POST", "/api/admin/users", { token: adminA.token, body: { email: "made@corp.test", displayName: "Dup", password: PASSWORD } })).code).toBe("emailTaken");
		expect((await t.api("POST", "/api/admin/users", { token: adminA.token, body: { email: "x@corp.test", displayName: "X", password: PASSWORD, orgId: orgB } })).status).toBe(403);
	});

	it("rejects invalid list parameters", async () => {
		expect((await t.api("GET", "/api/admin/users?status=bogus", { token: root.token })).code).toBe("validationError");
		expect((await t.api("GET", "/api/admin/users?limit=0", { token: root.token })).status).toBe(400);
	});
});

describe("organizations and members", () => {
	let t: TestHub;
	let root: Sess & { orgId: string };
	let orgB: string;
	let carol: Sess;
	beforeAll(async () => {
		t = await startHub();
		root = await t.bootstrap();
		orgB = (await t.api("POST", "/api/orgs", { token: root.token, body: { name: "Beta", slug: "beta" } })).data.id;
		carol = await t.createUser(root.token, "carol@corp.test");
	});
	afterAll(() => t.stop());

	it("lists organizations through RLS", async () => {
		expect((await t.api("GET", "/api/orgs", { token: root.token })).data.map((o: any) => o.name).sort()).toEqual(["Beta", "我的团队"].sort());
		expect((await t.api("GET", "/api/orgs", { token: carol.token })).data).toHaveLength(1);
		expect((await t.api("POST", "/api/orgs", { token: root.token, body: { name: "Beta2", slug: "beta" } })).code).toBe("slugTaken");
		const derived = await t.api("POST", "/api/orgs", { token: root.token, body: { name: "Beta" } });
		expect(derived.data.role).toBe("owner");
	});

	it("manages members and protects the last owner", async () => {
		const put = await t.api("PUT", `/api/orgs/${orgB}/members/${carol.userId}`, { token: root.token, body: { role: "member" } });
		expect(put.data).toMatchObject({ userId: carol.userId, role: "member", status: "active" });
		const members = await t.api("GET", `/api/orgs/${orgB}/members`, { token: carol.token });
		expect(members.data).toHaveLength(2);
		expect((await t.api("PUT", `/api/orgs/${orgB}/members/${carol.userId}`, { token: carol.token, body: { role: "admin" } })).status).toBe(403);
		expect((await t.api("DELETE", `/api/orgs/${orgB}/members/${root.userId}`, { token: root.token })).code).toBe("lastOwner");
		expect((await t.api("PUT", `/api/orgs/${orgB}/members/${root.userId}`, { token: root.token, body: { role: "admin" } })).code).toBe("lastOwner");
		expect((await t.api("DELETE", `/api/orgs/${orgB}/members/${carol.userId}`, { token: root.token })).status).toBe(200);
		expect((await t.api("DELETE", `/api/orgs/${orgB}/members/${carol.userId}`, { token: root.token })).status).toBe(404);
	});

	it("only owners hand out ownership", async () => {
		await t.api("PUT", `/api/orgs/${orgB}/members/${carol.userId}`, { token: root.token, body: { role: "admin" } });
		expect((await t.api("PUT", `/api/orgs/${orgB}/members/${carol.userId}`, { token: carol.token, body: { role: "owner" } })).status).toBe(403);
		expect((await t.api("PUT", `/api/orgs/${orgB}/members/${root.userId}`, { token: carol.token, body: { role: "member" } })).status).toBe(403);
	});

	it("members of other organizations cannot list or change members", async () => {
		const outsider = await t.createUser(root.token, "outsider@corp.test");
		await t.api("DELETE", `/api/orgs/${root.orgId}/members/${outsider.userId}`, { token: root.token });
		expect((await t.api("GET", `/api/orgs/${orgB}/members`, { token: outsider.token })).status).toBe(403);
		expect((await t.api("PUT", `/api/orgs/${orgB}/members/${outsider.userId}`, { token: outsider.token, body: { role: "admin" } })).status).toBe(403);
	});
});

describe("teams", () => {
	let t: TestHub;
	let root: Sess & { orgId: string };
	let orgAdmin: Sess;
	let tAdmin: Sess;
	let reviewer: Sess;
	let member: Sess;
	let plain: Sess;
	let teamId: string;
	beforeAll(async () => {
		t = await startHub();
		root = await t.bootstrap();
		orgAdmin = await t.createUser(root.token, "oadmin@corp.test");
		await t.api("PUT", `/api/orgs/${root.orgId}/members/${orgAdmin.userId}`, { token: root.token, body: { role: "admin" } });
		tAdmin = await t.createUser(root.token, "tadmin@corp.test");
		reviewer = await t.createUser(root.token, "reviewer@corp.test");
		member = await t.createUser(root.token, "member@corp.test");
		plain = await t.createUser(root.token, "plain@corp.test");
		teamId = (await t.api("POST", "/api/teams", { token: orgAdmin.token, body: { name: "Core", orgId: root.orgId } })).data.id;
		for (const [u, role] of [[tAdmin, "admin"], [reviewer, "reviewer"], [member, "member"]] as const) {
			await t.api("POST", `/api/teams/${teamId}/members`, { token: orgAdmin.token, body: { userId: u.userId, role } });
		}
	});
	afterAll(() => t.stop());

	it("only org owner/admin create organization teams, creator becomes team admin", async () => {
		expect((await t.api("POST", "/api/teams", { token: member.token, body: { name: "X", orgId: root.orgId } })).status).toBe(403);
		const list = await t.api("GET", "/api/teams", { token: orgAdmin.token });
		expect(list.data).toEqual([expect.objectContaining({ id: teamId, name: "Core", orgId: root.orgId, role: "admin" })]);
		const members = await t.api("GET", `/api/teams/${teamId}/members`, { token: member.token });
		expect(members.data.map((m: any) => `${m.email}:${m.role}`)).toEqual(["oadmin@corp.test:admin", "tadmin@corp.test:admin", "reviewer@corp.test:reviewer", "member@corp.test:member"]);
	});

	it("shows teams according to membership and hides them from outsiders", async () => {
		expect((await t.api("GET", "/api/teams", { token: member.token })).data[0].role).toBe("member");
		expect((await t.api("GET", "/api/teams", { token: plain.token })).data).toEqual([]);
		expect((await t.api("GET", "/api/teams", { token: root.token })).data[0].role).toBe("admin");
		expect((await t.api("GET", `/api/teams/${teamId}/members`, { token: plain.token })).status).toBe(404);
		expect((await t.api("GET", "/api/teams/missing/members", { token: root.token })).status).toBe(404);
		const me = await t.api("GET", "/api/me", { token: reviewer.token });
		expect(me.data.teams).toEqual([{ id: teamId, name: "Core", role: "reviewer", orgId: root.orgId }]);
	});

	it("team admins (and implicit org admins) manage members, others cannot", async () => {
		const add = (tok: string, userId: string, role = "member") => t.api("POST", `/api/teams/${teamId}/members`, { token: tok, body: { userId, role } });
		expect((await add(member.token, plain.userId)).status).toBe(403);
		expect((await add(reviewer.token, plain.userId)).status).toBe(403);
		const ok = await add(tAdmin.token, plain.userId);
		expect(ok.status).toBe(201);
		expect(ok.data).toMatchObject({ userId: plain.userId, role: "member" });
		expect((await add(tAdmin.token, plain.userId)).code).toBe("alreadyMember");
		expect((await t.api("PUT", `/api/teams/${teamId}/members/${plain.userId}`, { token: member.token, body: { role: "admin" } })).status).toBe(403);
		expect((await t.api("PUT", `/api/teams/${teamId}/members/${plain.userId}`, { token: tAdmin.token, body: { role: "reviewer" } })).data.role).toBe("reviewer");
		expect((await t.api("DELETE", `/api/teams/${teamId}/members/${plain.userId}`, { token: root.token })).status).toBe(200);
		expect((await t.api("DELETE", `/api/teams/${teamId}/members/${plain.userId}`, { token: root.token })).status).toBe(404);
	});

	it("adds members by email and enforces org membership and activity", async () => {
		const byEmail = await t.api("POST", `/api/teams/${teamId}/members`, { token: tAdmin.token, body: { email: "PLAIN@corp.test", role: "member" } });
		expect(byEmail.status).toBe(201);
		const orgB = (await t.api("POST", "/api/orgs", { token: root.token, body: { name: "Other" } })).data.id;
		const stranger = await t.createUser(root.token, "stranger@corp.test", "S", orgB);
		await t.api("DELETE", `/api/orgs/${root.orgId}/members/${stranger.userId}`, { token: root.token });
		const notMember = await t.api("POST", `/api/teams/${teamId}/members`, { token: tAdmin.token, body: { userId: stranger.userId, role: "member" } });
		expect(notMember.code).toBe("notOrgMember");
		expect((await t.api("POST", `/api/teams/${teamId}/members`, { token: tAdmin.token, body: { email: "ghost@corp.test", role: "member" } })).status).toBe(404);
		expect((await t.api("POST", `/api/teams/${teamId}/members`, { token: tAdmin.token, body: { role: "member" } })).code).toBe("validationError");
		expect((await t.api("POST", `/api/teams/${teamId}/members`, { token: tAdmin.token, body: { userId: plain.userId, role: "boss" } })).status).toBe(400);
	});

	it("removing a user from the organization drops their team memberships", async () => {
		await t.api("DELETE", `/api/orgs/${root.orgId}/members/${member.userId}`, { token: root.token });
		const members = await t.api("GET", `/api/teams/${teamId}/members`, { token: tAdmin.token });
		expect(members.data.some((m: any) => m.userId === member.userId)).toBe(false);
	});

	it("personal teams are disabled by default and follow the platform setting", async () => {
		const denied = await t.api("POST", "/api/teams", { token: plain.token, body: { name: "Mine" } });
		expect(denied.status).toBe(403);
		expect(denied.code).toBe("personalTeamsDisabled");
		expect((await t.api("PUT", "/api/admin/settings", { token: orgAdmin.token, body: { allowPersonalTeams: true } })).status).toBe(403);
		expect((await t.api("PUT", "/api/admin/settings", { token: root.token, body: { allowPersonalTeams: true } })).data).toEqual({ allowPersonalTeams: true });

		const mine = await t.api("POST", "/api/teams", { token: plain.token, body: { name: "Mine", orgId: null } });
		expect(mine.status).toBe(201);
		expect(mine.data).toMatchObject({ orgId: null, ownerUserId: plain.userId, role: "admin" });
		const personalId = mine.data.id;
		// Only members see a personal team, even operators and org admins.
		expect((await t.api("GET", `/api/teams/${personalId}/members`, { token: orgAdmin.token })).status).toBe(404);
		expect((await t.api("GET", "/api/teams", { token: orgAdmin.token })).data.some((x: any) => x.id === personalId)).toBe(false);
		// Anyone active can be added; the owner cannot be demoted or removed.
		const added = await t.api("POST", `/api/teams/${personalId}/members`, { token: plain.token, body: { userId: reviewer.userId, role: "member" } });
		expect(added.status).toBe(201);
		expect((await t.api("PUT", `/api/teams/${personalId}/members/${plain.userId}`, { token: plain.token, body: { role: "member" } })).code).toBe("ownerImmutable");
		expect((await t.api("DELETE", `/api/teams/${personalId}/members/${plain.userId}`, { token: plain.token })).code).toBe("ownerImmutable");
		expect((await t.api("GET", `/api/teams/${personalId}/members`, { token: reviewer.token })).status).toBe(200);
	});
});

describe("audit log", () => {
	let t: TestHub;
	let root: Sess & { orgId: string };
	let orgAdmin: Sess;
	beforeAll(async () => {
		t = await startHub();
		root = await t.bootstrap();
		orgAdmin = await t.createUser(root.token, "oadmin@corp.test");
		await t.api("PUT", `/api/orgs/${root.orgId}/members/${orgAdmin.userId}`, { token: root.token, body: { role: "admin" } });
	});
	afterAll(() => t.stop());

	it("records administrative actions and filters by org, action and cursor", async () => {
		const team = await t.api("POST", "/api/teams", { token: orgAdmin.token, body: { name: "Audited", orgId: root.orgId } });
		const all = await t.api("GET", `/api/admin/audit?orgId=${root.orgId}`, { token: orgAdmin.token });
		const actions = all.data.items.map((i: any) => i.action);
		expect(actions).toEqual(expect.arrayContaining(["setup.bootstrap", "user.create", "org.member.set", "team.create"]));
		expect(actions[0]).toBe("team.create");
		const created = all.data.items.find((i: any) => i.action === "team.create");
		expect(created).toMatchObject({ actorId: orgAdmin.userId, targetType: "team", targetId: team.data.id, orgId: root.orgId, detail: { name: "Audited" } });

		const only = await t.api("GET", `/api/admin/audit?orgId=${root.orgId}&action=user.create&actor=${root.userId}`, { token: root.token });
		expect(only.data.items.every((i: any) => i.action === "user.create")).toBe(true);

		const page1 = await t.api("GET", `/api/admin/audit?orgId=${root.orgId}&limit=2`, { token: root.token });
		expect(page1.data.items).toHaveLength(2);
		expect(page1.data.nextBefore).toBeTruthy();
		const page2 = await t.api("GET", `/api/admin/audit?orgId=${root.orgId}&limit=2&before=${page1.data.nextBefore}`, { token: root.token });
		expect(page2.data.items[0].id < page1.data.items[1].id).toBe(true);
	});

	it("is restricted: members denied, org admins limited to their orgs, operators see the platform scope", async () => {
		const member = await t.createUser(root.token, "m@corp.test");
		expect((await t.api("GET", "/api/admin/audit", { token: member.token })).status).toBe(403);
		const otherOrg = (await t.api("POST", "/api/orgs", { token: root.token, body: { name: "Other" } })).data.id;
		expect((await t.api("GET", `/api/admin/audit?orgId=${otherOrg}`, { token: orgAdmin.token })).status).toBe(403);
		const scoped = await t.api("GET", "/api/admin/audit", { token: orgAdmin.token });
		expect(scoped.data.items.every((i: any) => i.orgId === root.orgId)).toBe(true);
		const platform = await t.api("PUT", "/api/admin/registration", { token: root.token, body: { allowOpen: false, allowedDomains: ["corp.test"], requireApproval: true, allowInvite: true, closed: false } });
		expect(platform.status).toBe(200);
		const op = await t.api("GET", "/api/admin/audit?action=registration.platform.update", { token: root.token });
		expect(op.data.items).toHaveLength(1);
		expect(op.data.items[0].orgId).toBeNull();
	});
});
