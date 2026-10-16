import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinPlugins } from "@prometheus/builtin-plugins";
import { DEFAULT_LAN_PORT, PrometheusHost } from "@prometheus/core";
import { type ClientFrame, type NetworkPatch, type NetworkStatus, PROTOCOL_VERSION, type ServerFrame } from "@prometheus/protocol";
import { WebSocket, WebSocketServer } from "ws";
import {
	type Access,
	accessFor,
	checkPasswordRules,
	hashPassword,
	isForwarded,
	isLoopbackSocket,
	lanAddresses,
	LoginLimiter,
	networkRequestAllowed,
	newSecret,
	normalizeHosts,
	signSession,
	verifyPassword,
	verifySession,
} from "./network.ts";
import { isLoopbackAddress, originAllowed, parseCookies, tokensEqual } from "./security.ts";
import { serveStatic } from "./static.ts";

const HOST = process.env.PROMETHEUS_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PROMETHEUS_PORT ?? 7420);
const TOKEN = process.env.PROMETHEUS_TOKEN ?? "";
const WEB_ROOT = process.env.PROMETHEUS_WEB_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const EXTRA_ORIGINS = new Set((process.env.PROMETHEUS_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const AUTH_TIMEOUT_MS = 5_000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const COOKIE = "prometheus_token";
/** An operator who binds a non-loopback HOST manages exposure themselves; a token on loopback (the desktop app) still allows these settings. */
const MANAGED = !isLoopbackAddress(HOST);

if (!isLoopbackAddress(HOST) && !TOKEN) {
	console.error(`[prometheus] 监听非回环地址 ${HOST} 时必须设置 PROMETHEUS_TOKEN，已拒绝启动`);
	process.exit(1);
}
if (TOKEN && TOKEN.length < 16) {
	console.error("[prometheus] PROMETHEUS_TOKEN 至少需要 16 个字符");
	process.exit(1);
}

type Kind = "main" | "network";

interface Client {
	id: string;
	ws: WebSocket;
	authed: boolean;
	sessions: Set<string>;
	access: Access;
	kind: Kind;
}

const clients = new Set<Client>();

function send(client: Client, frame: ServerFrame): void {
	if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(frame));
}

function broadcast(frame: ServerFrame, sessionId?: string): void {
	const data = JSON.stringify(frame);
	for (const c of clients) {
		if (!c.authed || c.ws.readyState !== WebSocket.OPEN) continue;
		if (sessionId && !c.sessions.has(sessionId)) continue;
		c.ws.send(data);
	}
}

const host = await PrometheusHost.create({
	dataDir: process.env.PROMETHEUS_HOME,
	cwd: process.env.PROMETHEUS_CWD,
	builtinPlugins,
	listener: {
		event: (sessionId, event) => broadcast({ type: "event", sessionId, event }, sessionId),
		uiRequest: (sessionId, request) => broadcast({ type: "ui.request", sessionId, request }, request.method === "permission" ? undefined : sessionId),
		uiResolved: (sessionId, requestId) => broadcast({ type: "ui.resolved", sessionId, requestId }),
		sessionsChanged: () => broadcast({ type: "sessions.changed" }),
		gatewaysChanged: () => broadcast({ type: "gateways.changed" }),
		pluginsChanged: () => broadcast({ type: "plugins.changed" }),
		pluginNotify: (plugin) => broadcast({ type: "plugin.notify", plugin }),
	},
});

const config = host.runtime.config;

// ---------- who is asking ----------

/** The password is checked on the network listener, and on the main one only for requests that came through a proxy. */
function accessOf(req: IncomingMessage, kind: Kind): Access {
	return accessFor({
		listener: kind,
		tokenSet: Boolean(TOKEN),
		managed: MANAGED,
		passwordSet: Boolean(config.network().passwordHash),
		forwarded: isForwarded(req),
		loopbackSocket: isLoopbackSocket(req.socket.remoteAddress),
	});
}

/** Whether this request may talk to us at all (Host/Origin rules differ per listener). */
function requestAllowed(req: IncomingMessage, kind: Kind, access: Access): boolean {
	if (access.mode === "deny") return false;
	if (kind === "network" || access.mode === "password") return networkRequestAllowed(req, config.network().allowedHosts, EXTRA_ORIGINS);
	return originAllowed(req, { tokenRequired: Boolean(TOKEN), extraOrigins: EXTRA_ORIGINS });
}

function validCredential(access: Access, secret: string): boolean {
	if (access.mode === "none") return true;
	if (access.mode === "token") return tokensEqual(secret, TOKEN);
	if (access.mode === "password") return verifySession(config.network().secret, secret);
	return false;
}

function httpAuthorized(req: IncomingMessage, kind: Kind): boolean {
	const access = accessOf(req, kind);
	if (access.mode === "none") return true;
	const header = req.headers.authorization;
	if (header?.startsWith("Bearer ") && validCredential(access, header.slice(7))) return true;
	const cookie = parseCookies(req.headers.cookie)[COOKIE];
	return cookie !== undefined && validCredential(access, cookie);
}

// ---------- login ----------

/** 5 free tries per address, then 2s, 4s, ... up to 15 minutes; plus a coarse global brake against distributed guessing. */
const byAddress = new LoginLimiter(5, 2000, 15 * 60 * 1000);
const global = new LoginLimiter(40, 1000, 5 * 60 * 1000);

function clientKey(req: IncomingMessage): string {
	return req.socket.remoteAddress ?? "unknown";
}

type LoginResult = { ok: true; token: string } | { ok: false; message: string; retryAfter?: number };

async function tryLogin(req: IncomingMessage, password: unknown): Promise<LoginResult> {
	const key = clientKey(req);
	const wait = Math.max(byAddress.wait(key), global.wait("*"));
	if (wait > 0) return { ok: false, message: `尝试次数过多，请 ${wait} 秒后再试`, retryAfter: wait };
	const stored = config.network().passwordHash;
	const secret = config.network().secret;
	if (!stored || !secret) return { ok: false, message: "尚未设置登录密码" };
	// Count the attempt before the slow hash so a burst of parallel guesses cannot all slip past the limiter.
	byAddress.fail(key);
	global.fail("*");
	const ok = typeof password === "string" && (await verifyPassword(password, stored));
	if (!ok) return { ok: false, message: "密码不正确" };
	byAddress.reset(key);
	global.refund("*");
	return { ok: true, token: signSession(secret) };
}

// ---------- listeners ----------

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > limit) throw new Error("请求体过大");
		chunks.push(chunk as Buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
	res.end(JSON.stringify(body));
}

