import type { Queryable } from "../db/db.ts";
import { HubError } from "../errors.ts";
import { ulid } from "../ids.ts";
import type { ServiceDeps } from "../services/common.ts";
import type { UsageEntry, UsageService } from "../services/usage.ts";
import type { Subject } from "./providers/provider.ts";

export const DEFAULT_MAX_TOKENS = 4096;
/** How long a subject's periodic grants are assumed to be in place before they are checked again. */
const ISSUE_CACHE_MS = 5 * 60 * 1000;

export interface ModelPrice {
	/** Credits per million tokens. */
	inputPrice: number;
	outputPrice: number;
}

/** Whole credits for a call, rounded up; at least 1 when anything was used and the model has a price. */
export function computeCost(price: ModelPrice, inputTokens: number, outputTokens: number): number {
	const raw = (Math.max(0, inputTokens) * price.inputPrice + Math.max(0, outputTokens) * price.outputPrice) / 1_000_000;
	return raw <= 0 ? 0 : Math.max(1, Math.ceil(raw - 1e-9));
}

/** What a call may cost at most as far as the pre-check can tell: the output cap times the output price. */
export function estimateCost(price: ModelPrice, maxOutputTokens: number | undefined): number {
	return computeCost({ inputPrice: 0, outputPrice: price.outputPrice }, 0, maxOutputTokens ?? DEFAULT_MAX_TOKENS);
}

/** The output cap a request asks for, across the OpenAI, Anthropic and Gemini request shapes. */
export function requestedMaxTokens(body: unknown): number | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const b = body as Record<string, unknown>;
	const gen = typeof b.generationConfig === "object" && b.generationConfig !== null ? (b.generationConfig as Record<string, unknown>) : {};
	for (const v of [b.max_tokens, b.max_completion_tokens, b.max_output_tokens, gen.maxOutputTokens]) {
		if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
	}
	return undefined;
}

export const addMonths = (date: Date, months: number): Date => {
	const d = new Date(date.getTime());
	const day = d.getUTCDate();
	d.setUTCDate(1);
	d.setUTCMonth(d.getUTCMonth() + months);
	const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
	d.setUTCDate(Math.min(day, last));
	return d;
};

export interface ConsumeResult {
	/** Credits taken from grants. */
	charged: number;
	/** Credits the subject could not cover; the balance is left at zero, never negative. */
	overdraft: number;
}

export async function balanceOf(q: Queryable, subject: Subject, nowIso: string): Promise<number> {
	const rows = await q.query<{ b: string | number | null }>(
		"SELECT coalesce(sum(remaining), 0) AS b FROM credit_grants WHERE subject_type = $1 AND subject_id = $2 AND remaining > 0 AND (expires_at IS NULL OR expires_at > $3::timestamptz)",
		[subject.type, subject.id, nowIso],
	);
	return Number(rows[0]?.b ?? 0);
}

/**
 * Takes `credits` from the subject's unexpired grants, earliest expiry first (grants that never expire last).
 * The grant rows are locked (`FOR UPDATE`) for the rest of the transaction, so concurrent charges serialize and the sum can never go below zero.
 */
export async function consume(q: Queryable, subject: Subject, credits: number, nowIso: string): Promise<ConsumeResult> {
	let left = Math.max(0, Math.round(credits));
	if (left === 0) return { charged: 0, overdraft: 0 };
	const grants = await q.query<{ id: string; remaining: string | number }>(
		`SELECT id, remaining FROM credit_grants
		 WHERE subject_type = $1 AND subject_id = $2 AND remaining > 0 AND (expires_at IS NULL OR expires_at > $3::timestamptz)
		 ORDER BY expires_at ASC NULLS LAST, created_at, id FOR UPDATE`,
		[subject.type, subject.id, nowIso],
	);
	let charged = 0;
	for (const g of grants) {
		if (left === 0) break;
		const take = Math.min(left, Number(g.remaining));
		await q.query("UPDATE credit_grants SET remaining = remaining - $2 WHERE id = $1", [g.id, take]);
		left -= take;
		charged += take;
	}
	return { charged, overdraft: left };
}

/**
 * Issues the grants every subject is entitled to for the current period. Idempotent: the unique index on
 * (subject, source, period_start) turns a second issuance into a no-op.
 * - `free`: each active user and organization gets the free plan's credits for the calendar month (UTC).
 * - `plan`: each active subscription gets its plan's monthly credits for the month window it is in (windows start at the subscription start).
 * `only` limits the work to one subject.
 */
