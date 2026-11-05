import { afterEach, describe, expect, it } from "vitest";
import { parseTrustProxy, resolveClientIp } from "../src/net/trusted-proxy.ts";
import { PASSWORD, startHub, type TestHub } from "./hub-helpers.ts";
import { startPublicHub } from "./p-helpers.ts";

const hubs: TestHub[] = [];
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((t) => t.stop()));
});

describe("HUB_TRUST_PROXY parsing", () => {
	it("maps flags and lists", () => {
		expect(parseTrustProxy(undefined)).toBe(false);
		expect(parseTrustProxy("")).toBe(false);
		expect(parseTrustProxy("0")).toBe(false);
		expect(parseTrustProxy("off")).toBe(false);
		expect(parseTrustProxy("1")).toBe(true);
		expect(parseTrustProxy("TRUE")).toBe(true);
		expect(parseTrustProxy("10.0.0.0/8, 192.168.1.5,::1")).toEqual(["10.0.0.0/8", "192.168.1.5", "::1"]);
	});

	it("rejects invalid entries", () => {
		expect(() => parseTrustProxy("10.0.0.0/33")).toThrow(/HUB_TRUST_PROXY/);
		expect(() => parseTrustProxy("proxy.local")).toThrow(/HUB_TRUST_PROXY/);
	});
});

describe("resolveClientIp", () => {
	it("ignores X-Forwarded-For when trust is off", () => {
		expect(resolveClientIp("203.0.113.9", "1.2.3.4", false)).toBe("203.0.113.9");
		expect(resolveClientIp("::ffff:203.0.113.9", "1.2.3.4", false)).toBe("203.0.113.9");
	});

	it("uses the address the immediate proxy appended when trust is on", () => {
		expect(resolveClientIp("10.0.0.2", "1.2.3.4", true)).toBe("1.2.3.4");
		// A client-supplied prefix cannot choose the address.
		expect(resolveClientIp("10.0.0.2", "6.6.6.6, 1.2.3.4", true)).toBe("1.2.3.4");
		expect(resolveClientIp("10.0.0.2", undefined, true)).toBe("10.0.0.2");
	});

	it("with a proxy list trusts the header only from listed peers and skips listed hops", () => {
		const list = ["10.0.0.0/8", "172.16.0.1"];
		expect(resolveClientIp("10.1.2.3", "1.2.3.4", list)).toBe("1.2.3.4");
		expect(resolveClientIp("10.1.2.3", "1.2.3.4, 172.16.0.1, 10.9.9.9", list)).toBe("1.2.3.4");
		expect(resolveClientIp("::ffff:10.1.2.3", "1.2.3.4", list)).toBe("1.2.3.4");
		// Peer not listed: header is ignored.
		expect(resolveClientIp("198.51.100.7", "1.2.3.4", list)).toBe("198.51.100.7");
	});
});

describe("rate limits and the client address", () => {
	const loginBurst = async (t: TestHub): Promise<number[]> => {
		const statuses: number[] = [];
		// Distinct accounts, so only the per-IP limit (10 per minute) can trigger.
		for (let i = 0; i < 12; i++) statuses.push((await t.api("POST", "/api/auth/login", { body: { email: `n${i}@x.test`, password: PASSWORD } })).status);
		return statuses;
	};

	it("trust on: each forwarded address has its own bucket", async () => {
		const t = await startHub({ trustProxy: true });
		hubs.push(t);
		expect((await loginBurst(t)).every((s) => s === 401)).toBe(true);
	});

	it("trust off: the forwarded address is ignored and everyone shares the peer bucket", async () => {
		const t = await startHub({ trustProxy: false });
		hubs.push(t);
		const statuses = await loginBurst(t);
		expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
		expect(statuses.slice(10)).toEqual([429, 429]);
	});

	it("HUB_TRUST_PROXY from the env is honoured and defaults to off", async () => {
		const off = await startHub({ trustProxy: undefined, env: {} });
		hubs.push(off);
		expect((await loginBurst(off))[11]).toBe(429);
		const on = await startHub({ trustProxy: undefined, env: { HUB_TRUST_PROXY: "1" } });
		hubs.push(on);
		expect((await loginBurst(on)).every((s) => s === 401)).toBe(true);
	});
});

