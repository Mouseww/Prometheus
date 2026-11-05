import type { IncomingMessage } from "node:http";
import { Type } from "typebox";
import { type BillingService, createBilling } from "../billing/index.ts";
import type { HubDeps } from "../deps.ts";
import { badRequest, HubError } from "../errors.ts";
import { Reply, type Router } from "../http/router.ts";
import { sharedUsage } from "./collab-util.ts";
import { IdSchema, NameSchema } from "./schemas.ts";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

const CheckoutBody = Type.Object({
	kind: Type.Union([Type.Literal("topup"), Type.Literal("subscription")]),
	planId: Type.Optional(IdSchema),
	credits: Type.Optional(Type.Integer({ minimum: 1 })),
	orgId: Type.Optional(IdSchema),
	provider: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
	successUrl: Type.Optional(Type.String({ maxLength: 2000 })),
	cancelUrl: Type.Optional(Type.String({ maxLength: 2000 })),
});
const RedeemBody = Type.Object({ code: Type.String({ minLength: 1, maxLength: 100 }), orgId: Type.Optional(IdSchema) });
const SummaryQuery = Type.Object({ orgId: Type.Optional(IdSchema) });

const CurrencySchema = Type.String({ pattern: "^[A-Za-z]{3}$" });
const PeriodSchema = Type.Union([Type.Literal("month"), Type.Literal("year")]);
const FeaturesSchema = Type.Record(Type.String(), Type.Unknown());
const PlanBody = Type.Object({
	name: NameSchema,
	period: PeriodSchema,
	priceCents: Type.Integer({ minimum: 0 }),
	currency: CurrencySchema,
	monthlyCredits: Type.Integer({ minimum: 0 }),
	features: Type.Optional(FeaturesSchema),
	active: Type.Optional(Type.Boolean()),
});
const PlanPatch = Type.Object({
	name: Type.Optional(NameSchema),
	period: Type.Optional(PeriodSchema),
	priceCents: Type.Optional(Type.Integer({ minimum: 0 })),
	currency: Type.Optional(CurrencySchema),
	monthlyCredits: Type.Optional(Type.Integer({ minimum: 0 })),
	features: Type.Optional(FeaturesSchema),
	active: Type.Optional(Type.Boolean()),
});

const ModelSchema = Type.String({ minLength: 1, maxLength: 200 });
const PriceNumber = Type.Number({ minimum: 0, maximum: 1e12 });
const PriceBody = Type.Object({
	model: ModelSchema,
	gatewayId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
	inputPrice: PriceNumber,
	outputPrice: PriceNumber,
	currencyNote: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
});
const PricePatch = Type.Object({
	model: Type.Optional(ModelSchema),
	gatewayId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
	inputPrice: Type.Optional(PriceNumber),
	outputPrice: Type.Optional(PriceNumber),
	currencyNote: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
});

const OrderQuery = Type.Object({
	status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("paid"), Type.Literal("failed"), Type.Literal("refunded"), Type.Literal("canceled")])),
	provider: Type.Optional(Type.String({ maxLength: 32 })),
	subjectType: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("org")])),
	subjectId: Type.Optional(IdSchema),
	before: Type.Optional(IdSchema),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

const CodesBody = Type.Object({
	count: Type.Integer({ minimum: 1, maximum: 1000 }),
	credits: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
	maxUses: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
	expiresAt: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
});

const SettingsBody = Type.Object({
	topupCreditsPerCent: Type.Optional(Type.Number({ minimum: 0.001, maximum: 1_000_000 })),
	currency: Type.Optional(CurrencySchema),
	topupExpiryDays: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 3650 }), Type.Null()])),
});

const GrantBody = Type.Object({
	subjectType: Type.Union([Type.Literal("user"), Type.Literal("org")]),
	subjectId: IdSchema,
	credits: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
	expiresAt: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
});

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > MAX_WEBHOOK_BYTES) throw badRequest("请求体过大", "payloadTooLarge");
		chunks.push(buf);
	}
	return Buffer.concat(chunks);
}

/**
 * Block 4B: credits billing. User routes live under `/api/billing`, operator routes under `/api/admin`, and the payment
 * providers call `<base>/billing/webhook/:provider`. Registry name: `billing` (the LLM proxy reads its wallet from there).
 * The user routes and the webhook answer 404 `billingDisabled` unless billing is on (HUB_MODE=public or HUB_BILLING=on).
 */
