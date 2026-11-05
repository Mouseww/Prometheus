import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto.ts";
import { PASSWORD, startHub, type TestHub } from "./hub-helpers.ts";
import { type PublicTestHub, startPublicHub } from "./p-helpers.ts";

const hubs: TestHub[] = [];
const start = async (options?: Parameters<typeof startPublicHub>[0]): Promise<PublicTestHub> => {
	const t = await startPublicHub(options);
	hubs.push(t);
	return t;
};
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((t) => t.stop()));
});

const DAY = 24 * 60 * 60 * 1000;
const register = (t: TestHub, email: string, extra: Record<string, unknown> = {}) =>
	t.api("POST", "/api/auth/register", { body: { email, password: PASSWORD, displayName: "U", ...extra } });

describe("public mode registration and email verification", () => {
	it("registers pending without joining any org, mails a link, then activates on verify", async () => {
		const t = await start();
		const reg = await register(t, "alice@example.com");
		expect(reg.status).toBe(201);
		expect(reg.data).toMatchObject({ status: "pending", verificationRequired: true, bootstrap: false });
		await t.flush();
		const memberships = await t.hub.db.query("SELECT 1 FROM org_members WHERE user_id = $1", [reg.data.user.id]);
		expect(memberships).toHaveLength(0);

		const login = await t.api("POST", "/api/auth/login", { body: { email: "alice@example.com", password: PASSWORD } });
		expect(login.status).toBe(403);
		expect(login.code).toBe("emailNotVerified");

		const token = t.capture.tokenFor("alice@example.com", "verify-email") as string;
		expect(token).toBeTruthy();
		const v = await t.api("POST", "/api/auth/verify-email", { body: { token } });
		expect(v.data).toEqual({ verified: true, status: "active" });
		const me = await t.api("GET", "/api/me", { token: (await t.login("alice@example.com")).token });
		expect(me.data.user.emailVerifiedAt).not.toBeNull();
		expect(me.data.orgs).toEqual([]);
	});

	it("stores only the token hash and the token works once", async () => {
		const t = await start();
		await register(t, "bob@example.com");
		await t.flush();
		const token = t.capture.tokenFor("bob@example.com", "verify-email") as string;
		const rows = await t.hub.db.query<{ token_hash: string }>("SELECT token_hash FROM email_verifications");
		expect(rows.map((r) => r.token_hash)).toEqual([sha256Hex(token)]);
		expect(JSON.stringify(rows)).not.toContain(token);
		expect((await t.api("POST", "/api/auth/verify-email", { body: { token } })).status).toBe(200);
		const again = await t.api("POST", "/api/auth/verify-email", { body: { token } });
		expect(again.status).toBe(400);
		expect(again.code).toBe("invalidToken");
	});

	it("rejects an unknown token and an expired one (24h)", async () => {
		const t = await start();
		expect((await t.api("POST", "/api/auth/verify-email", { body: { token: "nope" } })).code).toBe("invalidToken");
		await register(t, "carol@example.com");
		await t.flush();
		const token = t.capture.tokenFor("carol@example.com", "verify-email") as string;
		t.capture.clock.offsetMs = DAY + 60_000;
		const late = await t.api("POST", "/api/auth/verify-email", { body: { token } });
		t.capture.clock.offsetMs = 0;
		expect(late.code).toBe("invalidToken");
		// Still unused, so it works inside the window.
		expect((await t.api("POST", "/api/auth/verify-email", { body: { token } })).status).toBe(200);
	});

	it("resend gives the same answer for known and unknown accounts and invalidates the old link", async () => {
		const t = await start();
		await register(t, "dave@example.com");
		await t.flush();
		const first = t.capture.tokenFor("dave@example.com", "verify-email") as string;
		const known = await t.api("POST", "/api/auth/resend-verification", { body: { email: "dave@example.com" } });
		const unknown = await t.api("POST", "/api/auth/resend-verification", { body: { email: "ghost@example.com" } });
		await t.flush();
		expect(known.status).toBe(200);
		expect(unknown.status).toBe(200);
		expect(known.body).toEqual(unknown.body);
		expect(t.capture.mails.some((m) => m.includes("ghost@example.com"))).toBe(false);
		const second = t.capture.tokenFor("dave@example.com", "verify-email") as string;
		expect(second).not.toBe(first);
		expect((await t.api("POST", "/api/auth/verify-email", { body: { token: first } })).code).toBe("invalidToken");
		expect((await t.api("POST", "/api/auth/verify-email", { body: { token: second } })).status).toBe(200);
		// Verified accounts get no further mail.
		const before = t.capture.mails.length;
		await t.api("POST", "/api/auth/resend-verification", { body: { email: "dave@example.com" } });
		await t.flush();
		expect(t.capture.mails.length).toBe(before);
	});

	it("rate limits resend per IP (429) and per address (silently)", async () => {
		const t = await start();
		await register(t, "erin@example.com");
		await t.flush();
		const sent = t.capture.mails.length;
		for (let i = 0; i < 5; i++) await t.api("POST", "/api/auth/resend-verification", { body: { email: "erin@example.com" }, ip: "198.51.100.9" });
		await t.flush();
		expect(t.capture.mails.length - sent).toBe(3);
		let limited = 0;
		for (let i = 0; i < 12; i++) {
			const r = await t.api("POST", "/api/auth/resend-verification", { body: { email: `x${i}@example.com` }, ip: "198.51.100.9" });
			if (r.status === 429) limited++;
		}
		expect(limited).toBeGreaterThan(0);
	});

	it("keeps the account pending after verification when the platform policy requires approval", async () => {
		const t = await start();
		await t.api("PUT", "/api/admin/registration", {
			token: t.operator.token,
			body: { allowOpen: true, allowedDomains: [], requireApproval: true, allowInvite: true, closed: false },
		});
		await register(t, "frank@example.com");
		await t.flush();
		const v = await t.api("POST", "/api/auth/verify-email", { body: { token: t.capture.tokenFor("frank@example.com", "verify-email") } });
		expect(v.data.status).toBe("pending");
		const login = await t.api("POST", "/api/auth/login", { body: { email: "frank@example.com", password: PASSWORD } });
		expect(login.code).toBe("pendingApproval");
	});

	it("exposes mode, mailConfigured and the Turnstile site key in /api/meta", async () => {
		const t = await start({ env: { HUB_TURNSTILE_SECRET: "s", HUB_TURNSTILE_SITE_KEY: "site-key" } });
		const meta = await t.api("GET", "/api/meta");
		expect(meta.data).toMatchObject({ mode: "public", mailConfigured: false, turnstileSiteKey: "site-key", turnstileRequired: true, allowSelfCreateOrg: true, billingEnabled: true });
	});
});

