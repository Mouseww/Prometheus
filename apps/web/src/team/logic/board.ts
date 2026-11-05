// Live updates of the team board from `workspace:<id>` events. A change that can be applied locally is; anything the
// board cannot derive from the event (new sessions, merge request changes) asks for a reload instead.
import type { Board, SessionStatus } from "../types.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const STATUSES: readonly string[] = ["running", "waiting", "idle", "offline"];

export type BoardUpdate = { kind: "patched"; board: Board } | { kind: "reload" } | { kind: "ignore" };

/** What a workspace event means for the board. Never mutates `board`. */
export function applyBoardEvent(board: Board, event: unknown): BoardUpdate {
	if (!isRecord(event) || typeof event.kind !== "string") return { kind: "ignore" };
	switch (event.kind) {
		case "session.status": {
			const id = event.sessionId;
			const status = event.status;
			if (typeof id !== "string" || typeof status !== "string" || !STATUSES.includes(status)) return { kind: "reload" };
			const lastActivityAt = typeof event.lastActivityAt === "string" ? event.lastActivityAt : undefined;
			let found = false;
			const members = board.members.map((m) => {
				if (!m.sessions.some((s) => s.id === id)) return m;
				found = true;
				return {
					...m,
					lastActivityAt: lastActivityAt ?? m.lastActivityAt,
					sessions: m.sessions.map((s) => (s.id === id ? { ...s, status: status as SessionStatus, lastActivityAt: lastActivityAt ?? s.lastActivityAt } : s)),
				};
			});
			// A session the board does not show yet (beyond the per-member cap or just created) needs a fresh board.
			return found ? { kind: "patched", board: { ...board, members } } : { kind: "reload" };
		}
		case "session.created":
		case "session.updated":
		case "mergeRequest":
			return { kind: "reload" };
		default:
			return { kind: "ignore" };
	}
}
