import { afterEach, describe, expect, it } from "vitest";
import { issuePeriodGrants } from "../src/billing/wallet.ts";
import { INVITES_PER_DAY_PUBLIC } from "../src/services/invitations.ts";
import { PASSWORD, startHub, type TestHub } from "./hub-helpers.ts";
import { startPublicHub } from "./p-helpers.ts";

const hubs: TestHub[] = [];
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((t) => t.stop()));
});

const grantCount = async (t: TestHub, userId: string): Promise<number> => {
	await t.hub.db.tx({ system: true }, (q) => issuePeriodGrants(q, Date.now()));
	const rows = await t.hub.db.query<{ n: string | number }>("SELECT count(*) AS n FROM credit_grants WHERE subject_type = 'user' AND subject_id = $1", [userId]);
	return Number(rows[0]?.n ?? 0);
};

describe("public mode invite registration", () => {
	it("runs the abuse guards: disposable domains are refused even with a valid invite", async () => {
		const t = await startPublicHub();
		hubs.push(t);
		const created = await t.api("POST", "/api/invitations", { token: t.operator.token, body: { scope: "org", scopeId: t.operator.orgId, email: "x@mailinator.com", role: "member" } });
		expect(created.status).toBe(201);
		const reg = await t.api("POST", "/api/auth/register", { body: { email: "x@mailinator.com", password: PASSWORD, displayName: "X", inviteToken: created.data.token } });
		expect(reg.status).toBeGreaterThanOrEqual(400);
		expect(reg.code).not.toBe("invalidInvite");
	});

	it("applies the per-IP registration cap to invite registrations", async () => {
		const t = await startPublicHub();
		hubs.push(t);
		const ip = "198.51.100.77";
		const statuses: number[] = [];
		for (let i = 0; i < 7; i++) {
			const inv = await t.api("POST", "/api/invitations", { token: t.operator.token, body: { scope: "org", scopeId: t.operator.orgId, email: `farm${i}@example.com`, role: "member" } });
			const reg = await t.api("POST", "/api/auth/register", { ip, body: { email: `farm${i}@example.com`, password: PASSWORD, displayName: "F", inviteToken: inv.data.token } });
			statuses.push(reg.status);
		}
		expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
		expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
	});

	it("gives no free credit grant until the email is verified", async () => {
		const t = await startPublicHub();
		hubs.push(t);
		const inv = await t.api("POST", "/api/invitations", { token: t.operator.token, body: { scope: "org", scopeId: t.operator.orgId, email: "nina@example.com", role: "member" } });
		const reg = await t.api("POST", "/api/auth/register", { body: { email: "nina@example.com", password: PASSWORD, displayName: "Nina", inviteToken: inv.data.token } });
		expect(reg.data.status).toBe("pending");
		expect(await grantCount(t, reg.data.user.id)).toBe(0);
		await t.flush();
		const token = t.capture.tokenFor("nina@example.com", "verify-email") as string;
		expect((await t.api("POST", "/api/auth/verify-email", { body: { token } })).status).toBe(200);
		expect(await grantCount(t, reg.data.user.id)).toBe(1);
	});

	it("caps invitation creation per inviter per day", async () => {
		const t = await startPublicHub();
		hubs.push(t);
		for (let i = 0; i < INVITES_PER_DAY_PUBLIC; i++) {
			const r = await t.api("POST", "/api/invitations", { token: t.operator.token, body: { scope: "org", scopeId: t.operator.orgId, email: `cap${i}@example.com`, role: "member" } });
			expect(r.status).toBe(201);
		}
		const over = await t.api("POST", "/api/invitations", { token: t.operator.token, body: { scope: "org", scopeId: t.operator.orgId, email: "over@example.com", role: "member" } });
		expect(over.status).toBe(429);
		expect(over.code).toBe("rateLimited");
	});

	it("a non-admin cannot invite", async () => {
		const t = await startPublicHub();
		hubs.push(t);
		const u = await t.registerVerified("plain@example.com");
		const r = await t.api("POST", "/api/invitations", { token: u.token, body: { scope: "org", scopeId: t.operator.orgId, email: "y@example.com", role: "member" } });
		expect(r.status).toBe(403);
	});
});

describe("refresh token reuse", () => {
	it("a replayed logged-out or unknown token does not revoke other sessions", async () => {
		const t = await startHub();
		hubs.push(t);
		await t.bootstrap();
		const keep = await t.login("root@corp.test");
		const gone = await t.login("root@corp.test");
		await t.api("POST", "/api/auth/logout", { body: { refreshToken: gone.refreshToken } });
		expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: gone.refreshToken } })).status).toBe(401);
		expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: "unknown-token" } })).status).toBe(401);
		expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: keep.refreshToken } })).status).toBe(200);
	});

	it("reuse of a rotated token ends the other live sessions of that account too", async () => {
		const t = await startHub();
		hubs.push(t);
		await t.bootstrap();
		const a = await t.login("root@corp.test");
		const b = await t.login("root@corp.test");
		expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: a.refreshToken } })).status).toBe(200);
		expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: a.refreshToken } })).status).toBe(401);
		expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: b.refreshToken } })).status).toBe(401);
	});
});

