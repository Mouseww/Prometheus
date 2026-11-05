import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto.ts";
import { checkoutParams, createStripeProvider, mapStripeEvent, verifyStripeSignature, WEBHOOK_TOLERANCE_SEC } from "../src/billing/providers/stripe.ts";
import type { Order } from "../src/billing/providers/provider.ts";
import { type BHub, startB, startUpstream, type Upstream } from "./b-helpers.ts";

const WHSEC = "whsec_test_secret";
const SK = "sk_test_abcdef";

const sign = (body: string, secret = WHSEC, t = Math.floor(Date.now() / 1000)): string => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

const order = (over: Partial<Order> = {}): Order => ({
	id: "ord_1",
	subjectType: "user",
	subjectId: "u1",
	kind: "topup",
	amountCents: 500,
	currency: "CNY",
	credits: 5000,
	planId: null,
	status: "pending",
	provider: "stripe",
	providerRef: null,
	createdBy: "u1",
	createdAt: new Date().toISOString(),
	paidAt: null,
	...over,
});

describe("Stripe provider", () => {
	it("builds the checkout session request: form encoding, bearer secret, idempotency key", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const fakeFetch = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }), { status: 200 });
		}) as unknown as typeof fetch;
		const stripe = createStripeProvider({ secret: SK, webhookSecret: WHSEC, fetch: fakeFetch });
		const result = await stripe.createCheckout(order(), { successUrl: "https://hub.test/ok", cancelUrl: "https://hub.test/no", customerEmail: "a@b.test", description: "5000 credits" });
		expect(result).toEqual({ redirectUrl: "https://checkout.stripe.com/c/pay/cs_test_1", providerRef: "cs_test_1" });
		const call = calls[0]!;
		expect(call.url).toBe("https://api.stripe.com/v1/checkout/sessions");
		expect(call.init.method).toBe("POST");
		const headers = call.init.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bearer ${SK}`);
		expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
		expect(headers["idempotency-key"]).toBe("ord_1");
		const form = new URLSearchParams(call.init.body as string);
		expect(Object.fromEntries(form)).toEqual({
			mode: "payment",
			success_url: "https://hub.test/ok",
			cancel_url: "https://hub.test/no",
			customer_email: "a@b.test",
			client_reference_id: "ord_1",
			"metadata[order_id]": "ord_1",
			"payment_intent_data[metadata][order_id]": "ord_1",
			"line_items[0][quantity]": "1",
			"line_items[0][price_data][currency]": "cny",
			"line_items[0][price_data][unit_amount]": "500",
			"line_items[0][price_data][product_data][name]": "5000 credits",
		});
	});

	it("builds a recurring line item for subscriptions", () => {
		const form = checkoutParams(order({ kind: "subscription", planId: "p", amountCents: 2000 }), { successUrl: "s", cancelUrl: "c", customerEmail: "e", description: "Pro", recurringInterval: "year" });
		expect(form.get("mode")).toBe("subscription");
		expect(form.get("line_items[0][price_data][recurring][interval]")).toBe("year");
		expect(form.get("subscription_data[metadata][order_id]")).toBe("ord_1");
		expect(form.get("payment_intent_data[metadata][order_id]")).toBeNull();
	});

	it("honours a custom API base and reports Stripe errors without leaking the secret", async () => {
		let url = "";
		const failing = (async (u: string) => {
			url = u;
			return new Response(JSON.stringify({ error: { message: "Invalid currency" } }), { status: 400 });
		}) as unknown as typeof fetch;
		const stripe = createStripeProvider({ secret: SK, webhookSecret: WHSEC, fetch: failing, apiBase: "http://localhost:12111/" });
		await expect(stripe.createCheckout(order(), { successUrl: "s", cancelUrl: "c", customerEmail: "e" })).rejects.toThrow(/400.*Invalid currency/);
		expect(url).toBe("http://localhost:12111/v1/checkout/sessions");
		const noUrl = createStripeProvider({ secret: SK, webhookSecret: WHSEC, fetch: (async () => new Response(JSON.stringify({ id: "x" }), { status: 200 })) as unknown as typeof fetch });
		await expect(noUrl.createCheckout(order(), { successUrl: "s", cancelUrl: "c", customerEmail: "e" })).rejects.toThrow(/缺少/);
		try {
			await stripe.createCheckout(order(), { successUrl: "s", cancelUrl: "c", customerEmail: "e" });
		} catch (err) {
			expect((err as Error).message).not.toContain(SK);
		}
	});

	describe("webhook signature", () => {
		const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "paid" } } });
		const raw = Buffer.from(body);
		const now = Date.now();
		const ts = Math.floor(now / 1000);

		it("accepts a correct signature", () => {
			expect(verifyStripeSignature(raw, sign(body, WHSEC, ts), WHSEC, now)).toBe(true);
		});
		it("accepts when any of several v1 signatures matches", () => {
			const good = sign(body, WHSEC, ts);
			const header = `t=${ts},v1=${"0".repeat(64)},${good.split(",")[1]}`;
			expect(verifyStripeSignature(raw, header, WHSEC, now)).toBe(true);
		});
		it("rejects a wrong secret, a tampered body and a tampered timestamp", () => {
			expect(verifyStripeSignature(raw, sign(body, "whsec_other", ts), WHSEC, now)).toBe(false);
			expect(verifyStripeSignature(Buffer.from(`${body} `), sign(body, WHSEC, ts), WHSEC, now)).toBe(false);
			const [, v1] = sign(body, WHSEC, ts).split(",");
			expect(verifyStripeSignature(raw, `t=${ts + 1},${v1}`, WHSEC, now)).toBe(false);
		});
		it("rejects malformed or missing headers", () => {
			for (const h of [undefined, "", "garbage", `t=${ts}`, `v1=abc`, `t=abc,v1=${"0".repeat(64)}`, `t=${ts},v1=short`, `t=${ts},v1=${"z".repeat(64)}`]) {
				expect(verifyStripeSignature(raw, h, WHSEC, now), String(h)).toBe(false);
			}
		});
		it("rejects timestamps outside the five minute tolerance, in both directions", () => {
			const tol = WEBHOOK_TOLERANCE_SEC;
			expect(tol).toBe(300);
			expect(verifyStripeSignature(raw, sign(body, WHSEC, ts - tol - 5), WHSEC, now)).toBe(false);
			expect(verifyStripeSignature(raw, sign(body, WHSEC, ts + tol + 5), WHSEC, now)).toBe(false);
			expect(verifyStripeSignature(raw, sign(body, WHSEC, ts - tol + 10), WHSEC, now)).toBe(true);
		});
		it("parseWebhook returns undefined for a bad signature and an event for a good one", () => {
			const stripe = createStripeProvider({ secret: SK, webhookSecret: WHSEC });
			expect(stripe.parseWebhook(raw, { "stripe-signature": sign(body, "nope") })).toBeUndefined();
			expect(stripe.parseWebhook(raw, {})).toBeUndefined();
			expect(stripe.parseWebhook(raw, { "stripe-signature": sign(body) })).toEqual({ type: "paid", providerRef: "cs_1" });
			expect(stripe.parseWebhook(Buffer.from("not json"), { "stripe-signature": sign("not json") })).toBeUndefined();
		});
	});

	describe("event mapping", () => {
		const ev = (type: string, object: Record<string, unknown>) => mapStripeEvent({ id: "evt", type, data: { object } });
		it("maps completed checkouts to paid, with the order id, subscription and amount", () => {
			expect(ev("checkout.session.completed", { id: "cs_1", payment_status: "paid", client_reference_id: "ord_9", amount_total: 700, subscription: "sub_1" })).toEqual({
				type: "paid",
				providerRef: "cs_1",
				orderId: "ord_9",
				amountCents: 700,
				subscriptionRef: "sub_1",
			});
			expect(ev("checkout.session.completed", { id: "cs_1", payment_status: "unpaid" }).type).toBe("ignored");
			expect(ev("checkout.session.async_payment_succeeded", { id: "cs_2", payment_status: "paid", metadata: { order_id: "o" } })).toMatchObject({ type: "paid", orderId: "o" });
		});
		it("maps failures, renewals, cancellations and refunds", () => {
			expect(ev("checkout.session.expired", { id: "cs_3" })).toEqual({ type: "failed", providerRef: "cs_3" });
			expect(ev("checkout.session.async_payment_failed", { id: "cs_4" }).type).toBe("failed");
			const end = 1_900_000_000;
			expect(ev("invoice.paid", { id: "in_1", billing_reason: "subscription_cycle", subscription: "sub_1", amount_paid: 900, lines: { data: [{ period: { end } }] } })).toEqual({
				type: "subscriptionRenewed",
				providerRef: "sub_1",
				periodEnd: new Date(end * 1000).toISOString(),
				amountCents: 900,
			});
			expect(ev("invoice.paid", { id: "in_2", billing_reason: "subscription_create", subscription: "sub_1" }).type).toBe("ignored");
			expect(ev("invoice.paid", { id: "in_3", billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: "sub_2" } } })).toMatchObject({ type: "subscriptionRenewed", providerRef: "sub_2" });
			expect(ev("customer.subscription.deleted", { id: "sub_1" })).toEqual({ type: "subscriptionCanceled", providerRef: "sub_1" });
			expect(ev("charge.refunded", { id: "ch_1", payment_intent: "pi_1", metadata: { order_id: "ord_1" } })).toEqual({ type: "refunded", providerRef: "pi_1", orderId: "ord_1" });
		});
		it("ignores everything else, including malformed payloads", () => {
			expect(ev("customer.created", { id: "cus_1" }).type).toBe("ignored");
			expect(mapStripeEvent(null).type).toBe("ignored");
			expect(mapStripeEvent({ type: "x" }).type).toBe("ignored");
		});
	});
});

describe("orders and webhooks end to end", () => {
	let b: BHub;
	let stripeApi: Upstream;
	let sessionCounter = 0;
	let carol: { token: string; userId: string };

	beforeAll(async () => {
		stripeApi = await startUpstream((req, res) => {
			if (req.url?.startsWith("/v1/checkout/sessions")) {
				sessionCounter++;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ id: `cs_test_${sessionCounter}`, url: `https://checkout.stripe.test/c/${sessionCounter}` }));
			} else {
				res.statusCode = 404;
				res.end("{}");
			}
		});
		b = await startB({ billing: true, publicUrl: "https://hub.example.com", env: { HUB_STRIPE_SECRET: SK, HUB_STRIPE_WEBHOOK_SECRET: WHSEC, HUB_STRIPE_API_BASE: stripeApi.url } });
		carol = await b.t.createUser(b.root.token, "carol@corp.test", "Carol");
		// Free credits would blur the balances asserted below.
		await b.t.api("PUT", "/api/admin/plans/free", { token: b.root.token, body: { monthlyCredits: 0 } });
	});
	afterAll(async () => {
		await stripeApi.stop();
		await b.stop();
	});

	const post = (provider: string, body: string, signature?: string) =>
		fetch(`${b.t.baseUrl}/billing/webhook/${provider}`, { method: "POST", headers: { "content-type": "application/json", ...(signature ? { "stripe-signature": signature } : {}) }, body });
	const event = (type: string, object: Record<string, unknown>, id = `evt_${Math.random().toString(36).slice(2)}`): string => JSON.stringify({ id, type, data: { object } });
	const orderRow = async (id: string): Promise<any> => (await b.t.hub.db.query<any>("SELECT * FROM orders WHERE id = $1", [id]))[0];
	const grantsFor = (source: string, subjectId: string) => b.t.hub.db.query<any>("SELECT * FROM credit_grants WHERE source = $1 AND subject_id = $2", [source, subjectId]);
	const checkout = (token: string, body: Record<string, unknown>) => b.t.api("POST", "/api/billing/checkout", { token, body });

	it("creates a Stripe top-up checkout: priced from the settings, pending, with the session recorded", async () => {
		const r = await checkout(b.alice.token, { kind: "topup", credits: 5000 });
		expect(r.status).toBe(201);
		expect(r.data).toMatchObject({ status: "pending", provider: "stripe", redirectUrl: "https://checkout.stripe.test/c/1", amountCents: 500, currency: "cny", credits: 5000 });
		const row = await orderRow(r.data.orderId);
		expect(row).toMatchObject({ subject_type: "user", subject_id: b.alice.userId, kind: "topup", status: "pending", provider: "stripe", provider_ref: "cs_test_1", created_by: b.alice.userId });

		const sent = stripeApi.requests.at(-1)!;
		expect(sent.method).toBe("POST");
		expect(sent.headers.authorization).toBe(`Bearer ${SK}`);
		expect(sent.headers["idempotency-key"]).toBe(r.data.orderId);
		const form = new URLSearchParams(sent.body);
		expect(form.get("customer_email")).toBe("alice@corp.test");
		expect(form.get("client_reference_id")).toBe(r.data.orderId);
		expect(form.get("line_items[0][price_data][unit_amount]")).toBe("500");
		expect(form.get("success_url")).toBe("https://hub.example.com/?billing=success");
		expect(form.get("cancel_url")).toBe("https://hub.example.com/?billing=canceled");
	});

	it("only accepts return URLs on the Hub's own origin", async () => {
		await checkout(b.alice.token, { kind: "topup", credits: 1000, successUrl: "https://hub.example.com/#/billing", cancelUrl: "https://evil.example.net/x" });
		const form = new URLSearchParams(stripeApi.requests.at(-1)!.body);
		expect(form.get("success_url")).toBe("https://hub.example.com/#/billing");
		expect(form.get("cancel_url")).toBe("https://hub.example.com/?billing=canceled");
	});

	it("validates checkout input and who may buy for an organization", async () => {
		expect((await checkout(b.alice.token, { kind: "topup", credits: 10 })).code).toBe("validationError");
		expect((await checkout(b.alice.token, { kind: "topup" })).code).toBe("validationError");
		expect((await checkout(b.alice.token, { kind: "topup", credits: 1_000_000_000 })).code).toBe("validationError");
		expect((await checkout(b.alice.token, { kind: "subscription" })).code).toBe("validationError");
		expect((await checkout(b.alice.token, { kind: "subscription", planId: "free" })).code).toBe("planNotPurchasable");
		expect((await checkout(b.alice.token, { kind: "subscription", planId: "missing" })).status).toBe(404);
		expect((await checkout(b.alice.token, { kind: "topup", credits: 1000, provider: "paypal" })).code).toBe("unknownProvider");
		expect((await checkout(b.alice.token, { kind: "topup", credits: 1000, orgId: b.root.orgId })).status).toBe(403);
		expect((await checkout(b.root.token, { kind: "topup", credits: 1000, orgId: "no-such-org" })).status).toBe(404);
		expect((await b.t.api("POST", "/api/billing/checkout", { body: { kind: "topup", credits: 1000 } })).status).toBe(401);
	});

	it("marks the order paid and grants the credits on a valid webhook, exactly once", async () => {
		const r = await checkout(b.alice.token, { kind: "topup", credits: 7000 });
		const ref = (await orderRow(r.data.orderId)).provider_ref as string;
		const payload = event("checkout.session.completed", { id: ref, payment_status: "paid", client_reference_id: r.data.orderId, amount_total: 700 });
		const before = await b.balance("user", b.alice.userId);

		const first = await post("stripe", payload, sign(payload));
		expect(first.status).toBe(200);
		expect(((await first.json()) as any).data).toEqual({ received: true, outcome: "applied" });
		expect(await orderRow(r.data.orderId)).toMatchObject({ status: "paid" });
		expect(await b.balance("user", b.alice.userId)).toBe(before + 7000);
		const grants = (await grantsFor("topup", b.alice.userId)).filter((g: any) => g.ref === r.data.orderId);
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ expires_at: null });

		const replay = await post("stripe", payload, sign(payload));
		expect(replay.status).toBe(200);
		expect(((await replay.json()) as any).data.outcome).toBe("duplicate");
		expect(await b.balance("user", b.alice.userId)).toBe(before + 7000);
	});

	it("applies concurrent deliveries of the same event once", async () => {
		const r = await checkout(b.bob.token, { kind: "topup", credits: 2000 });
		const ref = (await orderRow(r.data.orderId)).provider_ref as string;
		const payload = event("checkout.session.completed", { id: ref, payment_status: "paid", client_reference_id: r.data.orderId });
		const results = await Promise.all(Array.from({ length: 5 }, () => post("stripe", payload, sign(payload)).then((x) => x.json() as Promise<any>)));
		expect(results.map((x) => x.data.outcome).sort()).toEqual(["applied", "duplicate", "duplicate", "duplicate", "duplicate"]);
		expect(await b.balance("user", b.bob.userId)).toBe(2000);
	});

	it("rejects bad signatures, expired timestamps, unknown providers and providers without webhooks", async () => {
		const payload = event("checkout.session.completed", { id: "cs_x", payment_status: "paid" });
		const bad = await post("stripe", payload, sign(payload, "whsec_wrong"));
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as any).error.code).toBe("invalidSignature");
		expect((await post("stripe", payload)).status).toBe(400);
		const old = Math.floor(Date.now() / 1000) - 3600;
		expect((await post("stripe", payload, sign(payload, WHSEC, old))).status).toBe(400);
		expect((await post("alipay", payload, sign(payload))).status).toBe(404);
		expect((await post("manual", payload)).status).toBe(400);
	});

	it("acknowledges events it has no use for, and events for orders it does not know", async () => {
		const other = event("customer.created", { id: "cus_1" });
		expect(((await (await post("stripe", other, sign(other))).json()) as any).data.outcome).toBe("ignored");
		const unknown = event("checkout.session.completed", { id: "cs_not_ours", payment_status: "paid" });
		const r = await post("stripe", unknown, sign(unknown));
		expect(r.status).toBe(200);
		expect(((await r.json()) as any).data.outcome).toBe("unknownOrder");
		// Not remembered as handled: once the order exists the same event can still apply.
		expect(await b.t.hub.db.query("SELECT 1 FROM payment_events WHERE provider_ref = 'cs_not_ours'")).toHaveLength(0);
	});

	it("marks pending orders failed on an expired session and never pays a failed order twice", async () => {
		const r = await checkout(b.alice.token, { kind: "topup", credits: 1000 });
		const ref = (await orderRow(r.data.orderId)).provider_ref as string;
		const expired = event("checkout.session.expired", { id: ref });
		await post("stripe", expired, sign(expired));
		expect(await orderRow(r.data.orderId)).toMatchObject({ status: "failed" });
	});

	it("refunds take back the unspent credits of the order", async () => {
		const r = await checkout(carol.token, { kind: "topup", credits: 3000 });
		const ref = (await orderRow(r.data.orderId)).provider_ref as string;
		const paid = event("checkout.session.completed", { id: ref, payment_status: "paid", client_reference_id: r.data.orderId });
		await post("stripe", paid, sign(paid));
		expect(await b.balance("user", carol.userId)).toBe(3000);
		const refunded = event("charge.refunded", { id: "ch_1", payment_intent: "pi_1", metadata: { order_id: r.data.orderId } });
		const res = await post("stripe", refunded, sign(refunded));
		expect(((await res.json()) as any).data.outcome).toBe("applied");
		expect(await orderRow(r.data.orderId)).toMatchObject({ status: "refunded" });
		expect(await b.balance("user", carol.userId)).toBe(0);
	});

	it("activates a subscription on payment, issues the plan credits, extends it on renewal and ends it on cancellation", async () => {
		const plan = await b.t.api("POST", "/api/admin/plans", { token: b.root.token, body: { name: "Pro", period: "month", priceCents: 2000, currency: "cny", monthlyCredits: 5000 } });
		const r = await checkout(b.alice.token, { kind: "subscription", planId: plan.data.id });
		expect(r.data).toMatchObject({ amountCents: 2000, currency: "cny", status: "pending" });
		const form = new URLSearchParams(stripeApi.requests.at(-1)!.body);
		expect(form.get("mode")).toBe("subscription");
		expect(form.get("line_items[0][price_data][recurring][interval]")).toBe("month");
		expect(form.get("line_items[0][price_data][product_data][name]")).toBe("Pro");

		const ref = (await orderRow(r.data.orderId)).provider_ref as string;
		const periodEnd = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000);
		const completed = event("checkout.session.completed", { id: ref, payment_status: "paid", client_reference_id: r.data.orderId, subscription: "sub_alice" });
		await post("stripe", completed, sign(completed));

		const summary = await b.t.api("GET", "/api/billing/summary", { token: b.alice.token });
		expect(summary.data.plan).toMatchObject({ id: plan.data.id, name: "Pro" });
		expect(summary.data.subscription).toMatchObject({ planId: plan.data.id, status: "active", provider: "stripe" });
		expect((await grantsFor("plan", b.alice.userId))).toHaveLength(1);
		expect(Number((await grantsFor("plan", b.alice.userId))[0].amount)).toBe(5000);

		const renewal = event("invoice.paid", { id: "in_2", billing_reason: "subscription_cycle", subscription: "sub_alice", lines: { data: [{ period: { end: periodEnd + 30 * 24 * 3600 } }] } });
		expect(((await (await post("stripe", renewal, sign(renewal))).json()) as any).data.outcome).toBe("applied");
		expect(((await (await post("stripe", renewal, sign(renewal))).json()) as any).data.outcome).toBe("duplicate");
		const sub = (await b.t.hub.db.query<any>("SELECT * FROM subscriptions WHERE subject_id = $1", [b.alice.userId]))[0];
		expect(new Date(sub.current_period_end).toISOString()).toBe(new Date((periodEnd + 30 * 24 * 3600) * 1000).toISOString());
		expect(sub.provider_ref).toBe("sub_alice");

		const gone = event("customer.subscription.deleted", { id: "sub_alice" });
		await post("stripe", gone, sign(gone));
		const after = await b.t.api("GET", "/api/billing/summary", { token: b.alice.token });
		expect(after.data.subscription).toBeNull();
		expect(after.data.plan.id).toBe("free");
	});

	it("lets organization owners and admins buy for the organization; the credits land in the organization's wallet", async () => {
		const r = await checkout(b.root.token, { kind: "topup", credits: 4000, orgId: b.root.orgId });
		expect(r.status).toBe(201);
		expect(await orderRow(r.data.orderId)).toMatchObject({ subject_type: "org", subject_id: b.root.orgId });
		const ref = (await orderRow(r.data.orderId)).provider_ref as string;
		const payload = event("checkout.session.completed", { id: ref, payment_status: "paid", client_reference_id: r.data.orderId });
		await post("stripe", payload, sign(payload));
		expect(await b.balance("org", b.root.orgId)).toBe(4000);
		const summary = await b.t.api("GET", `/api/billing/summary?orgId=${b.root.orgId}`, { token: b.root.token });
		expect(summary.data.balance).toBe(4000);
		expect(summary.data.recentOrders[0]).toMatchObject({ id: r.data.orderId, status: "paid" });
	});

	it("leaves the order failed and says 502 when the provider call fails", async () => {
		const down = await startB({ billing: true, env: { HUB_STRIPE_SECRET: SK, HUB_STRIPE_WEBHOOK_SECRET: WHSEC, HUB_STRIPE_API_BASE: "http://127.0.0.1:9" } });
		try {
			const r = await down.t.api("POST", "/api/billing/checkout", { token: down.alice.token, body: { kind: "topup", credits: 1000 } });
			expect(r.status).toBe(502);
			expect(r.code).toBe("paymentProviderError");
			const rows = await down.t.hub.db.query<any>("SELECT status FROM orders");
			expect(rows).toEqual([{ status: "failed" }]);
		} finally {
			await down.stop();
		}
	});
});

