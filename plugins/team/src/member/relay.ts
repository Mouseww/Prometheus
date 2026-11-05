import type { PluginContext } from "@prometheus/plugin-sdk";
import type { UIResponse } from "@prometheus/protocol";
import { errorMessage, LOG, TeamError } from "../types.ts";
import type { MemberEnv } from "./env.ts";

export interface RelayMessage {
	type: "relay";
	relayId: string;
	hubSessionId?: string;
	sessionId: string;
	serverId?: string;
	action: { type: string; text?: string; requestId?: string; response?: unknown };
	actor?: { userId?: string; name?: string };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Runs an action a granted teammate sent through the Hub. The local session must be in the team mapping and the Hub's idea of
 * which session it is must match ours; anything else is refused before it reaches `ctx.sessions`.
 */
export async function executeRelay(env: MemberEnv, sessions: PluginContext["sessions"], msg: RelayMessage): Promise<void> {
	const state = env.state.get();
	const mapping = typeof msg.sessionId === "string" ? state.sessions[msg.sessionId] : undefined;
	if (!mapping) throw new TeamError("notTeamSession", "该会话不是团队会话");
	if (msg.hubSessionId !== undefined && msg.hubSessionId !== mapping.hubSessionId) throw new TeamError("sessionMismatch", "Hub 会话与本地映射不一致");
	if (msg.serverId !== undefined && msg.serverId !== state.serverId) throw new TeamError("serverMismatch", "该操作不是发给这台服务器的");
	const action = msg.action;
	if (!isRecord(action)) throw new TeamError("invalidAction", "缺少操作内容");
	const actor = typeof msg.actor?.name === "string" && msg.actor.name.trim() ? msg.actor.name.trim() : "团队成员";
	switch (action.type) {
		case "prompt":
			if (typeof action.text !== "string" || !action.text.trim()) throw new TeamError("invalidAction", "prompt 需要非空的 text");
			await sessions.prompt(msg.sessionId, action.text, { actor });
			return;
		case "respond":
			if (typeof action.requestId !== "string" || !isRecord(action.response)) throw new TeamError("invalidAction", "respond 需要 requestId 和 response");
			await sessions.respond(msg.sessionId, action.requestId, action.response as UIResponse);
			return;
		case "abort":
			await sessions.abort(msg.sessionId);
			return;
		default:
			throw new TeamError("invalidAction", `不支持的操作 ${String(action.type)}`);
	}
}

export interface HubSocketOptions {
	env: MemberEnv;
	sessions: PluginContext["sessions"];
	/** Forwards a Hub `event` to the plugin's stream (`hub:<topic>`). */
	publish(topic: string, data: unknown): void;
	createSocket?: (url: string) => WebSocket;
	baseDelayMs?: number;
	maxDelayMs?: number;
	pingMs?: number;
	/** Which connection this is (block 3B). A tenant instance presents its tenant credential instead of an access token. */
	kind?: "local" | "tenant";
	/** The token put in the connection URL; defaults to a fresh access token. */
	wsToken?: () => Promise<string>;
}

/** Handles a frame the relay does not know; resolves true when it consumed it. */
export type FrameHandler = (frame: Record<string, unknown>) => boolean | Promise<boolean>;

/** The member's connection to the Hub: subscribes to `user`, runs relays, forwards events, reconnects with backoff. */
export class HubSocket {
	private readonly opts: HubSocketOptions;
	private readonly topics = new Set<string>(["user"]);
	private socket: WebSocket | undefined;
	private timer: NodeJS.Timeout | undefined;
	private ping: NodeJS.Timeout | undefined;
	private attempt = 0;
	private running = false;
	private readonly frameHandlers = new Set<FrameHandler>();

	constructor(opts: HubSocketOptions) {
		this.opts = opts;
	}

	/** Registers a handler for frames other than events, errors and relays (hand calls, commands, snapshot messages). Returns its remover. */
	onFrame(handler: FrameHandler): () => void {
		this.frameHandlers.add(handler);
		return () => void this.frameHandlers.delete(handler);
	}

	/** Sends a frame when the connection is open; false when it is not. */
	sendFrame(frame: unknown): boolean {
		if (this.socket?.readyState !== 1) return false;
		this.socket.send(JSON.stringify(frame));
		return true;
	}

	get connected(): boolean {
		return this.socket?.readyState === 1;
	}

