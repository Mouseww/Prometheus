import { toIso } from "../db/db.ts";
import type { Queryable } from "../db/db.ts";
import { badRequest, conflict, forbidden, HubError, notFound } from "../errors.ts";
import { ulid } from "../ids.ts";
import type { Actor } from "../permissions.ts";
import { can, effectiveTeamRole } from "../permissions.ts";
import type { ActorService } from "./actors.ts";
import type { AuditService } from "./audit.ts";
import { type ServiceDeps, scopeOf } from "./common.ts";
import type { NotificationsService } from "./notifications.ts";
import { RELAY_TIMEOUT_MS, type Realtime, type RelayAction, type RelayTarget } from "./realtime.ts";
import { applyEvent, deriveStatus, type SessionStatus, type StatusState } from "./session-status.ts";
import { requireWorkspace } from "./workspace-access.ts";

export const MAX_TRANSCRIPT_CHARS = 20 * 1024 * 1024;
export const MAX_EVENTS_PER_BATCH = 500;
const DEFAULT_EVENTS_LIMIT = 200;
const MAX_EVENTS_LIMIT = 1000;

export interface SessionView {
	id: string;
	workspaceId: string;
	orgId: string | null;
	ownerUserId: string;
	ownerName: string | null;
	title: string;
	status: SessionStatus;
	branch: string;
	baseCommit: string;
	forkedFromSessionId: string | null;
	execLocation: string;
	lastActivityAt: string;
	snapshotCommit: string | null;
	/** Mapping to the owner's machine; only the owner sees it. */
	localSessionId: string | null;
	serverId: string | null;
	createdAt: string;
}

export interface SessionDetail extends SessionView {
	isOwner: boolean;
	/** The caller may send actions through the relay (owner or granted). */
	canAct: boolean;
	/** User ids holding a grant; only filled for the owner. */
	grants: string[];
}

export interface RegisterSessionInput {
	localSessionId: string;
	serverId: string;
	title?: string;
	branch: string;
	baseCommit: string;
	forkedFrom?: string;
	execLocation?: string;
}

export interface PatchSessionInput {
	title?: string;
	status?: "running" | "waiting" | "idle";
	snapshotCommit?: string;
	lastActivity?: string;
	localSessionId?: string;
	serverId?: string;
}

export interface EventInput {
	seq: number;
	kind: string;
	payload: unknown;
}

export interface EventView {
	seq: number;
	kind: string;
	payload: unknown;
	createdAt: string;
}

export interface TranscriptView {
	format: string;
	/** gzip + base64 of the transcript text. */
	content: string;
	updatedAt: string;
}

export interface ForkResult {
	session: SessionView;
	transcript: { format: string; content: string } | null;
	snapshotCommit: string | null;
	branch: string;
	/** Branch of the original session, for forkers that have no snapshot and must start from its head. */
	sourceBranch: string;
}

export interface SessionsService {
	register(actor: Actor, workspaceId: string, input: RegisterSessionInput): Promise<{ session: SessionView; created: boolean }>;
	list(actor: Actor, workspaceId: string, query: { status?: SessionStatus; owner?: string; limit?: number }): Promise<SessionView[]>;
	get(actor: Actor, sessionId: string): Promise<SessionDetail>;
	patch(actor: Actor, sessionId: string, input: PatchSessionInput): Promise<SessionView>;
	appendEvents(actor: Actor, sessionId: string, events: readonly EventInput[]): Promise<{ accepted: number; duplicates: number; lastSeq: number | null }>;
	listEvents(actor: Actor, sessionId: string, query: { after?: number; limit?: number }): Promise<{ items: EventView[]; nextAfter: number | null; hasMore: boolean }>;
	putTranscript(actor: Actor, sessionId: string, input: { format: string; content: string }): Promise<{ bytes: number }>;
	getTranscript(actor: Actor, sessionId: string): Promise<TranscriptView | null>;
	grant(actor: Actor, sessionId: string, userId: string): Promise<{ sessionId: string; userId: string }>;
	revokeGrant(actor: Actor, sessionId: string, userId: string): Promise<void>;
	listGrants(actor: Actor, sessionId: string): Promise<{ userId: string; grantedBy: string; createdAt: string }[]>;
	relay(actor: Actor, sessionId: string, action: RelayAction): Promise<{ relayed: true }>;
	fork(actor: Actor, sessionId: string, input: { title?: string }): Promise<ForkResult>;
	/** Whether the user may subscribe to a WebSocket topic (`user`, `workspace:<id>`, `session:<id>`). */
	canSubscribe(userId: string, topic: string): Promise<boolean>;
	/** Presence: the owner's member connection has been gone too long. Returns the number of sessions flipped. */
	markOwnerOffline(userId: string): Promise<number>;
	/** Presence: the owner is back; sessions return to the status their events imply. */
	markOwnerOnline(userId: string): Promise<number>;
	/** Owners (with at least one non-offline session) the presence tracker should check. */
	ownersWithLiveSessions(): Promise<string[]>;
}

