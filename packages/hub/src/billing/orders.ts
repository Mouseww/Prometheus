import type { Queryable } from "../db/db.ts";
import { toIso } from "../db/db.ts";
import { badRequest, conflict, forbidden, HubError, notFound } from "../errors.ts";
import { ulid } from "../ids.ts";
import { LOG_PREFIX } from "../log.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { AuditService } from "../services/audit.ts";
import { type ServiceDeps, scopeOf } from "../services/common.ts";
import type { SettingsService } from "../services/settings.ts";
import type { Order, OrderKind, OrderStatus, PaymentEvent, PaymentProvider, Subject } from "./providers/provider.ts";
import { addMonths, issuePeriodGrants } from "./wallet.ts";

export const BILLING_SETTINGS_KEY = "billing_settings";
export const MIN_TOPUP_CREDITS = 1000;
export const MAX_TOPUP_CREDITS = 100_000_000;

export interface BillingSettings {
	/** How many credits one cent buys on top-up (1 credit = 0.001 of the currency unit means 10). */
	topupCreditsPerCent: number;
	currency: string;
	/** Top-up credits expire after this many days; null = never. */
	topupExpiryDays: number | null;
}

export const DEFAULT_BILLING_SETTINGS: BillingSettings = { topupCreditsPerCent: 10, currency: "cny", topupExpiryDays: null };

export interface CheckoutInput {
	kind: OrderKind;
	planId?: string;
	credits?: number;
	/** Buy for this organization (the actor must own or administer it); personal otherwise. */
	orgId?: string;
	provider?: string;
	successUrl?: string;
	cancelUrl?: string;
}

export interface CheckoutResult {
	orderId: string;
	status: OrderStatus;
	provider: string;
	/** Where to send the browser; null for offline providers (the order waits for an operator). */
	redirectUrl: string | null;
	amountCents: number;
	currency: string;
	credits: number;
}

export interface OrderFilter {
	status?: OrderStatus;
	provider?: string;
	subjectType?: "user" | "org";
	subjectId?: string;
	before?: string;
	limit?: number;
}

/** `mismatch`: a paid event whose amount or currency differs from the order; acknowledged but nothing is granted. */
export type WebhookOutcome = "applied" | "duplicate" | "ignored" | "unknownOrder" | "mismatch";

/** Why a paid event cannot be applied to this order, or undefined when it agrees (fields the provider did not send are not compared). */
export function paymentMismatch(order: Pick<OrderRow, "amount_cents" | "currency">, event: Pick<PaymentEvent, "amountCents" | "currency">): string | undefined {
	if (event.amountCents !== undefined && event.amountCents !== Number(order.amount_cents)) return `金额不符: 订单 ${Number(order.amount_cents)}，支付 ${event.amountCents}`;
	if (event.currency !== undefined && event.currency.toLowerCase() !== order.currency.toLowerCase()) return `币种不符: 订单 ${order.currency}，支付 ${event.currency}`;
	return undefined;
}

export interface OrdersService {
	providerIds(): string[];
	settings(q?: Queryable): Promise<BillingSettings>;
	/** Resolves who pays: the actor, or an organization they administer. */
	subjectFor(actor: Actor, orgId: string | undefined): Subject;
	checkout(actor: Actor, input: CheckoutInput): Promise<CheckoutResult>;
	handleWebhook(providerId: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ outcome: WebhookOutcome }>;
	list(actor: Actor, filter: OrderFilter): Promise<{ items: Order[]; nextBefore: string | null }>;
	/** Operator action for manual orders: pending -> paid, or paid -> refunded. */
	adminSetStatus(actor: Actor, id: string, status: "paid" | "refunded"): Promise<Order>;
	recent(actor: Actor, subject: Subject, limit: number): Promise<Order[]>;
}

interface OrderRow {
	id: string;
	subject_type: "user" | "org";
	subject_id: string;
	kind: OrderKind;
	amount_cents: string | number;
	currency: string;
	credits: string | number;
	plan_id: string | null;
	status: OrderStatus;
	provider: string;
	provider_ref: string | null;
	created_by: string | null;
	created_at: Date | string;
	paid_at: Date | string | null;
}

const ORDER_COLUMNS = "id, subject_type, subject_id, kind, amount_cents, currency, credits, plan_id, status, provider, provider_ref, created_by, created_at, paid_at";

