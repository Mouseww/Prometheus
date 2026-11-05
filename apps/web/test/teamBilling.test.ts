import { describe, expect, it, vi } from "vitest";
import { createApiMethods, type Requester, TeamApiError } from "../src/team/api.ts";
import { ACCESS_KEY, createHubApi, type KeyValueStore } from "../src/team/hubApi.ts";
import {
	centsToInput,
	checkoutRedirect,
	codesToText,
	formatCredits,
	formatCreditsShort,
	formatMoney,
	formatPrice,
	isBillingDisabled,
	localInputToIso,
	manualOrderActions,
	orderStatusTone,
	parseCentsInput,
	parseCreditsInput,
	parsePriceInput,
	percentOf,
	probeBilling,
} from "../src/team/logic/billing.ts";
import { createMemberApi } from "../src/team/memberApi.ts";

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

describe("TeamApi billing and BYOK methods (shared request construction)", () => {
	it("builds personal gateway and BYOK switch requests", async () => {
		const { seen, api } = recorder();
		await api.listMyGateways();
		await api.createMyGateway({ name: "Mine", format: "openai", baseUrl: "https://api.example.com/v1", apiKey: "sk-1", models: [{ id: "m1" }], enabled: true });
		await api.updateMyGateway("g 1", { enabled: false });
		await api.deleteMyGateway("g1");
		await api.getMyByok();
		await api.getByokSettings();
		await api.getByokSettings("o1");
		await api.setByokSettings({ scope: "platform", allowed: true });
		await api.setByokSettings({ scope: "org", orgId: "o1", allowed: null });
		expect(seen).toEqual([
			{ method: "GET", path: "/api/me/gateways" },
			{ method: "POST", path: "/api/me/gateways", body: { name: "Mine", format: "openai", baseUrl: "https://api.example.com/v1", apiKey: "sk-1", models: [{ id: "m1" }], enabled: true } },
			{ method: "PUT", path: "/api/me/gateways/g%201", body: { enabled: false } },
			{ method: "DELETE", path: "/api/me/gateways/g1" },
			{ method: "GET", path: "/api/me/byok" },
			{ method: "GET", path: "/api/admin/byok" },
			{ method: "GET", path: "/api/admin/byok?orgId=o1" },
			{ method: "PUT", path: "/api/admin/byok", body: { scope: "platform", allowed: true } },
			{ method: "PUT", path: "/api/admin/byok", body: { scope: "org", orgId: "o1", allowed: null } },
		]);
	});

	it("builds user billing requests", async () => {
		const { seen, api } = recorder();
		await api.listBillingPlans();
		await api.getBillingSummary();
		await api.getBillingSummary("o1");
		await api.checkout({ kind: "topup", credits: 50_000, orgId: "o1" });
		await api.checkout({ kind: "subscription", planId: "p1", provider: "manual" });
		await api.redeemCode({ code: "ABCD-1234" });
		await api.redeemCode({ code: "ABCD-1234", orgId: "o1" });
		expect(seen).toEqual([
			{ method: "GET", path: "/api/billing/plans" },
			{ method: "GET", path: "/api/billing/summary" },
			{ method: "GET", path: "/api/billing/summary?orgId=o1" },
			{ method: "POST", path: "/api/billing/checkout", body: { kind: "topup", credits: 50_000, orgId: "o1" } },
			{ method: "POST", path: "/api/billing/checkout", body: { kind: "subscription", planId: "p1", provider: "manual" } },
			{ method: "POST", path: "/api/billing/redeem", body: { code: "ABCD-1234" } },
			{ method: "POST", path: "/api/billing/redeem", body: { code: "ABCD-1234", orgId: "o1" } },
		]);
	});

	it("builds operator plan, price and order requests", async () => {
		const { seen, api } = recorder();
		await api.listAdminPlans();
		await api.createPlan({ name: "Pro", period: "month", priceCents: 1900, currency: "cny", monthlyCredits: 1_000_000 });
		await api.updatePlan("p1", { active: false });
		await api.deletePlan("p1");
		await api.listPrices();
		await api.createPrice({ model: "*", gatewayId: null, inputPrice: 1.5, outputPrice: 6 });
		await api.updatePrice("pr1", { outputPrice: 8 });
		await api.deletePrice("pr1");
		await api.listOrders();
		await api.listOrders({ status: "pending", provider: "manual", before: "o9", limit: 50 });
		await api.markOrderPaid("o 1");
		await api.markOrderRefunded("o1");
		expect(seen).toEqual([
			{ method: "GET", path: "/api/admin/plans" },
			{ method: "POST", path: "/api/admin/plans", body: { name: "Pro", period: "month", priceCents: 1900, currency: "cny", monthlyCredits: 1_000_000 } },
			{ method: "PUT", path: "/api/admin/plans/p1", body: { active: false } },
			{ method: "DELETE", path: "/api/admin/plans/p1" },
			{ method: "GET", path: "/api/admin/prices" },
			{ method: "POST", path: "/api/admin/prices", body: { model: "*", gatewayId: null, inputPrice: 1.5, outputPrice: 6 } },
			{ method: "PUT", path: "/api/admin/prices/pr1", body: { outputPrice: 8 } },
			{ method: "DELETE", path: "/api/admin/prices/pr1" },
			{ method: "GET", path: "/api/admin/orders" },
			{ method: "GET", path: "/api/admin/orders?status=pending&provider=manual&before=o9&limit=50" },
			{ method: "POST", path: "/api/admin/orders/o%201/mark-paid" },
			{ method: "POST", path: "/api/admin/orders/o1/mark-refunded" },
		]);
	});

	it("builds redeem code, settings and credit grant requests", async () => {
		const { seen, api } = recorder();
		await api.listRedeemCodes();
		await api.generateRedeemCodes({ count: 5, credits: 10_000, maxUses: 1, expiresAt: "2026-12-31T00:00:00.000Z" });
		await api.getBillingSettings();
		await api.putBillingSettings({ topupCreditsPerCent: 10, currency: "cny", topupExpiryDays: null });
		await api.grantCredits({ subjectType: "user", subjectId: "u1", credits: 5000, expiresAt: null });
		expect(seen).toEqual([
			{ method: "GET", path: "/api/admin/redeem-codes" },
			{ method: "POST", path: "/api/admin/redeem-codes", body: { count: 5, credits: 10_000, maxUses: 1, expiresAt: "2026-12-31T00:00:00.000Z" } },
			{ method: "GET", path: "/api/admin/billing/settings" },
			{ method: "PUT", path: "/api/admin/billing/settings", body: { topupCreditsPerCent: 10, currency: "cny", topupExpiryDays: null } },
			{ method: "POST", path: "/api/admin/credits", body: { subjectType: "user", subjectId: "u1", credits: 5000, expiresAt: null } },
		]);
	});
});