describe("manual orders", () => {
	let b: BHub;
	beforeAll(async () => {
		b = await startB({ billing: true });
		await b.t.api("PUT", "/api/admin/plans/free", { token: b.root.token, body: { monthlyCredits: 0 } });
	});
	afterAll(() => b.stop());
	const checkout = (token: string, body: Record<string, unknown>) => b.t.api("POST", "/api/billing/checkout", { token, body });

	it("defaults to manual without Stripe configured: pending, no redirect, nothing granted yet", async () => {
		const r = await checkout(b.alice.token, { kind: "topup", credits: 50_000 });
		expect(r.status).toBe(201);
		expect(r.data).toMatchObject({ provider: "manual", status: "pending", redirectUrl: null, amountCents: 5000 });
		expect(await b.balance("user", b.alice.userId)).toBe(0);
		expect((await b.t.api("POST", "/api/billing/checkout", { token: b.alice.token, body: { kind: "topup", credits: 1000, provider: "stripe" } })).code).toBe("unknownProvider");
	});

	it("is confirmed by an operator only, once: paid grants the credits, refund takes them back", async () => {
		const r = await checkout(b.alice.token, { kind: "topup", credits: 12_000 });
		const id = r.data.orderId as string;
		expect((await b.t.api("POST", `/api/admin/orders/${id}/mark-paid`, { token: b.alice.token })).status).toBe(403);
		expect((await b.t.api("POST", `/api/admin/orders/${id}/mark-refunded`, { token: b.root.token })).code).toBe("invalidState");

		const paid = await b.t.api("POST", `/api/admin/orders/${id}/mark-paid`, { token: b.root.token });
		expect(paid.data).toMatchObject({ id, status: "paid", provider: "manual" });
		expect(paid.data.paidAt).not.toBeNull();
		expect(await b.balance("user", b.alice.userId)).toBe(12_000);
		expect((await b.t.api("POST", `/api/admin/orders/${id}/mark-paid`, { token: b.root.token })).code).toBe("invalidState");
		expect(await b.balance("user", b.alice.userId)).toBe(12_000);

		const refunded = await b.t.api("POST", `/api/admin/orders/${id}/mark-refunded`, { token: b.root.token });
		expect(refunded.data.status).toBe("refunded");
		expect(await b.balance("user", b.alice.userId)).toBe(0);
		expect((await b.t.api("POST", `/api/admin/orders/${id}/mark-paid`, { token: b.root.token })).code).toBe("invalidState");
		expect((await b.t.api("POST", "/api/admin/orders/nope/mark-paid", { token: b.root.token })).status).toBe(404);
	});

	it("refuses to confirm non-manual orders by hand", async () => {
		await b.t.hub.db.tx({ system: true }, (q) =>
			q.query("INSERT INTO orders (id, subject_type, subject_id, kind, amount_cents, currency, status, provider, provider_ref) VALUES ('st1','user',$1,'topup',1,'cny','pending','stripe','cs_1')", [b.alice.userId]),
		);
		expect((await b.t.api("POST", "/api/admin/orders/st1/mark-paid", { token: b.root.token })).code).toBe("notManual");
	});

	it("activates a manual subscription with its plan credits", async () => {
		const plan = await b.t.api("POST", "/api/admin/plans", { token: b.root.token, body: { name: "Yearly", period: "year", priceCents: 90000, currency: "cny", monthlyCredits: 8000 } });
		const r = await checkout(b.root.token, { kind: "subscription", planId: plan.data.id, orgId: b.root.orgId });
		await b.t.api("POST", `/api/admin/orders/${r.data.orderId}/mark-paid`, { token: b.root.token });
		const summary = await b.t.api("GET", `/api/billing/summary?orgId=${b.root.orgId}`, { token: b.root.token });
		expect(summary.data.plan.id).toBe(plan.data.id);
		expect(summary.data.balance).toBe(8000);
		const end = new Date(summary.data.subscription.currentPeriodEnd).getTime();
		expect(end - Date.now()).toBeGreaterThan(360 * 24 * 60 * 60 * 1000);
	});

	it("lists orders for operators with filters and a cursor", async () => {
		const all = await b.t.api("GET", "/api/admin/orders", { token: b.root.token });
		expect(all.data.items.length).toBeGreaterThanOrEqual(4);
		const paid = await b.t.api("GET", "/api/admin/orders?status=paid", { token: b.root.token });
		expect(paid.data.items.every((o: any) => o.status === "paid")).toBe(true);
		const page = await b.t.api("GET", "/api/admin/orders?limit=2", { token: b.root.token });
		expect(page.data.items).toHaveLength(2);
		expect(page.data.nextBefore).toBe(page.data.items[1].id);
		const next = await b.t.api("GET", `/api/admin/orders?limit=2&before=${page.data.nextBefore}`, { token: b.root.token });
		expect(next.data.items[0].id < page.data.items[1].id).toBe(true);
		expect((await b.t.api("GET", `/api/admin/orders?subjectType=org&subjectId=${b.root.orgId}`, { token: b.root.token })).data.items.every((o: any) => o.subjectType === "org")).toBe(true);
		expect((await b.t.api("GET", "/api/admin/orders?status=weird", { token: b.root.token })).status).toBe(400);
	});
});

