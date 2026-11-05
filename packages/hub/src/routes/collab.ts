import { Type } from "typebox";
import { Reply, type Router } from "../http/router.ts";
import type { BoardService } from "../services/board.ts";
import type { NotificationsService } from "../services/notifications.ts";
import type { ReportsService } from "../services/reports.ts";
import { optionalJson } from "./collab-util.ts";

const NotificationsQuery = Type.Object({
	unread: Type.Optional(Type.String({ maxLength: 8 })),
	before: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
const ReadBody = Type.Object({
	ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 500 })),
	all: Type.Optional(Type.Boolean()),
});
const DatePattern = "^\\d{4}-\\d{2}-\\d{2}$";
const ReportQuery = Type.Object({ date: Type.Optional(Type.String({ pattern: DatePattern })) });
const GenerateBody = Type.Object({ date: Type.Optional(Type.String({ pattern: DatePattern })) });

/** Notifications, board and daily reports. */
export function registerCollabRoutes(router: Router, svc: { notifications: NotificationsService; board: BoardService; reports: ReportsService }): void {
	const { notifications, board, reports } = svc;

	router.get("/api/notifications", async (ctx) => {
		const q = ctx.query(NotificationsQuery);
		return notifications.list(await ctx.actor(), { unread: q.unread === "1" || q.unread === "true", before: q.before, limit: q.limit });
	});
	router.post("/api/notifications/read", async (ctx) => {
		const body = await ctx.json(ReadBody);
		return notifications.markRead(await ctx.actor(), { ids: body.ids, all: body.all });
	});

	router.get("/api/workspaces/:id/board", async (ctx) => board.get(await ctx.actor(), ctx.params.id as string));

	router.get("/api/workspaces/:id/reports", async (ctx) => reports.get(await ctx.actor(), ctx.params.id as string, ctx.query(ReportQuery).date));
	router.post("/api/workspaces/:id/reports/generate", async (ctx) => {
		const body = await optionalJson(ctx.req, GenerateBody);
		return new Reply(201, await reports.generate(await ctx.actor(), ctx.params.id as string, body.date));
	});
}
