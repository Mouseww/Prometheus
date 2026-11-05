import type { IncomingMessage } from "node:http";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { JWT_AUDIENCE } from "../config.ts";
import type { HubDeps } from "../deps.ts";
import { HubError, notFound, validationError } from "../errors.ts";
import { enforcePushRules, serveGitRequest } from "../git/http-backend.ts";
import { createTeamNotifier } from "../git/notify.ts";
import { createGitRuntime } from "../git/runtime.ts";
import { createUpstreamSync, UPSTREAM_POLL_INTERVAL_MS } from "../git/upstream.ts";
import { readJsonBody } from "../http/context.ts";
import { HANDLED, type Handler, Reply, type Router } from "../http/router.ts";
import { verifyJwt } from "../jwt.ts";
import { LOG_PREFIX } from "../log.ts";
import { can } from "../permissions.ts";
import { scopeOf } from "../services/common.ts";
import { createMergeRequestsService } from "../services/merge-requests.ts";
import { createWorkspacesService } from "../services/workspaces.ts";
import { IdSchema, NameSchema } from "./schemas.ts";

const CreateWorkspaceBody = Type.Object({
	name: NameSchema,
	importUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
	upstreamUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
	upstreamToken: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
});

const UpdateWorkspaceBody = Type.Object({
	name: Type.Optional(NameSchema),
	dailyReportTime: Type.Optional(Type.String({ maxLength: 5 })),
	dailyReportTz: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	dailyReportEnabled: Type.Optional(Type.Boolean()),
	upstreamUrl: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()])),
	upstreamToken: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 1000 }), Type.Null()])),
});

const FilesQuery = Type.Object({ ref: Type.Optional(Type.String({ maxLength: 200 })), path: Type.Optional(Type.String({ maxLength: 1000 })) });

const CreateMrBody = Type.Object({
	sessionId: Type.Optional(IdSchema),
	title: Type.String({ minLength: 1, maxLength: 200 }),
	description: Type.Optional(Type.String({ maxLength: 20000 })),
	branch: Type.String({ minLength: 1, maxLength: 200 }),
	baseCommit: Type.String({ minLength: 40, maxLength: 40 }),
	headCommit: Type.String({ minLength: 40, maxLength: 40 }),
	skipReview: Type.Optional(Type.Boolean()),
});

const MrListQuery = Type.Object({
	status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("approved"), Type.Literal("merged"), Type.Literal("rejected"), Type.Literal("conflict"), Type.Literal("closed")])),
});

/** The head commit the reviewer looked at; approval fails with 409 `headChanged` if the request moved since. */
const ApproveBody = Type.Object({ expectedHeadCommit: Type.String({ minLength: 40, maxLength: 40 }) });

const RejectBody = Type.Object({ reason: Type.Optional(Type.String({ maxLength: 2000 })) });

const GIT_REALM = { "www-authenticate": 'Basic realm="Prometheus Hub"' };

/** Access token from `Authorization: Bearer <token>` or HTTP Basic (any user name, token as the password). */
function gitCredential(req: IncomingMessage): string | undefined {
	const header = req.headers.authorization;
	if (!header) return undefined;
	const bearer = /^Bearer\s+(.+)$/i.exec(header);
	if (bearer) return bearer[1]?.trim();
	const basic = /^Basic\s+(.+)$/i.exec(header);
	if (!basic) return undefined;
	const decoded = Buffer.from(basic[1] as string, "base64").toString("utf8");
	const colon = decoded.indexOf(":");
	return colon >= 0 ? decoded.slice(colon + 1) : undefined;
}

/**
 * Block 2B: workspaces, git smart HTTP (`/git/<workspaceId>.git/*`), merge requests, diff and file browsing.
 * Registers `workspaces`, `mergeRequests` and `upstreamSync` in the service registry for other blocks.
 */