describe("password reset (both modes)", () => {
	it("public mode: forgot -> reset changes the password and revokes refresh tokens", async () => {
		const t = await start();
		const u = await t.registerVerified("gina@example.com");
		expect((await t.api("POST", "/api/auth/forgot-password", { body: { email: "gina@example.com" } })).status).toBe(200);
		await t.flush();
		const token = t.capture.tokenFor("gina@example.com", "reset-password") as string;
		const stored = await t.hub.db.query<{ token_hash: string }>("SELECT token_hash FROM password_resets");
		expect(stored.map((r) => r.token_hash)).toEqual([sha256Hex(token)]);

		const bad = await t.api("POST", "/api/auth/reset-password", { body: { token, password: "short" } });
		expect(bad.status).toBe(400);
		const ok = await t.api("POST", "/api/auth/reset-password", { body: { token, password: "a-brand-new-password" } });
		expect(ok.status).toBe(200);
		expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: u.refreshToken } })).status).toBe(401);
		expect((await t.api("POST", "/api/auth/login", { body: { email: "gina@example.com", password: PASSWORD } })).status).toBe(401);
		expect((await t.api("POST", "/api/auth/login", { body: { email: "gina@example.com", password: "a-brand-new-password" } })).status).toBe(200);
		expect((await t.api("POST", "/api/auth/reset-password", { body: { token, password: "another-password-1" } })).code).toBe("invalidToken");
	});

	it("reset tokens expire after 1h and unknown emails are answered identically without mail", async () => {
		const t = await start();
		await t.registerVerified("hank@example.com");
		const known = await t.api("POST", "/api/auth/forgot-password", { body: { email: "hank@example.com" } });
		const unknown = await t.api("POST", "/api/auth/forgot-password", { body: { email: "nobody@example.com" } });
		await t.flush();
		expect(known.body).toEqual(unknown.body);
		expect(t.capture.mails.some((m) => m.includes("nobody@example.com"))).toBe(false);
		const token = t.capture.tokenFor("hank@example.com", "reset-password") as string;
		t.capture.clock.offsetMs = 61 * 60 * 1000;
		const late = await t.api("POST", "/api/auth/reset-password", { body: { token, password: "a-brand-new-password" } });
		t.capture.clock.offsetMs = 0;
		expect(late.code).toBe("invalidToken");
	});

	it("private mode also supports forgot and reset", async () => {
		const t = await startHub({ log: { info: () => {}, warn: () => {}, error: () => {} } });
		hubs.push(t);
		const root = await t.bootstrap();
		await t.createUser(root.token, "ivy@corp.test");
		await t.api("POST", "/api/auth/forgot-password", { body: { email: "ivy@corp.test" } });
		await (t.hub.registry.require("publicAccounts") as { flush(): Promise<void> }).flush();
		const rows = await t.hub.db.query<{ n: string }>("SELECT count(*) AS n FROM password_resets");
		expect(Number(rows[0]?.n)).toBe(1);
	});
});

