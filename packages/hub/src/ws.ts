import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { JWT_AUDIENCE } from "./config.ts";
import type { HubDeps, UpgradeHandler } from "./deps.ts";
import { relativePath } from "./http/dispatch.ts";
import { verifyJwt } from "./jwt.ts";
import { LOG_PREFIX } from "./log.ts";
import { type ConnKind, type HandPeer, HandRouter, type HandRouterOptions } from "./services/hands.ts";
import { RELAY_TIMEOUT_MS, type Realtime, type RelayMessage, type RelayOutcome } from "./services/realtime.ts";

/** Audience of the long-lived credential a tenant instance's team plugin presents (see runtime/tenant-env.ts). */
const TENANT_TOKEN_AUDIENCE = "prometheus-tenant";
const COMMAND_TIMEOUT_MS = 60_000;
const SNAPSHOT_REF_FIELD = /^[A-Za-z0-9_.-]{1,200}$/;

export type CommandOutcome = { kind: "ok"; data: unknown } | { kind: "offline" } | { kind: "timeout" } | { kind: "failed"; error?: string; code?: string };

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
	/**
	 * Sends a command frame `{type:"cmd", cmdId, cmd, params}` to the user's newest connection of `kind` and waits for its
	 * `cmdResult`. Used by the handoff orchestration; only the connection the command went to may answer it.
	 */
	command(userId: string, kind: ConnKind, cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<CommandOutcome>;
	/** Starts the user's tenant when a hand call targets an offline team side (set by the runtime-aware route module). */
	setWake(wake: HandRouterOptions["wake"]): void;
	/** Flags sessions of owners that have had no connection for longer than the grace period. Runs every 10 seconds; exposed for tests. */
	sweep(): Promise<number>;
	connectionCount(userId?: string, kind?: ConnKind): number;
	close(): Promise<void>;
}

interface Conn extends HandPeer {
	ws: WebSocket;
	topics: Set<string>;
	alive: boolean;
}

interface PendingCommand {
	conn: Conn;
	resolve(outcome: CommandOutcome): void;
	timer: NodeJS.Timeout;
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
	const pendingCommands = new Map<string, PendingCommand>();
	const startedAt = deps.now();
	let handlers: WsHandlers | undefined;
	let wakeTenant: HandRouterOptions["wake"];
	let sweeping = false;

	const send = (ws: WebSocket, frame: unknown): void => {
		if (ws.readyState === 1) ws.send(JSON.stringify(frame));
	};

	const hands = new HandRouter({
		peers: (userId, kind) => (byUser.get(userId) ?? []).filter((c) => c.kind === kind),
		log: deps.log,
		wake: (userId) => (wakeTenant ? wakeTenant(userId) : Promise.reject(new Error("no wake"))),
	});

	const failPendingFor = (conn: Conn): void => {
		for (const [id, p] of pending) {
			if (p.conn !== conn) continue;
			clearTimeout(p.timer);
			pending.delete(id);
			p.resolve({ kind: "offline" });
		}
		for (const [id, p] of pendingCommands) {
			if (p.conn !== conn) continue;
			clearTimeout(p.timer);
			pendingCommands.delete(id);
			p.resolve({ kind: "offline" });
		}
		hands.dropPeer(conn);
	};

	/** Frames of the other connections of the same user (the sender never hears its own snapshot messages). */
	const toSiblings = (from: Conn, frame: unknown): void => {
		for (const c of byUser.get(from.userId) ?? []) if (c !== from) send(c.ws, frame);
	};

