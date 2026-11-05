import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyJwt } from "../src/jwt.ts";
import { evaluateSelfRegistration, type RegistrationPolicy } from "../src/services/registration.ts";
import { PASSWORD, startHub, type TestHub } from "./hub-helpers.ts";

const policy = (over: Partial<RegistrationPolicy> = {}): RegistrationPolicy => ({ allowOpen: false, allowedDomains: [], requireApproval: true, allowInvite: true, closed: false, ...over });

describe("evaluateSelfRegistration (policy combinations)", () => {
	it("private defaults reject everyone", () => {
		expect(evaluateSelfRegistration(policy(), undefined, "a@corp.test")).toEqual({ allowed: false, reason: "domainNotAllowed" });
	});
	it("allowed domain passes, others fail", () => {
		const p = policy({ allowedDomains: ["corp.test"] });
		expect(evaluateSelfRegistration(p, undefined, "a@corp.test")).toEqual({ allowed: true, requireApproval: true });
		expect(evaluateSelfRegistration(p, undefined, "a@evil.test")).toEqual({ allowed: false, reason: "domainNotAllowed" });
	});
	it("open registration allows any domain; approval flag decides pending", () => {
		expect(evaluateSelfRegistration(policy({ allowOpen: true, requireApproval: false }), undefined, "x@any.test")).toEqual({ allowed: true, requireApproval: false });
	});
	it("closed wins over open and domains", () => {
		expect(evaluateSelfRegistration(policy({ closed: true, allowOpen: true }), undefined, "a@corp.test")).toEqual({ allowed: false, reason: "closed" });
	});
	it("org policy narrows and can add approval", () => {
		const platform = policy({ allowOpen: true, requireApproval: false });
		expect(evaluateSelfRegistration(platform, policy({ allowOpen: false, allowedDomains: ["corp.test"], requireApproval: true }), "a@corp.test")).toEqual({ allowed: true, requireApproval: true });
		expect(evaluateSelfRegistration(platform, policy({ allowedDomains: ["corp.test"] }), "a@other.test")).toEqual({ allowed: false, reason: "domainNotAllowed" });
		expect(evaluateSelfRegistration(platform, policy({ closed: true }), "a@corp.test")).toEqual({ allowed: false, reason: "closed" });
	});
	it("domain match is case insensitive via the address", () => {
		expect(evaluateSelfRegistration(policy({ allowedDomains: ["corp.test"] }), undefined, "A@CORP.TEST")).toMatchObject({ allowed: true });
	});
});

