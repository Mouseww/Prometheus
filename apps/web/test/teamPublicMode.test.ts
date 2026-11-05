import { describe, expect, it, vi } from "vitest";
import { createApiMethods, type Requester, TeamApiError } from "../src/team/api.ts";
import { ACCESS_KEY, createHubApi, type KeyValueStore } from "../src/team/hubApi.ts";
import {
	authLinkFromLocation,
	billingFromMeta,
	canCreateOrg,
	filterTeamsByScope,
	isOneTimeLinkPath,
	mailWarning,
	needsTurnstile,
	needsVerificationBanner,
	normalizeDomainInput,
	orgIdOfScope,
	orgScope,
	pendingDecisions,
	pendingTransferFor,
	SCOPE_ALL,
	SCOPE_PERSONAL,
	transferRows,
	transferTargets,
	transferTone,
	validScope,
} from "../src/team/logic/publicMode.ts";
import type { MeResult, MetaInfo, TeamView, TransferView } from "../src/team/types.ts";

const baseMeta: MetaInfo = { version: "1", publicKey: "k", needsSetup: false, registration: { open: true, domains: [], approval: false, invite: true } };
const meta = (patch: Partial<MetaInfo>): MetaInfo => ({ ...baseMeta, ...patch });

const me = (patch: { platformRole?: "operator" | null; emailVerifiedAt?: string | null; orgs?: MeResult["orgs"]; teams?: MeResult["teams"] } = {}): MeResult => ({
	user: { id: "u1", email: "a@b.c", displayName: "A", status: "active", platformRole: patch.platformRole ?? null, emailVerifiedAt: patch.emailVerifiedAt === undefined ? "2026-01-01T00:00:00Z" : patch.emailVerifiedAt, createdAt: "2026-01-01T00:00:00Z" },
	orgs: patch.orgs ?? [],
	teams: patch.teams ?? [],
});

const team = (id: string, orgId: string | null): TeamView => ({ id, name: id, orgId, ownerUserId: orgId ? null : "u1", role: "admin", createdAt: "2026-01-01T00:00:00Z" });

const transfer = (patch: Partial<TransferView> & { id: string }): TransferView => ({
	teamId: "t1",
	teamName: "Core",
	fromUserId: "u1",
	toOrgId: "o1",
	toOrgName: "Acme",
	status: "pending",
	decidedBy: null,
	createdAt: "2026-02-01T00:00:00Z",
	decidedAt: null,
	...patch,
});

describe("meta helpers", () => {
	it("shows Turnstile only when required, keyed and not the bootstrap account", () => {
		expect(needsTurnstile(undefined)).toBe(false);
		expect(needsTurnstile(meta({}))).toBe(false);
		expect(needsTurnstile(meta({ turnstileRequired: true, turnstileSiteKey: "site" }))).toBe(true);
		expect(needsTurnstile(meta({ turnstileRequired: true, turnstileSiteKey: null }))).toBe(false);
		expect(needsTurnstile(meta({ turnstileRequired: true, turnstileSiteKey: "site", needsSetup: true }))).toBe(false);
	});

	it("derives billing from meta without calling the Hub", () => {
		expect(billingFromMeta(undefined)).toBeUndefined();
		expect(billingFromMeta(meta({}))).toBeUndefined();
		expect(billingFromMeta(meta({ mode: "public" }))).toBe(true);
		expect(billingFromMeta(meta({ mode: "private" }))).toBe(false);
		expect(billingFromMeta(meta({ mode: "private", billingEnabled: true }))).toBe(true);
		expect(billingFromMeta(meta({ mode: "public", billingEnabled: false }))).toBe(false);
	});

	it("warns about mail only when the Hub says it is not configured", () => {
		expect(mailWarning(meta({ mailConfigured: false }))).toBe(true);
		expect(mailWarning(meta({ mailConfigured: true }))).toBe(false);
		expect(mailWarning(meta({}))).toBe(false);
		expect(mailWarning(undefined)).toBe(false);
	});

	it("shows the verification banner for unverified users in public mode only", () => {
		expect(needsVerificationBanner(me({ emailVerifiedAt: null }), meta({ mode: "public" }))).toBe(true);
		expect(needsVerificationBanner(me({ emailVerifiedAt: null }), meta({ mode: "private" }))).toBe(false);
		expect(needsVerificationBanner(me({}), meta({ mode: "public" }))).toBe(false);
	});

	it("lets anyone create an organization only in public mode when the operator allows it", () => {
		expect(canCreateOrg(me({}), meta({ mode: "public", allowSelfCreateOrg: true }))).toBe(true);
		expect(canCreateOrg(me({}), meta({ mode: "public", allowSelfCreateOrg: false }))).toBe(false);
		expect(canCreateOrg(me({}), meta({ mode: "private", allowSelfCreateOrg: true }))).toBe(false);
		expect(canCreateOrg(me({ platformRole: "operator" }), meta({ mode: "private" }))).toBe(true);
	});
});

