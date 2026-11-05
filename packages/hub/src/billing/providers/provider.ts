export type SubjectType = "user" | "org";

export interface Subject {
	type: SubjectType;
	id: string;
}

export type OrderKind = "topup" | "subscription";
export type OrderStatus = "pending" | "paid" | "failed" | "refunded" | "canceled";

export interface Order {
	id: string;
	subjectType: SubjectType;
	subjectId: string;
	kind: OrderKind;
	amountCents: number;
	currency: string;
	credits: number;
	planId: string | null;
	status: OrderStatus;
	provider: string;
	providerRef: string | null;
	createdBy: string | null;
	createdAt: string;
	paidAt: string | null;
}

export interface CheckoutOptions {
	successUrl: string;
	cancelUrl: string;
	customerEmail: string;
	/** Line item title, e.g. "10000 credits" or the plan name. */
	description?: string;
	/** Subscriptions only: billing interval of the plan. */
	recurringInterval?: "month" | "year";
}

export interface PaymentEvent {
	/** `ignored`: a correctly signed event this Hub has no use for (acknowledged with 200). */
	type: "paid" | "failed" | "refunded" | "subscriptionRenewed" | "subscriptionCanceled" | "ignored";
	/** Matches `orders.provider_ref` (checkout session id), or `subscriptions.provider_ref` for subscription events. */
	providerRef: string;
	/** Fallback lookup: the order id the Hub put into the checkout metadata. */
	orderId?: string;
	/** What the provider says was paid (paid, renewals) or the amount of the charge (refunds). Compared with the order when present. */
	amountCents?: number;
	/** Lower-case ISO currency the provider charged in; compared with the order when present. */
	currency?: string;
	/** Refunds: the cumulative amount refunded so far for the charge. Absent means a full refund. */
	amountRefundedCents?: number;
	/** ISO timestamp of the end of the paid period (renewals). */
	periodEnd?: string;
	/** The provider's subscription id, remembered on activation so later renewals can find the subscription. */
	subscriptionRef?: string;
}

export interface PaymentProvider {
	readonly id: string;
	createCheckout(order: Order, opts: CheckoutOptions): Promise<{ redirectUrl: string; providerRef: string }>;
	/** Verifies and parses a webhook; returns undefined when the signature is invalid. */
	parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent | undefined;
}
