import { isUniqueViolation, toIso } from "../db/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { ulid } from "../ids.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { AuditService } from "../services/audit.ts";
import { type ServiceDeps, scopeOf } from "../services/common.ts";
import type { SettingsService } from "../services/settings.ts";
import { BILLING_SETTINGS_KEY, type BillingSettings, DEFAULT_BILLING_SETTINGS } from "./orders.ts";
import type { Subject } from "./providers/provider.ts";

export interface PlanView {
	id: string;
	name: string;
	period: "month" | "year";
	priceCents: number;
	currency: string;
	monthlyCredits: number;
	features: Record<string, unknown>;
	active: boolean;
}

export interface PlanInput {
	name: string;
	period: "month" | "year";
	priceCents: number;
	currency: string;
	monthlyCredits: number;
	features?: Record<string, unknown>;
	active?: boolean;
}

export interface PriceView {
	id: string;
	model: string;
	gatewayId: string | null;
	inputPrice: number;
	outputPrice: number;
	currencyNote: string | null;
}

export interface PriceInput {
	model: string;
	gatewayId?: string | null;
	inputPrice: number;
	outputPrice: number;
	currencyNote?: string | null;
}

export interface CatalogService {
	listPlans(actor: Actor, opts: { includeInactive: boolean }): Promise<PlanView[]>;
	createPlan(actor: Actor, input: PlanInput): Promise<PlanView>;
	updatePlan(actor: Actor, id: string, input: Partial<PlanInput>): Promise<PlanView>;
	deletePlan(actor: Actor, id: string): Promise<void>;
	listPrices(actor: Actor): Promise<PriceView[]>;
	/** Creates a price, or replaces the one that exists for the same model and gateway. */
	upsertPrice(actor: Actor, input: PriceInput): Promise<PriceView>;
	updatePrice(actor: Actor, id: string, input: Partial<PriceInput>): Promise<PriceView>;
	deletePrice(actor: Actor, id: string): Promise<void>;
	getSettings(actor: Actor): Promise<BillingSettings>;
	setSettings(actor: Actor, patch: Partial<BillingSettings>): Promise<BillingSettings>;
	/** Operator top-up or compensation: a grant with source `admin`. */
	grantCredits(actor: Actor, input: { subject: Subject; credits: number; expiresAt?: string | null }): Promise<{ id: string }>;
}

interface PlanRow {
	id: string;
	name: string;
	period: "month" | "year";
	price_cents: string | number;
	currency: string;
	monthly_credits: string | number;
	features: Record<string, unknown>;
	active: boolean;
}
const PLAN_COLUMNS = "id, name, period, price_cents, currency, monthly_credits, features, active";
const toPlan = (r: PlanRow): PlanView => ({
	id: r.id,
	name: r.name,
	period: r.period,
	priceCents: Number(r.price_cents),
	currency: r.currency,
	monthlyCredits: Number(r.monthly_credits),
	features: r.features ?? {},
	active: r.active,
});

interface PriceRow {
	id: string;
	model: string;
	gateway_id: string | null;
	input_price: string | number;
	output_price: string | number;
	currency_note: string | null;
}
const PRICE_COLUMNS = "id, model, gateway_id, input_price, output_price, currency_note";
const toPrice = (r: PriceRow): PriceView => ({
	id: r.id,
	model: r.model,
	gatewayId: r.gateway_id,
	inputPrice: Number(r.input_price),
	outputPrice: Number(r.output_price),
	currencyNote: r.currency_note,
});

const isForeignKeyViolation = (err: unknown): boolean => typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23503";