describe("one-time links", () => {
	it("reads the token of the verify and reset links the Hub mails", () => {
		expect(authLinkFromLocation("/verify-email", "?token=abc")).toEqual({ kind: "verify-email", token: "abc" });
		expect(authLinkFromLocation("/reset-password/", "?token=a%2Bb")).toEqual({ kind: "reset-password", token: "a+b" });
		expect(authLinkFromLocation("/verify-email", "")).toBeUndefined();
		expect(authLinkFromLocation("/verify-email", "?token=")).toBeUndefined();
		expect(authLinkFromLocation("/teams", "?token=abc")).toBeUndefined();
	});

	it("knows which paths hold a one-time token", () => {
		expect(isOneTimeLinkPath("/invite/abc")).toBe(true);
		expect(isOneTimeLinkPath("/verify-email")).toBe(true);
		expect(isOneTimeLinkPath("/reset-password")).toBe(true);
		expect(isOneTimeLinkPath("/")).toBe(false);
		expect(isOneTimeLinkPath("/invite")).toBe(false);
	});
});

describe("context scope", () => {
	const teams = [team("p1", null), team("a1", "o1"), team("b1", "o2"), team("a2", "o1")];

	it("scopes the teams list", () => {
		expect(filterTeamsByScope(teams, SCOPE_ALL).map((t) => t.id)).toEqual(["p1", "a1", "b1", "a2"]);
		expect(filterTeamsByScope(teams, SCOPE_PERSONAL).map((t) => t.id)).toEqual(["p1"]);
		expect(filterTeamsByScope(teams, orgScope("o1")).map((t) => t.id)).toEqual(["a1", "a2"]);
		expect(filterTeamsByScope(teams, orgScope("none"))).toEqual([]);
	});

	it("round-trips org scopes and falls back to all for unknown ones", () => {
		expect(orgIdOfScope(orgScope("o1"))).toBe("o1");
		expect(orgIdOfScope(SCOPE_PERSONAL)).toBeUndefined();
		const user = me({ orgs: [{ id: "o1", name: "Acme", role: "member" }] });
		expect(validScope(orgScope("o1"), user)).toBe(orgScope("o1"));
		expect(validScope(orgScope("gone"), user)).toBe(SCOPE_ALL);
		expect(validScope(SCOPE_PERSONAL, user)).toBe(SCOPE_PERSONAL);
		expect(validScope("garbage", user)).toBe(SCOPE_ALL);
	});
});

describe("transfers", () => {
	const user = me({ orgs: [{ id: "o1", name: "Acme", role: "admin" }, { id: "o2", name: "Beta", role: "member" }] });

	it("orders pending first and decides which actions the viewer has", () => {
		const rows = transferRows(
			[
				transfer({ id: "old", status: "accepted", createdAt: "2026-01-01T00:00:00Z" }),
				transfer({ id: "mine", fromUserId: "u1", toOrgId: "o2", createdAt: "2026-02-01T00:00:00Z" }),
				transfer({ id: "inbox", fromUserId: "u9", toOrgId: "o1", createdAt: "2026-03-01T00:00:00Z" }),
				transfer({ id: "elsewhere", fromUserId: "u9", toOrgId: "o2", createdAt: "2026-04-01T00:00:00Z" }),
			],
			user,
		);
		expect(rows.map((r) => r.transfer.id)).toEqual(["elsewhere", "inbox", "mine", "old"]);
		const by = Object.fromEntries(rows.map((r) => [r.transfer.id, r]));
		expect(by.inbox).toMatchObject({ canDecide: true, canCancel: false });
		expect(by.mine).toMatchObject({ canDecide: false, canCancel: true });
		expect(by.elsewhere).toMatchObject({ canDecide: false, canCancel: false });
		expect(by.old).toMatchObject({ canDecide: false, canCancel: false });
		expect(pendingDecisions(rows)).toBe(1);
	});

	it("lets an operator decide on any pending request", () => {
		const op = me({ platformRole: "operator" });
		const rows = transferRows([transfer({ id: "x", fromUserId: "u9", toOrgId: "o7" })], op);
		expect(rows[0]).toMatchObject({ canDecide: true, canCancel: false });
	});

	it("finds the pending request of a team and the target organizations", () => {
		const list = [transfer({ id: "a", teamId: "t1", status: "rejected" }), transfer({ id: "b", teamId: "t1" }), transfer({ id: "c", teamId: "t2" })];
		expect(pendingTransferFor(list, "t1")?.id).toBe("b");
		expect(pendingTransferFor(list, "t9")).toBeUndefined();
		expect(transferTargets(user)).toEqual([{ id: "o1", name: "Acme" }, { id: "o2", name: "Beta" }]);
		expect(transferTone("pending")).toBe("ember");
		expect(transferTone("accepted")).toBe("moss");
		expect(transferTone("rejected")).toBe("rose");
		expect(transferTone("canceled")).toBe("muted");
	});
});

