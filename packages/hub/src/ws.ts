import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { JWT_AUDIENCE } from "./config.ts";
import type { HubDeps, UpgradeHandler } from "./deps.ts";
import { relativePath } from "./http/dispatch.ts";
import { verifyJwt } from "./jwt.ts";
import { LOG_PREFIX } from "./log.ts";
import { RELAY_TIMEOUT_MS, type Realtime, type RelayMessage, type RelayOutcome } from "./services/realtime.ts";

/** A member's WebSocket may be gone this long before the Hub flags their sessions offline (spec 6.2). */
export const OFFLINE_GRACE_MS = 60_000;
const SWEEP_INTERVAL_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const WS_PATH = "/ws";

export interface WsHandlers {
	canSubscribe(userId: string, topic: string): Promise<boolean>;
	/** The user's first connection opened. */
	onOnline(userId: string): Promise<unknown>;
	/** Offline check: users who own a session that is not flagged offline. */
	ownersWithLiveSessions(): Promise<string[]>;
	markOwnerOffline(userId: string): Promise<number>;
}

export interface WsGateway extends Realtime {
	handleUpgrade: UpgradeHandler;
	/**
	 * Takes over a socket the host already upgraded (the plugin host owns the HTTP server). The access token comes from
	 * the `token` query parameter of `req.url`, like in `handleUpgrade`; a missing or bad token closes the socket with 4401.
	 */
	attach(ws: WebSocket, req: IncomingMessage): void;
	setHandlers(handlers: WsHandlers): void;
	/** Flags sessions of owners that have had no connection for longer than the grace period. Runs every 10 seconds; exposed for tests. */
	sweep(): Promise<number>;
	connectionCount(userId?: string): number;
	close(): Promise<void>;
}

interface Conn {
	ws: WebSocket;
	userId: string;
	topics: Set<string>;
	alive: boolean;
}

interface PendingRelay {
	conn: Conn;
	resolve(outcome: RelayOutcome): void;
	timer: NodeJS.Timeout;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
	if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	socket.destroy();
}

