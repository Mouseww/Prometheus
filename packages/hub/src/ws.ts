import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { TENANT_SCOPE, type TenantCredentials } from "./auth/tenant-credentials.ts";
import { JWT_AUDIENCE } from "./config.ts";
import type { HubDeps, UpgradeHandler } from "./deps.ts";
import { HubError } from "./errors.ts";
import { hostMatchesOrigin, relativePath } from "./http/dispatch.ts";
import { verifyJwt } from "./jwt.ts";
import { LOG_PREFIX } from "./log.ts";
import { type ConnKind, type HandPeer, HandRouter, type HandRouterOptions } from "./services/hands.ts";
import { RELAY_TIMEOUT_MS, type Realtime, type RelayMessage, type RelayOutcome } from "./services/realtime.ts";

const COMMAND_TIMEOUT_MS = 60_000;
/** How often every open connection is re-validated (account still active, credential not revoked). */
export const REVALIDATE_INTERVAL_MS = 60_000;
/** How long a subscriber's ACL check for a workspace or session topic is trusted before a publish re-checks it. */
export const ACL_TTL_MS = 15_000;
/** A topic whose audience is restricted: every delivery re-checks the subscriber's rights (cached per connection). */
const GUARDED_TOPIC = /^(workspace|session):/;
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
	/** Closes every connection of the user (optionally one kind) with 4401; used when an account is disabled or a credential revoked. Returns how many were closed. */
	disconnectUser(userId: string, kind?: ConnKind): number;
	/** Re-validates every open connection now (runs every 60 seconds) and closes the ones that no longer qualify; exposed for tests. Returns how many were closed. */
	revalidate(): Promise<number>;
	close(): Promise<void>;
}

interface Conn extends HandPeer {
	ws: WebSocket;
	topics: Set<string>;
	alive: boolean;
	/** False once the account is disabled or the credential the connection authenticated with is revoked or expired. */
	check(): Promise<boolean>;
	/** Guarded topic -> time its ACL was last confirmed. */
	acl: Map<string, number>;
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

/** An authenticated connection: who it is, what kind, and how to re-validate it later. */
interface Identity {
	userId: string;
	kind: ConnKind;
	check(): Promise<boolean>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
	if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	socket.destroy();
}

export function createWsGateway(deps: HubDeps, options: { offlineGraceMs?: number; revalidateMs?: number; aclTtlMs?: number } = {}): WsGateway {
	const grace = options.offlineGraceMs ?? OFFLINE_GRACE_MS;
	const aclTtl = options.aclTtlMs ?? ACL_TTL_MS;
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
				if (GUARDED_TOPIC.test(topic)) conn.acl.set(topic, deps.now());
				send(conn.ws, { type: "subscribed", topic });
				return;
			}
			case "unsubscribe":
				if (typeof msg.topic === "string") {
					conn.topics.delete(msg.topic);
					conn.acl.delete(msg.topic);
				}
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

