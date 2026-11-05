import type { ExtensionFactory, PluginContext } from "@prometheus/plugin-sdk";
import type { MemberEnv } from "../member/env.ts";
import type { HubSocket } from "../member/relay.ts";
import { errorMessage, LOG, TeamError } from "../types.ts";
import { Handoff, type HandoffDeps } from "./handoff.ts";

export { Handoff, type HandoffDeps } from "./handoff.ts";

export type HandoffCtx = Pick<PluginContext, "extension">;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Refuses prompts to a session whose brain moved to the other side; the UI routes the user to the active copy (`execChanged`). */
export function readOnlyGuard(env: MemberEnv): ExtensionFactory {
	return (pi) => {
		pi.on("input", (_event, ectx) => {
			const mapping = env.state.get().sessions[ectx.sessionManager.getSessionId()];
			if (!mapping?.readOnly) return { action: "continue" as const };
			ectx.ui.notify(`这个会话已经${mapping.readOnly.to === "team" ? "移交到团队 server" : "移回本机"}执行，请在那一端继续对话`, "warning");
			return { action: "handled" as const };
		});
	};
}

/** Answers the Hub's handoff commands (`cmd` frames) and installs the read-only guard. */
export function setupHandoff(ctx: HandoffCtx, deps: HandoffDeps, socket: Pick<HubSocket, "sendFrame" | "onFrame">): { handoff: Handoff; off(): void } {
	const handoff = new Handoff(deps);
	ctx.extension(readOnlyGuard(deps.env));
	const off = socket.onFrame(async (frame) => {
		if (frame.type !== "cmd") return false;
		const cmdId = typeof frame.cmdId === "string" ? frame.cmdId : "";
		if (!cmdId) return true;
		try {
			const data = await handoff.run(typeof frame.cmd === "string" ? frame.cmd : "", isRecord(frame.params) ? frame.params : {});
			socket.sendFrame({ type: "cmdResult", cmdId, ok: true, data });
		} catch (err) {
			const code = err instanceof TeamError ? err.code : "commandFailed";
			deps.env.log.warn(`${LOG} 移交命令 ${String(frame.cmd)} 失败: ${errorMessage(err)}`);
			socket.sendFrame({ type: "cmdResult", cmdId, ok: false, error: errorMessage(err), code });
		}
		return true;
	});
	return { handoff, off };
}