describe("setup code bootstrap", () => {
	let t: TestHub;
	beforeAll(async () => {
		t = await startHub({ orgName: "Acme" });
	});
	afterAll(() => t.stop());

	it("reports needsSetup and writes the setup code file", async () => {
		const meta = await t.api("GET", "/api/meta");
		expect(meta.data.needsSetup).toBe(true);
		expect(meta.data.publicKey).toContain("BEGIN PUBLIC KEY");
		expect((await readFile(join(t.dataDir, "setup-code.txt"), "utf8")).trim()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
	});

	it("rejects the first registration without or with a wrong code", async () => {
		const body = { email: "root@corp.test", password: PASSWORD, displayName: "Root" };
		const none = await t.api("POST", "/api/auth/register", { body });
		expect(none.status).toBe(403);
		expect(none.code).toBe("setupCodeRequired");
		const wrong = await t.api("POST", "/api/auth/register", { body: { ...body, setupCode: "AAAA-BBBB-CCCC" } });
		expect(wrong.code).toBe("invalidSetupCode");
	});

	it("makes the first user operator and owner of a default org, then removes the code", async () => {
		const root = await t.bootstrap();
		const me = await t.api("GET", "/api/me", { token: root.token });
		expect(me.data.user.platformRole).toBe("operator");
		expect(me.data.orgs).toEqual([{ id: root.orgId, name: "Acme", role: "owner" }]);
		expect((await t.api("GET", "/api/meta")).data.needsSetup).toBe(false);
		await expect(readFile(join(t.dataDir, "setup-code.txt"), "utf8")).rejects.toThrow();
		// A second registration cannot reuse a setup code and obeys the (closed by default) policy.
		const second = await t.api("POST", "/api/auth/register", { body: { email: "late@corp.test", password: PASSWORD, displayName: "Late", setupCode: "X" } });
		expect(second.status).toBe(403);
		expect(second.code).toBe("domainNotAllowed");
	});
});

describe("registration, approval and login", () => {
	let t: TestHub;
	let root: { token: string; orgId: string; userId: string };
	beforeAll(async () => {
		t = await startHub();
		root = await t.bootstrap();
	});
	afterAll(() => t.stop());

	const register = (email: string, extra: Record<string, unknown> = {}) =>
		t.api("POST", "/api/auth/register", { body: { email, password: PASSWORD, displayName: email.split("@")[0], ...extra } });

	it("allowed domain with approval creates a pending user who cannot log in until approved", async () => {
		await t.api("PUT", "/api/admin/registration", { token: root.token, body: { allowOpen: false, allowedDomains: ["Corp.Test"], requireApproval: true, allowInvite: true, closed: false } });
		const meta = await t.api("GET", "/api/meta");
		expect(meta.data.registration).toEqual({ open: false, domains: ["corp.test"], approval: true, invite: true });
		expect(meta.data.billingEnabled).toBe(false);

		const r = await register("Alice@Corp.Test");
		expect(r.status).toBe(201);
		expect(r.data).toMatchObject({ status: "pending", bootstrap: false });
		expect(r.data.user.email).toBe("alice@corp.test");

		const pending = await t.api("POST", "/api/auth/login", { body: { email: "alice@corp.test", password: PASSWORD } });
		expect(pending.status).toBe(403);
		expect(pending.code).toBe("pendingApproval");

		const list = await t.api("GET", "/api/admin/users?status=pending", { token: root.token });
		expect(list.data).toHaveLength(1);
		expect(list.data[0].memberships).toEqual([{ orgId: root.orgId, role: "member", status: "pending" }]);

		const approved = await t.api("POST", `/api/admin/users/${r.data.user.id}/approve`, { token: root.token });
		expect(approved.data.status).toBe("active");
		const login = await t.login("alice@corp.test");
		const me = await t.api("GET", "/api/me", { token: login.token });
		expect(me.data.orgs).toEqual([{ id: root.orgId, name: expect.any(String), role: "member" }]);
		expect((await t.api("POST", `/api/admin/users/${r.data.user.id}/approve`, { token: root.token })).code).toBe("notPending");
	});

	it("rejects disallowed domains and closed registration", async () => {
		expect((await register("bob@evil.test")).code).toBe("domainNotAllowed");
		await t.api("PUT", "/api/admin/registration", { token: root.token, body: { allowOpen: true, allowedDomains: [], requireApproval: false, allowInvite: true, closed: true } });
		expect((await register("bob@corp.test")).code).toBe("registrationClosed");
	});

	it("open registration without approval gives an active user", async () => {
		await t.api("PUT", "/api/admin/registration", { token: root.token, body: { allowOpen: true, allowedDomains: [], requireApproval: false, allowInvite: true, closed: false } });
		const r = await register("carol@anywhere.test");
		expect(r.data.status).toBe("active");
		await t.login("carol@anywhere.test");
	});

	it("org policy adds a restriction on top of the platform policy", async () => {
		await t.api("PUT", `/api/orgs/${root.orgId}/registration`, {
			token: root.token,
			body: { allowOpen: false, allowedDomains: ["corp.test"], requireApproval: true, allowInvite: true, closed: false },
		});
		expect((await register("dave@anywhere.test")).code).toBe("domainNotAllowed");
		const ok = await register("erin@corp.test");
		expect(ok.data.status).toBe("pending");
		const got = await t.api("GET", `/api/orgs/${root.orgId}/registration`, { token: root.token });
		expect(got.data).toMatchObject({ configured: true, allowedDomains: ["corp.test"] });
	});

	it("rejects duplicate emails and weak input", async () => {
		await t.api("PUT", `/api/orgs/${root.orgId}/registration`, { token: root.token, body: { allowOpen: true, allowedDomains: [], requireApproval: false, allowInvite: true, closed: false } });
		expect((await register("carol@anywhere.test")).code).toBe("emailTaken");
		const weak = await t.api("POST", "/api/auth/register", { body: { email: "x@y.test", password: "short", displayName: "x" } });
		expect(weak.status).toBe(400);
		expect(weak.code).toBe("validationError");
		expect((await t.api("POST", "/api/auth/register", { body: { email: "not-an-email", password: PASSWORD, displayName: "x" } })).status).toBe(400);
	});

	it("invalid credentials give 401 without revealing which part was wrong", async () => {
		const badPw = await t.api("POST", "/api/auth/login", { body: { email: "carol@anywhere.test", password: "wrong-password" } });
		const noUser = await t.api("POST", "/api/auth/login", { body: { email: "ghost@anywhere.test", password: "wrong-password" } });
		expect(badPw.status).toBe(401);
		expect(noUser.status).toBe(401);
		expect(badPw.code).toBe("invalidCredentials");
		expect(noUser.body).toEqual(badPw.body);
	});

	it("issues Ed25519 access tokens with the expected claims", async () => {
		const login = await t.api("POST", "/api/auth/login", { body: { email: "carol@anywhere.test", password: PASSWORD } });
		const claims = verifyJwt(login.data.accessToken, { publicKey: t.hub.publicKeyPem, issuer: "prometheus-hub", audience: "prometheus" });
		expect(claims).toMatchObject({ sub: login.data.user.id, name: "carol", org: root.orgId, aud: "prometheus", iss: "prometheus-hub" });
		expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(900);
		expect(login.data.user.passwordHash).toBeUndefined();
		expect(JSON.stringify(login.body)).not.toContain("scrypt$");
	});
});

describe("tokens: refresh rotation and logout", () => {
	let t: TestHub;
	let root: { token: string; orgId: string; userId: string };
	beforeAll(async () => {
		t = await startHub();
		root = await t.bootstrap();
	});
	afterAll(() => t.stop());

	it("rotates refresh tokens and rejects reuse of the old one", async () => {
		const first = await t.login("root@corp.test");
		const second = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: first.refreshToken } });
		expect(second.status).toBe(200);
		expect(second.data.refreshToken).not.toBe(first.refreshToken);
		expect(second.data.accessToken).toBeTruthy();
		await ageRotations();
		const reuse = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: first.refreshToken } });
		expect(reuse.status).toBe(401);
		expect(reuse.code).toBe("invalidRefreshToken");
		// Reuse after the grace window is a theft signal: the whole family, including the newest token, is revoked.
		const third = await t.api("POST", "/api/auth/refresh", { body: { refreshToken: second.data.refreshToken } });
		expect(third.status).toBe(401);
		const audit = await t.hub.db.query("SELECT 1 FROM audit_log WHERE action = 'auth.refresh.reuse' AND target_id = $1", [root.userId]);
		expect(audit.length).toBeGreaterThanOrEqual(1);
	});

	// Pushes every rotation further into the past than the reuse grace window.
	const ageRotations = (): Promise<unknown> => t.hub.db.query("UPDATE refresh_tokens SET rotated_at = rotated_at - interval '5 minutes' WHERE rotated_at IS NOT NULL");
	const refresh = (refreshToken: string) => t.api("POST", "/api/auth/refresh", { body: { refreshToken } });

	it("two tabs refreshing with the same stored token both succeed inside the grace window", async () => {
		const login = await t.createUser(root.token, "tabs@corp.test");
		const [a, b] = await Promise.all([refresh(login.refreshToken), refresh(login.refreshToken)]);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(a.data.refreshToken).not.toBe(b.data.refreshToken);
		// Neither tab was logged out: both new tokens keep rotating, and so does a retry with the original token.
		expect((await refresh(a.data.refreshToken)).status).toBe(200);
		expect((await refresh(b.data.refreshToken)).status).toBe(200);
		expect((await refresh(login.refreshToken)).status).toBe(200);
		// All of it stayed in the one family of that login.
		const families = await t.hub.db.query<{ family_id: string }>("SELECT DISTINCT family_id FROM refresh_tokens WHERE user_id = $1", [login.userId]);
		expect(families).toHaveLength(1);
	});

	it("a replay inside the grace window gets nothing once the family was logged out", async () => {
		const login = await t.createUser(root.token, "tabs2@corp.test");
		const next = await refresh(login.refreshToken);
		expect(next.status).toBe(200);
		await t.api("POST", "/api/auth/logout", { body: { refreshToken: next.data.refreshToken } });
		// The original token was rotated a moment ago, but the family's live token was revoked on purpose: the replay must not revive it.
		expect((await refresh(login.refreshToken)).status).toBe(401);
		expect((await refresh(next.data.refreshToken)).status).toBe(401);
	});

	it("reuse after the grace window revokes only that login's family, other devices stay signed in", async () => {
		const laptop = await t.createUser(root.token, "devices@corp.test");
		const phone = await t.login("devices@corp.test");
		const laptop2 = await refresh(laptop.refreshToken);
		expect(laptop2.status).toBe(200);
		const rows = await t.hub.db.query<{ family_id: string }>("SELECT DISTINCT family_id FROM refresh_tokens WHERE user_id = $1", [laptop.userId]);
		await ageRotations();
		expect((await refresh(laptop.refreshToken)).status).toBe(401);
		// The laptop's family is gone, including its newest token.
		expect((await refresh(laptop2.data.refreshToken)).status).toBe(401);
		// The phone has a family of its own and is untouched.
		expect((await refresh(phone.refreshToken)).status).toBe(200);
		expect(rows.length).toBeGreaterThanOrEqual(2);
	});

	it("tokens of one login share a family and every login starts its own", async () => {
		const a = await t.createUser(root.token, "families@corp.test");
		const b = await t.login("families@corp.test");
		const a2 = await refresh(a.refreshToken);
		const familyOf = async (token: string): Promise<string> => {
			const { sha256Hex } = await import("../src/crypto.ts");
			return (await t.hub.db.query<{ family_id: string }>("SELECT family_id FROM refresh_tokens WHERE token_hash = $1", [sha256Hex(token)]))[0]?.family_id as string;
		};
		expect(await familyOf(a2.data.refreshToken)).toBe(await familyOf(a.refreshToken));
		expect(await familyOf(a.refreshToken)).not.toBe(await familyOf(b.refreshToken));
	});


	it("logout revokes the refresh token and is idempotent", async () => {
		const l = await t.login("root@corp.test");
		expect((await t.api("POST", "/api/auth/logout", { body: { refreshToken: l.refreshToken } })).status).toBe(200);
		expect((await t.api("POST", "/api/auth/logout", { body: { refreshToken: l.refreshToken } })).status).toBe(200);
		expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: l.refreshToken } })).status).toBe(401);
	});

	it("expired refresh tokens are rejected", async () => {
		const l = await t.login("root@corp.test");
		await t.hub.db.query("UPDATE refresh_tokens SET expires_at = now() - interval '1 day'");
		expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: l.refreshToken } })).code).toBe("invalidRefreshToken");
	});

	it("disabling a user revokes refresh tokens and blocks the access token", async () => {
		const u = await t.createUser(root.token, "temp@corp.test");
		expect((await t.api("GET", "/api/me", { token: u.token })).status).toBe(200);
		await t.api("POST", `/api/admin/users/${u.userId}/disable`, { token: root.token });
		expect((await t.api("GET", "/api/me", { token: u.token })).status).toBe(401);
		expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: u.refreshToken } })).status).toBe(401);
		const login = await t.api("POST", "/api/auth/login", { body: { email: "temp@corp.test", password: PASSWORD } });
		expect(login.code).toBe("accountDisabled");
		await t.api("POST", `/api/admin/users/${u.userId}/enable`, { token: root.token });
		await t.login("temp@corp.test");
	});

	it("rejects missing, malformed and tampered tokens", async () => {
		expect((await t.api("GET", "/api/me")).status).toBe(401);
		expect((await t.api("GET", "/api/me", { token: "garbage" })).code).toBe("invalidToken");
		const tampered = `${root.token.slice(0, -4)}AAAA`;
		expect((await t.api("GET", "/api/me", { token: tampered })).status).toBe(401);
	});
});

