import type { PluginContext } from "@prometheus/plugin-sdk";
import type { MemberEnv } from "../member/env.ts";
import type { HubSocket } from "../member/relay.ts";
import type { SyncManager } from "../sync/manager.ts";
import { TeamError } from "../types.ts";
import { HandCaller } from "./caller.ts";
import { ConfirmGate, type ConfirmOptions, type Decision } from "./confirm.ts";
import { HandExecutor } from "./executor.ts";
import { buildHandTools } from "./tools.ts";

export { HandCaller } from "./caller.ts";
export { CONFIRM_TIMEOUT_MS, ConfirmGate, type Decision, type HandRequest } from "./confirm.ts";
export { HandExecutor, LOCAL_TOOLS, TEAM_TOOLS } from "./executor.ts";
export { buildHandTools } from "./tools.ts";

export interface HandsApi {
	caller: HandCaller;
	executor: HandExecutor;
	gate: ConfirmGate;
}

export type HandsCtx = Pick<PluginContext, "tools" | "rpc" | "stream">;

export interface HandsOptions {
	confirmTimeoutMs?: ConfirmOptions["timeoutMs"];
	shellDisabled?: () => Promise<boolean>;
	callTimeoutMs?: number;
}

const DECISIONS: readonly string[] = ["once", "session", "deny"];

/**
 * Wires the two hands (spec 4): registers this side's tools, answers hand calls from the other side, and exposes the confirmation flow.
 * Stream topics: `handRequest` {callId, tool, input, session, insideProject, allowSession} when the user must decide, `handResolved` {callId, decision} when it is over.
 * RPC: `hand.answer` {callId, decision: "once"|"session"|"deny"}, `hand.pending` (open questions).
 */
export function setupHands(ctx: HandsCtx, env: MemberEnv, socket: Pick<HubSocket, "sendFrame" | "onFrame">, sync: SyncManager, options: HandsOptions = {}): HandsApi {
	const gate = new ConfirmGate({ publish: (topic, data) => ctx.stream.publish(topic, data), timeoutMs: options.confirmTimeoutMs });
	const executor = new HandExecutor({ env, sync, gate, shellDisabled: options.shellDisabled });
	const caller = new HandCaller(socket, executor, env.log, options.callTimeoutMs);
	for (const tool of buildHandTools({ env, caller, sync })) ctx.tools.register(tool);

	ctx.rpc("hand.answer", (p) => {
		if (typeof p.callId !== "string" || !p.callId) throw new TeamError("invalidParams", "缺少参数 callId");
		if (typeof p.decision !== "string" || !DECISIONS.includes(p.decision)) throw new TeamError("invalidParams", "decision 必须是 once、session 或 deny");
		return { answered: gate.answer(p.callId, p.decision as Decision) };
	});
	ctx.rpc("hand.pending", () => ({ items: gate.pending() }));
	return { caller, executor, gate };
}