function cookieHeader(value: string, req: IncomingMessage, maxAgeS?: number): string {
	const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
	const age = maxAgeS === undefined ? "" : `; Max-Age=${maxAgeS}`;
	return `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/${age}${secure}`;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, kind: Kind): Promise<void> {
	const url = new URL(req.url ?? "/", "http://x");
	const access = accessOf(req, kind);
	if (!requestAllowed(req, kind, access)) return json(res, 403, { error: "forbidden" });
	const needsLogin = access.mode !== "none";

	if (url.pathname === "/api/health") return json(res, 200, { ok: true, protocol: PROTOCOL_VERSION, authRequired: needsLogin, login: access.mode === "password" ? "password" : access.mode === "token" ? "token" : undefined });

	// Exchanges a credential for an HttpOnly cookie so plugin panel iframes can load authenticated routes.
	if (url.pathname === "/api/login" && req.method === "POST") {
		const body = (await readJson(req).catch(() => ({}))) as { token?: unknown; password?: unknown };
		if (access.mode === "password" && typeof body.password === "string") {
			const result = await tryLogin(req, body.password);
			if (!result.ok) return json(res, result.retryAfter ? 429 : 401, { error: result.message, retryAfter: result.retryAfter });
			return json(res, 200, { ok: true, token: result.token }, { "set-cookie": cookieHeader(result.token, req, 30 * 24 * 3600) });
		}
		if (needsLogin && (typeof body.token !== "string" || !validCredential(access, body.token))) return json(res, 401, { error: "invalid token" });
		return json(res, 200, { ok: true }, needsLogin ? { "set-cookie": cookieHeader(String(body.token), req) } : {});
	}
	if (url.pathname === "/api/logout" && req.method === "POST") return json(res, 200, { ok: true }, { "set-cookie": cookieHeader("", req, 0) });

	if (url.pathname.startsWith("/plugins/")) {
		if (!httpAuthorized(req, kind)) return json(res, 401, { error: "unauthorized" });
		const route = host.runtime.plugins.routes.find((r) => r.method === req.method && r.path === url.pathname);
		if (!route) return json(res, 404, { error: "not found" });
		await route.handler(req, res);
		return;
	}

	if (await serveStatic(WEB_ROOT, req, res)) return;
	json(res, 404, { error: "not found" });
}