interface SessionRow {
	id: string;
	workspace_id: string;
	org_id: string | null;
	owner_user_id: string;
	owner_name: string | null;
	local_session_id: string;
	server_id: string;
	title: string;
	status: SessionStatus;
	agent_running: boolean;
	pending_requests: string[];
	branch: string;
	base_commit: string;
	forked_from_session_id: string | null;
	exec_location: string;
	tenant_session_id: string | null;
	last_activity_at: Date | string;
	snapshot_commit: string | null;
	created_at: Date | string;
	team_id: string;
}

const SESSION_SELECT = `SELECT s.id, s.workspace_id, s.org_id, s.owner_user_id, u.display_name AS owner_name, s.local_session_id, s.server_id, s.title, s.status,
	s.agent_running, s.pending_requests, s.branch, s.base_commit, s.forked_from_session_id, s.exec_location, s.tenant_session_id, s.last_activity_at, s.snapshot_commit, s.created_at, w.team_id
	FROM sessions s JOIN workspaces w ON w.id = s.workspace_id LEFT JOIN users u ON u.id = s.owner_user_id`;

const toView = (r: SessionRow, viewerId: string | null): SessionView => ({
	id: r.id,
	workspaceId: r.workspace_id,
	orgId: r.org_id,
	ownerUserId: r.owner_user_id,
	ownerName: r.owner_name,
	title: r.title,
	status: r.status,
	branch: r.branch,
	baseCommit: r.base_commit,
	forkedFromSessionId: r.forked_from_session_id,
	execLocation: r.exec_location,
	lastActivityAt: toIso(r.last_activity_at) as string,
	snapshotCommit: r.snapshot_commit,
	localSessionId: viewerId === r.owner_user_id ? r.local_session_id : null,
	serverId: viewerId === r.owner_user_id ? r.server_id : null,
	createdAt: toIso(r.created_at) as string,
});

const stateOf = (r: SessionRow): StatusState => ({ agentRunning: r.agent_running, pending: r.pending_requests });

const parseTopic = (topic: string): { kind: "user" } | { kind: "workspace" | "session"; id: string } | undefined => {
	if (topic === "user") return { kind: "user" };
	const m = /^(workspace|session):(.{1,64})$/.exec(topic);
	return m ? { kind: m[1] as "workspace" | "session", id: m[2] as string } : undefined;
};

