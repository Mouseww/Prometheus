// Maps a Hub notification to the page it should open. Payload shapes come from the Hub services that call
// `notifications.notify` (sessions, git/notify, runtime); unknown kinds fall back to whatever ids the payload carries.
import type { Route } from "../context.tsx";
import type { NotificationView } from "../types.ts";

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The route a notification leads to, or undefined when the payload carries nothing to open. */
export function notificationRoute(n: Pick<NotificationView, "kind" | "payload">): Route | undefined {
	const p = n.payload ?? {};
	const mergeRequestId = str(p.mergeRequestId) ?? str(p.mrId);
	const workspaceId = str(p.workspaceId);
	const teamId = str(p.teamId);
	const sessionId = str(p.sessionId);
	const newSessionId = str(p.newSessionId);

	// A fork notice tells the owner who forked; the interesting session is the one that was forked, i.e. their own.
	if (n.kind === "session.forked") {
		const id = sessionId ?? newSessionId;
		return id ? { page: "session", params: { sessionId: id } } : undefined;
	}
	if (n.kind.startsWith("report") || n.kind === "report.generated") {
		return workspaceId ? { page: "teamHome", params: { workspaceId, tab: "report" } } : undefined;
	}
	if (mergeRequestId) {
		const params: Record<string, string> = { mergeRequestId };
		if (teamId) params.teamId = teamId;
		if (workspaceId) params.workspaceId = workspaceId;
		return { page: "mergeRequest", params };
	}
	if (sessionId) return { page: "session", params: { sessionId } };
	if (workspaceId) {
		const params: Record<string, string> = { workspaceId };
		if (teamId) params.teamId = teamId;
		return { page: "workspace", params };
	}
	if (teamId) return { page: "team", params: { teamId } };
	return undefined;
}