function makeServer(kind: Kind): Server {
	const server = createServer((req, res) => {
		handleHttp(req, res, kind).catch((err: unknown) => {
			console.error("[prometheus] HTTP 错误", err);
			if (!res.headersSent) json(res, 500, { error: "internal error" });
			else res.end();
		});
	});
	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url ?? "/", "http://x");
		if (pathname !== "/ws" || !requestAllowed(req, kind, accessOf(req, kind))) {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, kind));
	});
	return server;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

// ---------- network settings ----------

const main = makeServer("main");
let net: Server | undefined;
let netError: string | undefined;
let mainPort = PORT;

function networkStatus(canEdit: boolean): NetworkStatus {
	const n = config.network();
	return {
		managed: MANAGED,
		lan: n.lan,
		port: n.port || DEFAULT_LAN_PORT,
		allowedHosts: n.allowedHosts,
		passwordSet: Boolean(n.passwordHash),
		listening: Boolean(net?.listening),
		...(netError ? { error: netError } : {}),
		addresses: net?.listening ? lanAddresses() : [],
		localPort: mainPort,
		canEdit: canEdit && !MANAGED,
	};
}

function stopNetwork(): Promise<void> {
	const current = net;
	net = undefined;
	if (!current) return Promise.resolve();
	for (const c of clients) if (c.kind === "network") c.ws.close(1001, "network access closed");
	return new Promise((done) => {
		current.close(() => done());
		current.closeAllConnections?.();
	});
}

function startNetwork(): Promise<void> {
	return new Promise((done) => {
		const n = config.network();
		const server = makeServer("network");
		netError = undefined;
		server.once("error", (err: NodeJS.ErrnoException) => {
			netError = err.code === "EADDRINUSE" ? `端口 ${n.port} 已被占用` : err.code === "EACCES" ? `没有权限监听端口 ${n.port}` : err.message;
			net = undefined;
			done();
		});
		server.listen(n.port, "0.0.0.0", () => {
			net = server;
			console.log(`[prometheus] 局域网访问已开启 0.0.0.0:${n.port}`);
			done();
		});
	});
}

/** Brings the network listener in line with the saved settings; never listens without a password. */
async function applyNetwork(): Promise<void> {
	await stopNetwork();
	const n = config.network();
	if (MANAGED || !n.lan || !n.passwordHash) return;
	await startNetwork();
}

async function updateNetwork(patch: NetworkPatch): Promise<NetworkStatus> {
	if (MANAGED) throw new Error("监听地址由环境变量管理，请在服务端环境变量中配置");
	const cur = config.network();
	let { passwordHash, secret } = cur;
	if (patch.password !== undefined) {
		passwordHash = await hashPassword(checkPasswordRules(patch.password));
		secret = newSecret();
	}
	if (patch.revokeSessions) secret = newSecret();
	const lan = patch.lan ?? cur.lan;
	if (lan && !passwordHash) throw new Error("开启局域网访问前，请先设置登录密码");
	let port = cur.port;
	if (patch.port !== undefined) {
		if (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535) throw new Error("端口需在 1024–65535 之间");
		if (patch.port === mainPort) throw new Error("该端口已被本机服务占用");
		port = patch.port;
	}
	const allowedHosts = patch.allowedHosts === undefined ? cur.allowedHosts : normalizeHosts(patch.allowedHosts);
	await config.setNetwork({ lan, port, allowedHosts, passwordHash, secret: secret ?? newSecret() });
	const rebind = patch.lan !== undefined || patch.port !== undefined || patch.password !== undefined || patch.revokeSessions;
	if (rebind) await applyNetwork();
	// Signed-in devices on the old password lose access at once; the settings page itself is local and stays.
	if (patch.password !== undefined || patch.revokeSessions) for (const c of clients) if (c.access.mode === "password") c.ws.close(4003, "unauthorized");
	return networkStatus(true);
}

