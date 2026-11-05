import { errorMessage, LOG } from "../types.ts";
import type { MemberEnv } from "./env.ts";

export interface SessionLinkInfo {
	hubSessionId: string;
	workspaceId: string;
	/** This copy moved to the other side: it only mirrors and refuses prompts. */
	readOnly: boolean;
	/** Side that takes prompts now. */
	activeSide: "local" | "team";
	/** The copy that takes prompts, when this one is a read-only mirror. */
	activeSessionId?: string;
	/** From the Hub (the mode is not kept on this machine); absent when the Hub could not be asked. */
	execMode?: "local-first" | "team-first";
}

/**
 * RPC `session.link`: which Hub session a local session belongs to, or null when it is not a team session here.
 * Everything but `execMode` comes from the state store; the mode is asked of the Hub on a best-effort basis.
 */
export async function linkOfSession(env: MemberEnv, localSessionId: string): Promise<SessionLinkInfo | null> {
	const mapping = env.state.get().sessions[localSessionId];
	if (!mapping) return null;
	const info: SessionLinkInfo = {
		hubSessionId: mapping.hubSessionId,
		workspaceId: mapping.workspaceId,
		readOnly: mapping.readOnly !== undefined,
		activeSide: mapping.readOnly ? mapping.readOnly.to : env.side,
		...(mapping.readOnly ? { activeSessionId: mapping.readOnly.activeSessionId } : {}),
	};
	if (!env.client.loggedIn) return info;
	try {
		const exec = await env.client.call<{ mode?: unknown }>("GET", `/sessions/${encodeURIComponent(mapping.hubSessionId)}/exec`);
		if (exec.mode === "local-first" || exec.mode === "team-first") return { ...info, execMode: exec.mode };
	} catch (err) {
		env.log.warn(`${LOG} 读取会话执行模式失败 (${mapping.hubSessionId}): ${errorMessage(err)}`);
	}
	return info;
}
