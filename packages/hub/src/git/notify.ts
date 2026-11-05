import type { HubDeps } from "../deps.ts";
import { LOG_PREFIX } from "../log.ts";

/** The part of block 2C's `NotificationsService` (registered as `notifications`) that the git services use. */
export interface NotificationSink {
	notifyMany(userIds: readonly string[], kind: string, payload: Record<string, unknown>, orgId?: string | null): Promise<void>;
}

/** The part of block 2C's realtime gateway (registered as `realtime`) that the git services use. */
export interface RealtimeSink {
	publish(topic: string, data: unknown): void;
}

export interface TeamNotifier {
	/** Pushes to a realtime topic (`workspace:<id>`); silently does nothing when no realtime gateway is registered. */
	publish(topic: string, data: unknown): void;
	/** Sends to the given users; silently does nothing when no notifications service is registered. */
	send(orgId: string | null, userIds: readonly string[], kind: string, payload: Record<string, unknown>): Promise<void>;
	/** Team member ids, optionally limited to some roles. */
	teamUsers(teamId: string, roles?: readonly string[]): Promise<string[]>;
}

export function createTeamNotifier(deps: Pick<HubDeps, "db" | "registry" | "log">): TeamNotifier {
	return {
		publish(topic, data) {
			// Looked up on every call: the realtime gateway registers after the git routes.
			if (!deps.registry.has("realtime")) return;
			try {
				deps.registry.require<RealtimeSink>("realtime").publish(topic, data);
			} catch (err) {
				deps.log.warn(`${LOG_PREFIX} 发布实时消息失败 (${topic}): ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		async send(orgId, userIds, kind, payload) {
			if (!deps.registry.has("notifications")) return;
			const unique = [...new Set(userIds)];
			if (unique.length === 0) return;
			try {
				await deps.registry.require<NotificationSink>("notifications").notifyMany(unique, kind, payload, orgId);
			} catch (err) {
				deps.log.warn(`${LOG_PREFIX} 发送通知失败 (${kind}): ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		async teamUsers(teamId, roles) {
			const rows = await deps.db.tx({ system: true }, (q) => q.query<{ user_id: string; role: string }>("SELECT user_id, role FROM team_members WHERE team_id = $1", [teamId]));
			return rows.filter((r) => !roles || roles.includes(r.role)).map((r) => r.user_id);
		},
	};
}
