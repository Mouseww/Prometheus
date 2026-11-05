import { Type } from "typebox";
import type { HubDeps } from "../deps.ts";
import { validationError } from "../errors.ts";
import { Reply, type Router } from "../http/router.ts";
import { createLlmProxy } from "../llm/proxy.ts";
import { createModelsService } from "../services/models.ts";
import { createQuotasService } from "../services/quotas.ts";
import { parseRange } from "../services/usage.ts";
import { sharedUsage } from "./collab-util.ts";
import { IdSchema, NameSchema } from "./schemas.ts";

const FormatSchema = Type.Union([Type.Literal("openai"), Type.Literal("anthropic"), Type.Literal("gemini")]);
const ModelsSchema = Type.Array(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }), name: Type.Optional(Type.String({ maxLength: 200 })) })]), {
	maxItems: 500,
});

const GatewayQuery = Type.Object({ scope: Type.Optional(Type.Union([Type.Literal("platform"), Type.Literal("org")])), orgId: Type.Optional(IdSchema) });
const CreateGatewayBody = Type.Object({
	scope: Type.Union([Type.Literal("platform"), Type.Literal("org")]),
	scopeId: Type.Optional(IdSchema),
	name: NameSchema,
	format: FormatSchema,
	baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
	apiKey: Type.String({ minLength: 1, maxLength: 2000 }),
	models: Type.Optional(ModelsSchema),
	enabled: Type.Optional(Type.Boolean()),
});
const UpdateGatewayBody = Type.Object({
	name: Type.Optional(NameSchema),
	format: Type.Optional(FormatSchema),
	baseUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	models: Type.Optional(ModelsSchema),
	enabled: Type.Optional(Type.Boolean()),
});

const SubjectSchema = Type.Union([Type.Literal("user"), Type.Literal("org")]);
const QuotaQuery = Type.Object({ subjectType: Type.Optional(SubjectSchema), subjectId: Type.Optional(IdSchema) });
const QuotaBody = Type.Object({
	subjectType: SubjectSchema,
	subjectId: IdSchema,
	period: Type.Union([Type.Literal("day"), Type.Literal("month")]),
	limitTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});

const UsageQuery = Type.Object({
	groupBy: Type.Union([Type.Literal("user"), Type.Literal("org"), Type.Literal("day"), Type.Literal("model")]),
	from: Type.Optional(Type.String({ maxLength: 40 })),
	to: Type.Optional(Type.String({ maxLength: 40 })),
});

/**
 * Block 2C model side: gateway admin, quotas, usage, `/api/models` and the `/llm/:format/*` proxy.
 * Registry names: `models`, `quotas`, `usage`.
 */
export function registerModelRoutes(router: Router, deps: HubDeps): void {
	const base = { db: deps.db, log: deps.log, now: deps.now };
	const models = deps.registry.register("models", createModelsService(base, deps.secretBox, deps.services.audit));
	const quotas = deps.registry.register("quotas", createQuotasService(base, deps.services.audit));
	const usage = sharedUsage(deps);

	router.get("/api/admin/gateways", async (ctx) => models.list(await ctx.actor(), ctx.query(GatewayQuery)));
	router.post("/api/admin/gateways", async (ctx) => new Reply(201, await models.create(await ctx.actor(), await ctx.json(CreateGatewayBody))));
	router.put("/api/admin/gateways/:id", async (ctx) => models.update(await ctx.actor(), ctx.params.id as string, await ctx.json(UpdateGatewayBody)));
	router.delete("/api/admin/gateways/:id", async (ctx) => {
		await models.remove(await ctx.actor(), ctx.params.id as string);
		return {};
	});

	router.get("/api/admin/quotas", async (ctx) => quotas.list(await ctx.actor(), ctx.query(QuotaQuery)));
	router.put("/api/admin/quotas", async (ctx) => quotas.set(await ctx.actor(), await ctx.json(QuotaBody)));

	router.get("/api/admin/usage", async (ctx) => {
		const q = ctx.query(UsageQuery);
		let range: { from?: string; to?: string };
		try {
			range = parseRange(q.from, q.to);
		} catch (err) {
			throw validationError(err instanceof Error ? err.message : "日期无效");
		}
		return usage.report(await ctx.actor(), { groupBy: q.groupBy, ...range });
	});

	router.get("/api/models", async (ctx) => models.visibleModels(await ctx.actor()));

	// The proxy authenticates itself (it also accepts x-api-key and x-goog-api-key, which the Anthropic and Gemini SDKs send).
	const proxy = createLlmProxy(deps, quotas, usage);
	router.get("/llm/:format/*", (ctx) => proxy.handle(ctx), { auth: "none" });
	router.post("/llm/:format/*", (ctx) => proxy.handle(ctx), { auth: "none" });
}