export function createCatalogService(deps: ServiceDeps, audit: AuditService, settings: SettingsService): CatalogService {
	const requireOperator = (actor: Actor): void => {
		if (!can(actor, "platform.manage")) throw forbidden();
	};

	const loadSettings = async (): Promise<BillingSettings> => ({ ...DEFAULT_BILLING_SETTINGS, ...((await settings.get<Partial<BillingSettings>>(BILLING_SETTINGS_KEY)) ?? {}) });

	return {
		async listPlans(actor, opts) {
			if (opts.includeInactive) requireOperator(actor);
			const rows = await deps.db.tx(scopeOf(actor), (q) =>
				q.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans ${opts.includeInactive ? "" : "WHERE active"} ORDER BY price_cents, id`),
			);
			return rows.map(toPlan);
		},

		async createPlan(actor, input) {
			requireOperator(actor);
			const id = ulid(deps.now());
			const row = await deps.db.tx(scopeOf(actor), async (q) => {
				const rows = await q.query<PlanRow>(
					`INSERT INTO plans (id, name, period, price_cents, currency, monthly_credits, features, active) VALUES ($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8) RETURNING ${PLAN_COLUMNS}`,
					[id, input.name, input.period, input.priceCents, input.currency.toLowerCase(), input.monthlyCredits, JSON.stringify(input.features ?? {}), input.active ?? true],
				);
				await audit.write(q, { actorId: actor.userId, action: "plan.create", targetType: "plan", targetId: id, detail: { name: input.name, priceCents: input.priceCents } });
				return rows[0] as PlanRow;
			});
			return toPlan(row);
		},

		async updatePlan(actor, id, input) {
			requireOperator(actor);
			if (id === "free" && (input.active === false || (input.priceCents !== undefined && input.priceCents !== 0) || (input.period !== undefined && input.period !== "month"))) {
				throw badRequest("免费套餐不能下架，也不能改价或改周期", "freePlanLocked");
			}
			const row = await deps.db.tx(scopeOf(actor), async (q) => {
				const sets: string[] = [];
				const params: unknown[] = [id];
				const set = (column: string, value: unknown, cast = ""): void => {
					params.push(value);
					sets.push(`${column} = $${params.length}${cast}`);
				};
				if (input.name !== undefined) set("name", input.name);
				if (input.period !== undefined) set("period", input.period);
				if (input.priceCents !== undefined) set("price_cents", input.priceCents);
				if (input.currency !== undefined) set("currency", input.currency.toLowerCase());
				if (input.monthlyCredits !== undefined) set("monthly_credits", input.monthlyCredits);
				if (input.features !== undefined) set("features", JSON.stringify(input.features), "::text::jsonb");
				if (input.active !== undefined) set("active", input.active);
				const rows =
					sets.length === 0
						? await q.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1`, [id])
						: await q.query<PlanRow>(`UPDATE plans SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${PLAN_COLUMNS}`, params);
				if (!rows[0]) throw notFound("套餐不存在");
				if (sets.length > 0) await audit.write(q, { actorId: actor.userId, action: "plan.update", targetType: "plan", targetId: id, detail: { fields: Object.keys(input) } });
				return rows[0];
			});
			return toPlan(row);
		},

		async deletePlan(actor, id) {
			requireOperator(actor);
			if (id === "free") throw badRequest("免费套餐不能删除", "freePlanLocked");
			try {
				await deps.db.tx(scopeOf(actor), async (q) => {
					const rows = await q.query("DELETE FROM plans WHERE id = $1 RETURNING id", [id]);
					if (rows.length === 0) throw notFound("套餐不存在");
					await audit.write(q, { actorId: actor.userId, action: "plan.delete", targetType: "plan", targetId: id });
				});
			} catch (err) {
				if (isForeignKeyViolation(err)) throw conflict("套餐已有订单或订阅，请改为下架", "planInUse");
				throw err;
			}
		},

		async listPrices(actor) {
			requireOperator(actor);
			const rows = await deps.db.tx(scopeOf(actor), (q) => q.query<PriceRow>(`SELECT ${PRICE_COLUMNS} FROM model_prices ORDER BY model, gateway_id NULLS FIRST`));
			return rows.map(toPrice);
		},

		async upsertPrice(actor, input) {
			requireOperator(actor);
			const id = ulid(deps.now());
			try {
				const row = await deps.db.tx(scopeOf(actor), async (q) => {
					const rows = await q.query<PriceRow>(
						`INSERT INTO model_prices (id, model, gateway_id, input_price, output_price, currency_note) VALUES ($1,$2,$3,$4,$5,$6)
						 ON CONFLICT (model, (coalesce(gateway_id, ''))) DO UPDATE SET input_price = EXCLUDED.input_price, output_price = EXCLUDED.output_price, currency_note = EXCLUDED.currency_note, updated_at = now()
						 RETURNING ${PRICE_COLUMNS}`,
						[id, input.model, input.gatewayId ?? null, input.inputPrice, input.outputPrice, input.currencyNote ?? null],
					);
					await audit.write(q, { actorId: actor.userId, action: "price.set", targetType: "price", targetId: (rows[0] as PriceRow).id, detail: { model: input.model, gatewayId: input.gatewayId ?? null } });
					return rows[0] as PriceRow;
				});
				return toPrice(row);
			} catch (err) {
				if (isForeignKeyViolation(err)) throw notFound("网关不存在");
				throw err;
			}
		},

		async updatePrice(actor, id, input) {
			requireOperator(actor);
			try {
				const row = await deps.db.tx(scopeOf(actor), async (q) => {
					const sets: string[] = [];
					const params: unknown[] = [id];
					const set = (column: string, value: unknown): void => {
						params.push(value);
						sets.push(`${column} = $${params.length}`);
					};
					if (input.model !== undefined) set("model", input.model);
					if (input.gatewayId !== undefined) set("gateway_id", input.gatewayId);
					if (input.inputPrice !== undefined) set("input_price", input.inputPrice);
					if (input.outputPrice !== undefined) set("output_price", input.outputPrice);
					if (input.currencyNote !== undefined) set("currency_note", input.currencyNote);
					const rows =
						sets.length === 0
							? await q.query<PriceRow>(`SELECT ${PRICE_COLUMNS} FROM model_prices WHERE id = $1`, [id])
							: await q.query<PriceRow>(`UPDATE model_prices SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${PRICE_COLUMNS}`, params);
					if (!rows[0]) throw notFound("价格不存在");
					if (sets.length > 0) await audit.write(q, { actorId: actor.userId, action: "price.update", targetType: "price", targetId: id, detail: { fields: Object.keys(input) } });
					return rows[0];
				});
				return toPrice(row);
			} catch (err) {
				if (isUniqueViolation(err)) throw conflict("该模型和网关已有价格", "priceExists");
				if (isForeignKeyViolation(err)) throw notFound("网关不存在");
				throw err;
			}
		},

		async deletePrice(actor, id) {
			requireOperator(actor);
			await deps.db.tx(scopeOf(actor), async (q) => {
				const rows = await q.query("DELETE FROM model_prices WHERE id = $1 RETURNING id", [id]);
				if (rows.length === 0) throw notFound("价格不存在");
				await audit.write(q, { actorId: actor.userId, action: "price.delete", targetType: "price", targetId: id });
			});
		},

		async getSettings(actor) {
			requireOperator(actor);
			return loadSettings();
		},

		async setSettings(actor, patch) {
			requireOperator(actor);
			const next = { ...(await loadSettings()), ...patch };
			await deps.db.tx(scopeOf(actor), async (q) => {
				await settings.set(q, BILLING_SETTINGS_KEY, next);
				await audit.write(q, { actorId: actor.userId, action: "billing.settings", targetType: "platform", detail: { ...patch } });
			});
			return next;
		},

		async grantCredits(actor, input) {
			requireOperator(actor);
			const id = ulid(deps.now());
			if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) throw badRequest("expiresAt 不是有效的日期", "validationError");
			await deps.db.tx({ system: true }, async (q) => {
				const exists = await q.query(input.subject.type === "user" ? "SELECT 1 FROM users WHERE id = $1" : "SELECT 1 FROM organizations WHERE id = $1", [input.subject.id]);
				if (exists.length === 0) throw notFound(input.subject.type === "user" ? "用户不存在" : "企业不存在");
				await q.query("INSERT INTO credit_grants (id, subject_type, subject_id, source, amount, remaining, expires_at) VALUES ($1,$2,$3,'admin',$4,$4,$5::timestamptz)", [
					id,
					input.subject.type,
					input.subject.id,
					input.credits,
					input.expiresAt ? toIso(input.expiresAt) : null,
				]);
				await audit.write(q, {
					actorId: actor.userId,
					orgId: input.subject.type === "org" ? input.subject.id : null,
					action: "credits.grant",
					targetType: input.subject.type,
					targetId: input.subject.id,
					detail: { credits: input.credits, expiresAt: input.expiresAt ?? null },
				});
			});
			return { id };
		},
	};
}
