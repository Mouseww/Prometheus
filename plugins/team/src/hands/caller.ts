import { randomUUID } from "node:crypto";
import type { HubSocket } from "../member/relay.ts";
import { errorMessage, LOG, TeamError } from "../types.ts";
import type { HandExecutor } from "./executor.ts";

/** A hand call may include the user's confirmation (120 s) and a long command, so the caller waits this long for the Hub's answer. */
export const CALL_TIMEOUT_MS = 11 * 60_000;

export type HandSocket = Pick<HubSocket, "sendFrame" | "onFrame">;

interface Pending {
	resolve(output: string): void;
	reject(err: Error): void;
	timer: NodeJS.Timeout;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Both ends of the hand protocol on one Hub connection: `call` sends a `hand.call` and waits for its `hand.result`; an incoming
 * `hand.call` is run by the executor and answered with a `hand.result`.
 */
export class HandCaller {
	private readonly socket: HandSocket;
	private readonly executor: Pick<HandExecutor, "run">;
	private readonly log: { warn(message: string): void };
	private readonly timeoutMs: number;
	private readonly pending = new Map<string, Pending>();
	private readonly off: () => void;

	constructor(socket: HandSocket, executor: Pick<HandExecutor, "run">, log: { warn(message: string): void }, timeoutMs = CALL_TIMEOUT_MS) {
		this.socket = socket;
		this.executor = executor;
		this.log = log;
		this.timeoutMs = timeoutMs;
		this.off = socket.onFrame((frame) => this.handle(frame));
	}

	dispose(): void {
		this.off();
		for (const [id, p] of this.pending) {
			clearTimeout(p.timer);
			this.pending.delete(id);
			p.reject(new TeamError("handOffline", "插件已停止", 503));
		}
	}

	/** Calls a tool on the other machine. Resolves with its output text; rejects with a TeamError carrying the Hub's code (`handOffline`, `handDenied`, ...). */
	call(target: "local" | "team", tool: string, input: Record<string, unknown>, fromSession: string): Promise<string> {
		const callId = randomUUID();
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(callId);
				reject(new TeamError("handTimeout", "等待对端响应超时", 504));
			}, this.timeoutMs);
			timer.unref();
			this.pending.set(callId, { resolve, reject, timer });
			if (!this.socket.sendFrame({ type: "hand.call", callId, fromSession, tool, input, target })) {
				clearTimeout(timer);
				this.pending.delete(callId);
				reject(new TeamError("handOffline", "尚未连接 Hub，无法调用另一台机器的工具", 503));
			}
		});
	}

	private handle(frame: Record<string, unknown>): boolean | Promise<boolean> {
		if (frame.type === "hand.result") {
			const callId = typeof frame.callId === "string" ? frame.callId : "";
			const entry = this.pending.get(callId);
			if (!entry) return true;
			clearTimeout(entry.timer);
			this.pending.delete(callId);
			if (frame.ok === true) entry.resolve(typeof frame.output === "string" ? frame.output : JSON.stringify(frame.output ?? ""));
			else entry.reject(new TeamError(typeof frame.code === "string" ? frame.code : "handFailed", typeof frame.error === "string" ? frame.error : "手调用失败", 502));
			return true;
		}
		if (frame.type !== "hand.call") return false;
		return this.serve(frame).then(() => true);
	}

	private async serve(frame: Record<string, unknown>): Promise<void> {
		const callId = typeof frame.callId === "string" ? frame.callId : "";
		if (!callId) return;
		let reply: Record<string, unknown>;
		try {
			if (typeof frame.tool !== "string" || typeof frame.fromSession !== "string") throw new TeamError("invalidParams", "手调用缺少 tool 或 fromSession");
			const output = await this.executor.run({ callId, tool: frame.tool, fromSession: frame.fromSession, input: isRecord(frame.input) ? frame.input : {} });
			reply = { ok: true, output };
		} catch (err) {
			const code = err instanceof TeamError ? err.code : "handFailed";
			if (code !== "handDenied") this.log.warn(`${LOG} 执行手调用失败 (${String(frame.tool)}): ${errorMessage(err)}`);
			reply = { ok: false, error: errorMessage(err), code };
		}
		this.socket.sendFrame({ type: "hand.result", callId, ...reply });
	}
}