export const toOrder = (r: OrderRow): Order => ({
	id: r.id,
	subjectType: r.subject_type,
	subjectId: r.subject_id,
	kind: r.kind,
	amountCents: Number(r.amount_cents),
	currency: r.currency,
	credits: Number(r.credits),
	planId: r.plan_id,
	status: r.status,
	provider: r.provider,
	providerRef: r.provider_ref,
	createdBy: r.created_by,
	createdAt: toIso(r.created_at) as string,
	paidAt: toIso(r.paid_at),
});

const sameOrigin = (candidate: string | undefined, base: string): boolean => {
	if (!candidate) return false;
	try {
		return new URL(candidate).origin === new URL(base).origin;
	} catch {
		return false;
	}
};

interface SubscriptionRow {
	id: string;
	plan_id: string;
	subject_type: "user" | "org";
	subject_id: string;
	current_period_end: Date | string;
}

interface PlanRow {
	id: string;
	name: string;
	period: "month" | "year";
	price_cents: string | number;
	currency: string;
	monthly_credits: string | number;
	active: boolean;
}

export function createOrdersService(
	deps: ServiceDeps,
	opts: { audit: AuditService; settings: SettingsService; providers: readonly PaymentProvider[]; publicUrl: string; defaultProvider: string },
): OrdersService {
	const providers = new Map(opts.providers.map((p) => [p.id, p]));
	const { audit, settings } = opts;

	const loadSettings = async (q?: Queryable): Promise<BillingSettings> => {
		const v = await settings.get<Partial<BillingSettings>>(BILLING_SETTINGS_KEY, q);
		return { ...DEFAULT_BILLING_SETTINGS, ...(v ?? {}) };
	};

	/** Marks the order paid and hands out what was bought. Idempotent: an order that is already paid is left alone. */
	const fulfill = async (q: Queryable, order: OrderRow, event: PaymentEvent): Promise<void> => {
		if (order.status === "paid") return;
		if (order.status === "refunded" || order.status === "canceled") return;
		const now = deps.now();
		const nowIso = new Date(now).toISOString();
		await q.query("UPDATE orders SET status = 'paid', paid_at = $2::timestamptz, updated_at = now() WHERE id = $1", [order.id, nowIso]);
		const subject: Subject = { type: order.subject_type, id: order.subject_id };
		if (order.kind === "topup") {
			const s = await loadSettings(q);
			const expires = s.topupExpiryDays ? new Date(now + s.topupExpiryDays * 24 * 60 * 60 * 1000).toISOString() : null;
			await q.query(
				`INSERT INTO credit_grants (id, subject_type, subject_id, source, amount, remaining, expires_at, ref)
				 VALUES ($1,$2,$3,'topup',$4,$4,$5::timestamptz,$6) ON CONFLICT (source, ref) WHERE ref IS NOT NULL DO NOTHING`,
				[ulid(now), subject.type, subject.id, Number(order.credits), expires, order.id],
			);
		} else {
			const plans = await q.query<PlanRow>("SELECT id, name, period, price_cents, currency, monthly_credits, active FROM plans WHERE id = $1", [order.plan_id]);
			const plan = plans[0];
			if (!plan) throw new HubError(500, "internalError", "订单对应的套餐不存在");
			const start = new Date(now);
			const end = event.periodEnd ? new Date(event.periodEnd) : addMonths(start, plan.period === "year" ? 12 : 1);
			await q.query(
				`INSERT INTO subscriptions (id, subject_type, subject_id, plan_id, status, current_period_start, current_period_end, provider, provider_ref)
				 VALUES ($1,$2,$3,$4,'active',$5::timestamptz,$6::timestamptz,$7,$8)
				 ON CONFLICT (subject_type, subject_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active', current_period_start = EXCLUDED.current_period_start,
				   current_period_end = EXCLUDED.current_period_end, provider = EXCLUDED.provider, provider_ref = EXCLUDED.provider_ref, updated_at = now()`,
				[ulid(now), subject.type, subject.id, plan.id, start.toISOString(), end.toISOString(), order.provider, event.subscriptionRef ?? order.provider_ref],
			);
			await issuePeriodGrants(q, now, subject);
		}
		await audit.write(q, {
			actorId: null,
			orgId: subject.type === "org" ? subject.id : null,
			action: "billing.order.paid",
			targetType: "order",
			targetId: order.id,
			detail: { kind: order.kind, provider: order.provider, amountCents: Number(order.amount_cents), credits: Number(order.credits) },
		});
	};

	/**
	 * Refunds take back credits in proportion to the refunded amount. Providers report the cumulative refunded amount, so the
	 * previous cumulative figure (kept as the discriminator of earlier refund events) is subtracted. A refund with no amount
	 * (manual orders) is a full refund. The order only becomes `refunded` once everything is refunded; a partial refund leaves it `paid`.
	 */
	const refund = async (q: Queryable, order: OrderRow, event: PaymentEvent, discriminator: string): Promise<void> => {
		if (order.status !== "paid") return;
		const paidCents = Math.max(1, event.amountCents ?? Number(order.amount_cents));
		const refundedCents = Math.min(paidCents, Math.max(0, event.amountRefundedCents ?? paidCents));
		const full = refundedCents >= paidCents;
		const credits = Number(order.credits);
		let revoked = 0;
		if (order.kind === "topup") {
			const earlier = await q.query<{ discriminator: string }>(
				"SELECT discriminator FROM payment_events WHERE provider = $1 AND provider_ref = $2 AND event_type = 'refunded' AND discriminator <> $3",
				[order.provider, event.providerRef, discriminator],
			);
			const previousCents = earlier.reduce((max, r) => Math.max(max, /^\d+$/.test(r.discriminator) ? Number(r.discriminator) : 0), 0);
			const previousCredits = Math.ceil((credits * Math.min(previousCents, paidCents)) / paidCents);
			const targetCredits = full ? credits : Math.ceil((credits * refundedCents) / paidCents);
			revoked = Math.max(0, targetCredits - previousCredits);
			// Whatever of that share is still unspent goes back; credits already used stay used.
			await q.query("UPDATE credit_grants SET remaining = GREATEST(0, remaining - $2) WHERE source = 'topup' AND ref = $1", [order.id, revoked]);
		} else if (full) {
			await q.query("UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE subject_type = $1 AND subject_id = $2", [order.subject_type, order.subject_id]);
		}
		if (full) await q.query("UPDATE orders SET status = 'refunded', updated_at = now() WHERE id = $1", [order.id]);
		await audit.write(q, {
			actorId: null,
			orgId: order.subject_type === "org" ? order.subject_id : null,
			action: full ? "billing.order.refunded" : "billing.order.refunded.partial",
			targetType: "order",
			targetId: order.id,
			detail: { kind: order.kind, provider: order.provider, refundedCents, paidCents, creditsRevoked: revoked },
		});
	};

	const findOrder = async (q: Queryable, provider: string, event: PaymentEvent): Promise<OrderRow | undefined> => {
		const rows = await q.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE provider = $1 AND (provider_ref = $2 OR id = $3) ORDER BY (provider_ref = $2) DESC LIMIT 1 FOR UPDATE`, [
			provider,
			event.providerRef,
			event.orderId ?? null,
		]);
		return rows[0];
	};

	const applyEvent = async (provider: string, event: PaymentEvent): Promise<WebhookOutcome> => {
		if (event.type === "ignored") return "ignored";
		return deps.db.tx({ system: true }, async (q): Promise<WebhookOutcome> => {
			// One row per provider reference and event type; renewals also carry the period so each cycle counts once.
			// Inserted after the target was found (an unknown reference must stay retryable) and in the same transaction as the effect.
			// Refunds carry the cumulative refunded amount, so each partial refund of one charge is its own event.
			const discriminator =
				event.type === "subscriptionRenewed" ? (event.periodEnd ?? "") : event.type === "refunded" && event.amountRefundedCents !== undefined ? String(event.amountRefundedCents) : "";
			const firstTime = async (): Promise<boolean> =>
				(
					await q.query(
						"INSERT INTO payment_events (provider, provider_ref, event_type, discriminator) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING provider_ref",
						[provider, event.providerRef, event.type, discriminator],
					)
				).length > 0;

			if (event.type === "subscriptionRenewed" || event.type === "subscriptionCanceled") {
				const subs = await q.query<SubscriptionRow>(
					"SELECT id, plan_id, subject_type, subject_id, current_period_end FROM subscriptions WHERE provider = $1 AND provider_ref = $2 FOR UPDATE",
					[provider, event.providerRef],
				);
				const sub = subs[0];
				if (!sub) return "unknownOrder";
				if (!(await firstTime())) return "duplicate";
				if (event.type === "subscriptionCanceled") await q.query("UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE id = $1", [sub.id]);
				else await renew(q, sub, event);
				return "applied";
			}

			const order = await findOrder(q, provider, event);
			if (!order) return "unknownOrder";
			const problem = event.type === "paid" ? paymentMismatch(order, event) : undefined;
			if (problem) {
				// Nothing is granted and the order stays pending for an operator to look at. The event is acknowledged (so the provider stops
				// retrying) but not remembered as handled, so a corrected event for the same session can still apply.
				deps.log.error(`${LOG_PREFIX} 支付通知与订单不符，已拒绝 (${provider}, 订单 ${order.id}): ${problem}`);
				await audit.write(q, {
					actorId: null,
					orgId: order.subject_type === "org" ? order.subject_id : null,
					action: "billing.order.mismatch",
					targetType: "order",
					targetId: order.id,
					detail: { provider, problem, expectedCents: Number(order.amount_cents), paidCents: event.amountCents ?? null },
				});
				return "mismatch";
			}
			if (!(await firstTime())) return "duplicate";
			if (event.type === "paid") await fulfill(q, order, event);
			else if (event.type === "refunded") await refund(q, order, event, discriminator);
			else if (order.status === "pending") await q.query("UPDATE orders SET status = 'failed', updated_at = now() WHERE id = $1", [order.id]);
			return "applied";
		});
	};

	const renew = async (q: Queryable, sub: SubscriptionRow, event: PaymentEvent): Promise<void> => {
		const now = deps.now();
		const plans = await q.query<{ period: "month" | "year" }>("SELECT period FROM plans WHERE id = $1", [sub.plan_id]);
		const previousEnd = new Date(sub.current_period_end);
		const start = previousEnd.getTime() > now ? previousEnd : new Date(now);
		const end = event.periodEnd ? new Date(event.periodEnd) : addMonths(start, plans[0]?.period === "year" ? 12 : 1);
		await q.query("UPDATE subscriptions SET status = 'active', current_period_start = $2::timestamptz, current_period_end = $3::timestamptz, updated_at = now() WHERE id = $1", [
			sub.id,
			start.toISOString(),
			end.toISOString(),
		]);
		await issuePeriodGrants(q, now, { type: sub.subject_type, id: sub.subject_id });
	};

	const hydrate = async (q: Queryable, id: string): Promise<Order> => {
		const rows = await q.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`, [id]);
		if (!rows[0]) throw notFound("订单不存在");
		return toOrder(rows[0]);
	};

	const subjectFor = (actor: Actor, orgId: string | undefined): Subject => {
		if (!orgId) return { type: "user", id: actor.userId };
		if (!can(actor, "org.manage", { orgId })) throw forbidden("只有企业所有者或管理员可以管理企业账单");
		return { type: "org", id: orgId };
	};

	return {
		providerIds: () => [...providers.keys()],
		settings: loadSettings,
		subjectFor,

		async checkout(actor, input) {
			const subject = subjectFor(actor, input.orgId);
			const providerId = input.provider ?? opts.defaultProvider;
			const provider = providers.get(providerId);
			if (!provider) throw badRequest(`不支持的支付方式: ${providerId}`, "unknownProvider");
			const s = await loadSettings();

			let amountCents: number;
			let currency: string;
			let credits = 0;
			let planId: string | null = null;
			let description: string;
			let interval: "month" | "year" | undefined;
			if (input.kind === "topup") {
				const wanted = input.credits;
				if (!Number.isInteger(wanted) || (wanted as number) < MIN_TOPUP_CREDITS || (wanted as number) > MAX_TOPUP_CREDITS) {
					throw badRequest(`充值额度需要是 ${MIN_TOPUP_CREDITS} 到 ${MAX_TOPUP_CREDITS} 之间的整数`, "validationError");
				}
				credits = wanted as number;
				amountCents = Math.ceil(credits / s.topupCreditsPerCent);
				currency = s.currency;
				description = `${credits} credits`;
			} else {
				if (!input.planId) throw badRequest("订阅需要 planId", "validationError");
				const plans = await deps.db.query<PlanRow>("SELECT id, name, period, price_cents, currency, monthly_credits, active FROM plans WHERE id = $1", [input.planId]);
				const plan = plans[0];
				if (!plan || !plan.active) throw notFound("套餐不存在或已下架");
				if (Number(plan.price_cents) <= 0) throw badRequest("该套餐无需购买", "planNotPurchasable");
				planId = plan.id;
				amountCents = Number(plan.price_cents);
				currency = plan.currency;
				credits = Number(plan.monthly_credits);
				description = plan.name;
				interval = plan.period;
			}

			const id = ulid(deps.now());
			const users = await deps.db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [actor.userId]);
			const email = users[0]?.email ?? "";
			await deps.db.tx({ system: true }, async (q) => {
				if (subject.type === "org") {
					const org = await q.query("SELECT 1 FROM organizations WHERE id = $1", [subject.id]);
					if (org.length === 0) throw notFound("企业不存在");
				}
				await q.query(
					`INSERT INTO orders (id, subject_type, subject_id, kind, amount_cents, currency, credits, plan_id, status, provider, created_by)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)`,
					[id, subject.type, subject.id, input.kind, amountCents, currency, credits, planId, providerId, actor.userId],
				);
				await audit.write(q, {
					actorId: actor.userId,
					orgId: subject.type === "org" ? subject.id : null,
					action: "billing.checkout",
					targetType: "order",
					targetId: id,
					detail: { kind: input.kind, provider: providerId, amountCents, credits, planId },
				});
			});

			const order = await deps.db.tx({ system: true }, (q) => hydrate(q, id));
			const home = opts.publicUrl || "http://localhost";
			const successUrl = sameOrigin(input.successUrl, home) ? (input.successUrl as string) : `${home}/?billing=success`;
			const cancelUrl = sameOrigin(input.cancelUrl, home) ? (input.cancelUrl as string) : `${home}/?billing=canceled`;
			try {
				const result = await provider.createCheckout(order, { successUrl, cancelUrl, customerEmail: email, description, ...(interval ? { recurringInterval: interval } : {}) });
				await deps.db.tx({ system: true }, (q) => q.query("UPDATE orders SET provider_ref = $2, updated_at = now() WHERE id = $1", [id, result.providerRef]));
				return { orderId: id, status: "pending", provider: providerId, redirectUrl: result.redirectUrl || null, amountCents, currency, credits };
			} catch (err) {
				deps.log.error(`${LOG_PREFIX} 创建支付会话失败 (${providerId}, 订单 ${id}): ${err instanceof Error ? err.message : String(err)}`);
				await deps.db.tx({ system: true }, (q) => q.query("UPDATE orders SET status = 'failed', updated_at = now() WHERE id = $1", [id]));
				throw new HubError(502, "paymentProviderError", "无法创建支付会话，请稍后再试");
			}
		},

		async handleWebhook(providerId, rawBody, headers) {
			const provider = providers.get(providerId);
			if (!provider) throw notFound("支付方式不存在");
			const event = provider.parseWebhook(rawBody, headers);
			if (!event) throw new HubError(400, "invalidSignature", "签名无效");
			const outcome = await applyEvent(providerId, event);
			if (outcome === "unknownOrder") deps.log.warn(`${LOG_PREFIX} 收到未知订单的支付通知 (${providerId}, ${event.type}, ${event.providerRef})`);
			return { outcome };
		},

		async list(actor, filter) {
			if (!can(actor, "platform.manage")) throw forbidden();
			const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
			const where: string[] = [];
			const params: unknown[] = [];
			const add = (sql: string, value: unknown): void => {
				params.push(value);
				where.push(sql.replace("?", `$${params.length}`));
			};
			if (filter.status) add("status = ?", filter.status);
			if (filter.provider) add("provider = ?", filter.provider);
			if (filter.subjectType) add("subject_type = ?", filter.subjectType);
			if (filter.subjectId) add("subject_id = ?", filter.subjectId);
			if (filter.before) add("id < ?", filter.before);
			params.push(limit + 1);
			const rows = await deps.db.tx(scopeOf(actor), (q) =>
				q.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT $${params.length}`, params),
			);
			const page = rows.slice(0, limit);
			return { items: page.map(toOrder), nextBefore: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null };
		},

		async adminSetStatus(actor, id, status) {
			if (!can(actor, "platform.manage")) throw forbidden();
			const order = await deps.db.tx({ system: true }, (q) => hydrate(q, id));
			if (order.provider !== "manual") throw conflict("只有线下支付的订单可以手动确认", "notManual");
			if (status === "paid" && order.status !== "pending" && order.status !== "failed") throw conflict("订单状态不允许标记为已支付", "invalidState");
			if (status === "refunded" && order.status !== "paid") throw conflict("只有已支付的订单可以退款", "invalidState");
			const outcome = await applyEvent("manual", { type: status === "paid" ? "paid" : "refunded", providerRef: order.providerRef ?? order.id, orderId: order.id });
			if (outcome === "unknownOrder") throw notFound("订单不存在");
			await deps.db.tx({ system: true }, (q) => audit.write(q, { actorId: actor.userId, orgId: order.subjectType === "org" ? order.subjectId : null, action: `billing.order.${status}.manual`, targetType: "order", targetId: id }));
			return deps.db.tx({ system: true }, (q) => hydrate(q, id));
		},

		async recent(actor, subject, limit) {
			const rows = await deps.db.tx(scopeOf(actor), (q) =>
				q.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE subject_type = $1 AND subject_id = $2 ORDER BY id DESC LIMIT $3`, [subject.type, subject.id, limit]),
			);
			return rows.map(toOrder);
		},
	};
}
