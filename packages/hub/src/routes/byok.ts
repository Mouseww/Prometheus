import { Type } from "typebox";
import type { HubDeps } from "../deps.ts";
import { Reply, type Router } from "../http/router.ts";
import { type ByokService, createByokService, safeUrlPolicyOf } from "../services/byok.ts";
import { IdSchema, NameSchema } from "./schemas.ts";

const FormatSchema = Type.Union([Type.Literal("openai"), Type.Literal("anthropic"), Type.Literal("gemini")]);
const ModelsSchema = Type.Array(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }), name: Type.Optional(Type.String({ maxLength: 200 })) })]), {
	maxItems: 500,
});

const CreateBody = Type.Object({
	name: NameSchema,
	format: FormatSchema,
	baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
	apiKey: Type.String({ minLength: 1, maxLength: 2000 }),
	models: Type.Optional(ModelsSchema),
	enabled: Type.Optional(Type.Boolean()),
});
const UpdateBody = Type.Object({
	name: Type.Optional(NameSchema),
	format: Type.Optional(FormatSchema),
	baseUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	models: Type.Optional(ModelsSchema),
	enabled: Type.Optional(Type.Boolean()),
});
const SettingQuery = Type.Object({ orgId: Type.Optional(IdSchema) });
const SettingBody = Type.Object({
	scope: Type.Union([Type.Literal("platform"), Type.Literal("org")]),
	orgId: Type.Optional(IdSchema),
	allowed: Type.Union([Type.Boolean(), Type.Null()]),
});

/**
 * Block 4C: personal gateways (bring your own key) at `/api/me/gateways`, and the BYOK switch at `/api/admin/byok`.
 * Registry name: `byok`. The LLM proxy picks the service up from the registry.
 */
export function registerByokRoutes(router: Router, deps: HubDeps): void {
	const base = { db: deps.db, log: deps.log, now: deps.now };
	const byok: ByokService = deps.registry.register("byok", createByokService(base, deps.secretBox, deps.services.audit, deps.services.settings, safeUrlPolicyOf(deps.config)));

	router.get("/api/me/gateways", async (ctx) => byok.list(await ctx.actor()));
	router.post("/api/me/gateways", async (ctx) => new Reply(201, await byok.create(await ctx.actor(), await ctx.json(CreateBody))));
	router.put("/api/me/gateways/:id", async (ctx) => byok.update(await ctx.actor(), ctx.params.id as string, await ctx.json(UpdateBody)));
	router.delete("/api/me/gateways/:id", async (ctx) => {
		await byok.remove(await ctx.actor(), ctx.params.id as string);
		return {};
	});
	router.get("/api/me/byok", async (ctx) => {
		const actor = await ctx.actor();
		return { allowed: await byok.isAllowed(Object.keys(actor.orgRoles)) };
	});

	router.get("/api/admin/byok", async (ctx) => byok.getSettings(await ctx.actor(), ctx.query(SettingQuery).orgId));
	router.put("/api/admin/byok", async (ctx) => byok.setAllowed(await ctx.actor(), await ctx.json(SettingBody)));
}