	const snapshotFrame = (type: "snapshot.updated" | "snapshot.applied", msg: Record<string, unknown>): Record<string, unknown> | undefined => {
		const { hubSessionId, side, commit } = msg;
		if (typeof hubSessionId !== "string" || !SNAPSHOT_REF_FIELD.test(hubSessionId)) return undefined;
		if (side !== "local" && side !== "team") return undefined;
		if (typeof commit !== "string" || !/^[0-9a-f]{40,64}$/.test(commit)) return undefined;
		return { type, hubSessionId, side, commit, ...(typeof msg.conflictRef === "string" && msg.conflictRef.length <= 300 ? { conflictRef: msg.conflictRef } : {}) };
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
			case "cmdResult": {
				const cmdId = msg.cmdId;
				const entry = typeof cmdId === "string" ? pendingCommands.get(cmdId) : undefined;
				if (!entry || entry.conn !== conn || typeof cmdId !== "string") return;
				clearTimeout(entry.timer);
				pendingCommands.delete(cmdId);
				entry.resolve(
					msg.ok === true
						? { kind: "ok", data: msg.data }
						: { kind: "failed", error: typeof msg.error === "string" ? msg.error : undefined, code: typeof msg.code === "string" ? msg.code : undefined },
				);
				return;
			}
			case "hand.call":
				await hands.call(conn, msg);
				return;
			case "hand.result":
				hands.result(conn, msg);
				return;
			case "snapshot.updated":
			case "snapshot.applied": {
				const frame = snapshotFrame(msg.type, msg);
				if (!frame) {
					send(conn.ws, { type: "error", code: "invalidMessage", message: `${msg.type} 缺少或带有无效的 hubSessionId/side/commit` });
					return;
				}
				toSiblings(conn, frame);
				return;
			}
			default:
				send(conn.ws, { type: "error", code: "invalidMessage", message: `未知消息类型 ${msg.type}` });
		}
	};

	const accept = (ws: WebSocket, who: { userId: string; kind: ConnKind }): void => {
		const { userId, kind } = who;
		const conn: Conn = { ws, userId, kind, topics: new Set(), alive: true, send: (frame) => send(ws, frame) };
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
		send(ws, { type: "ready", userId, kind });
		if (first && handlers) {
			void handlers.onOnline(userId).catch((err: unknown) => {
				deps.log.warn(`${LOG_PREFIX} 恢复会话在线状态失败: ${err instanceof Error ? err.message : String(err)}`);
			});
		}
	};

	/**
	 * Who the `token` query parameter belongs to, or undefined when it is missing, invalid, or the account is gone. A user
	 * access token makes a `local` connection; a tenant credential (aud `prometheus-tenant`, `tenant: true`) makes a `tenant`
	 * one. The `kind` parameter may only repeat what the token already says, so a user cannot pose as a tenant instance.
	 */
	const authenticate = async (url: URL): Promise<{ userId: string; kind: ConnKind } | undefined> => {
		const token = url.searchParams.get("token");
		if (!token) return undefined;
		const base = { publicKey: deps.publicKeyPem, issuer: deps.config.issuer };
		let kind: ConnKind = "local";
		let claims = verifyJwt(token, { ...base, audience: JWT_AUDIENCE });
		if (!claims) {
			const tenantClaims = verifyJwt(token, { ...base, audience: TENANT_TOKEN_AUDIENCE });
			if (tenantClaims && (tenantClaims as { tenant?: unknown }).tenant === true) {
				claims = tenantClaims;
				kind = "tenant";
			}
		}
		if (!claims) return undefined;
		const declared = url.searchParams.get("kind");
		if (declared !== null && declared !== kind) return undefined;
		try {
			await deps.services.actors.load(claims.sub);
		} catch {
			return undefined;
		}
		return { userId: claims.sub, kind };
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
			.then((who) => {
				ws.off("message", hold);
				ws.off("error", noop);
				if (!who) return ws.close(4401, "Unauthorized");
				if (ws.readyState !== 1) return;
				accept(ws, who);
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
			const who = await authenticate(url);
			if (!who) return rejectUpgrade(socket, 401, "Unauthorized");
			if (socket.destroyed) return;
			wss.handleUpgrade(req, socket, head, (ws) => accept(ws, who));
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
		connectionCount: (userId, kind) => (userId ? (byUser.get(userId) ?? []).filter((c) => kind === undefined || c.kind === kind).length : conns.size),
		setWake(wake) {
			wakeTenant = wake;
		},

		command(userId, kind, cmd, params, timeoutMs = COMMAND_TIMEOUT_MS) {
			const conn = (byUser.get(userId) ?? []).filter((c) => c.kind === kind).at(-1);
			if (!conn) return Promise.resolve<CommandOutcome>({ kind: "offline" });
			const cmdId = randomUUID();
			return new Promise<CommandOutcome>((resolve) => {
				const timer = setTimeout(() => {
					pendingCommands.delete(cmdId);
					resolve({ kind: "timeout" });
				}, timeoutMs);
				pendingCommands.set(cmdId, { conn, resolve, timer });
				send(conn.ws, { type: "cmd", cmdId, cmd, params });
			});
		},

		publish(topic, data) {
			for (const conn of conns) if (conn.topics.has(topic)) send(conn.ws, { type: "event", topic, data });
		},
		publishUser(userId, data) {
			for (const conn of byUser.get(userId) ?? []) if (conn.topics.has("user")) send(conn.ws, { type: "event", topic: "user", data });
		},
		isOnline: (userId) => byUser.has(userId),

		relay(userId, msg: RelayMessage, timeoutMs = RELAY_TIMEOUT_MS) {
			// Relays go to the owner's own machine; a tenant instance only serves hand calls and commands.
			const list = byUser.get(userId)?.filter((c) => c.kind === "local");
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
			for (const [id, p] of pendingCommands) {
				clearTimeout(p.timer);
				pendingCommands.delete(id);
				p.resolve({ kind: "offline" });
			}
			hands.dispose();
			for (const conn of conns) conn.ws.terminate();
			conns.clear();
			byUser.clear();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
		},
	};
}
