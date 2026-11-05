import { Type } from "typebox";
import type { HubDeps } from "../deps.ts";
import { Reply, type Router } from "../http/router.ts";
import { createRuntime } from "../runtime/index.ts";
import { NameSchema } from "./schemas.ts";

const StatusSchema = Type.Union([Type.Literal("active"), Type.Literal("draining"), Type.Literal("offline")]);
const CreateNodeBody = Type.Object({
	name: NameSchema,
	dockerUrl: Type.String({ minLength: 1, maxLength: 500 }),
	tlsDir: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()])),
	cpuCapacity: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 4096 })),
	memCapacityMb: Type.Optional(Type.Integer({ minimum: 256, maximum: 100_000_000 })),
	status: Type.Optional(StatusSchema),
});
const UpdateNodeBody = Type.Object({
	name: Type.Optional(NameSchema),
	dockerUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
	tlsDir: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()])),
	cpuCapacity: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 4096 })),
	memCapacityMb: Type.Optional(Type.Integer({ minimum: 256, maximum: 100_000_000 })),
	status: Type.Optional(StatusSchema),
});
const LimitsBody = Type.Object({
	cpuLimit: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0, maximum: 256 }), Type.Null()])),
	memLimitMb: Type.Optional(Type.Union([Type.Integer({ minimum: 64, maximum: 10_000_000 }), Type.Null()])),
});

const RT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Block 3A: executor nodes, tenant runtimes and the `<base>/rt/*` reverse proxy.
 * Registry name: `runtime` ({ manager, nodes, proxy }).
 */
export function registerRuntimeRoutes(router: Router, deps: HubDeps): void {
	const { manager, nodes, proxy } = createRuntime(deps);

	router.get("/api/admin/nodes", async (ctx) => nodes.list(await ctx.actor()));
	router.post("/api/admin/nodes", async (ctx) => new Reply(201, await nodes.create(await ctx.actor(), await ctx.json(CreateNodeBody))));
	router.put("/api/admin/nodes/:id", async (ctx) => nodes.update(await ctx.actor(), ctx.params.id as string, await ctx.json(UpdateNodeBody)));
	router.post("/api/admin/nodes/:id/drain", async (ctx) => nodes.update(await ctx.actor(), ctx.params.id as string, { status: "draining" }));
	router.post("/api/admin/nodes/:id/ping", async (ctx) => nodes.ping(await ctx.actor(), ctx.params.id as string));
	router.delete("/api/admin/nodes/:id", async (ctx) => {
		await nodes.remove(await ctx.actor(), ctx.params.id as string);
		return {};
	});

	router.get("/api/admin/runtimes", async (ctx) => {
		const actor = await ctx.actor();
		return { items: await manager.list(actor), ...(await manager.drivers()) };
	});
	router.post("/api/admin/runtimes/:userId/stop", async (ctx) => manager.adminStop(await ctx.actor(), ctx.params.userId as string));
	router.put("/api/admin/runtimes/:userId/limits", async (ctx) => {
		const actor = await ctx.actor();
		const body = await ctx.json(LimitsBody);
		return manager.setLimits(actor, ctx.params.userId as string, body);
	});

	// The caller's own tenant: status for the workbench entry, and an explicit warm-up.
	router.get("/api/runtime", async (ctx) => manager.me(await ctx.actor()));
	router.post("/api/runtime/start", async (ctx) => {
		const actor = await ctx.actor();
		await manager.ensureRunning(actor.userId);
		return manager.me(actor);
	});

	// The proxy authenticates itself (bearer, cookie or ?token=), so the generic bearer check must not run first.
	for (const method of RT_METHODS) router.route(method, "/rt/*", (ctx) => proxy.handle(ctx), { auth: "none" });
}