describe("rate limiting", () => {
	let t: TestHub;
	beforeAll(async () => {
		t = await startHub();
		await t.bootstrap();
	});
	afterAll(() => t.stop());

	it("limits logins per account to 5 per minute with Retry-After", async () => {
		const codes: number[] = [];
		for (let i = 0; i < 7; i++) codes.push((await t.api("POST", "/api/auth/login", { body: { email: "victim@corp.test", password: "wrong-password" } })).status);
		expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429]);
		const blocked = await t.api("POST", "/api/auth/login", { body: { email: "victim@corp.test", password: PASSWORD } });
		expect(blocked.code).toBe("rateLimited");
		expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
	});

	it("limits attempts per IP to 10 per minute across accounts", async () => {
		const ip = "203.0.113.9";
		const codes: number[] = [];
		for (let i = 0; i < 12; i++) codes.push((await t.api("POST", "/api/auth/login", { ip, body: { email: `u${i}@x.test`, password: "wrong-password" } })).status);
		expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
		expect(codes.slice(10)).toEqual([429, 429]);
	});
});

describe("GET /api/meta billingEnabled", () => {
	it("follows HubConfig.billingEnabled: on with HUB_BILLING in private mode, off by default", async () => {
		const on = await startHub({ billing: true });
		const off = await startHub();
		try {
			expect((await on.api("GET", "/api/meta")).data).toMatchObject({ mode: "private", billingEnabled: true });
			expect((await off.api("GET", "/api/meta")).data).toMatchObject({ mode: "private", billingEnabled: false });
		} finally {
			await on.stop();
			await off.stop();
		}
	});
});