export function registerBillingRoutes(router: Router, deps: HubDeps): void {
	const base = { db: deps.db, log: deps.log, now: deps.now };
	const billing: BillingService = deps.registry.register(
		"billing",
		createBilling(base, { config: deps.config, audit: deps.services.audit, settings: deps.services.settings, usage: sharedUsage(deps), limiter: deps.limiter, log: deps.log }),
	);
	if (billing.enabled) {
		const stop = billing.startScheduler();
		deps.onClose(stop);
	}
	const enabled = (): void => {
		if (!billing.enabled) throw new HubError(404, "billingDisabled", "计费未启用");
	};

	router.get("/api/billing/plans", async (ctx) => {
		enabled();
		return billing.catalog.listPlans(await ctx.actor(), { includeInactive: false });
	});
	router.get("/api/billing/summary", async (ctx) => {
		enabled();
		return billing.summary(await ctx.actor(), ctx.query(SummaryQuery).orgId);
	});
	router.post("/api/billing/checkout", async (ctx) => {
		enabled();
		return new Reply(201, await billing.orders.checkout(await ctx.actor(), await ctx.json(CheckoutBody)));
	});
	router.post("/api/billing/redeem", async (ctx) => {
		enabled();
		const actor = await ctx.actor();
		const body = await ctx.json(RedeemBody);
		return billing.redeem.redeem(actor, billing.orders.subjectFor(actor, body.orgId), body.code);
	});
	// The provider authenticates itself with a signature over the raw body, so the body must not be parsed first.
	router.post(
		"/billing/webhook/:provider",
		async (ctx) => {
			enabled();
			const raw = await readRawBody(ctx.req);
			const result = await billing.orders.handleWebhook(ctx.params.provider as string, raw, ctx.req.headers);
			return { received: true, outcome: result.outcome };
		},
		{ auth: "none" },
	);

	router.get("/api/admin/plans", async (ctx) => billing.catalog.listPlans(await ctx.actor(), { includeInactive: true }));
	router.post("/api/admin/plans", async (ctx) => new Reply(201, await billing.catalog.createPlan(await ctx.actor(), await ctx.json(PlanBody))));
	router.put("/api/admin/plans/:id", async (ctx) => billing.catalog.updatePlan(await ctx.actor(), ctx.params.id as string, await ctx.json(PlanPatch)));
	router.delete("/api/admin/plans/:id", async (ctx) => {
		await billing.catalog.deletePlan(await ctx.actor(), ctx.params.id as string);
		return {};
	});

	router.get("/api/admin/prices", async (ctx) => billing.catalog.listPrices(await ctx.actor()));
	router.post("/api/admin/prices", async (ctx) => new Reply(201, await billing.catalog.upsertPrice(await ctx.actor(), await ctx.json(PriceBody))));
	router.put("/api/admin/prices/:id", async (ctx) => billing.catalog.updatePrice(await ctx.actor(), ctx.params.id as string, await ctx.json(PricePatch)));
	router.delete("/api/admin/prices/:id", async (ctx) => {
		await billing.catalog.deletePrice(await ctx.actor(), ctx.params.id as string);
		return {};
	});

	router.get("/api/admin/orders", async (ctx) => billing.orders.list(await ctx.actor(), ctx.query(OrderQuery)));
	router.post("/api/admin/orders/:id/mark-paid", async (ctx) => billing.orders.adminSetStatus(await ctx.actor(), ctx.params.id as string, "paid"));
	router.post("/api/admin/orders/:id/mark-refunded", async (ctx) => billing.orders.adminSetStatus(await ctx.actor(), ctx.params.id as string, "refunded"));

	router.get("/api/admin/redeem-codes", async (ctx) => billing.redeem.list(await ctx.actor()));
	// The plaintext codes are in this reply and nowhere else: only their hashes are stored.
	router.post("/api/admin/redeem-codes", async (ctx) => new Reply(201, await billing.redeem.generate(await ctx.actor(), await ctx.json(CodesBody))));

	router.get("/api/admin/billing/settings", async (ctx) => billing.catalog.getSettings(await ctx.actor()));
	router.put("/api/admin/billing/settings", async (ctx) => {
		const patch = await ctx.json(SettingsBody);
		return billing.catalog.setSettings(await ctx.actor(), {
			...(patch.topupCreditsPerCent !== undefined ? { topupCreditsPerCent: patch.topupCreditsPerCent } : {}),
			...(patch.currency !== undefined ? { currency: patch.currency.toLowerCase() } : {}),
			...(patch.topupExpiryDays !== undefined ? { topupExpiryDays: patch.topupExpiryDays } : {}),
		});
	});
	router.post("/api/admin/credits", async (ctx) => {
		const body = await ctx.json(GrantBody);
		return new Reply(201, await billing.catalog.grantCredits(await ctx.actor(), { subject: { type: body.subjectType, id: body.subjectId }, credits: body.credits, expiresAt: body.expiresAt ?? null }));
	});
}