export function createWsGateway(deps: HubDeps, options: { offlineGraceMs?: number } = {}): WsGateway {
	const grace = options.offlineGraceMs ?? OFFLINE_GRACE_MS;
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
	const conns = new Set<Conn>();
	const byUser = new Map<string, Conn[]>();
	const disconnectedAt = new Map<string, number>();
	const pending = new Map<string, PendingRelay>();
	const startedAt = deps.now();
	let handlers: WsHandlers | undefined;
	let sweeping = false;

	const send = (ws: WebSocket, frame: unknown): void => {
		if (ws.readyState === 1) ws.send(JSON.stringify(frame));
	};

	const failPendingFor = (conn: Conn): void => {
		for (const [id, p] of pending) {
			if (p.conn !== conn) continue;
			clearTimeout(p.timer);
			pending.delete(id);
			p.resolve({ kind: "offline" });
		}
	};

	const removeConn = (conn: Conn): void => {
		conns.delete(conn);
		failPendingFor(conn);
		const rest = (byUser.get(conn.userId) ?? []).filter((c) => c !== conn);
		if (rest.length > 0) byUser.set(conn.userId, rest);
		else {
			byUser.delete(conn.userId);
			disconnectedAt.set(conn.userId, deps.now());
		}
	};

	const onMessage = async (conn: Conn, raw: RawData): Promise<void> => {
		conn.alive = true;
		let msg: unknown;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			send(conn.ws, { type: "error", code: "invalidMessage", message: "消息不是有效的 JSON" });
			return;
		}
		if (!isRecord(msg) || typeof msg.type !== "string") {
			send(conn.ws, { type: "error", code: "invalidMessage", message: "缺少 type 字段" });
			return;
		}
		switch (msg.type) {
			case "ping":
				send(conn.ws, { type: "pong" });
				return;
			case "subscribe": {
				const topic = msg.topic;
				if (typeof topic !== "string") {
					send(conn.ws, { type: "error", code: "invalidMessage", message: "缺少 topic" });
					return;
				}
				const allowed = topic === "user" || (handlers ? await handlers.canSubscribe(conn.userId, topic) : false);
				if (!allowed) {
					send(conn.ws, { type: "error", code: "forbidden", topic, message: "没有权限订阅该主题" });
					return;
				}
				conn.topics.add(topic);
				send(conn.ws, { type: "subscribed", topic });
				return;
			}
			case "unsubscribe":
				if (typeof msg.topic === "string") conn.topics.delete(msg.topic);
				return;
			case "relayResult": {
				const relayId = msg.relayId;
				const entry = typeof relayId === "string" ? pending.get(relayId) : undefined;
				// Only the connection the relay was sent to may answer it.
				if (!entry || entry.conn !== conn || typeof relayId !== "string") return;
				clearTimeout(entry.timer);
				pending.delete(relayId);
				entry.resolve(msg.ok === true ? { kind: "ok" } : { kind: "failed", error: typeof msg.error === "string" ? msg.error : undefined });
				return;
			}
			default:
				send(conn.ws, { type: "error", code: "invalidMessage", message: `未知消息类型 ${msg.type}` });
		}
	};

	const accept = (ws: WebSocket, userId: string): void => {
		const conn: Conn = { ws, userId, topics: new Set(), alive: true };
		conns.add(conn);
		const list = byUser.get(userId) ?? [];
		const first = list.length === 0;
		byUser.set(userId, [...list, conn]);
		disconnectedAt.delete(userId);
		ws.on("pong", () => {
			conn.alive = true;
		});
		ws.on("message", (raw) => {
			void onMessage(conn, raw).catch((err: unknown) => {
				deps.log.warn(`${LOG_PREFIX} 处理 WebSocket 消息失败: ${err instanceof Error ? err.message : String(err)}`);
			});
		});
		ws.on("close", () => removeConn(conn));
		ws.on("error", () => removeConn(conn));
		send(ws, { type: "ready", userId });
		if (first && handlers) {
			void handlers.onOnline(userId).catch((err: unknown) => {
				deps.log.warn(`${LOG_PREFIX} 恢复会话在线状态失败: ${err instanceof Error ? err.message : String(err)}`);
			});
		}
	};

	/** The user id behind the `token` query parameter, or undefined when it is missing, invalid, or the account is gone. */
	const authenticate = async (url: URL): Promise<string | undefined> => {
		const token = url.searchParams.get("token");
		const claims = token ? verifyJwt(token, { publicKey: deps.publicKeyPem, issuer: deps.config.issuer, audience: JWT_AUDIENCE }) : undefined;
		if (!claims) return undefined;
		try {
			await deps.services.actors.load(claims.sub);
		} catch {
			return undefined;
		}
		return claims.sub;
	};

	const attach = (ws: WebSocket, req: IncomingMessage): void => {
		const url = new URL(req.url ?? "/", "http://hub.local");
		// The socket is already open: whatever the client sends while the token is being checked is replayed once it is accepted.
		const early: RawData[] = [];
		const hold = (raw: RawData): void => void early.push(raw);
		const noop = (): void => {};
		ws.on("message", hold);
		ws.on("error", noop);
		void authenticate(url)
			.then((userId) => {
				ws.off("message", hold);
				ws.off("error", noop);
				if (!userId) return ws.close(4401, "Unauthorized");
				if (ws.readyState !== 1) return;
				accept(ws, userId);
				for (const raw of early) ws.emit("message", raw, false);
			})
			.catch((err: unknown) => {
				deps.log.error(`${LOG_PREFIX} WebSocket 接入失败: ${err instanceof Error ? err.message : String(err)}`);
				ws.close(1011, "Internal Server Error");
			});
	};

	const handleUpgrade: UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(req.url ?? "/", "http://hub.local");
		if (relativePath(deps.config, url.pathname) !== WS_PATH) return false;
		socket.on("error", () => {});
		void (async () => {
			const userId = await authenticate(url);
			if (!userId) return rejectUpgrade(socket, 401, "Unauthorized");
			if (socket.destroyed) return;
			wss.handleUpgrade(req, socket, head, (ws) => accept(ws, userId));
		})().catch((err: unknown) => {
			deps.log.error(`${LOG_PREFIX} WebSocket 升级失败: ${err instanceof Error ? err.message : String(err)}`);
			rejectUpgrade(socket, 500, "Internal Server Error");
		});
		return true;
	};

	const sweep = async (): Promise<number> => {
		if (!handlers || sweeping) return 0;
		sweeping = true;
		try {
			let flipped = 0;
			for (const owner of await handlers.ownersWithLiveSessions()) {
				if (byUser.has(owner)) continue;
				const since = disconnectedAt.get(owner) ?? startedAt;
				if (deps.now() - since >= grace) flipped += await handlers.markOwnerOffline(owner);
			}
			return flipped;
		} finally {
			sweeping = false;
		}
	};

	const sweepTimer = setInterval(() => {
		void sweep().catch((err: unknown) => {
			deps.log.warn(`${LOG_PREFIX} 检查成员离线状态失败: ${err instanceof Error ? err.message : String(err)}`);
		});
	}, SWEEP_INTERVAL_MS);
	sweepTimer.unref();

	const heartbeat = setInterval(() => {
		for (const conn of conns) {
			if (!conn.alive) {
				conn.ws.terminate();
				continue;
			}
			conn.alive = false;
			conn.ws.ping();
		}
	}, HEARTBEAT_INTERVAL_MS);
	heartbeat.unref();

	return {
		handleUpgrade,
		attach,
		setHandlers(h) {
			handlers = h;
		},
		sweep,
		connectionCount: (userId) => (userId ? (byUser.get(userId)?.length ?? 0) : conns.size),

		publish(topic, data) {
			for (const conn of conns) if (conn.topics.has(topic)) send(conn.ws, { type: "event", topic, data });
		},
		publishUser(userId, data) {
			for (const conn of byUser.get(userId) ?? []) if (conn.topics.has("user")) send(conn.ws, { type: "event", topic: "user", data });
		},
		isOnline: (userId) => byUser.has(userId),

		relay(userId, msg: RelayMessage, timeoutMs = RELAY_TIMEOUT_MS) {
			const list = byUser.get(userId);
			const conn = list?.[list.length - 1];
			if (!conn) return Promise.resolve<RelayOutcome>({ kind: "offline" });
			const relayId = randomUUID();
			return new Promise<RelayOutcome>((resolve) => {
				const timer = setTimeout(() => {
					pending.delete(relayId);
					resolve({ kind: "timeout" });
				}, timeoutMs);
				pending.set(relayId, { conn, resolve, timer });
				send(conn.ws, { type: "relay", relayId, ...msg });
			});
		},

		async close() {
			clearInterval(sweepTimer);
			clearInterval(heartbeat);
			for (const [id, p] of pending) {
				clearTimeout(p.timer);
				pending.delete(id);
				p.resolve({ kind: "offline" });
			}
			for (const conn of conns) conn.ws.terminate();
			conns.clear();
			byUser.clear();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
		},
	};
}