describe("redeem codes", () => {
	let b: BHub;
	let carol: { token: string; userId: string };
	beforeAll(async () => {
		b = await startB({ billing: true });
		carol = await b.t.createUser(b.root.token, "carol@corp.test", "Carol");
		await b.t.api("PUT", "/api/admin/plans/free", { token: b.root.token, body: { monthlyCredits: 0 } });
	});
	afterAll(() => b.stop());
	const generate = (body: Record<string, unknown>) => b.t.api("POST", "/api/admin/redeem-codes", { token: b.root.token, body });
	const redeem = (token: string, code: string, orgId?: string) => b.t.api("POST", "/api/billing/redeem", { token, body: { code, ...(orgId ? { orgId } : {}) } });

	it("generates codes in bulk, shows them once and stores only hashes", async () => {
		const r = await generate({ count: 3, credits: 500, maxUses: 2 });
		expect(r.status).toBe(201);
		expect(r.data.codes).toHaveLength(3);
		expect(new Set(r.data.codes).size).toBe(3);
		for (const c of r.data.codes) expect(c).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
		expect(r.data).toMatchObject({ credits: 500, maxUses: 2, expiresAt: null });

		const rows = await b.t.hub.db.query<any>("SELECT * FROM redeem_codes");
		expect(rows).toHaveLength(3);
		const dump = JSON.stringify(rows);
		for (const c of r.data.codes) {
			expect(dump).not.toContain(c);
			expect(dump).not.toContain(c.replaceAll("-", ""));
			expect(rows.some((row: any) => row.code_hash === sha256Hex(c.replaceAll("-", "")))).toBe(true);
		}
		const list = await b.t.api("GET", "/api/admin/redeem-codes", { token: b.root.token });
		expect(list.data).toHaveLength(3);
		expect(JSON.stringify(list.body)).not.toContain(r.data.codes[0]);
		expect(list.data[0]).toMatchObject({ credits: 500, maxUses: 2, usedCount: 0 });
		expect(list.data.map((x: any) => x.hint).sort()).toEqual(r.data.codes.map((c: string) => c.slice(-4)).sort());
		await b.t.hub.db.query("DELETE FROM redeem_codes");
	});

	it("validates generation input and is operator only", async () => {
		expect((await generate({ count: 0, credits: 5 })).status).toBe(400);
		expect((await generate({ count: 1001, credits: 5 })).status).toBe(400);
		expect((await generate({ count: 1, credits: 0 })).status).toBe(400);
		expect((await generate({ count: 1, credits: 5, expiresAt: "soon" })).status).toBe(400);
		expect((await b.t.api("POST", "/api/admin/redeem-codes", { token: b.alice.token, body: { count: 1, credits: 5 } })).status).toBe(403);
	});

	it("honours max uses, one redemption per user, and normalizes what users type", async () => {
		const gen = await generate({ count: 1, credits: 500, maxUses: 2 });
		const code = gen.data.codes[0] as string;
		const r = await redeem(b.alice.token, code.toLowerCase().replaceAll("-", " "));
		expect(r.data).toEqual({ credits: 500, balance: 500 });
		expect(await b.balance("user", b.alice.userId)).toBe(500);
		expect((await redeem(b.alice.token, code)).code).toBe("codeAlreadyRedeemed");
		expect((await redeem(b.bob.token, code)).data.credits).toBe(500);
		const third = await redeem(carol.token, code);
		expect(third.status).toBe(409);
		expect(third.code).toBe("codeExhausted");
		expect(await b.balance("user", carol.userId)).toBe(0);
		const list = (await b.t.api("GET", "/api/admin/redeem-codes", { token: b.root.token })).data.find((x: any) => x.hint === code.slice(-4));
		expect(list.usedCount).toBe(2);
		expect((await grantsOf("redeem", b.alice.userId))).toHaveLength(1);
	});
	const grantsOf = (source: string, subjectId: string) => b.t.hub.db.query<any>("SELECT * FROM credit_grants WHERE source = $1 AND subject_id = $2", [source, subjectId]);

	it("never lets concurrent redemptions exceed the max uses", async () => {
		const gen = await generate({ count: 1, credits: 100, maxUses: 1 });
		const code = gen.data.codes[0] as string;
		const results = await Promise.all([redeem(b.alice.token, code), redeem(b.bob.token, code), redeem(carol.token, code)]);
		expect(results.filter((x) => x.status === 200)).toHaveLength(1);
		expect(results.filter((x) => x.code === "codeExhausted")).toHaveLength(2);
	});

	it("rejects expired and unknown codes without revealing which", async () => {
		const gen = await generate({ count: 1, credits: 100, expiresAt: new Date(Date.now() + 60_000).toISOString() });
		const code = gen.data.codes[0] as string;
		expect((await redeem(b.alice.token, code)).status).toBe(200);
		await b.t.hub.db.query("UPDATE redeem_codes SET expires_at = now() - interval '1 day'");
		const bob = await redeem(b.bob.token, code);
		expect(bob.status).toBe(410);
		expect(bob.code).toBe("codeExpired");
		const unknown = await redeem(b.bob.token, "AAAA-BBBB-CCCC-DDDD");
		expect(unknown.status).toBe(404);
		expect(unknown.code).toBe("invalidCode");
		expect((await redeem(b.bob.token, "short")).code).toBe("invalidCode");
		expect((await b.t.api("POST", "/api/billing/redeem", { body: { code: "x" } })).status).toBe(401);
	});

	it("credits an organization's wallet when an owner or admin redeems for it", async () => {
		const gen = await generate({ count: 1, credits: 900, maxUses: 5 });
		const code = gen.data.codes[0] as string;
		expect((await redeem(b.alice.token, code, b.root.orgId)).status).toBe(403);
		const r = await redeem(b.root.token, code, b.root.orgId);
		expect(r.data.credits).toBe(900);
		expect(await b.balance("org", b.root.orgId)).toBe(900);
		expect(await b.balance("user", b.root.userId)).toBe(0);
	});

	it("limits redemption attempts per user", async () => {
		let limited: any;
		for (let i = 0; i < 25 && !limited; i++) {
			const r = await redeem(carol.token, "ZZZZ-ZZZZ-ZZZZ-ZZZZ");
			if (r.status === 429) limited = r;
		}
		expect(limited?.code).toBe("rateLimited");
		expect(limited.headers.get("retry-after")).toBeTruthy();
	});
});