export function registerGitRoutes(router: Router, deps: HubDeps): void {
	const { services, db, log } = deps;
	const base = { db, log, now: deps.now };
	const runtime = createGitRuntime(deps.config, log, deps.config.allowLocalGitRemotes);
	const notifier = createTeamNotifier(deps);
	const workspaces = deps.registry.register("workspaces", createWorkspacesService(base, services.audit, services.teams, runtime, deps.secretBox));
	const upstream = deps.registry.register("upstreamSync", createUpstreamSync({ log, workspaces, runtime, notifier }));
	const mergeRequests = deps.registry.register(
		"mergeRequests",
		createMergeRequestsService({ base, audit: services.audit, workspaces, runtime, notifier, upstream }),
	);

	// Merges that were mid-flight when the previous process stopped go back to review.
	const startup = runtime.caps
		.then(() => mergeRequests.resetInterrupted())
		.then((n) => {
			if (n > 0) log.warn(`${LOG_PREFIX} 已将 ${n} 个中断的合并请求恢复为待审核`);
		})
		.catch((err: unknown) => log.warn(`${LOG_PREFIX} 恢复中断的合并请求失败: ${err instanceof Error ? err.message : String(err)}`));
	deps.onClose(() => startup);

	const timer = setInterval(() => {
		upstream.syncAll().catch((err: unknown) => log.warn(`${LOG_PREFIX} 上游同步出错: ${err instanceof Error ? err.message : String(err)}`));
	}, UPSTREAM_POLL_INTERVAL_MS);
	timer.unref();
	deps.onClose(() => clearInterval(timer));

	// Workspaces
	router.get("/api/teams/:id/workspaces", async (ctx) => workspaces.listForTeam(await ctx.actor(), ctx.params.id as string));
	router.post("/api/teams/:id/workspaces", async (ctx) => {
		const body = await ctx.json(CreateWorkspaceBody);
		return new Reply(201, await workspaces.create(await ctx.actor(), ctx.params.id as string, body));
	});
	router.get("/api/workspaces/:id", async (ctx) => workspaces.get(await ctx.actor(), ctx.params.id as string));
	router.patch("/api/workspaces/:id", async (ctx) => workspaces.update(await ctx.actor(), ctx.params.id as string, await ctx.json(UpdateWorkspaceBody)));
	router.get("/api/workspaces/:id/files", async (ctx) => {
		const q = ctx.query(FilesQuery);
		return workspaces.browse(await ctx.actor(), ctx.params.id as string, q.ref, q.path);
	});

	// Merge requests
	router.get("/api/workspaces/:id/merge-requests", async (ctx) => mergeRequests.list(await ctx.actor(), ctx.params.id as string, ctx.query(MrListQuery)));
	router.post("/api/workspaces/:id/merge-requests", async (ctx) => {
		const body = await ctx.json(CreateMrBody);
		return new Reply(201, await mergeRequests.create(await ctx.actor(), ctx.params.id as string, body));
	});
	router.get("/api/merge-requests/:id", async (ctx) => mergeRequests.get(await ctx.actor(), ctx.params.id as string));
	router.get("/api/merge-requests/:id/diff", async (ctx) => mergeRequests.diff(await ctx.actor(), ctx.params.id as string));
	router.post("/api/merge-requests/:id/approve", async (ctx) => {
		const actor = await ctx.actor();
		const body = await ctx.json(ApproveBody);
		return mergeRequests.approve(actor, ctx.params.id as string, body.expectedHeadCommit);
	});
	router.post("/api/merge-requests/:id/reject", async (ctx) => {
		// The body is optional: an empty request rejects without a reason.
		const raw = (await readJsonBody(ctx.req)) ?? {};
		if (!Value.Check(RejectBody, raw)) throw validationError("参数 reason 无效");
		return mergeRequests.reject(await ctx.actor(), ctx.params.id as string, raw.reason);
	});
	router.post("/api/merge-requests/:id/refresh", async (ctx) => mergeRequests.refresh(await ctx.actor(), ctx.params.id as string));
	router.post("/api/merge-requests/:id/close", async (ctx) => mergeRequests.close(await ctx.actor(), ctx.params.id as string));

	// git smart HTTP. Route auth is "none": the credential (Basic password or Bearer) is the Hub access token.
	const gitHandler: Handler = async (ctx) => {
		const repo = /^([0-9A-Za-z]{1,64})\.git$/.exec(ctx.params.repo ?? "");
		if (!repo) throw notFound("仓库不存在");
		const workspaceId = repo[1] as string;
		const token = gitCredential(ctx.req);
		const claims = token ? verifyJwt(token, { publicKey: deps.publicKeyPem, issuer: deps.config.issuer, audience: JWT_AUDIENCE }) : undefined;
		if (!claims) throw new HubError(401, "invalidToken", token ? "访问令牌无效或已过期" : "需要登录", GIT_REALM);
		const actor = await services.actors.load(claims.sub);
		// Visibility check doubles as the team membership check; outsiders see the same 404 as for a missing repository.
		const ws = await db.tx(scopeOf(actor), (q) => workspaces.require(q, actor, workspaceId)).catch((err: unknown) => {
			if (err instanceof HubError && err.status === 404) throw notFound("仓库不存在");
			throw err;
		});
		if (!can(actor, "team.view", { teamId: ws.teamId, orgId: ws.orgId })) throw notFound("仓库不存在");
		await runtime.requireGit();
		await serveGitRequest({
			req: ctx.req,
			res: ctx.res,
			reposRoot: runtime.reposRoot,
			workspaceId,
			userId: actor.userId,
			rest: ctx.params["*"] ?? "",
			log,
			onPush: (commands) => enforcePushRules(actor.userId, commands),
		});
		return HANDLED;
	};
	router.get("/git/:repo/*", gitHandler, { auth: "none" });
	router.post("/git/:repo/*", gitHandler, { auth: "none" });
}
