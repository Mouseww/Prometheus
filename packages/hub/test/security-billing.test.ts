import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapStripeEvent } from "../src/billing/providers/stripe.ts";
import { paymentMismatch } from "../src/billing/orders.ts";
import { CHECKOUT_PER_WINDOW } from "../src/routes/billing.ts";
import { type BHub, startB, startUpstream, type Upstream } from "./b-helpers.ts";

const WHSEC = "whsec_test_secret";
const SK = "sk_test_abcdef";
const sign = (body: string): string => {
	const t = Math.floor(Date.now() / 1000);
	return `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${body}`).digest("hex")}`;
};

describe("amount and currency comparison", () => {
	it("compares only what the provider sent", () => {
		const order = { amount_cents: "700", currency: "cny" };
		expect(paymentMismatch(order, {})).toBeUndefined();
		expect(paymentMismatch(order, { amountCents: 700, currency: "CNY" })).toBeUndefined();
		expect(paymentMismatch(order, { amountCents: 1 })).toMatch(/金额不符/);
		expect(paymentMismatch(order, { amountCents: 700, currency: "usd" })).toMatch(/币种不符/);
	});

	it("maps currency and refund amounts from Stripe events", () => {
		const paid = mapStripeEvent({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "paid", amount_total: 700, currency: "CNY" } } });
		expect(paid).toMatchObject({ type: "paid", amountCents: 700, currency: "cny" });
		const refunded = mapStripeEvent({ type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: "pi_1", amount: 700, amount_refunded: 200, currency: "cny" } } });
		expect(refunded).toMatchObject({ type: "refunded", amountCents: 700, amountRefundedCents: 200, currency: "cny" });
	});
});

describe("billing webhooks and checkout abuse", () => {
	let b: BHub;
	let stripeApi: Upstream;
	let n = 0;
	let carol: { token: string; userId: string };
	let dave: { token: string; userId: string };
	beforeAll(async () => {
		stripeApi = await startUpstream((req, res) => {
			n++;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ id: `cs_sec_${n}`, url: `https://checkout.stripe.test/c/${n}` }));
		});
		b = await startB({ billing: true, publicUrl: "https://hub.example.com", env: { HUB_STRIPE_SECRET: SK, HUB_STRIPE_WEBHOOK_SECRET: WHSEC, HUB_STRIPE_API_BASE: stripeApi.url } });
		await b.t.api("PUT", "/api/admin/plans/free", { token: b.root.token, body: { monthlyCredits: 0 } });
		carol = await b.t.createUser(b.root.token, "carol@corp.test", "Carol");
		dave = await b.t.createUser(b.root.token, "dave@corp.test", "Dave");
	});
	afterAll(async () => {
		await stripeApi.stop();
		await b.stop();
	});

	const post = async (body: string): Promise<{ status: number; outcome: string | undefined }> => {
		const res = await fetch(`${b.t.baseUrl}/billing/webhook/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sign(body) }, body });
		return { status: res.status, outcome: ((await res.json()) as any).data?.outcome };
	};
	const event = (type: string, object: Record<string, unknown>): string => JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } });
	const orderRow = async (id: string): Promise<any> => (await b.t.hub.db.query<any>("SELECT * FROM orders WHERE id = $1", [id]))[0];
	const buy = async (who: { token: string }, credits: number): Promise<{ orderId: string; ref: string }> => {
		const r = await b.t.api("POST", "/api/billing/checkout", { token: who.token, body: { kind: "topup", credits } });
		return { orderId: r.data.orderId, ref: (await orderRow(r.data.orderId)).provider_ref };
	};
	const paidEvent = (o: { orderId: string; ref: string }, extra: Record<string, unknown>): string =>
		event("checkout.session.completed", { id: o.ref, payment_status: "paid", client_reference_id: o.orderId, ...extra });

	it("refuses a paid event whose amount or currency differs and still accepts the corrected one", async () => {
		const o = await buy(b.alice, 5000);
		const before = await b.balance("user", b.alice.userId);
		expect(await post(paidEvent(o, { amount_total: 1, currency: "cny" }))).toEqual({ status: 200, outcome: "mismatch" });
		expect(await post(paidEvent(o, { amount_total: 500, currency: "usd" }))).toEqual({ status: 200, outcome: "mismatch" });
		expect(await orderRow(o.orderId)).toMatchObject({ status: "pending" });
		expect(await b.balance("user", b.alice.userId)).toBe(before);
		const audit = await b.t.hub.db.query("SELECT 1 FROM audit_log WHERE action = 'billing.order.mismatch' AND target_id = $1", [o.orderId]);
		expect(audit.length).toBe(2);

		expect(await post(paidEvent(o, { amount_total: 500, currency: "CNY" }))).toEqual({ status: 200, outcome: "applied" });
		expect(await orderRow(o.orderId)).toMatchObject({ status: "paid" });
		expect(await b.balance("user", b.alice.userId)).toBe(before + 5000);
	});

	it("a partial refund takes back a proportional share and a later full refund the rest", async () => {
		const o = await buy(b.bob, 10_000);
		await post(paidEvent(o, { amount_total: 1000, currency: "cny" }));
		expect(await b.balance("user", b.bob.userId)).toBe(10_000);

		const refund = (refunded: number) => post(event("charge.refunded", { id: "ch_p", payment_intent: o.ref, metadata: { order_id: o.orderId }, amount: 1000, amount_refunded: refunded, currency: "cny" }));
		expect((await refund(250)).outcome).toBe("applied");
		expect(await b.balance("user", b.bob.userId)).toBe(7_500);
		expect(await orderRow(o.orderId)).toMatchObject({ status: "paid" });
		expect((await refund(250)).outcome).toBe("duplicate");
		expect(await b.balance("user", b.bob.userId)).toBe(7_500);

		expect((await refund(1000)).outcome).toBe("applied");
		expect(await b.balance("user", b.bob.userId)).toBe(0);
		expect(await orderRow(o.orderId)).toMatchObject({ status: "refunded" });
	});

	it("never takes back more than is left: spent credits stay spent", async () => {
		const o = await buy(carol, 4000);
		await post(paidEvent(o, { amount_total: 400, currency: "cny" }));
		await b.t.hub.db.query("UPDATE credit_grants SET remaining = 500 WHERE ref = $1", [o.orderId]);
		await post(event("charge.refunded", { id: "ch_c", payment_intent: o.ref, metadata: { order_id: o.orderId }, amount: 400, amount_refunded: 200, currency: "cny" }));
		// Half of 4000 is 2000, but only 500 remain.
		expect(await b.balance("user", carol.userId)).toBe(0);
	});

	it("rate-limits checkout per user", async () => {
		const who = dave;
		const statuses: number[] = [];
		for (let i = 0; i < CHECKOUT_PER_WINDOW + 2; i++) statuses.push((await b.t.api("POST", "/api/billing/checkout", { token: who.token, body: { kind: "topup", credits: 1000 } })).status);
		expect(statuses.slice(0, CHECKOUT_PER_WINDOW).every((s) => s === 201)).toBe(true);
		expect(statuses.slice(CHECKOUT_PER_WINDOW)).toEqual([429, 429]);
		// Another user is not affected.
		expect((await b.t.api("POST", "/api/billing/checkout", { token: b.alice.token, body: { kind: "topup", credits: 1000 } })).status).toBe(201);
	});
});
