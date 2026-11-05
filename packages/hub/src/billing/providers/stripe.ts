import { createHmac, timingSafeEqual } from "node:crypto";
import type { CheckoutOptions, Order, PaymentEvent, PaymentProvider } from "./provider.ts";

export const STRIPE_API_BASE = "https://api.stripe.com";
/** Stripe's own recommended replay window. */
export const WEBHOOK_TOLERANCE_SEC = 5 * 60;
const REQUEST_TIMEOUT_MS = 15_000;

export interface StripeOptions {
	/** HUB_STRIPE_SECRET */
	secret: string;
	/** HUB_STRIPE_WEBHOOK_SECRET (`whsec_...`) */
	webhookSecret: string;
	/** Override for local mocks; defaults to https://api.stripe.com. */
	apiBase?: string;
	fetch?: typeof fetch;
	now?: () => number;
}

type Headers = Record<string, string | string[] | undefined>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Form body of `POST /v1/checkout/sessions` (nested keys use Stripe's bracket syntax). */
export function checkoutParams(order: Order, opts: CheckoutOptions): URLSearchParams {
	const p = new URLSearchParams();
	const subscription = order.kind === "subscription";
	p.set("mode", subscription ? "subscription" : "payment");
	p.set("success_url", opts.successUrl);
	p.set("cancel_url", opts.cancelUrl);
	p.set("customer_email", opts.customerEmail);
	p.set("client_reference_id", order.id);
	p.set("metadata[order_id]", order.id);
	p.set(subscription ? "subscription_data[metadata][order_id]" : "payment_intent_data[metadata][order_id]", order.id);
	p.set("line_items[0][quantity]", "1");
	p.set("line_items[0][price_data][currency]", order.currency.toLowerCase());
	p.set("line_items[0][price_data][unit_amount]", String(order.amountCents));
	p.set("line_items[0][price_data][product_data][name]", opts.description ?? (subscription ? "Subscription" : `${order.credits} credits`));
	if (subscription) p.set("line_items[0][price_data][recurring][interval]", opts.recurringInterval ?? "month");
	return p;
}

function headerValue(headers: Headers, name: string): string | undefined {
	const v = headers[name];
	return Array.isArray(v) ? v[0] : v;
}

/** Verifies `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]`: HMAC-SHA256 over `<t>.<raw body>` and a timestamp within the tolerance. */
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, nowMs: number): boolean {
	if (!header) return false;
	let timestamp: string | undefined;
	const signatures: string[] = [];
	for (const part of header.split(",")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const key = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (key === "t") timestamp = value;
		else if (key === "v1") signatures.push(value);
	}
	if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return false;
	if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SEC) return false;
	const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
	return signatures.some((sig) => {
		if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
		return timingSafeEqual(expected, Buffer.from(sig, "hex"));
	});
}

const isoFromUnix = (v: unknown): string | undefined => (typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : undefined);

