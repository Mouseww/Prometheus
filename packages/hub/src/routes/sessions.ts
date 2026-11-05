import type { IncomingMessage } from "node:http";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { HubDeps } from "../deps.ts";
import { badRequest, HubError, validationError } from "../errors.ts";
import { Reply, type Router } from "../http/router.ts";
import { createInternalLlm } from "../llm/internal.ts";
import { createReportScheduler } from "../scheduler.ts";
import { createBoardService } from "../services/board.ts";
import type { ServiceDeps } from "../services/common.ts";
import { createNotificationsService } from "../services/notifications.ts";
import { createReportsService } from "../services/reports.ts";
import { createSessionsService, MAX_EVENTS_PER_BATCH, MAX_TRANSCRIPT_CHARS } from "../services/sessions.ts";
import { createWsGateway } from "../ws.ts";
import { registerCollabRoutes } from "./collab.ts";
import { optionalJson, sharedUsage } from "./collab-util.ts";
import { IdSchema } from "./schemas.ts";

const StatusSchema = Type.Union([Type.Literal("running"), Type.Literal("waiting"), Type.Literal("idle"), Type.Literal("offline")]);

const RegisterBody = Type.Object({
	localSessionId: Type.String({ minLength: 1, maxLength: 200 }),
	serverId: Type.String({ minLength: 1, maxLength: 200 }),
	title: Type.Optional(Type.String({ maxLength: 300 })),
	branch: Type.String({ minLength: 1, maxLength: 255 }),
	baseCommit: Type.String({ maxLength: 64 }),
	forkedFrom: Type.Optional(IdSchema),
	execLocation: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{1,32}$" })),
});

const PatchBody = Type.Object({
	title: Type.Optional(Type.String({ maxLength: 300 })),
	status: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("waiting"), Type.Literal("idle")])),
	snapshotCommit: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	lastActivity: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	localSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	serverId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

const EventsBody = Type.Object({
	events: Type.Array(Type.Object({ seq: Type.Integer({ minimum: 0 }), kind: Type.String({ minLength: 1, maxLength: 64 }), payload: Type.Optional(Type.Unknown()) }), {
		maxItems: MAX_EVENTS_PER_BATCH,
	}),
});

const TranscriptBody = Type.Object({ format: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })), content: Type.String() });
const GrantBody = Type.Object({ userId: IdSchema });
const ActionBody = Type.Object({
	type: Type.Union([Type.Literal("prompt"), Type.Literal("respond"), Type.Literal("abort")]),
	text: Type.Optional(Type.String({ maxLength: 100_000 })),
	requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	response: Type.Optional(Type.Unknown()),
});
const ForkBody = Type.Object({ title: Type.Optional(Type.String({ maxLength: 300 })) });

const ListQuery = Type.Object({ status: Type.Optional(StatusSchema), owner: Type.Optional(IdSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) });
const EventsQuery = Type.Object({ after: Type.Optional(Type.Integer({ minimum: -1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) });

/** JSON body with an explicit size limit (the shared reader stops at 1MB, a transcript may be 20MB). */
async function readLimitedJson(req: IncomingMessage, limitBytes: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > limitBytes) throw new HubError(413, "payloadTooLarge", "请求体过大");
		chunks.push(buf);
	}
	if (size === 0) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw badRequest("请求体不是有效的 JSON", "invalidJson");
	}
}

/**
 * Block 2C collaboration surface: session mirror, grants, relay, fork, notifications, board, daily reports and the WebSocket.
 * Registry names (resolve lazily, this runs after 2B's `registerGitRoutes`): `realtime`, `notifications`, `sessions`, `board`, `reports`, `reportScheduler`, `usage`.
 */