describe("private mode stays as in 2A", () => {
	it("self registration joins the default org, no verification step", async () => {
		const t = await startHub();
		hubs.push(t);
		const root = await t.bootstrap();
		await t.api("PUT", "/api/admin/registration", {
			token: root.token,
			body: { allowOpen: false, allowedDomains: ["corp.test"], requireApproval: false, allowInvite: true, closed: false },
		});
		const reg = await register(t, "jack@corp.test");
		expect(reg.data).toMatchObject({ status: "active" });
		expect(reg.data.verificationRequired).toBeUndefined();
		const l = await t.login("jack@corp.test");
		const me = await t.api("GET", "/api/me", { token: l.token });
		expect(me.data.orgs.map((o: { id: string }) => o.id)).toEqual([root.orgId]);
		expect((await t.api("GET", "/api/meta")).data.mode).toBe("private");
	});

	it("non-operators cannot create orgs, even though self-create is allowed in public mode", async () => {
		const t = await startHub();
		hubs.push(t);
		const root = await t.bootstrap();
		const u = await t.createUser(root.token, "kim@corp.test");
		expect((await t.api("POST", "/api/orgs", { token: u.token, body: { name: "Mine" } })).status).toBe(403);
	});
});

describe("self-service organizations", () => {
	it("a verified user creates an org and becomes owner; users may belong to several orgs", async () => {
		const t = await start();
		const u = await t.registerVerified("lena@example.com");
		const a = await t.api("POST", "/api/orgs", { token: u.token, body: { name: "Alpha Inc" } });
		expect(a.status).toBe(201);
		expect(a.data).toMatchObject({ name: "Alpha Inc", role: "owner" });
		const b = await t.api("POST", "/api/orgs", { token: u.token, body: { name: "Beta Inc" } });
		expect(b.status).toBe(201);
		const me = await t.api("GET", "/api/me", { token: u.token });
		expect(me.data.orgs.map((o: { name: string; role: string }) => `${o.name}:${o.role}`)).toEqual(["Alpha Inc:owner", "Beta Inc:owner"]);
		const members = await t.api("GET", `/api/orgs/${a.data.id}/members`, { token: u.token });
		expect(members.data.map((m: { email: string }) => m.email)).toEqual(["lena@example.com"]);
	});

	it("the operator can switch self-service off and on", async () => {
		const t = await start();
		const u = await t.registerVerified("mona@example.com");
		const off = await t.api("PUT", "/api/admin/settings", { token: t.operator.token, body: { allowSelfCreateOrg: false } });
		expect(off.data.allowSelfCreateOrg).toBe(false);
		const denied = await t.api("POST", "/api/orgs", { token: u.token, body: { name: "Nope" } });
		expect(denied.status).toBe(403);
		expect(denied.code).toBe("selfCreateOrgDisabled");
		// The operator is unaffected, and the other setting is untouched by a partial update.
		expect((await t.api("POST", "/api/orgs", { token: t.operator.token, body: { name: "Ops" } })).status).toBe(201);
		const on = await t.api("PUT", "/api/admin/settings", { token: t.operator.token, body: { allowSelfCreateOrg: true } });
		expect(on.data).toMatchObject({ allowSelfCreateOrg: true, allowPersonalTeams: true });
		expect((await t.api("POST", "/api/orgs", { token: u.token, body: { name: "Yes" } })).status).toBe(201);
	});

	it("requires a verified address and refuses to create on behalf of someone else", async () => {
		const t = await start();
		const u = await t.registerVerified("nina@example.com");
		const other = await t.registerVerified("omar@example.com");
		const r = await t.api("POST", "/api/orgs", { token: u.token, body: { name: "X", ownerUserId: other.userId } });
		expect(r.status).toBe(403);
		// Admin-created accounts have no verified address.
		const adminMade = await t.createUser(t.operator.token, "pete@example.com");
		const denied = await t.api("POST", "/api/orgs", { token: adminMade.token, body: { name: "Y" } });
		expect(denied.code).toBe("emailNotVerified");
	});
});

