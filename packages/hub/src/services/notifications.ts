import { toIso } from "../db/db.ts";
import { ulid } from "../ids.ts";
import { LOG_PREFIX } from "../log.ts";
import type { Actor } from "../permissions.ts";
import { type ServiceDeps, scopeOf } from "./common.ts";
import type { Realtime } from "./realtime.ts";

export interface NotificationView {
	id: string;
	kind: string;
	payload: Record<string, unknown>;
	readAt: string | null;
	createdAt: string;
}

export interface NotificationsService {
	/**
	 * Stores a notification and pushes it to the user's `user` topic. Best effort: a failure is logged and never thrown,
	 * so callers (merge, grants, fork) do not fail because a notification could not be written.
	 */
	notify(userId: string, kind: string, payload: Record<string, unknown>, orgId?: string | null): Promise<void>;
	notifyMany(userIds: readonly string[], kind: string, payload: Record<string, unknown>, orgId?: string | null): Promise<void>;
	list(actor: Actor, query: { unread?: boolean; before?: string; limit?: number }): Promise<{ items: NotificationView[]; unread: number; nextBefore: string | null }>;
	markRead(actor: Actor, input: { ids?: readonly string[]; all?: boolean }): Promise<{ updated: number }>;
}

interface NotificationRow {
	id: string;
	kind: string;
	payload: Record<string, unknown>;
	read_at: Date | string | null;
	created_at: Date | string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const toView = (r: NotificationRow): NotificationView => ({
	id: r.id,
	kind: r.kind,
	payload: r.payload,
	readAt: toIso(r.read_at),
	createdAt: toIso(r.created_at) as string,
});

export function createNotificationsService(deps: ServiceDeps, realtime: Realtime): NotificationsService {
	const notify: NotificationsService["notify"] = async (userId, kind, payload, orgId) => {
		try {
			const id = ulid(deps.now());
			const rows = await deps.db.tx({ system: true }, (q) =>
				q.query<NotificationRow>(
					"INSERT INTO notifications (id, user_id, org_id, kind, payload) VALUES ($1,$2,$3,$4,$5::text::jsonb) RETURNING id, kind, payload, read_at, created_at",
					[id, userId, orgId ?? null, kind, JSON.stringify(payload)],
				),
			);
			const row = rows[0];
			if (row) realtime.publishUser(userId, { kind: "notification", notification: toView(row) });
		} catch (err) {
			deps.log.warn(`${LOG_PREFIX} 写入通知失败 (${kind} -> ${userId}): ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	return {
		notify,

		async notifyMany(userIds, kind, payload, orgId) {
			for (const userId of new Set(userIds)) await notify(userId, kind, payload, orgId);
		},

		async list(actor, query) {
			const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
			const where = ["user_id = $1"];
			const params: unknown[] = [actor.userId];
			if (query.unread) where.push("read_at IS NULL");
			if (query.before) {
				params.push(query.before);
				where.push(`id < $${params.length}`);
			}
			params.push(limit + 1);
			return deps.db.tx(scopeOf(actor), async (q) => {
				const rows = await q.query<NotificationRow>(
					`SELECT id, kind, payload, read_at, created_at FROM notifications WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT $${params.length}`,
					params,
				);
				const count = await q.query<{ n: string | number }>("SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [actor.userId]);
				const page = rows.slice(0, limit);
				return {
					items: page.map(toView),
					unread: Number(count[0]?.n ?? 0),
					nextBefore: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
				};
			});
		},

		async markRead(actor, input) {
			const stamp = new Date(deps.now()).toISOString();
			return deps.db.tx(scopeOf(actor), async (q) => {
				const rows = input.all
					? await q.query("UPDATE notifications SET read_at = $2::timestamptz WHERE user_id = $1 AND read_at IS NULL RETURNING id", [actor.userId, stamp])
					: await q.query("UPDATE notifications SET read_at = $3::timestamptz WHERE user_id = $1 AND id = ANY($2::text[]) AND read_at IS NULL RETURNING id", [
							actor.userId,
							[...(input.ids ?? [])],
							stamp,
						]);
				return { updated: rows.length };
			});
		},
	};
}