export async function issuePeriodGrants(q: Queryable, nowMs: number, only?: Subject): Promise<number> {
	const now = new Date(nowMs);
	const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
	let issued = 0;

	for (const [type, table] of [
		["user", "users"],
		["org", "organizations"],
	] as const) {
		if (only && only.type !== type) continue;
		const rows = await q.query(
			`INSERT INTO credit_grants (id, subject_type, subject_id, source, amount, remaining, expires_at, period_start)
			 SELECT gen_random_uuid()::text, '${type}', s.id, 'free', p.monthly_credits, p.monthly_credits, $2::timestamptz, $1::timestamptz
			 FROM ${table} s CROSS JOIN plans p
			 WHERE p.id = 'free' AND p.monthly_credits > 0 AND s.status = 'active' AND ($3::text IS NULL OR s.id = $3)
			 ON CONFLICT (subject_type, subject_id, source, period_start) WHERE period_start IS NOT NULL DO NOTHING
			 RETURNING id`,
			[monthStart.toISOString(), monthEnd.toISOString(), only?.id ?? null],
		);
		issued += rows.length;
	}

	const subs = await q.query<{ subject_type: "user" | "org"; subject_id: string; current_period_start: Date | string; current_period_end: Date | string; monthly_credits: string | number }>(
		`SELECT s.subject_type, s.subject_id, s.current_period_start, s.current_period_end, p.monthly_credits
		 FROM subscriptions s JOIN plans p ON p.id = s.plan_id
		 WHERE s.status = 'active' AND s.current_period_start <= $1::timestamptz AND s.current_period_end > $1::timestamptz AND p.monthly_credits > 0
		   AND ($2::text IS NULL OR (s.subject_type = $2 AND s.subject_id = $3))`,
		[now.toISOString(), only?.type ?? null, only?.id ?? null],
	);
	for (const s of subs) {
		const start = new Date(s.current_period_start);
		const end = new Date(s.current_period_end);
		let k = 0;
		while (addMonths(start, k + 1) <= now) k++;
		const windowStart = addMonths(start, k);
		const windowEnd = new Date(Math.min(addMonths(start, k + 1).getTime(), end.getTime()));
		const amount = Number(s.monthly_credits);
		const rows = await q.query(
			`INSERT INTO credit_grants (id, subject_type, subject_id, source, amount, remaining, expires_at, period_start)
			 VALUES ($1,$2,$3,'plan',$4,$4,$5::timestamptz,$6::timestamptz)
			 ON CONFLICT (subject_type, subject_id, source, period_start) WHERE period_start IS NOT NULL DO NOTHING RETURNING id`,
			[ulid(nowMs), s.subject_type, s.subject_id, amount, windowEnd.toISOString(), windowStart.toISOString()],
		);
		issued += rows.length;
	}
	return issued;
}

/** How long an unsettled reservation keeps holding credits before it is treated as orphaned. */
export const RESERVATION_TTL_MS = 10 * 60 * 1000;

/** Credits held for one in-flight call. */
export interface Reservation {
	id: string;
	subject: Subject;
	amount: number;
}

/**
 * Holds `amount` credits of the subject for a call that is about to start. Concurrent reservations serialize on the subject's grant
 * rows (the same `FOR UPDATE` lock `consume` takes), and each sees the live reservations of the others, so the sum of what is held
 * never exceeds the balance. Throws 402 `insufficientCredits` when the unreserved balance cannot cover it.
 */
export async function reserveCredits(q: Queryable, subject: Subject, amount: number, nowMs: number, ttlMs: number): Promise<Reservation> {
	const nowIso = new Date(nowMs).toISOString();
	const grants = await q.query<{ remaining: string | number }>(
		`SELECT remaining FROM credit_grants
		 WHERE subject_type = $1 AND subject_id = $2 AND remaining > 0 AND (expires_at IS NULL OR expires_at > $3::timestamptz)
		 ORDER BY expires_at ASC NULLS LAST, created_at, id FOR UPDATE`,
		[subject.type, subject.id, nowIso],
	);
	await q.query("DELETE FROM credit_reservations WHERE subject_type = $1 AND subject_id = $2 AND expires_at <= $3::timestamptz", [subject.type, subject.id, nowIso]);
	const held = await q.query<{ held: string | number | null }>(
		"SELECT coalesce(sum(amount), 0) AS held FROM credit_reservations WHERE subject_type = $1 AND subject_id = $2",
		[subject.type, subject.id],
	);
	const balance = grants.reduce((sum, g) => sum + Number(g.remaining), 0);
	if (balance - Number(held[0]?.held ?? 0) < amount) throw new HubError(402, "insufficientCredits", "额度不足，请充值或升级套餐");
	const id = ulid(nowMs);
	await q.query("INSERT INTO credit_reservations (id, subject_type, subject_id, amount, expires_at) VALUES ($1,$2,$3,$4,$5::timestamptz)", [
		id,
		subject.type,
		subject.id,
		amount,
		new Date(nowMs + ttlMs).toISOString(),
	]);
	return { id, subject, amount };
}