describe("team member add", () => {
	it("answers the same for unknown, inactive, outside-org users and personal teams", async () => {
		const t = await startHub();
		hubs.push(t);
		const root = await t.bootstrap();
		const outsider = await t.createUser(root.token, "out@corp.test");
		const orgB = (await t.api("POST", "/api/orgs", { token: root.token, body: { name: "B" } })).data.id;
		await t.api("DELETE", `/api/orgs/${root.orgId}/members/${outsider.userId}`, { token: root.token });
		await t.api("PUT", `/api/orgs/${orgB}/members/${outsider.userId}`, { token: root.token, body: { role: "member" } });
		const team = await t.api("POST", "/api/teams", { token: root.token, body: { name: "T", orgId: root.orgId } });
		const add = (body: Record<string, unknown>) => t.api("POST", `/api/teams/${team.data.id}/members`, { token: root.token, body: { role: "member", ...body } });
		const unknown = await add({ email: "nobody@corp.test" });
		const notInOrg = await add({ userId: outsider.userId });
		expect(unknown.status).toBe(404);
		expect(notInOrg.status).toBe(404);
		expect(notInOrg.body).toEqual(unknown.body);
	});
});

describe("org admin user disable and enable", () => {
	const setup = async () => {
		const t = await startHub();
		hubs.push(t);
		const root = await t.bootstrap();
		const orgB = (await t.api("POST", "/api/orgs", { token: root.token, body: { name: "B" } })).data.id;
		const admin = await t.createUser(root.token, "oadmin@corp.test", "OA", orgB);
		await t.api("PUT", `/api/orgs/${orgB}/members/${admin.userId}`, { token: root.token, body: { role: "admin" } });
		const member = await t.createUser(root.token, "m@corp.test", "M", orgB);
		await t.api("DELETE", `/api/orgs/${root.orgId}/members/${member.userId}`, { token: root.token });
		return { t, root, orgB, admin, member };
	};

	it("disables a user wholly inside its orgs, stops the tenant runtime and revokes refresh tokens", async () => {
		const { t, admin, member } = await setup();
		const stopped: string[] = [];
		t.hub.registry.register("tenants", { stop: async (id: string, reason?: string) => void stopped.push(`${id}:${reason}`) });
		const r = await t.api("POST", `/api/admin/users/${member.userId}/disable`, { token: admin.token });
		expect(r.status).toBe(200);
		expect(stopped).toEqual([`${member.userId}:disabled`]);
		expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: member.refreshToken } })).status).toBe(401);
	});

	it("refuses owners, operators and users who also belong to organizations the admin does not manage", async () => {
		const { t, root, orgB, admin, member } = await setup();
		expect((await t.api("POST", `/api/admin/users/${root.userId}/disable`, { token: admin.token })).status).toBeGreaterThanOrEqual(403);
		await t.hub.db.tx({ system: true }, (q) => q.query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1,$2,'member','active') ON CONFLICT DO NOTHING", [root.orgId, member.userId]));
		const shared = await t.api("POST", `/api/admin/users/${member.userId}/disable`, { token: admin.token });
		expect(shared.status).toBe(403);
		expect(shared.code).toBe("outsideManagedOrgs");
		// An org owner inside the admin's own org is protected as well.
		const owner = await t.createUser(root.token, "own@corp.test", "O", orgB);
		await t.api("PUT", `/api/orgs/${orgB}/members/${owner.userId}`, { token: root.token, body: { role: "owner" } });
		await t.hub.db.tx({ system: true }, (q) => q.query("DELETE FROM org_members WHERE user_id = $1 AND org_id <> $2", [owner.userId, orgB]));
		const own = await t.api("POST", `/api/admin/users/${owner.userId}/disable`, { token: admin.token });
		expect(own.code).toBe("ownerProtected");
	});

	it("an org admin cannot re-enable an account an operator disabled, but can re-enable its own disable", async () => {
		const { t, root, admin, member } = await setup();
		await t.api("POST", `/api/admin/users/${member.userId}/disable`, { token: root.token });
		const denied = await t.api("POST", `/api/admin/users/${member.userId}/enable`, { token: admin.token });
		expect(denied.status).toBe(403);
		expect(denied.code).toBe("disabledByOperator");
		expect((await t.api("POST", `/api/admin/users/${member.userId}/enable`, { token: root.token })).status).toBe(200);
		expect((await t.api("POST", `/api/admin/users/${member.userId}/disable`, { token: admin.token })).status).toBe(200);
		expect((await t.api("POST", `/api/admin/users/${member.userId}/enable`, { token: admin.token })).status).toBe(200);
	});
});
