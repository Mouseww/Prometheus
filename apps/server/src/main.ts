import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinPlugins } from "@prometheus/builtin-plugins";
import { PrometheusHost } from "@prometheus/core";
import { type ClientFrame, PROTOCOL_VERSION, type ServerFrame } from "@prometheus/protocol";
import { WebSocket, WebSocketServer } from "ws";
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

if (!isLoopbackAddress(HOST) && !TOKEN) {
	console.error(`[prometheus] 监听非回环地址 ${HOST} 时必须设置 PROMETHEUS_TOKEN，已拒绝启动`);
	process.exit(1);
}
if (TOKEN && TOKEN.length < 16) {
	console.error("[prometheus] PROMETHEUS_TOKEN 至少需要 16 个字符");
	process.exit(1);
}

interface Client {
	id: string;
	ws: WebSocket;
	authed: boolean;
	sessions: Set<string>;
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
		uiRequest: (sessionId, request) => broadcast({ type: "ui.request", sessionId, request }, sessionId),
		uiResolved: (sessionId, requestId) => broadcast({ type: "ui.resolved", sessionId, requestId }, sessionId),
		sessionsChanged: () => broadcast({ type: "sessions.changed" }),
		gatewaysChanged: () => broadcast({ type: "gateways.changed" }),
	},
});

function httpAuthorized(req: IncomingMessage): boolean {
	if (!TOKEN) return true;
	const header = req.headers.authorization;
	if (header?.startsWith("Bearer ") && tokensEqual(header.slice(7), TOKEN)) return true;
	const cookie = parseCookies(req.headers.cookie)[COOKIE];
	return cookie !== undefined && tokensEqual(cookie, TOKEN);
}

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

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://x");

	if (url.pathname === "/api/health") return json(res, 200, { ok: true, protocol: PROTOCOL_VERSION, authRequired: Boolean(TOKEN) });

	// Exchanges the token for an HttpOnly cookie so plugin panel iframes can load authenticated routes.
	if (url.pathname === "/api/login" && req.method === "POST") {
		if (!originAllowed(req, { tokenRequired: Boolean(TOKEN), extraOrigins: EXTRA_ORIGINS })) return json(res, 403, { error: "forbidden" });
		const body = (await readJson(req).catch(() => ({}))) as { token?: unknown };
		if (TOKEN && (typeof body.token !== "string" || !tokensEqual(body.token, TOKEN))) return json(res, 401, { error: "invalid token" });
		const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
		res.setHeader("set-cookie", `${COOKIE}=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/${secure}`);
		return json(res, 200, { ok: true });
	}

	if (url.pathname.startsWith("/plugins/")) {
		if (!httpAuthorized(req)) return json(res, 401, { error: "unauthorized" });
		const route = host.runtime.plugins.routes.find((r) => r.method === req.method && r.path === url.pathname);
		if (!route) return json(res, 404, { error: "not found" });
		await route.handler(req, res);
		return;
	}

	if (await serveStatic(WEB_ROOT, req, res)) return;
	json(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
	handleHttp(req, res).catch((err: unknown) => {
		console.error("[prometheus] HTTP 错误", err);
		if (!res.headersSent) json(res, 500, { error: "internal error" });
		else res.end();
	});
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

server.on("upgrade", (req, socket, head) => {
	const { pathname } = new URL(req.url ?? "/", "http://x");
	if (pathname !== "/ws" || !originAllowed(req, { tokenRequired: Boolean(TOKEN), extraOrigins: EXTRA_ORIGINS })) {
		socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws: WebSocket) => {
	const client: Client = { id: randomUUID(), ws, authed: !TOKEN, sessions: new Set() };
	clients.add(client);
	send(client, { type: "hello", protocol: PROTOCOL_VERSION, authRequired: Boolean(TOKEN) });
	const authTimer = TOKEN ? setTimeout(() => ws.close(4001, "auth timeout"), AUTH_TIMEOUT_MS) : undefined;

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
			if (frame.type === "auth" && typeof frame.token === "string" && tokensEqual(frame.token, TOKEN)) {
				client.authed = true;
				clearTimeout(authTimer);
				return send(client, { type: "auth_ok" });
			}
			return ws.close(4003, "unauthorized");
		}

		switch (frame.type) {
			case "auth":
				return send(client, { type: "auth_ok" });
			case "subscribe":
				client.sessions.add(frame.sessionId);
				return;
			case "unsubscribe":
				client.sessions.delete(frame.sessionId);
				return;
			case "rpc": {
				try {
					const data = await host.call(frame.method, frame.params as never);
					if (frame.method === "session.create" || frame.method === "session.open") {
						client.sessions.add((data as { id: string }).id);
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

server.listen(PORT, HOST, () => {
	const addr = server.address();
	const port = addr && typeof addr === "object" ? addr.port : PORT;
	const url = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${port}`;
	console.log(`[prometheus] 已启动 ${url}  (鉴权: ${TOKEN ? "令牌" : "仅本机"})`);
	// Machine-readable line for the desktop shell to detect readiness.
	console.log(`PROMETHEUS_READY ${port}`);
});

async function shutdown(): Promise<void> {
	for (const c of clients) c.ws.close(1001, "server shutdown");
	server.close();
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
