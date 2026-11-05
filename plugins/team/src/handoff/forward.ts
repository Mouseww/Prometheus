import type { PluginContext } from "@prometheus/plugin-sdk";
import type { MemberEnv } from "../member/env.ts";
import { applyAction } from "../member/relay.ts";
import { TeamError } from "../types.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The fields of an action the Hub accepts, nothing else. */
function cleanAction(raw: unknown): { type: string; text?: string; requestId?: string; response?: unknown } {
	if (!isRecord(raw) || typeof raw.type !== "string") throw new TeamError("invalidAction", "缺少操作内容");
	return {
		type: raw.type,
		...(typeof raw.text === "string" ? { text: raw.text } : {}),
		...(typeof raw.requestId === "string" ? { requestId: raw.requestId } : {}),
		...(raw.response !== undefined ? { response: raw.response } : {}),
	};
}

/**
 * Sends an action of the session's owner through the Hub, which delivers it to whichever side runs the session now
 * (`POST /api/sessions/:id/actions`: same grant checks as for a teammate, owner included).
 */
export async function forwardToActiveSide(env: MemberEnv, hubSessionId: string, action: unknown): Promise<void> {
	await env.client.call("POST", `/sessions/${encodeURIComponent(hubSessionId)}/actions`, cleanAction(action));
}

/**
 * RPC `session.act`: the owner's client prompts, answers or aborts a session on this server. A live copy runs it here; a copy whose
 * brain moved to the other side only mirrors, so the action is forwarded to the active side through the Hub instead of being dropped.
 */
export async function actOnSession(env: MemberEnv, sessions: PluginContext["sessions"], params: Record<string, unknown>): Promise<{ routed: "local" | "hub" }> {
	const sessionId = params.sessionId;
	if (typeof sessionId !== "string" || !sessionId) throw new TeamError("invalidParams", "缺少参数 sessionId");
	const mapping = env.state.get().sessions[sessionId];
	if (!mapping) throw new TeamError("notTeamSession", "该会话不是团队会话", 404);
	const action = cleanAction(params.action ?? params);
	if (mapping.readOnly) {
		await forwardToActiveSide(env, mapping.hubSessionId, action);
		return { routed: "hub" };
	}
	await applyAction(sessions, sessionId, action);
	return { routed: "local" };
}