describe("both transports carry the billing methods", () => {
	it("member mode relays through team / hub.request and keeps the plaintext codes", async () => {
		const call = vi.fn(async () => ({ ok: true, data: { codes: ["AAAA-BBBB"], credits: 100, maxUses: 1, expiresAt: null } }));
		const api = createMemberApi(call);
		await expect(api.generateRedeemCodes({ count: 1, credits: 100 })).resolves.toMatchObject({ codes: ["AAAA-BBBB"] });
		await api.getBillingSummary("o1");
		expect(call.mock.calls).toEqual([
			["team", "hub.request", { method: "POST", path: "/api/admin/redeem-codes", body: { count: 1, credits: 100 } }],
			["team", "hub.request", { method: "GET", path: "/api/billing/summary?orgId=o1" }],
		]);
	});

	it("member mode surfaces billingDisabled as a TeamApiError the detector recognizes", async () => {
		const api = createMemberApi(async () => ({ ok: false, error: { code: "billingDisabled", message: "off" } }));
		const err = await api.getBillingSummary().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TeamApiError);
		expect(isBillingDisabled(err)).toBe(true);
	});

	it("hub mode sends the same paths with the bearer token and maps a 404 billingDisabled", async () => {
		const data = new Map<string, string>([[ACCESS_KEY, "tok"]]);
		const store: KeyValueStore = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
		const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
			String(url).includes("/api/billing/")
				? new Response(JSON.stringify({ ok: false, error: { code: "billingDisabled", message: "off" } }), { status: 404 })
				: new Response(JSON.stringify({ ok: true, data: { allowed: true } }), { status: 200 }),
		);
		const api = createHubApi({ fetch: fetchMock as unknown as typeof fetch, session: store, local: store });
		await expect(api.getMyByok()).resolves.toEqual({ allowed: true });
		const err = await api.getBillingSummary().catch((e: unknown) => e);
		expect(isBillingDisabled(err)).toBe(true);
		expect(await probeBilling(() => api.getBillingSummary())).toBe("disabled");
		const first = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(first[0]).toBe("/plugins/team/api/me/byok");
		expect((first[1].headers as Record<string, string>).authorization).toBe("Bearer tok");
	});
});