// ---------- websocket ----------

wss.on("connection", (ws: WebSocket, req: IncomingMessage, kind: Kind) => {
	const access = accessOf(req, kind);
	const client: Client = { id: randomUUID(), ws, authed: access.mode === "none", sessions: new Set(), access, kind };
	clients.add(client);
	const login = access.mode === "password" ? "password" : access.mode === "token" ? "token" : undefined;
	send(client, { type: "hello", protocol: PROTOCOL_VERSION, authRequired: access.mode !== "none", ...(login ? { login } : {}), local: access.local });
	const authTimer = client.authed ? undefined : setTimeout(() => ws.close(4001, "auth timeout"), AUTH_TIMEOUT_MS);

	ws.on("close", () => {
		clearTimeout(authTimer);
		clients.delete(client);
	});

	ws.on("message", async (raw) => {
		let frame: ClientFrame;
		try {
			frame = JSON.parse(raw.toString()) as ClientFrame;
		} catch {
			return send(client, { type: "error", message: "无效的 JSON 帧" });
		}

		if (!client.authed) {
			if (frame.type === "auth" && typeof frame.token === "string" && validCredential(access, frame.token)) {
				client.authed = true;
				clearTimeout(authTimer);
				return send(client, { type: "auth_ok" });
			}
			if (frame.type === "login" && access.mode === "password") {
				const result = await tryLogin(req, frame.password);
				if (!result.ok) {
					send(client, { type: "login_failed", message: result.message, ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}) });
					// Leave the socket open for another try until the auth timer runs out; the limiter slows guessing.
					return;
				}
				client.authed = true;
				clearTimeout(authTimer);
				return send(client, { type: "auth_ok", token: result.token });
			}
			return ws.close(4003, "unauthorized");
		}

		switch (frame.type) {
			case "auth":
			case "login":
				return send(client, { type: "auth_ok" });
			case "subscribe":
				client.sessions.add(frame.sessionId);
				return;
			case "unsubscribe":
				client.sessions.delete(frame.sessionId);
				return;
			case "rpc": {
				try {
					let data: unknown;
					if (frame.method === "network.get") data = networkStatus(access.local);
					else if (frame.method === "network.set") {
						// Only the machine itself, with nothing in between, may open or reshape network access.
						if (!access.local) throw new Error("只能在本机上修改网络访问设置");
						data = await updateNetwork(frame.params as NetworkPatch);
					} else {
						data = await host.call(frame.method, frame.params as never);
						if (frame.method === "session.create" || frame.method === "session.open") client.sessions.add((data as { id: string }).id);
					}
					send(client, { type: "response", id: frame.id, ok: true, data });
				} catch (err) {
					send(client, { type: "response", id: frame.id, ok: false, error: err instanceof Error ? err.message : String(err) });
				}
				return;
			}
			default:
				send(client, { type: "error", message: "未知帧类型" });
		}
	});
});

main.listen(PORT, HOST, () => {
	const addr = main.address();
	mainPort = addr && typeof addr === "object" ? addr.port : PORT;
	const url = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${mainPort}`;
	console.log(`[prometheus] 已启动 ${url}  (鉴权: ${TOKEN ? "令牌" : "仅本机"})`);
	// Machine-readable line for the desktop shell to detect readiness.
	console.log(`PROMETHEUS_READY ${mainPort}`);
	void applyNetwork();
});

async function shutdown(): Promise<void> {
	for (const c of clients) c.ws.close(1001, "server shutdown");
	main.close();
	await stopNetwork();
	await host.dispose().catch(() => {});
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Desktop shell holds our stdin; when it exits (even if killed) the pipe closes and we follow.
if (process.env.PROMETHEUS_PARENT_WATCH === "1") {
	process.stdin.on("end", shutdown);
	process.stdin.on("error", shutdown);
	process.stdin.resume();
}