	const accept = (ws: WebSocket, who: Identity): void => {
		const { userId, kind } = who;
		const conn: Conn = { ws, userId, kind, topics: new Set(), alive: true, send: (frame) => send(ws, frame), check: who.check, acl: new Map() };
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

	const accountActive = (userId: string): Promise<boolean> =>
		deps.services.actors.load(userId).then(
			() => true,
			(err: unknown) => {
				// Only an unusable account counts as gone; a database hiccup must not drop every connection.
				if (err instanceof HubError && err.status === 401) return false;
				deps.log.warn(`${LOG_PREFIX} 重新校验账号失败: ${err instanceof Error ? err.message : String(err)}`);
				return true;
			},
		);

	const credentials = (): TenantCredentials | undefined => deps.registry.get<TenantCredentials>("tenantCredentials");

	/**
	 * Who the `token` query parameter belongs to, or undefined when it is missing, invalid, or the account is gone. A user
	 * access token makes a `local` connection; a tenant credential (aud `prometheus-tenant`, `tenant: true`, live jti) or an
	 * access token minted from one (`scope: "tenant"`) makes a `tenant` one. The `kind` parameter may only repeat what the
	 * token already says, so a user cannot pose as a tenant instance. `check` is run again every minute for the open connection.
	 */
	const authenticate = async (url: URL): Promise<Identity | undefined> => {
		const token = url.searchParams.get("token");
		if (!token) return undefined;
		const base = { publicKey: deps.publicKeyPem, issuer: deps.config.issuer };
		let kind: ConnKind = "local";
		let claims = verifyJwt(token, { ...base, audience: JWT_AUDIENCE });
		let credentialJti: string | undefined;
		if (claims?.scope === TENANT_SCOPE) {
			// An access token minted for a tenant instance never makes a `local` connection.
			if (!(await credentials()?.accessTokenActive(claims))) return undefined;
			kind = "tenant";
			credentialJti = claims.cid;
		} else if (claims?.scope !== undefined) {
			return undefined;
		}
		if (!claims) {
			const tenantClaims = await credentials()?.verify(token, "tenant");
			if (tenantClaims) {
				claims = tenantClaims;
				kind = "tenant";
				credentialJti = tenantClaims.jti;
			}
		}
		if (!claims) return undefined;
		const declared = url.searchParams.get("kind");
		if (declared !== null && declared !== kind) return undefined;
		const userId = claims.sub;
		if (!(await accountActive(userId))) return undefined;
		const check = async (): Promise<boolean> => {
			if (credentialJti !== undefined && !(await credentials()?.isActive(credentialJti))) return false;
			return accountActive(userId);
		};
		return { userId, kind, check };
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
		// The dedicated workbench origin serves `/rt` only.
		if (deps.config.runtimeOrigin && hostMatchesOrigin(req, deps.config.runtimeOrigin)) return false;
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

	const kick = (conn: Conn): void => {
		conn.ws.close(4401, "Unauthorized");
		// A client that ignores the close handshake must not keep the connection open.
		const timer = setTimeout(() => conn.ws.terminate(), 2000);
		timer.unref();
		removeConn(conn);
	};

	/** Sends an event to the subscribers of a topic. Guarded topics re-check the subscriber's rights when the cached check is stale. */
	function deliver(topic: string, data: unknown): void {
		const guarded = GUARDED_TOPIC.test(topic);
		for (const conn of [...conns]) {
			if (!conn.topics.has(topic)) continue;
			const frame = { type: "event", topic, data };
			const checkedAt = conn.acl.get(topic);
			if (!guarded || (checkedAt !== undefined && deps.now() - checkedAt < aclTtl)) {
				send(conn.ws, frame);
				continue;
			}
			void (handlers ? handlers.canSubscribe(conn.userId, topic) : Promise.resolve(false))
				.then((ok) => {
					if (!ok) {
						conn.topics.delete(topic);
						conn.acl.delete(topic);
						send(conn.ws, { type: "error", code: "forbidden", topic, message: "没有权限订阅该主题" });
						return;
					}
					conn.acl.set(topic, deps.now());
					if (conn.topics.has(topic)) send(conn.ws, frame);
				})
				.catch((err: unknown) => {
					deps.log.warn(`${LOG_PREFIX} 重新校验订阅权限失败: ${err instanceof Error ? err.message : String(err)}`);
				});
		}
	}

	let revalidating = false;
	const revalidate = async (): Promise<number> => {
		if (revalidating) return 0;
		revalidating = true;
		try {
			let closed = 0;
			for (const conn of [...conns]) {
				if (await conn.check()) continue;
				deps.log.info(`${LOG_PREFIX} WebSocket 连接已失效，关闭 user=${conn.userId} kind=${conn.kind}`);
				kick(conn);
				closed += 1;
			}
			return closed;
		} finally {
			revalidating = false;
		}
	};

	const revalidateTimer = setInterval(() => {
		void revalidate().catch((err: unknown) => {
			deps.log.warn(`${LOG_PREFIX} 重新校验 WebSocket 连接失败: ${err instanceof Error ? err.message : String(err)}`);
		});
	}, options.revalidateMs ?? REVALIDATE_INTERVAL_MS);
	revalidateTimer.unref();

	return {
		handleUpgrade,
		attach,
		setHandlers(h) {
			handlers = h;
		},
		sweep,
		revalidate,
		disconnectUser(userId, kind) {
			const targets = (byUser.get(userId) ?? []).filter((c) => kind === undefined || c.kind === kind);
			for (const conn of targets) kick(conn);
			return targets.length;
		},
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
			deliver(topic, data);
		},
		publishUser(userId, data) {
			for (const conn of byUser.get(userId) ?? []) if (conn.topics.has("user")) send(conn.ws, { type: "event", topic: "user", data });
		},
		isOnline: (userId, target) => (target ? (byUser.get(userId) ?? []).some((c) => c.kind === target) : byUser.has(userId)),

		relay(userId, msg: RelayMessage, timeoutMs = RELAY_TIMEOUT_MS, target = "local") {
			// By default relays go to the owner's own machine; once a session's brain moved to the team side they go to the tenant instance.
			const list = byUser.get(userId)?.filter((c) => c.kind === target);
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
			clearInterval(revalidateTimer);
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