describe("billingDisabled detection", () => {
	it("recognizes only the billingDisabled code", () => {
		expect(isBillingDisabled(new TeamApiError(404, "billingDisabled", "off"))).toBe(true);
		expect(isBillingDisabled(new TeamApiError(404, "notFound", "x"))).toBe(false);
		expect(isBillingDisabled(new Error("billingDisabled"))).toBe(false);
		expect(isBillingDisabled(undefined)).toBe(false);
	});

	it("probe hides billing only on a definitive billingDisabled", async () => {
		expect(await probeBilling(async () => ({}))).toBe("enabled");
		expect(await probeBilling(async () => Promise.reject(new TeamApiError(404, "billingDisabled", "off")))).toBe("disabled");
		expect(await probeBilling(async () => Promise.reject(new TeamApiError(0, "network", "down")))).toBe("enabled");
		expect(await probeBilling(async () => Promise.reject(new TeamApiError(403, "forbidden", "no")))).toBe("enabled");
	});
});

describe("credits and price formatting", () => {
	it("formats credits", () => {
		expect(formatCredits(1234567)).toBe("1,234,567");
		expect(formatCredits(12.6)).toBe("13");
		expect(formatCredits(Number.NaN)).toBe("0");
		expect(formatCreditsShort(500)).toBe("500");
		expect(formatCreditsShort(10_000)).toBe("10K");
		expect(formatCreditsShort(1_500_000)).toBe("1.5M");
		expect(formatCreditsShort(Number.POSITIVE_INFINITY)).toBe("0");
	});

	it("formats money and model prices", () => {
		expect(formatMoney(1999, "cny")).toBe("CNY 19.99");
		expect(formatMoney(0, "usd")).toBe("USD 0.00");
		expect(formatPrice(1.5)).toBe("1.5");
		expect(formatPrice(6)).toBe("6");
		expect(formatPrice(0)).toBe("0");
		expect(formatPrice(0.12345)).toBe("0.1235");
	});

	it("parses price, credit and money inputs", () => {
		expect(parsePriceInput("1.25")).toBe(1.25);
		expect(parsePriceInput(" 0 ")).toBe(0);
		expect(parsePriceInput("-1")).toBeUndefined();
		expect(parsePriceInput("1e3")).toBeUndefined();
		expect(parsePriceInput("")).toBeUndefined();
		expect(parseCreditsInput("50,000", 1000, 100_000_000)).toBe(50_000);
		expect(parseCreditsInput("999", 1000)).toBeUndefined();
		expect(parseCreditsInput("1.5")).toBeUndefined();
		expect(parseCentsInput("19.9")).toBe(1990);
		expect(parseCentsInput("0")).toBe(0);
		expect(parseCentsInput("1.234")).toBeUndefined();
		expect(centsToInput(1990)).toBe("19.90");
	});

	it("converts datetime-local text and tones", () => {
		expect(localInputToIso("")).toBeNull();
		expect(localInputToIso("not a date")).toBeNull();
		expect(localInputToIso("2026-12-31T00:00")).toMatch(/^2026-12-3[01]T/);
		expect(orderStatusTone("paid")).toBe("moss");
		expect(orderStatusTone("pending")).toBe("ember");
		expect(orderStatusTone("canceled")).toBe("muted");
	});

	it("limits mark paid and refunded to manual orders in the right state", () => {
		expect(manualOrderActions({ provider: "manual", status: "pending" })).toEqual({ markPaid: true, markRefunded: false });
		expect(manualOrderActions({ provider: "manual", status: "paid" })).toEqual({ markPaid: false, markRefunded: true });
		expect(manualOrderActions({ provider: "stripe", status: "pending" })).toEqual({ markPaid: false, markRefunded: false });
		expect(manualOrderActions({ provider: "manual", status: "refunded" })).toEqual({ markPaid: false, markRefunded: false });
	});

	it("accepts only http(s) checkout redirects and formats code lists", () => {
		expect(checkoutRedirect("https://pay.example.com/s/1")).toBe("https://pay.example.com/s/1");
		expect(checkoutRedirect("javascript:alert(1)")).toBeUndefined();
		expect(checkoutRedirect(null)).toBeUndefined();
		expect(codesToText(["A", "B"])).toBe("A\nB\n");
		expect(percentOf(25, 100)).toBe(25);
		expect(percentOf(500, 100)).toBe(100);
		expect(percentOf(1, 0)).toBe(0);
	});
});