export function registerSessionRoutes(router: Router, deps: HubDeps): void {
	const base: ServiceDeps = { db: deps.db, log: deps.log, now: deps.now };
	const { audit, actors } = deps.services;

	const realtime = deps.registry.register("realtime", createWsGateway(deps));
	const notifications = deps.registry.register("notifications", createNotificationsService(base, realtime));
	const sessions = deps.registry.register("sessions", createSessionsService(base, { audit, actors, notifications, realtime }));
	realtime.setHandlers({
		canSubscribe: (userId, topic) => sessions.canSubscribe(userId, topic),
		onOnline: (userId) => sessions.markOwnerOnline(userId),
		ownersWithLiveSessions: () => sessions.ownersWithLiveSessions(),
		markOwnerOffline: (userId) => sessions.markOwnerOffline(userId),
	});
	deps.setUpgradeHandler(realtime.handleUpgrade);
	deps.onClose(() => realtime.close());

	const board = deps.registry.register("board", createBoardService(base, realtime));
	const reports = deps.registry.register("reports", createReportsService(base, createInternalLlm(deps, sharedUsage(deps)), realtime));
	const scheduler = deps.registry.register("reportScheduler", createReportScheduler(deps, reports));
	deps.onClose(() => scheduler.stop());

	router.post("/api/workspaces/:id/sessions", async (ctx) => {
		const { session, created } = await sessions.register(await ctx.actor(), ctx.params.id as string, await ctx.json(RegisterBody));
		return new Reply(created ? 201 : 200, session);
	});
	router.get("/api/workspaces/:id/sessions", async (ctx) => sessions.list(await ctx.actor(), ctx.params.id as string, ctx.query(ListQuery)));
	router.get("/api/sessions/:id", async (ctx) => sessions.get(await ctx.actor(), ctx.params.id as string));
	router.patch("/api/sessions/:id", async (ctx) => sessions.patch(await ctx.actor(), ctx.params.id as string, await ctx.json(PatchBody)));

	router.post("/api/sessions/:id/events", async (ctx) => {
		const body = await ctx.json(EventsBody);
		return sessions.appendEvents(await ctx.actor(), ctx.params.id as string, body.events.map((e) => ({ seq: e.seq, kind: e.kind, payload: e.payload ?? {} })));
	});
	router.get("/api/sessions/:id/events", async (ctx) => sessions.listEvents(await ctx.actor(), ctx.params.id as string, ctx.query(EventsQuery)));

	router.put("/api/sessions/:id/transcript", async (ctx) => {
		const raw = await readLimitedJson(ctx.req, MAX_TRANSCRIPT_CHARS + 64 * 1024);
		if (!Value.Check(TranscriptBody, raw)) throw validationError("请求参数无效: 需要 content");
		return sessions.putTranscript(await ctx.actor(), ctx.params.id as string, { format: raw.format ?? "pi-jsonl", content: raw.content });
	});
	router.get("/api/sessions/:id/transcript", async (ctx) => sessions.getTranscript(await ctx.actor(), ctx.params.id as string));

	router.get("/api/sessions/:id/grants", async (ctx) => sessions.listGrants(await ctx.actor(), ctx.params.id as string));
	router.post("/api/sessions/:id/grants", async (ctx) => new Reply(201, await sessions.grant(await ctx.actor(), ctx.params.id as string, (await ctx.json(GrantBody)).userId)));
	router.delete("/api/sessions/:id/grants/:userId", async (ctx) => {
		await sessions.revokeGrant(await ctx.actor(), ctx.params.id as string, ctx.params.userId as string);
		return {};
	});

	router.post("/api/sessions/:id/actions", async (ctx) => {
		const body = await ctx.json(ActionBody);
		if (body.type === "prompt" && !body.text?.trim()) throw validationError("prompt 需要非空的 text");
		if (body.type === "respond" && (!body.requestId || body.response === undefined)) throw validationError("respond 需要 requestId 和 response");
		return sessions.relay(await ctx.actor(), ctx.params.id as string, { type: body.type, text: body.text, requestId: body.requestId, response: body.response });
	});

	router.post("/api/sessions/:id/fork", async (ctx) => {
		const body = await optionalJson(ctx.req, ForkBody);
		return new Reply(201, await sessions.fork(await ctx.actor(), ctx.params.id as string, { title: body.title }));
	});

	registerCollabRoutes(router, { notifications, board, reports });
}
