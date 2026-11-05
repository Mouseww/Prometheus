import { LOG_PREFIX, type HubLog } from "../log.ts";

/** Which of a user's member connections a socket is: their own machine's server, or their tenant instance on the Hub host. */
export type ConnKind = "local" | "tenant";
export type HandTarget = "local" | "team";

/** A hand call may wait for the user's confirmation (120 s) and then for the command itself. */
export const HAND_CALL_TIMEOUT_MS = 10 * 60_000;
const WAKE_WAIT_MS = 20_000;
const WAKE_POLL_MS = 100;

/** One side of a user's pair of connections, as the router sees it. */
export interface HandPeer {
	readonly userId: string;
	readonly kind: ConnKind;
	send(frame: unknown): void;
}

export interface HandRouterOptions {
	/** The user's live connections of one kind, oldest first. */
	peers(userId: string, kind: ConnKind): readonly HandPeer[];
	log: HubLog;
	timeoutMs?: number;
	/** Starts the user's tenant when a call targets an offline team side (the call then waits a short while for it to connect). */
	wake?(userId: string): Promise<unknown>;
	wakeWaitMs?: number;
}

interface Pending {
	origin: HandPeer;
	target: HandPeer;
	callId: string;
	timer: NodeJS.Timeout;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const targetKind = (target: HandTarget): ConnKind => (target === "team" ? "tenant" : "local");

/**
 * Forwards `hand.call` between the two member connections of one user (spec 4.2). A call is only ever delivered to a
 * connection of the caller's own user and of the opposite kind; the answer goes back the same way.
 */
export class HandRouter {
	private readonly opts: HandRouterOptions;
	private readonly pending = new Map<string, Pending>();

	constructor(opts: HandRouterOptions) {
		this.opts = opts;
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	private key(userId: string, callId: string): string {
		return `${userId}\u0000${callId}`;
	}

	private fail(origin: HandPeer, callId: string, code: string, error: string): void {
		origin.send({ type: "hand.result", callId, ok: false, code, error });
	}

	/** Handles a `hand.call` frame from `from`. Always answers `from` eventually (success, target error, offline, timeout). */
	async call(from: HandPeer, msg: Record<string, unknown>): Promise<void> {
		const callId = typeof msg.callId === "string" && msg.callId.length > 0 && msg.callId.length <= 100 ? msg.callId : undefined;
		if (!callId) {
			from.send({ type: "error", code: "invalidMessage", message: "hand.call 需要 callId" });
			return;
		}
		const target = msg.target;
		if (target !== "local" && target !== "team") return this.fail(from, callId, "invalidMessage", "target 必须是 local 或 team");
		if (typeof msg.tool !== "string" || !TOOL_NAME.test(msg.tool)) return this.fail(from, callId, "invalidMessage", "tool 无效");
		if (typeof msg.fromSession !== "string" || msg.fromSession.length === 0 || msg.fromSession.length > 200) return this.fail(from, callId, "invalidMessage", "缺少 fromSession");
		if (msg.input !== undefined && !isRecord(msg.input)) return this.fail(from, callId, "invalidMessage", "input 必须是对象");
		// A hand always belongs to the caller's own user; naming someone else is refused outright.
		if (msg.targetUserId !== undefined && msg.targetUserId !== from.userId) return this.fail(from, callId, "handForbidden", "不能调用其他用户的手");
		const wanted = targetKind(target);
		if (wanted === from.kind) return this.fail(from, callId, "handTarget", from.kind === "local" ? "本机 server 只能调用团队 server 的手" : "团队 server 只能调用本机的手");
		const key = this.key(from.userId, callId);
		if (this.pending.has(key)) return this.fail(from, callId, "duplicateCall", "callId 已在使用");

		let peer = this.opts.peers(from.userId, wanted).at(-1);
		if (!peer && target === "team" && this.opts.wake) peer = await this.wakeTenant(from.userId);
		if (!peer) {
			const where = target === "team" ? "团队 server" : "本机";
			return this.fail(from, callId, "handOffline", `${where}当前不在线 (handOffline)，请确认它已启动并连接了 Hub`);
		}
		if (this.pending.has(key)) return this.fail(from, callId, "duplicateCall", "callId 已在使用");
		const timer = setTimeout(() => {
			this.pending.delete(key);
			this.fail(from, callId, "handTimeout", "手调用超时");
		}, this.opts.timeoutMs ?? HAND_CALL_TIMEOUT_MS);
		timer.unref();
		this.pending.set(key, { origin: from, target: peer, callId, timer });
		peer.send({ type: "hand.call", callId, fromSession: msg.fromSession, tool: msg.tool, input: msg.input ?? {}, target });
	}

	private async wakeTenant(userId: string): Promise<HandPeer | undefined> {
		try {
			await this.opts.wake?.(userId);
		} catch (err) {
			this.opts.log.warn(`${LOG_PREFIX} 唤醒租户实例失败: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
		const end = Date.now() + (this.opts.wakeWaitMs ?? WAKE_WAIT_MS);
		for (;;) {
			const peer = this.opts.peers(userId, "tenant").at(-1);
			if (peer) return peer;
			if (Date.now() >= end) return undefined;
			await new Promise((r) => setTimeout(r, WAKE_POLL_MS));
		}
	}

	/** Handles a `hand.result` frame; only the connection the call was delivered to may answer it. */
	result(from: HandPeer, msg: Record<string, unknown>): void {
		if (typeof msg.callId !== "string") return;
		const key = this.key(from.userId, msg.callId);
		const entry = this.pending.get(key);
		if (!entry || entry.target !== from) return;
		clearTimeout(entry.timer);
		this.pending.delete(key);
		const ok = msg.ok === true;
		entry.origin.send({
			type: "hand.result",
			callId: entry.callId,
			ok,
			...(ok && msg.output !== undefined ? { output: msg.output } : {}),
			...(!ok ? { error: typeof msg.error === "string" ? msg.error : "手调用失败", ...(typeof msg.code === "string" ? { code: msg.code } : {}) } : {}),
		});
	}

	/** A connection closed: calls it was serving fail now, calls it made are forgotten. */
	dropPeer(peer: HandPeer): void {
		for (const [key, entry] of this.pending) {
			if (entry.target === peer) {
				clearTimeout(entry.timer);
				this.pending.delete(key);
				this.fail(entry.origin, entry.callId, "handOffline", "对端在调用过程中断开了连接 (handOffline)");
			} else if (entry.origin === peer) {
				clearTimeout(entry.timer);
				this.pending.delete(key);
			}
		}
	}

	dispose(): void {
		for (const entry of this.pending.values()) clearTimeout(entry.timer);
		this.pending.clear();
	}
}
