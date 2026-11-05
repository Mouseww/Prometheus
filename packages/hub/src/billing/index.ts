import type { HubConfig } from "../config.ts";
import { toIso } from "../db/db.ts";
import type { HubLog } from "../log.ts";
import { LOG_PREFIX } from "../log.ts";
import type { Actor } from "../permissions.ts";
import type { RateLimiter } from "../rate-limit.ts";
import type { AuditService } from "../services/audit.ts";
import type { ServiceDeps } from "../services/common.ts";
import type { SettingsService } from "../services/settings.ts";
import type { UsageService } from "../services/usage.ts";
import { type CatalogService, createCatalogService, type PlanView } from "./catalog.ts";
import { createOrdersService, type OrdersService } from "./orders.ts";
import { createManualProvider } from "./providers/manual.ts";
import type { Order, PaymentProvider, Subject } from "./providers/provider.ts";
import { createStripeProvider } from "./providers/stripe.ts";
import { createRedeemService, type RedeemService } from "./redeem.ts";
import { balanceOf, createWalletService, type WalletService } from "./wallet.ts";

export const SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;

export interface GrantView {
	id: string;
	source: string;
	amount: number;
	remaining: number;
	expiresAt: string | null;
}

export interface BillingSummary {
	subject: Subject;
	balance: number;
	grants: GrantView[];
	plan: PlanView;
	subscription: { planId: string; status: string; currentPeriodStart: string; currentPeriodEnd: string; provider: string } | null;
	/** Usage charged to this subject in the current calendar month (UTC). */
	periodUsage: { credits: number; inputTokens: number; outputTokens: number; requests: number; overdraftCredits: number };
	recentOrders: Order[];
	providers: string[];
}

export interface BillingService {
	/** Credits billing is active for the LLM proxy (public mode, or HUB_BILLING=on). */
	readonly enabled: boolean;
	wallet: WalletService;
	orders: OrdersService;
	catalog: CatalogService;
	redeem: RedeemService;
	summary(actor: Actor, orgId: string | undefined): Promise<BillingSummary>;
	/** Starts the hourly grant issuance; the returned function stops it and waits for a run in flight. */
	startScheduler(): () => Promise<void>;
}

export interface BillingOptions {
	config: HubConfig;
	audit: AuditService;
	settings: SettingsService;
	usage: UsageService;
	limiter: RateLimiter;
	log: HubLog;
	/** Extra providers (tests, future adapters); the built-in manual and configured stripe providers are always there. */
	providers?: readonly PaymentProvider[];
}