export interface WalletService {
	/** The price of a model on a gateway: exact match, then the gateway-less price, then the `*` fallback. */
	priceFor(model: string, gatewayId: string | null): Promise<ModelPrice | undefined>;
	balance(subject: Subject): Promise<number>;
	/** Throws 402 `insufficientCredits` unless the subject can cover the estimated cost of this call. */
	precheck(subject: Subject, price: ModelPrice | undefined, maxOutputTokens: number | undefined): Promise<void>;
	/**
	 * Holds `estimatedCost` credits of the subject before an upstream call, so concurrent calls cannot overspend together. Returns
	 * undefined when there is nothing to hold (zero estimate); throws 402 `insufficientCredits` when the unreserved balance is short.
	 * Settle the result with `commit` or `release`; a reservation nobody settles stops counting after `ttlMs`.
	 */
	reserve(subject: Subject, estimatedCost: number, ttlMs?: number): Promise<Reservation | undefined>;
	/** Charges the actual cost, books the usage row and drops the reservation, all in one transaction. */
	commit(reservation: Reservation | undefined, subject: Subject, entry: UsageEntry, price: ModelPrice | undefined): Promise<{ cost: number; overdraft: number }>;
	/** Gives a reservation back without charging (the call failed or produced no usage). Safe to call twice. */
	release(reservation: Reservation | undefined): Promise<void>;
	/** Charges the actual cost and books the usage row in one transaction. */
	chargeAndRecord(subject: Subject, entry: UsageEntry, price: ModelPrice | undefined): Promise<{ cost: number; overdraft: number }>;
	/** Issues this subject's periodic grants now (cheap no-op when they exist). */
	ensureGrants(subject: Subject, force?: boolean): Promise<void>;
	/** Scheduler entry: issues periodic grants for every subject. Returns how many grants were created. */
	issueAll(): Promise<number>;
}

export function createWalletService(deps: ServiceDeps, usage: UsageService): WalletService {
	const issued = new Map<string, number>();
	const nowIso = (): string => new Date(deps.now()).toISOString();

	const ensureGrants = async (subject: Subject, force = false): Promise<void> => {
		const key = `${subject.type}:${subject.id}`;
		const at = deps.now();
		const last = issued.get(key);
		if (!force && last !== undefined && at - last < ISSUE_CACHE_MS && at >= last) return;
		await deps.db.tx({ system: true }, (q) => issuePeriodGrants(q, at, subject));
		issued.set(key, at);
	};

	const chargeAndRecord = async (subject: Subject, entry: UsageEntry, price: ModelPrice | undefined, reservation?: Reservation): Promise<{ cost: number; overdraft: number }> => {
		const cost = price ? computeCost(price, entry.inputTokens, entry.outputTokens) : 0;
		const overdraft = await deps.db.tx({ system: true }, async (q) => {
			const result = await consume(q, subject, cost, nowIso());
			await usage.record({ ...entry, costCredits: cost, subjectType: subject.type, subjectId: subject.id, overdraftCredits: result.overdraft }, q);
			if (reservation) await q.query("DELETE FROM credit_reservations WHERE id = $1", [reservation.id]);
			return result.overdraft;
		});
		return { cost, overdraft };
	};

	return {
		async priceFor(model, gatewayId) {
			const rows = await deps.db.query<{ input_price: string | number; output_price: string | number }>(
				`SELECT input_price, output_price FROM model_prices
				 WHERE (model = $1 AND gateway_id = $2) OR (model = $1 AND gateway_id IS NULL) OR (model = '*' AND gateway_id IS NULL)
				 ORDER BY (model <> '*') DESC, (gateway_id IS NOT NULL) DESC LIMIT 1`,
				[model, gatewayId],
			);
			const r = rows[0];
			return r ? { inputPrice: Number(r.input_price), outputPrice: Number(r.output_price) } : undefined;
		},

		balance: (subject) => deps.db.tx({ system: true }, (q) => balanceOf(q, subject, nowIso())),

		async precheck(subject, price, maxOutputTokens) {
			if (!price) return;
			const estimate = estimateCost(price, maxOutputTokens);
			if (estimate <= 0) return;
			await ensureGrants(subject);
			const balance = await deps.db.tx({ system: true }, (q) => balanceOf(q, subject, nowIso()));
			if (balance < estimate) throw new HubError(402, "insufficientCredits", "额度不足，请充值或升级套餐");
		},

		async reserve(subject, estimatedCost, ttlMs = RESERVATION_TTL_MS) {
			const amount = Math.max(0, Math.ceil(estimatedCost));
			if (amount === 0) return undefined;
			return deps.db.tx({ system: true }, (q) => reserveCredits(q, subject, amount, deps.now(), ttlMs));
		},

		commit: (reservation, subject, entry, price) => chargeAndRecord(subject, entry, price, reservation),

		async release(reservation) {
			if (!reservation) return;
			await deps.db.tx({ system: true }, (q) => q.query("DELETE FROM credit_reservations WHERE id = $1", [reservation.id]));
		},

		chargeAndRecord: (subject, entry, price) => chargeAndRecord(subject, entry, price),

		ensureGrants,

		async issueAll() {
			const n = await deps.db.tx({ system: true }, (q) => issuePeriodGrants(q, deps.now()));
			issued.clear();
			return n;
		},
	};
}