describe("operator additions", () => {
	it("GET /api/admin/orgs lists every org with member counts, operator only", async () => {
		const t = await start();
		const u = await t.registerVerified("quin@example.com");
		await t.api("POST", "/api/orgs", { token: u.token, body: { name: "Quin Co" } });
		const list = await t.api("GET", "/api/admin/orgs", { token: t.operator.token });
		const quin = list.data.find((o: { name: string }) => o.name === "Quin Co");
		expect(quin).toMatchObject({ memberCount: 1, teamCount: 0, status: "active" });
		expect(list.data.length).toBe(2);
		expect((await t.api("GET", "/api/admin/orgs", { token: u.token })).status).toBe(403);
	});

	it("ban disables the account, revokes refresh tokens and stops the tenant runtime when present", async () => {
		const t = await start();
		const stopped: string[] = [];
		t.hub.registry.register("tenants", {
			stop: async (id: string, reason?: string) => {
				stopped.push(`${id}:${reason}`);
			},
		});
		const u = await t.registerVerified("ruth@example.com");
		const res = await t.api("POST", `/api/admin/users/${u.userId}/ban`, { token: t.operator.token });
		expect(res.data.status).toBe("disabled");
		expect(stopped).toEqual([`${u.userId}:banned`]);
		expect((await t.api("POST", "/api/auth/refresh", { body: { refreshToken: u.refreshToken } })).status).toBe(401);
		expect((await t.api("POST", "/api/auth/login", { body: { email: "ruth@example.com", password: PASSWORD } })).code).toBe("accountDisabled");
		const audit = await t.api("GET", "/api/admin/audit?action=user.ban", { token: t.operator.token });
		expect(audit.data.items).toHaveLength(1);
		// The banned user's access token stops working at once; other non-operators are simply forbidden.
		expect((await t.api("GET", "/api/me", { token: u.token })).status).toBe(401);
		const other = await t.registerVerified("tess@example.com");
		expect((await t.api("POST", `/api/admin/users/${u.userId}/ban`, { token: other.token })).status).toBe(403);
	});

	it("ban works when no runtime manager is registered", async () => {
		const t = await start();
		const u = await t.registerVerified("sam@example.com");
		expect((await t.api("POST", `/api/admin/users/${u.userId}/ban`, { token: t.operator.token })).status).toBe(200);
	});
});
