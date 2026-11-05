import { toIso } from "../db/db.ts";
import type { Actor } from "../permissions.ts";
import { type ServiceDeps, scopeOf } from "./common.ts";
import type { Realtime } from "./realtime.ts";
import type { SessionStatus } from "./session-status.ts";
import { requireWorkspace } from "./workspace-access.ts";

const SESSIONS_PER_MEMBER = 5;
const RECENT_MERGES = 10;
const OPEN_MR_LIMIT = 50;

export interface BoardSession {
	id: string;
	title: string;
	status: SessionStatus;
	lastActivityAt: string;
}

export interface BoardMember {
	user: { id: string; displayName: string; email: string };
	role: "admin" | "reviewer" | "member";
	online: boolean;
	sessions: BoardSession[];
	lastActivityAt: string | null;
}

export interface BoardMergeRequest {
	id: string;
	title: string;
	authorId: string;
	authorName: string | null;
	branch: string;
	status: string;
	sessionId: string | null;
	createdAt: string;
	decidedAt: string | null;
}

export interface Board {
	members: BoardMember[];
	openMergeRequests: BoardMergeRequest[];
	recentMerges: BoardMergeRequest[];
}

export interface BoardService {
	get(actor: Actor, workspaceId: string): Promise<Board>;
}

interface MrRow {
	id: string;
	title: string;
	author_id: string;
	author_name: string | null;
	branch: string;
	status: string;
	session_id: string | null;
	created_at: Date | string;
	decided_at: Date | string | null;
}

const toMr = (r: MrRow): BoardMergeRequest => ({
	id: r.id,
	title: r.title,
	authorId: r.author_id,
	authorName: r.author_name,
	branch: r.branch,
	status: r.status,
	sessionId: r.session_id,
	createdAt: toIso(r.created_at) as string,
	decidedAt: toIso(r.decided_at),
});

const MR_SELECT = `SELECT m.id, m.title, m.author_id, u.display_name AS author_name, m.branch, m.status, m.session_id, m.created_at, m.decided_at
	FROM merge_requests m LEFT JOIN users u ON u.id = m.author_id`;

/** Spec section 7: one card per team member plus open and recently merged merge requests. */
export function createBoardService(deps: ServiceDeps, realtime: Realtime): BoardService {
	return {
		async get(actor, workspaceId) {
			return deps.db.tx(scopeOf(actor), async (q) => {
				const ws = await requireWorkspace(q, actor, workspaceId, "session.spectate");
				const members = await q.query<{ user_id: string; display_name: string; email: string; role: BoardMember["role"] }>(
					"SELECT m.user_id, u.display_name, u.email, m.role FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY m.created_at, m.user_id",
					[ws.teamId],
				);
				const sessions = await q.query<{ id: string; owner_user_id: string; title: string; status: SessionStatus; last_activity_at: Date | string }>(
					"SELECT id, owner_user_id, title, status, last_activity_at FROM sessions WHERE workspace_id = $1 ORDER BY last_activity_at DESC, id DESC",
					[workspaceId],
				);
				const open = await q.query<MrRow>(`${MR_SELECT} WHERE m.workspace_id = $1 AND m.status IN ('open','conflict') ORDER BY m.created_at DESC LIMIT ${OPEN_MR_LIMIT}`, [workspaceId]);
				const merged = await q.query<MrRow>(`${MR_SELECT} WHERE m.workspace_id = $1 AND m.status = 'merged' ORDER BY m.decided_at DESC NULLS LAST, m.id DESC LIMIT ${RECENT_MERGES}`, [workspaceId]);

				const board: BoardMember[] = members.map((m) => {
					const mine = sessions.filter((s) => s.owner_user_id === m.user_id);
					return {
						user: { id: m.user_id, displayName: m.display_name, email: m.email },
						role: m.role,
						online: realtime.isOnline(m.user_id),
						sessions: mine.slice(0, SESSIONS_PER_MEMBER).map((s) => ({ id: s.id, title: s.title, status: s.status, lastActivityAt: toIso(s.last_activity_at) as string })),
						lastActivityAt: mine[0] ? toIso(mine[0].last_activity_at) : null,
					};
				});
				return { members: board, openMergeRequests: open.map(toMr), recentMerges: merged.map(toMr) };
			});
		},
	};
}