describe("personal teams default by mode", () => {
	it("private mode: off until an admin enables it", async () => {
		const t = await startHub();
		hubs.push(t);
		const root = await t.bootstrap();
		const u = await t.createUser(root.token, "pat@corp.test");
		const denied = await t.api("POST", "/api/teams", { token: u.token, body: { name: "Mine" } });
		expect(denied.status).toBe(403);
		expect(denied.code).toBe("personalTeamsDisabled");
		expect((await t.api("GET", "/api/admin/settings", { token: root.token })).data.allowPersonalTeams).toBe(false);
	});

	it("public mode: on by default, and an explicit operator choice wins", async () => {
		const t = await startPublicHub();
		hubs.push(t);
		const u = await t.registerVerified("quinn@example.com");
		expect((await t.api("GET", "/api/admin/settings", { token: t.operator.token })).data.allowPersonalTeams).toBe(true);
		expect((await t.api("POST", "/api/teams", { token: u.token, body: { name: "Mine" } })).status).toBe(201);

		await t.api("PUT", "/api/admin/settings", { token: t.operator.token, body: { allowPersonalTeams: false } });
		const denied = await t.api("POST", "/api/teams", { token: u.token, body: { name: "Second" } });
		expect(denied.code).toBe("personalTeamsDisabled");
	});

	it("an explicit allowPersonalTeams option beats the mode default", async () => {
		const t = await startPublicHub({ allowPersonalTeams: false });
		hubs.push(t);
		const u = await t.registerVerified("rae@example.com");
		expect((await t.api("POST", "/api/teams", { token: u.token, body: { name: "Mine" } })).code).toBe("personalTeamsDisabled");
	});
});

describe("invite registration and email verification", () => {
	it("public mode: the invitee joins but must still verify the mailbox", async () => {
		const t = await startPublicHub();
		hubs.push(t);
		const created = await t.api("POST", "/api/invitations", { token: t.operator.token, body: { scope: "org", scopeId: t.operator.orgId, email: "sam@example.com", role: "member" } });
		expect(created.status).toBe(201);
		const reg = await t.api("POST", "/api/auth/register", { body: { email: "sam@example.com", password: PASSWORD, displayName: "Sam", inviteToken: created.data.token } });
		expect(reg.status).toBe(201);
		expect(reg.data).toMatchObject({ status: "active", verificationRequired: true });
		expect(reg.data.user.emailVerifiedAt).toBeNull();
		await t.flush();
		const verifyToken = t.capture.tokenFor("sam@example.com", "verify-email");
		expect(verifyToken).toBeTruthy();

		const login = await t.login("sam@example.com");
		const me = await t.api("GET", "/api/me", { token: login.token });
		expect(me.data.orgs.map((o: { id: string }) => o.id)).toContain(t.operator.orgId);
		expect(me.data.user.emailVerifiedAt).toBeNull();
		// Unverified: cannot self-create an organization.
		expect((await t.api("POST", "/api/orgs", { token: login.token, body: { name: "Sneaky" } })).code).toBe("emailNotVerified");

		expect((await t.api("POST", "/api/auth/verify-email", { body: { token: verifyToken } })).data).toEqual({ verified: true, status: "active" });
		expect((await t.api("POST", "/api/orgs", { token: login.token, body: { name: "Legit" } })).status).toBe(201);
	});

	it("private mode: invite registration still counts as verified and sends no mail", async () => {
		const t = await startHub();
		hubs.push(t);
		const root = await t.bootstrap();
		const created = await t.api("POST", "/api/invitations", { token: root.token, body: { scope: "org", scopeId: root.orgId, email: "tia@outside.test", role: "member" } });
		const reg = await t.api("POST", "/api/auth/register", { body: { email: "tia@outside.test", password: PASSWORD, displayName: "Tia", inviteToken: created.data.token } });
		expect(reg.data.status).toBe("active");
		expect(reg.data.verificationRequired).toBeUndefined();
		expect(reg.data.user.emailVerifiedAt).not.toBeNull();
	});

	it("accepting an invitation as a signed-in user does not touch email verification", async () => {
		const t = await startPublicHub();
		hubs.push(t);
		const u = await t.registerVerified("uma@example.com");
		const created = await t.api("POST", "/api/invitations", { token: t.operator.token, body: { scope: "org", scopeId: t.operator.orgId, email: "uma@example.com", role: "member" } });
		expect((await t.api("POST", `/api/invitations/${created.data.token}/accept`, { token: u.token })).status).toBe(200);
		const me = await t.api("GET", "/api/me", { token: u.token });
		expect(me.data.user.emailVerifiedAt).not.toBeNull();
	});
});