	/** (Re)starts the connection loop; a no-op while it already runs. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.attempt = 0;
		void this.connect();
	}

	stop(): void {
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		if (this.ping) clearInterval(this.ping);
		this.timer = undefined;
		this.ping = undefined;
		const socket = this.socket;
		this.socket = undefined;
		try {
			socket?.close();
		} catch {
			// Already closed.
		}
	}

	subscribe(topic: string): void {
		this.topics.add(topic);
		this.send({ type: "subscribe", topic });
	}

	unsubscribe(topic: string): void {
		if (topic === "user") return;
		this.topics.delete(topic);
		this.send({ type: "unsubscribe", topic });
	}

	private send(frame: unknown): void {
		if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(frame));
	}

	private schedule(): void {
		if (!this.running || this.timer) return;
		const base = this.opts.baseDelayMs ?? 1000;
		const delay = Math.min(this.opts.maxDelayMs ?? 30_000, base * 2 ** this.attempt++);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.connect();
		}, delay);
		this.timer.unref();
	}

	private async connect(): Promise<void> {
		if (!this.running) return;
		const { env } = this.opts;
		const hubUrl = env.client.hubUrl;
		if (!hubUrl || !env.client.loggedIn) {
			this.running = false;
			return;
		}
		let token: string;
		try {
			token = this.opts.wsToken ? await this.opts.wsToken() : await env.client.ensureToken();
		} catch (err) {
			if (err instanceof TeamError && err.code === "notLoggedIn") {
				this.running = false;
				return;
			}
			env.log.warn(`${LOG} 连接 Hub 前获取令牌失败: ${errorMessage(err)}`);
			this.schedule();
			return;
		}
		if (!this.running) return;
		const kind = this.opts.kind ? `&kind=${this.opts.kind}` : "";
		const url = `${hubUrl.replace(/^http/, "ws")}/plugins/team/ws?token=${encodeURIComponent(token)}${kind}`;
		let socket: WebSocket;
		try {
			socket = (this.opts.createSocket ?? ((u: string) => new WebSocket(u)))(url);
		} catch (err) {
			env.log.warn(`${LOG} 无法创建到 Hub 的 WebSocket: ${errorMessage(err)}`);
			this.schedule();
			return;
		}
		this.socket = socket;
		socket.onopen = () => {
			if (this.socket !== socket) return;
			this.attempt = 0;
			for (const topic of this.topics) socket.send(JSON.stringify({ type: "subscribe", topic }));
			if (this.ping) clearInterval(this.ping);
			this.ping = setInterval(() => this.send({ type: "ping" }), this.opts.pingMs ?? 25_000);
			this.ping.unref();
		};
		socket.onmessage = (ev) => {
			// A frame from a socket that has been replaced is never acted on: relays are only accepted from the current connection.
			if (this.socket !== socket) return;
			void this.handle(socket, typeof ev.data === "string" ? ev.data : String(ev.data));
		};
		socket.onerror = () => {};
		socket.onclose = () => {
			if (this.socket !== socket) return;
			this.socket = undefined;
			if (this.ping) clearInterval(this.ping);
			this.ping = undefined;
			this.schedule();
		};
	}

	private async handle(socket: WebSocket, raw: string): Promise<void> {
		let frame: unknown;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (!isRecord(frame) || typeof frame.type !== "string") return;
		if (frame.type === "event" && typeof frame.topic === "string") {
			this.opts.publish(`hub:${frame.topic}`, frame.data);
			return;
		}
		if (frame.type === "error") {
			this.opts.env.log.warn(`${LOG} Hub 返回错误: ${String(frame.code)} ${String(frame.message ?? "")}`);
			return;
		}
		if (frame.type !== "relay") {
			for (const handler of [...this.frameHandlers]) {
				try {
					if (await handler(frame)) return;
				} catch (err) {
					this.opts.env.log.warn(`${LOG} 处理 Hub 消息 ${frame.type} 失败: ${errorMessage(err)}`);
					return;
				}
			}
			return;
		}
		if (typeof frame.relayId !== "string") return;
		const relayId = frame.relayId;
		let result: { ok: boolean; error?: string };
		try {
			await executeRelay(this.opts.env, this.opts.sessions, frame as unknown as RelayMessage);
			result = { ok: true };
		} catch (err) {
			result = { ok: false, error: errorMessage(err) };
			this.opts.env.log.warn(`${LOG} 转发操作失败: ${result.error}`);
		}
		if (socket.readyState === 1) socket.send(JSON.stringify({ type: "relayResult", relayId, ...result }));
	}
}