export function createSessionsService(
	deps: ServiceDeps,
	collab: { audit: AuditService; actors: ActorService; notifications: NotificationsService; realtime: Realtime },
): SessionsService {
	const { audit, actors, notifications, realtime } = collab;

	/** Loads a session and checks `action` on its team; outsiders get 404. */
	const loadSession = async (q: Queryable, actor: Actor, sessionId: string, action: "session.spectate" | "session.fork" | "session.start", lock = false): Promise<SessionRow> => {
		const rows = await q.query<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1${lock ? " FOR UPDATE OF s" : ""}`, [sessionId]);
		const row = rows[0];
		if (!row) throw notFound("会话不存在");
		const orgId = row.org_id;
		if (effectiveTeamRole(actor, { teamId: row.team_id, orgId }) === undefined) throw notFound("会话不存在");
		if (!can(actor, action, { teamId: row.team_id, orgId })) throw forbidden();
		return row;
	};

	const requireOwner = (actor: Actor, row: SessionRow): void => {
		if (!can(actor, "session.grant", { ownerUserId: row.owner_user_id })) throw forbidden("只有会话所有者可以执行此操作", "notOwner");
	};

	const publishStatus = (row: { id: string; workspace_id: string }, status: SessionStatus, lastActivityAt: string): void => {
		const data = { kind: "session.status", sessionId: row.id, workspaceId: row.workspace_id, status, lastActivityAt };
		realtime.publish(`session:${row.id}`, data);
		realtime.publish(`workspace:${row.workspace_id}`, data);
	};

	const reload = async (q: Queryable, sessionId: string): Promise<SessionRow> => {
		const rows = await q.query<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1`, [sessionId]);
		return rows[0] as SessionRow;
	};

	return {
		async register(actor, workspaceId, input) {
			const result = await deps.db.tx(scopeOf(actor), async (q) => {
				const ws = await requireWorkspace(q, actor, workspaceId, "session.start");
				const existing = await q.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM sessions WHERE owner_user_id = $1 AND server_id = $2 AND local_session_id = $3", [
					actor.userId,
					input.serverId,
					input.localSessionId,
				]);
				if (existing[0]) {
					if (existing[0].workspace_id !== workspaceId) throw conflict("该本地会话已登记在其他工作区", "sessionExists");
					if (input.title !== undefined) await q.query("UPDATE sessions SET title = $2, updated_at = now() WHERE id = $1", [existing[0].id, input.title]);
					return { row: await reload(q, existing[0].id), created: false };
				}
				if (input.forkedFrom) {
					const parent = await q.query<{ workspace_id: string }>("SELECT workspace_id FROM sessions WHERE id = $1", [input.forkedFrom]);
					if (!parent[0] || parent[0].workspace_id !== workspaceId) throw badRequest("forkedFrom 不是同一工作区的会话", "invalidForkedFrom");
				}
				const id = ulid(deps.now());
				await q.query(
					`INSERT INTO sessions (id, workspace_id, org_id, owner_user_id, local_session_id, server_id, title, branch, base_commit, forked_from_session_id, exec_location, last_activity_at)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)`,
					[
						id,
						workspaceId,
						ws.orgId,
						actor.userId,
						input.localSessionId,
						input.serverId,
						input.title ?? "",
						input.branch,
						input.baseCommit,
						input.forkedFrom ?? null,
						input.execLocation ?? "local",
						new Date(deps.now()).toISOString(),
					],
				);
				return { row: await reload(q, id), created: true };
			});
			const session = toView(result.row, actor.userId);
			if (result.created) realtime.publish(`workspace:${session.workspaceId}`, { kind: "session.created", session: { ...session, localSessionId: null, serverId: null } });
			return { session, created: result.created };
		},

		async list(actor, workspaceId, query) {
			const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
			const rows = await deps.db.tx(scopeOf(actor), async (q) => {
				await requireWorkspace(q, actor, workspaceId, "session.spectate");
				const where = ["s.workspace_id = $1"];
				const params: unknown[] = [workspaceId];
				if (query.status) {
					params.push(query.status);
					where.push(`s.status = $${params.length}`);
				}
				if (query.owner) {
					params.push(query.owner);
					where.push(`s.owner_user_id = $${params.length}`);
				}
				params.push(limit);
				return q.query<SessionRow>(`${SESSION_SELECT} WHERE ${where.join(" AND ")} ORDER BY s.last_activity_at DESC, s.id DESC LIMIT $${params.length}`, params);
			});
			return rows.map((r) => toView(r, actor.userId));
		},

		async get(actor, sessionId) {
			return deps.db.tx(scopeOf(actor), async (q) => {
				const row = await loadSession(q, actor, sessionId, "session.spectate");
				const isOwner = row.owner_user_id === actor.userId;
				const grants = await q.query<{ user_id: string }>("SELECT user_id FROM session_grants WHERE session_id = $1 ORDER BY created_at, user_id", [sessionId]);
				const granted = grants.some((g) => g.user_id === actor.userId);
				return { ...toView(row, actor.userId), isOwner, canAct: isOwner || granted, grants: isOwner ? grants.map((g) => g.user_id) : [] };
			});
		},

		async patch(actor, sessionId, input) {
			const { row, changedStatus } = await deps.db.tx(scopeOf(actor), async (q) => {
				const current = await loadSession(q, actor, sessionId, "session.spectate", true);
				requireOwner(actor, current);
				const sets: string[] = [];
				const params: unknown[] = [sessionId];
				const set = (column: string, value: unknown, cast = ""): void => {
					params.push(value);
					sets.push(`${column} = $${params.length}${cast}`);
				};
				if (input.title !== undefined) set("title", input.title);
				if (input.snapshotCommit !== undefined) set("snapshot_commit", input.snapshotCommit);
				if (input.localSessionId !== undefined) set("local_session_id", input.localSessionId);
				if (input.serverId !== undefined) set("server_id", input.serverId);
				if (input.lastActivity !== undefined) {
					const t = Date.parse(input.lastActivity);
					if (Number.isNaN(t)) throw badRequest("lastActivity 不是有效的时间", "validationError");
					set("last_activity_at", new Date(t).toISOString(), "::timestamptz");
				}
				let status: SessionStatus = current.status;
				if (input.status !== undefined) {
					// An explicit status updates the machine's input; 'offline' (presence) keeps winning until the owner is back.
					const running = input.status === "running" ? true : input.status === "idle" ? false : current.agent_running;
					set("agent_running", running);
					if (input.status === "waiting" && current.pending_requests.length === 0) set("pending_requests", JSON.stringify(["manual"]), "::text::jsonb");
					if (input.status !== "waiting" && current.pending_requests.length > 0) set("pending_requests", "[]", "::text::jsonb");
					if (current.status !== "offline") {
						status = input.status;
						set("status", status);
					}
				}
				if (sets.length === 0) return { row: current, changedStatus: false };
				try {
					await q.query(`UPDATE sessions SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
				} catch (err) {
					if ((err as { code?: unknown }).code === "23505") throw conflict("该本地会话已被其他会话占用", "sessionExists");
					throw err;
				}
				return { row: await reload(q, sessionId), changedStatus: status !== current.status };
			});
			const view = toView(row, actor.userId);
			realtime.publish(`workspace:${row.workspace_id}`, { kind: "session.updated", session: { ...view, localSessionId: null, serverId: null } });
			realtime.publish(`session:${row.id}`, { kind: "session.updated", session: { ...view, localSessionId: null, serverId: null } });
			if (changedStatus) publishStatus(row, row.status, view.lastActivityAt);
			return view;
		},

		async appendEvents(actor, sessionId, events) {
			if (events.length > MAX_EVENTS_PER_BATCH) throw badRequest(`单批事件最多 ${MAX_EVENTS_PER_BATCH} 条`, "tooManyEvents");
			const outcome = await deps.db.tx(scopeOf(actor), async (q) => {
				const row = await loadSession(q, actor, sessionId, "session.spectate", true);
				requireOwner(actor, row);
				if (events.length === 0) return { row, inserted: [] as EventInput[], status: row.status, duplicates: 0 };

				const firstBySeq = new Map<number, EventInput>();
				for (const e of events) if (!firstBySeq.has(e.seq)) firstBySeq.set(e.seq, e);
				const unique = [...firstBySeq.values()];
				const rows = await q.query<{ seq: string | number }>(
					`INSERT INTO session_events (session_id, seq, kind, payload, org_id)
					 SELECT $1, u.seq, u.kind, u.payload::jsonb, $5 FROM unnest($2::bigint[], $3::text[], $4::text[]) AS u(seq, kind, payload)
					 ON CONFLICT (session_id, seq) DO NOTHING RETURNING seq`,
					[sessionId, unique.map((e) => e.seq), unique.map((e) => e.kind), unique.map((e) => JSON.stringify(e.payload ?? {})), row.org_id],
				);
				const insertedSeqs = new Set(rows.map((r) => Number(r.seq)));
				const inserted = unique.filter((e) => insertedSeqs.has(e.seq)).sort((a, b) => a.seq - b.seq);
				const duplicates = events.length - inserted.length;
				if (inserted.length === 0) return { row, inserted, status: row.status, duplicates };

				let state = stateOf(row);
				for (const e of inserted) state = applyEvent(state, e);
				const status: SessionStatus = row.status === "offline" ? "offline" : deriveStatus(state);
				await q.query(
					"UPDATE sessions SET agent_running = $2, pending_requests = $3::text::jsonb, status = $4, last_activity_at = $5::timestamptz, updated_at = now() WHERE id = $1",
					[sessionId, state.agentRunning, JSON.stringify(state.pending), status, new Date(deps.now()).toISOString()],
				);
				return { row, inserted, status, duplicates };
			});
			const { row, inserted, status } = outcome;
			if (inserted.length > 0) {
				realtime.publish(`session:${row.id}`, { kind: "events", sessionId: row.id, events: inserted.map((e) => ({ seq: e.seq, kind: e.kind, payload: e.payload })) });
				publishStatus(row, status, new Date(deps.now()).toISOString());
			}
			const lastSeq = events.reduce<number | null>((max, e) => (max === null || e.seq > max ? e.seq : max), null);
			return { accepted: inserted.length, duplicates: outcome.duplicates, lastSeq };
		},

		async listEvents(actor, sessionId, query) {
			const limit = Math.min(Math.max(query.limit ?? DEFAULT_EVENTS_LIMIT, 1), MAX_EVENTS_LIMIT);
			const after = query.after ?? -1;
			const rows = await deps.db.tx(scopeOf(actor), async (q) => {
				await loadSession(q, actor, sessionId, "session.spectate");
				return q.query<{ seq: string | number; kind: string; payload: unknown; created_at: Date | string }>(
					"SELECT seq, kind, payload, created_at FROM session_events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
					[sessionId, after, limit + 1],
				);
			});
			const page = rows.slice(0, limit);
			const last = page[page.length - 1];
			return {
				items: page.map((r) => ({ seq: Number(r.seq), kind: r.kind, payload: r.payload, createdAt: toIso(r.created_at) as string })),
				nextAfter: last ? Number(last.seq) : null,
				hasMore: rows.length > limit,
			};
		},

		async putTranscript(actor, sessionId, input) {
			if (input.content.length > MAX_TRANSCRIPT_CHARS) throw new HubError(413, "payloadTooLarge", "转写内容超过 20MB 上限");
			if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) throw badRequest("转写内容必须是 base64", "invalidTranscript");
			const head = Buffer.from(input.content.slice(0, 8), "base64");
			if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) throw badRequest("转写内容必须是 gzip 压缩后的 base64", "invalidTranscript");
			await deps.db.tx(scopeOf(actor), async (q) => {
				const row = await loadSession(q, actor, sessionId, "session.spectate");
				requireOwner(actor, row);
				await q.query(
					`INSERT INTO session_transcripts (session_id, org_id, format, content, updated_at) VALUES ($1,$2,$3,$4,$5::timestamptz)
					 ON CONFLICT (session_id) DO UPDATE SET format = EXCLUDED.format, content = EXCLUDED.content, updated_at = EXCLUDED.updated_at`,
					[sessionId, row.org_id, input.format, input.content, new Date(deps.now()).toISOString()],
				);
			});
			return { bytes: input.content.length };
		},

		async getTranscript(actor, sessionId) {
			return deps.db.tx(scopeOf(actor), async (q) => {
				await loadSession(q, actor, sessionId, "session.spectate");
				const rows = await q.query<{ format: string; content: string; updated_at: Date | string }>("SELECT format, content, updated_at FROM session_transcripts WHERE session_id = $1", [sessionId]);
				const r = rows[0];
				return r ? { format: r.format, content: r.content, updatedAt: toIso(r.updated_at) as string } : null;
			});
		},

		async grant(actor, sessionId, userId) {
			// The target's roles are loaded between two transactions: PGlite has one connection, so no transaction may open inside another.
			const current = await deps.db.tx(scopeOf(actor), async (q) => {
				const session = await loadSession(q, actor, sessionId, "session.spectate");
				requireOwner(actor, session);
				if (userId === actor.userId) throw badRequest("不需要给自己授权", "selfGrant");
				return session;
			});
			let target: Actor;
			try {
				target = await actors.load(userId);
			} catch {
				throw notFound("用户不存在或不可用");
			}
			if (effectiveTeamRole(target, { teamId: current.team_id, orgId: current.org_id }) === undefined) throw conflict("被授权人不是该团队成员", "notTeamMember");
			const row = await deps.db.tx(scopeOf(actor), async (q) => {
				const session = await loadSession(q, actor, sessionId, "session.spectate");
				requireOwner(actor, session);
				const inserted = await q.query("INSERT INTO session_grants (session_id, user_id, granted_by, org_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING user_id", [
					sessionId,
					userId,
					actor.userId,
					session.org_id,
				]);
				if (inserted.length > 0) {
					await audit.write(q, { actorId: actor.userId, orgId: session.org_id, action: "session.grant", targetType: "session", targetId: sessionId, detail: { userId } });
				}
				return { session, isNew: inserted.length > 0 };
			});
			if (row.isNew) {
				await notifications.notify(userId, "session.granted", { sessionId, title: row.session.title, workspaceId: row.session.workspace_id, ownerUserId: actor.userId }, row.session.org_id);
			}
			return { sessionId, userId };
		},

		async revokeGrant(actor, sessionId, userId) {
			await deps.db.tx(scopeOf(actor), async (q) => {
				const session = await loadSession(q, actor, sessionId, "session.spectate");
				requireOwner(actor, session);
				const removed = await q.query("DELETE FROM session_grants WHERE session_id = $1 AND user_id = $2 RETURNING user_id", [sessionId, userId]);
				if (removed.length === 0) throw notFound("授权不存在");
				await audit.write(q, { actorId: actor.userId, orgId: session.org_id, action: "session.grant.revoke", targetType: "session", targetId: sessionId, detail: { userId } });
			});
		},

		async listGrants(actor, sessionId) {
			return deps.db.tx(scopeOf(actor), async (q) => {
				const session = await loadSession(q, actor, sessionId, "session.spectate");
				requireOwner(actor, session);
				const rows = await q.query<{ user_id: string; granted_by: string; created_at: Date | string }>(
					"SELECT user_id, granted_by, created_at FROM session_grants WHERE session_id = $1 ORDER BY created_at, user_id",
					[sessionId],
				);
				return rows.map((r) => ({ userId: r.user_id, grantedBy: r.granted_by, createdAt: toIso(r.created_at) as string }));
			});
		},

		async relay(actor, sessionId, action) {
			const { session, name } = await deps.db.tx(scopeOf(actor), async (q) => {
				const row = await loadSession(q, actor, sessionId, "session.spectate");
				if (row.owner_user_id !== actor.userId) {
					const g = await q.query("SELECT 1 FROM session_grants WHERE session_id = $1 AND user_id = $2", [sessionId, actor.userId]);
					if (g.length === 0) throw forbidden("没有该会话的操作授权", "notGranted");
				}
				const users = await q.query<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [actor.userId]);
				return { session: row, name: users[0]?.display_name ?? actor.userId };
			});
			// The side that runs the session gets the action: the owner's machine, or their tenant instance after a handoff to the team side.
			const onTeam = session.exec_location === "team";
			const target: RelayTarget = onTeam ? "tenant" : "local";
			if (!realtime.isOnline(session.owner_user_id, target)) {
				throw conflict(onTeam ? "会话正在团队 server 上执行，但它当前不在线" : "会话所有者当前不在线", "ownerOffline");
			}
			const sideSessionId = onTeam ? (session.tenant_session_id ?? "") : session.local_session_id;
			if (sideSessionId === "") throw conflict(onTeam ? "会话尚未关联到团队 server 上的会话" : "会话尚未关联到所有者的本地会话", "sessionNotLinked");

			const outcome = await realtime.relay(
				session.owner_user_id,
				{ hubSessionId: session.id, sessionId: sideSessionId, ...(onTeam ? {} : { serverId: session.server_id }), action, actor: { userId: actor.userId, name } },
				RELAY_TIMEOUT_MS,
				target,
			);
			const result = outcome.kind === "ok" ? "ok" : outcome.kind === "failed" ? "failed" : outcome.kind;
			await deps.db.tx({ system: true }, (q) =>
				audit.write(q, {
					actorId: actor.userId,
					orgId: session.org_id,
					action: "session.relay",
					targetType: "session",
					targetId: sessionId,
					detail: {
						type: action.type,
						result,
						...(action.requestId ? { requestId: action.requestId } : {}),
						...(action.text !== undefined ? { textPreview: action.text.slice(0, 200), textLength: action.text.length } : {}),
					},
				}),
			);
			if (outcome.kind === "offline") throw conflict("会话所有者当前不在线", "ownerOffline");
			if (outcome.kind === "timeout") throw new HubError(504, "relayTimeout", "会话所有者未在 30 秒内响应");
			if (outcome.kind === "failed") throw new HubError(502, "relayFailed", outcome.error ?? "会话所有者执行操作失败");
			return { relayed: true };
		},

		async fork(actor, sessionId, input) {
			const { forked, source, transcript } = await deps.db.tx(scopeOf(actor), async (q) => {
				const src = await loadSession(q, actor, sessionId, "session.fork");
				const id = ulid(deps.now());
				const branch = `session/${actor.userId}/${id}`;
				const base = src.snapshot_commit ?? src.base_commit;
				await q.query(
					`INSERT INTO sessions (id, workspace_id, org_id, owner_user_id, title, status, branch, base_commit, forked_from_session_id, exec_location, last_activity_at)
					 VALUES ($1,$2,$3,$4,$5,'idle',$6,$7,$8,$9,$10::timestamptz)`,
					[id, src.workspace_id, src.org_id, actor.userId, input.title ?? src.title, branch, base, src.id, src.exec_location, new Date(deps.now()).toISOString()],
				);
				await audit.write(q, { actorId: actor.userId, orgId: src.org_id, action: "session.fork", targetType: "session", targetId: src.id, detail: { newSessionId: id } });
				const t = await q.query<{ format: string; content: string }>("SELECT format, content FROM session_transcripts WHERE session_id = $1", [src.id]);
				return { forked: await reload(q, id), source: src, transcript: t[0] ?? null };
			});
			const session = toView(forked, actor.userId);
			const users = await deps.db.tx({ system: true }, (q) => q.query<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [actor.userId]));
			if (source.owner_user_id !== actor.userId) {
				await notifications.notify(
					source.owner_user_id,
					"session.forked",
					{ sessionId: source.id, title: source.title, newSessionId: session.id, forkedBy: actor.userId, forkedByName: users[0]?.display_name ?? actor.userId, workspaceId: source.workspace_id },
					source.org_id,
				);
			}
			realtime.publish(`workspace:${session.workspaceId}`, { kind: "session.created", session: { ...session, localSessionId: null, serverId: null } });
			return { session, transcript, snapshotCommit: source.snapshot_commit, branch: session.branch, sourceBranch: source.branch };
		},

		async canSubscribe(userId, topic) {
			const parsed = parseTopic(topic);
			if (!parsed) return false;
			if (parsed.kind === "user") return true;
			let actor: Actor;
			try {
				actor = await actors.load(userId);
			} catch {
				return false;
			}
			try {
				return await deps.db.tx(scopeOf(actor), async (q) => {
					if (parsed.kind === "workspace") {
						await requireWorkspace(q, actor, parsed.id, "session.spectate");
					} else {
						await loadSession(q, actor, parsed.id, "session.spectate");
					}
					return true;
				});
			} catch (err) {
				if (err instanceof HubError) return false;
				throw err;
			}
		},

		async markOwnerOffline(userId) {
			const rows = await deps.db.tx({ system: true }, (q) =>
				q.query<{ id: string; workspace_id: string; last_activity_at: Date | string }>(
					"UPDATE sessions SET status = 'offline', updated_at = now() WHERE owner_user_id = $1 AND status <> 'offline' RETURNING id, workspace_id, last_activity_at",
					[userId],
				),
			);
			for (const r of rows) publishStatus(r, "offline", toIso(r.last_activity_at) as string);
			return rows.length;
		},

		async markOwnerOnline(userId) {
			const rows = await deps.db.tx({ system: true }, (q) =>
				q.query<{ id: string; workspace_id: string; status: SessionStatus; last_activity_at: Date | string }>(
					`UPDATE sessions SET status = CASE WHEN jsonb_array_length(pending_requests) > 0 THEN 'waiting' WHEN agent_running THEN 'running' ELSE 'idle' END, updated_at = now()
					 WHERE owner_user_id = $1 AND status = 'offline' RETURNING id, workspace_id, status, last_activity_at`,
					[userId],
				),
			);
			for (const r of rows) publishStatus(r, r.status, toIso(r.last_activity_at) as string);
			return rows.length;
		},

		async ownersWithLiveSessions() {
			const rows = await deps.db.query<{ owner_user_id: string }>("SELECT DISTINCT owner_user_id FROM sessions WHERE status <> 'offline'");
			return rows.map((r) => r.owner_user_id);
		},
	};
}