export function createBilling(deps: ServiceDeps, opts: BillingOptions): BillingService {
	const { config } = opts;
	const providers: PaymentProvider[] = [createManualProvider(), ...(opts.providers ?? [])];
	if (config.stripeSecret && config.stripeWebhookSecret) {
		providers.push(createStripeProvider({ secret: config.stripeSecret, webhookSecret: config.stripeWebhookSecret, now: deps.now, ...(config.stripeApiBase ? { apiBase: config.stripeApiBase } : {}) }));
	}
	const wallet = createWalletService(deps, opts.usage);
	const orders = createOrdersService(deps, { audit: opts.audit, settings: opts.settings, providers, publicUrl: config.publicUrl, defaultProvider: providers.some((p) => p.id === "stripe") ? "stripe" : "manual" });
	const catalog = createCatalogService(deps, opts.audit, opts.settings);
	const redeem = createRedeemService(deps, opts.audit, opts.limiter);

	return {
		enabled: config.billingEnabled,
		wallet,
		orders,
		catalog,
		redeem,

		async summary(actor, orgId) {
			const subject = orders.subjectFor(actor, orgId);
			await wallet.ensureGrants(subject);
			const nowIso = new Date(deps.now()).toISOString();
			const monthStart = new Date(Date.UTC(new Date(deps.now()).getUTCFullYear(), new Date(deps.now()).getUTCMonth(), 1)).toISOString();
			const data = await deps.db.tx({ system: true }, async (q) => {
				const balance = await balanceOf(q, subject, nowIso);
				const grants = await q.query<{ id: string; source: string; amount: string | number; remaining: string | number; expires_at: Date | string | null }>(
					`SELECT id, source, amount, remaining, expires_at FROM credit_grants
					 WHERE subject_type = $1 AND subject_id = $2 AND remaining > 0 AND (expires_at IS NULL OR expires_at > $3::timestamptz)
					 ORDER BY expires_at ASC NULLS LAST, created_at, id`,
					[subject.type, subject.id, nowIso],
				);
				const subs = await q.query<{ plan_id: string; status: string; current_period_start: Date | string; current_period_end: Date | string; provider: string }>(
					"SELECT plan_id, status, current_period_start, current_period_end, provider FROM subscriptions WHERE subject_type = $1 AND subject_id = $2",
					[subject.type, subject.id],
				);
				const live = subs[0] && subs[0].status === "active" && new Date(subs[0].current_period_end).getTime() > deps.now() ? subs[0] : undefined;
				const plan = await q.query<{ id: string; name: string; period: "month" | "year"; price_cents: string | number; currency: string; monthly_credits: string | number; features: Record<string, unknown>; active: boolean }>(
					"SELECT id, name, period, price_cents, currency, monthly_credits, features, active FROM plans WHERE id = $1",
					[live?.plan_id ?? "free"],
				);
				const usage = await q.query<{ credits: string | number | null; input: string | number | null; output: string | number | null; requests: string | number; overdraft: string | number | null }>(
					`SELECT sum(cost_credits) AS credits, sum(input_tokens) AS input, sum(output_tokens) AS output, count(*) AS requests, sum(overdraft_credits) AS overdraft
					 FROM usage_ledger WHERE subject_type = $1 AND subject_id = $2 AND at >= $3::timestamptz`,
					[subject.type, subject.id, monthStart],
				);
				return { balance, grants, live, plan: plan[0], usage: usage[0] };
			});
			const p = data.plan as NonNullable<typeof data.plan>;
			return {
				subject,
				balance: data.balance,
				grants: data.grants.map((g) => ({ id: g.id, source: g.source, amount: Number(g.amount), remaining: Number(g.remaining), expiresAt: toIso(g.expires_at) })),
				plan: { id: p.id, name: p.name, period: p.period, priceCents: Number(p.price_cents), currency: p.currency, monthlyCredits: Number(p.monthly_credits), features: p.features ?? {}, active: p.active },
				subscription: data.live
					? { planId: data.live.plan_id, status: data.live.status, currentPeriodStart: toIso(data.live.current_period_start) as string, currentPeriodEnd: toIso(data.live.current_period_end) as string, provider: data.live.provider }
					: null,
				periodUsage: {
					credits: Number(data.usage?.credits ?? 0),
					inputTokens: Number(data.usage?.input ?? 0),
					outputTokens: Number(data.usage?.output ?? 0),
					requests: Number(data.usage?.requests ?? 0),
					overdraftCredits: Number(data.usage?.overdraft ?? 0),
				},
				recentOrders: await orders.recent(actor, subject, 10),
				providers: orders.providerIds(),
			};
		},

		startScheduler() {
			let running: Promise<void> | undefined;
			let stopped = false;
			const tick = (): void => {
				if (stopped || running) return;
				running = wallet
					.issueAll()
					.then((n) => {
						if (n > 0) opts.log.info(`${LOG_PREFIX} 已发放 ${n} 笔周期额度`);
					})
					.catch((err: unknown) => opts.log.error(`${LOG_PREFIX} 发放周期额度失败: ${err instanceof Error ? err.message : String(err)}`))
					.finally(() => {
						running = undefined;
					});
			};
			const timer = setInterval(tick, SCHEDULER_INTERVAL_MS);
			timer.unref();
			// First run right away so a fresh start does not wait an hour; the proxy also tops up lazily per subject.
			const first = setTimeout(tick, 0);
			first.unref();
			return async () => {
				stopped = true;
				clearInterval(timer);
				clearTimeout(first);
				await running;
			};
		},
	};
}