/** Maps a verified Stripe event to the Hub's neutral event; events it does not care about become `ignored`. */
export function mapStripeEvent(event: unknown): PaymentEvent {
	if (!isRecord(event) || typeof event.type !== "string" || !isRecord(event.data) || !isRecord(event.data.object)) return { type: "ignored", providerRef: "" };
	const obj = event.data.object;
	const metadataOrder = isRecord(obj.metadata) ? str(obj.metadata.order_id) : undefined;
	switch (event.type) {
		case "checkout.session.completed":
		case "checkout.session.async_payment_succeeded": {
			const paid = obj.payment_status === "paid" || obj.payment_status === "no_payment_required";
			const id = str(obj.id);
			if (!paid || !id) return { type: "ignored", providerRef: id ?? "" };
			const orderId = str(obj.client_reference_id) ?? metadataOrder;
			const subscriptionRef = str(obj.subscription);
			const currency = str(obj.currency);
			return {
				type: "paid",
				providerRef: id,
				...(orderId ? { orderId } : {}),
				...(typeof obj.amount_total === "number" ? { amountCents: obj.amount_total } : {}),
				...(currency ? { currency: currency.toLowerCase() } : {}),
				...(subscriptionRef ? { subscriptionRef } : {}),
			};
		}
		case "checkout.session.async_payment_failed":
		case "checkout.session.expired": {
			const id = str(obj.id);
			if (!id) return { type: "ignored", providerRef: "" };
			const orderId = str(obj.client_reference_id) ?? metadataOrder;
			return { type: "failed", providerRef: id, ...(orderId ? { orderId } : {}) };
		}
		case "invoice.paid":
		case "invoice.payment_succeeded": {
			// The first invoice is settled by checkout.session.completed; only cycle invoices renew.
			if (obj.billing_reason !== "subscription_cycle") return { type: "ignored", providerRef: str(obj.id) ?? "" };
			const parent = isRecord(obj.parent) && isRecord(obj.parent.subscription_details) ? str(obj.parent.subscription_details.subscription) : undefined;
			const subscription = str(obj.subscription) ?? parent;
			const lines = isRecord(obj.lines) && Array.isArray(obj.lines.data) ? obj.lines.data : [];
			const first = lines[0];
			const periodEnd = isRecord(first) && isRecord(first.period) ? isoFromUnix(first.period.end) : undefined;
			if (!subscription) return { type: "ignored", providerRef: "" };
			return { type: "subscriptionRenewed", providerRef: subscription, ...(periodEnd ? { periodEnd } : {}), ...(typeof obj.amount_paid === "number" ? { amountCents: obj.amount_paid } : {}) };
		}
		case "customer.subscription.deleted": {
			const id = str(obj.id);
			return id ? { type: "subscriptionCanceled", providerRef: id } : { type: "ignored", providerRef: "" };
		}
		case "charge.refunded": {
			const ref = str(obj.payment_intent) ?? str(obj.id);
			if (!ref) return { type: "ignored", providerRef: "" };
			const currency = str(obj.currency);
			return {
				type: "refunded",
				providerRef: ref,
				...(metadataOrder ? { orderId: metadataOrder } : {}),
				...(typeof obj.amount === "number" ? { amountCents: obj.amount } : {}),
				...(typeof obj.amount_refunded === "number" ? { amountRefundedCents: obj.amount_refunded } : {}),
				...(currency ? { currency: currency.toLowerCase() } : {}),
			};
		}
		default:
			return { type: "ignored", providerRef: "" };
	}
}

/** Stripe over plain REST (no SDK): hosted Checkout sessions and signed webhooks. */
export function createStripeProvider(opts: StripeOptions): PaymentProvider {
	const doFetch = opts.fetch ?? fetch;
	const base = (opts.apiBase ?? STRIPE_API_BASE).replace(/\/+$/, "");
	const now = opts.now ?? Date.now;
	return {
		id: "stripe",
		async createCheckout(order, o) {
			const res = await doFetch(`${base}/v1/checkout/sessions`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${opts.secret}`,
					"content-type": "application/x-www-form-urlencoded",
					"idempotency-key": order.id,
				},
				body: checkoutParams(order, o).toString(),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			let data: unknown;
			try {
				data = await res.json();
			} catch {
				data = undefined;
			}
			if (!res.ok) {
				const message = isRecord(data) && isRecord(data.error) ? str(data.error.message) : undefined;
				throw new Error(`Stripe 返回 ${res.status}${message ? `: ${message}` : ""}`);
			}
			const id = isRecord(data) ? str(data.id) : undefined;
			const url = isRecord(data) ? str(data.url) : undefined;
			if (!id || !url) throw new Error("Stripe 响应缺少 id 或 url");
			return { redirectUrl: url, providerRef: id };
		},
		parseWebhook(rawBody, headers) {
			if (!verifyStripeSignature(rawBody, headerValue(headers, "stripe-signature"), opts.webhookSecret, now())) return undefined;
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawBody.toString("utf8"));
			} catch {
				return undefined;
			}
			return mapStripeEvent(parsed);
		},
	};
}