describe("normalizeDomainInput", () => {
	it("normalizes and validates domains", () => {
		expect(normalizeDomainInput("  @Mailinator.COM ")).toBe("mailinator.com");
		expect(normalizeDomainInput("a.b-c.io")).toBe("a.b-c.io");
		expect(normalizeDomainInput("nodot")).toBeUndefined();
		expect(normalizeDomainInput("bad domain.com")).toBeUndefined();
		expect(normalizeDomainInput("")).toBeUndefined();
	});
});

interface Seen {
	method: string;
	path: string;
	body?: unknown;
}

function recorder() {
	const seen: Seen[] = [];
	const requester: Requester = {
		async request<T>(method: string, path: string, body?: unknown): Promise<T> {
			seen.push(body === undefined ? { method, path } : { method, path, body });
			return undefined as T;
		},
	};
	return { seen, api: createApiMethods(requester) };
}

describe("TeamApi online-service methods (shared request construction)", () => {
	it("builds transfer requests", async () => {
		const { seen, api } = recorder();
		await api.requestTeamTransfer("t 1", "o1");
		await api.listTransfers();
		await api.acceptTransfer("x1");
		await api.rejectTransfer("x2");
		await api.cancelTransfer("x3");
		expect(seen).toEqual([
			{ method: "POST", path: "/api/teams/t%201/transfer", body: { orgId: "o1" } },
			{ method: "GET", path: "/api/transfers" },
			{ method: "POST", path: "/api/transfers/x1/accept" },
			{ method: "POST", path: "/api/transfers/x2/reject" },
			{ method: "POST", path: "/api/transfers/x3/cancel" },
		]);
	});

	it("builds operator console requests", async () => {
		const { seen, api } = recorder();
		await api.listAdminOrgs();
		await api.banUser("u 1");
		await api.listDisposableDomains();
		await api.addDisposableDomain("mailinator.com");
		await api.removeDisposableDomain("mailinator.com");
		await api.putSettings({ allowSelfCreateOrg: true });
		expect(seen).toEqual([
			{ method: "GET", path: "/api/admin/orgs" },
			{ method: "POST", path: "/api/admin/users/u%201/ban" },
			{ method: "GET", path: "/api/admin/disposable-domains" },
			{ method: "POST", path: "/api/admin/disposable-domains", body: { domain: "mailinator.com" } },
			{ method: "DELETE", path: "/api/admin/disposable-domains/mailinator.com" },
			{ method: "PUT", path: "/api/admin/settings", body: { allowSelfCreateOrg: true } },
		]);
	});
});

function memStore(): KeyValueStore {
	const data = new Map<string, string>();
	return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
const fail = (status: number, code: string) => new Response(JSON.stringify({ ok: false, error: { code, message: code } }), { status });

describe("createHubApi public account methods", () => {
	function setup(handler: (url: string, init: RequestInit | undefined) => Response) {
		const calls: { url: string; method: string; auth: string | null; body: unknown }[] = [];
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
			return handler(String(url), init);
		});
		const session = memStore();
		session.setItem(ACCESS_KEY, "tok");
		return { calls, api: createHubApi({ fetch: fetchMock as unknown as typeof fetch, session, local: memStore() }) };
	}

	it("verifies, resends, requests and completes a reset without sending the bearer token", async () => {
		const { api, calls } = setup((url) => (url.endsWith("/verify-email") ? ok({ verified: true, status: "active" }) : ok({})));
		expect(await api.verifyEmail("tok1")).toEqual({ verified: true, status: "active" });
		await api.resendVerification("a@b.c");
		await api.forgotPassword("a@b.c");
		await api.resetPassword("tok2", "newpassword");
		expect(calls.map((c) => [c.method, c.url.replace("/plugins/team", ""), c.auth, c.body])).toEqual([
			["POST", "/api/auth/verify-email", null, { token: "tok1" }],
			["POST", "/api/auth/resend-verification", null, { email: "a@b.c" }],
			["POST", "/api/auth/forgot-password", null, { email: "a@b.c" }],
			["POST", "/api/auth/reset-password", null, { token: "tok2", password: "newpassword" }],
		]);
	});

	it("surfaces the Hub's invalidToken for a used link", async () => {
		const { api } = setup(() => fail(400, "invalidToken"));
		await expect(api.verifyEmail("used")).rejects.toMatchObject({ code: "invalidToken", status: 400 } satisfies Partial<TeamApiError>);
	});

	it("sends the Turnstile token with registration", async () => {
		const { api, calls } = setup(() => ok({ user: { id: "u" }, status: "pending", bootstrap: false }));
		await api.register({ email: "a@b.c", password: "password1", displayName: "A", turnstileToken: "ts" });
		expect(calls[0]?.body).toEqual({ email: "a@b.c", password: "password1", displayName: "A", turnstileToken: "ts" });
	});
});
