import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { JWT_AUDIENCE } from "../config.ts";
import type { HubDeps, UpgradeHandler } from "../deps.ts";
import { HubError, unauthorized } from "../errors.ts";
import { bearerToken, relativePath } from "../http/dispatch.ts";
import type { RouteContext } from "../http/context.ts";
import { HANDLED } from "../http/router.ts";
import { verifyJwt } from "../jwt.ts";
import { LOG_PREFIX } from "../log.ts";
import type { TenantHandle } from "./driver.ts";
import type { TenantManager } from "./manager.ts";
import { TENANT_AUDIENCE } from "./tenant-env.ts";

export const RT_PREFIX = "/rt";
export const RT_COOKIE = "prometheus_hub_rt";
export const TENANT_JWT_TTL_SEC = 15 * 60;

/** Headers that describe one hop, plus everything that would leak the Hub's identity or credentials to the tenant. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection"]);
const STRIP_REQUEST = new Set(["host", "authorization", "cookie", "origin", "referer", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "x-api-key"]);

export interface RtAuth {
	userId: string;
	exp: number;
	source: "header" | "cookie" | "query";
}

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (header ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		const name = part.slice(0, i).trim();
		if (!name || name in out) continue;
		try {
			out[name] = decodeURIComponent(part.slice(i + 1).trim());
		} catch {
			// ignore malformed cookie values
		}
	}
	return out;
}

/** The request path inside the tenant: everything after `/rt`, still percent-encoded. */
export const upstreamPath = (relPath: string): string => {
	const rest = relPath.slice(RT_PREFIX.length);
	return rest.startsWith("/") ? rest : `/${rest}`;
};

/** Query string without the `token` parameter (it carries the Hub access token on first load only). */
export function stripTokenParam(search: URLSearchParams): string {
	const copy = new URLSearchParams(search);
	copy.delete("token");
	const text = copy.toString();
	return text ? `?${text}` : "";
}

export const isRtPath = (rel: string | undefined): boolean => rel !== undefined && (rel === RT_PREFIX || rel.startsWith(`${RT_PREFIX}/`));

function forwardHeaders(src: IncomingHttpHeaders, handle: TenantHandle, jwt: string, keepUpgrade: boolean): OutgoingHttpHeaders {
	const out: OutgoingHttpHeaders = {};
	for (const [k, v] of Object.entries(src)) {
		if (v === undefined || STRIP_REQUEST.has(k) || (HOP_BY_HOP.has(k) && !(keepUpgrade && (k === "upgrade" || k === "connection")))) continue;
		out[k] = v;
	}
	out.host = `${handle.host}:${handle.port}`;
	out.authorization = `Bearer ${jwt}`;
	if (src.origin) out.origin = `http://${handle.host}:${handle.port}`;
	return out;
}

export interface RuntimeProxy {
	handle(ctx: RouteContext): Promise<typeof HANDLED>;
	handleUpgrade: UpgradeHandler;
}

export function createRuntimeProxy(deps: HubDeps, manager: TenantManager): RuntimeProxy {
	const secure = deps.config.publicUrl.startsWith("https://");

	/** Hub access token from the Authorization header, the cookie, or `?token=`, in that order. */
	async function authenticate(req: IncomingMessage, search: URLSearchParams): Promise<RtAuth> {
		const candidates: { token: string | undefined; source: RtAuth["source"] }[] = [
			{ token: bearerToken(req), source: "header" },
			{ token: parseCookies(req.headers.cookie)[RT_COOKIE], source: "cookie" },
			{ token: search.get("token") ?? undefined, source: "query" },
		];
		for (const { token, source } of candidates) {
			if (!token) continue;
			const claims = verifyJwt(token, { publicKey: deps.publicKeyPem, issuer: deps.config.issuer, audience: JWT_AUDIENCE });
			if (!claims) continue;
			// Disabled accounts lose access at once instead of when the token expires.
			await deps.services.actors.load(claims.sub);
			return { userId: claims.sub, exp: claims.exp, source };
		}
		throw unauthorized("需要登录", "invalidToken");
	}

	const tenantJwt = (userId: string): string => deps.signToken({ sub: userId, aud: TENANT_AUDIENCE, exp: Math.floor(deps.now() / 1000) + TENANT_JWT_TTL_SEC });

	function authCookie(token: string, exp: number): string {
		const maxAge = Math.max(0, exp - Math.floor(deps.now() / 1000));
		return `${RT_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=${deps.config.basePath}${RT_PREFIX}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
	}

	/** The raw token a request carried, for turning it into a cookie. */
	const rawToken = (req: IncomingMessage, search: URLSearchParams): string | undefined => bearerToken(req) ?? search.get("token") ?? undefined;

	function rewriteLocation(location: string, handle: TenantHandle): string {
		const prefix = `${deps.config.basePath}${RT_PREFIX}`;
		if (location.startsWith("/") && !location.startsWith("//")) return `${prefix}${location}`;
		const own = `http://${handle.host}:${handle.port}`;
		return location.startsWith(own) ? `${prefix}${location.slice(own.length) || "/"}` : location;
	}

	function bad(res: ServerResponse, status: number, code: string, message: string): void {
		if (res.headersSent) return void res.destroy();
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify({ ok: false, error: { code, message } }));
	}

	async function handle(ctx: RouteContext): Promise<typeof HANDLED> {
		const { req, res } = ctx;
		const auth = await authenticate(req, ctx.searchParams);
		const cleanSearch = stripTokenParam(ctx.searchParams);
		const sets: string[] = [];
		if (auth.source !== "cookie" && ctx.method === "GET") {
			const token = rawToken(req, ctx.searchParams);
			if (token) sets.push(authCookie(token, auth.exp));
		}
		// First load with ?token=: set the cookie and come back without the token in the address bar.
		if (auth.source === "query" && ctx.method === "GET") {
			res.writeHead(302, { location: `${deps.config.basePath}${ctx.path}${cleanSearch}`, "set-cookie": sets, "cache-control": "no-store" });
			res.end();
			return HANDLED;
		}

		const target = await manager.ensureRunning(auth.userId);
		const release = manager.openConnection(auth.userId);
		const upstream = httpRequest(
			{ host: target.host, port: target.port, method: ctx.method, path: `${upstreamPath(ctx.path)}${cleanSearch}`, headers: forwardHeaders(req.headers, target, tenantJwt(auth.userId), false) },
			(up) => {
				const headers: OutgoingHttpHeaders = {};
				for (const [k, v] of Object.entries(up.headers)) {
					if (v === undefined || HOP_BY_HOP.has(k) || k === "set-cookie") continue;
					headers[k] = k === "location" && typeof v === "string" ? rewriteLocation(v, target) : v;
				}
				if (sets.length > 0) headers["set-cookie"] = sets;
				res.writeHead(up.statusCode ?? 502, headers);
				up.pipe(res);
				up.on("error", () => res.destroy());
			},
		);
		res.on("close", () => {
			release();
			upstream.destroy();
		});
		upstream.on("error", (err) => {
			deps.log.warn(`${LOG_PREFIX} 代理到租户实例失败 user=${auth.userId}: ${err.message}`);
			bad(res, 502, "tenantUnreachable", "无法连接到你的租户实例");
		});
		req.pipe(upstream);
		return HANDLED;
	}

	function reject(socket: Duplex, status: number, text: string): void {
		if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		socket.destroy();
	}

	const handleUpgrade: UpgradeHandler = (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://hub.local");
		const rel = relativePath(deps.config, url.pathname);
		if (!isRtPath(rel) || rel === undefined) return false;
		socket.on("error", () => {});
		void (async () => {
			let auth: RtAuth;
			try {
				auth = await authenticate(req, url.searchParams);
			} catch {
				return reject(socket, 401, "Unauthorized");
			}
			let target: TenantHandle;
			try {
				target = await manager.ensureRunning(auth.userId);
			} catch (err) {
				return reject(socket, err instanceof HubError && err.status === 503 ? 503 : 502, err instanceof HubError && err.status === 503 ? "Service Unavailable" : "Bad Gateway");
			}
			if (socket.destroyed) return;
			const release = manager.openConnection(auth.userId);
			const upstream = httpRequest({
				host: target.host,
				port: target.port,
				method: "GET",
				path: `${upstreamPath(rel)}${stripTokenParam(url.searchParams)}`,
				headers: forwardHeaders(req.headers, target, tenantJwt(auth.userId), true),
			});
			const finish = (): void => {
				release();
				socket.destroy();
				upstream.destroy();
			};
			upstream.on("upgrade", (up: IncomingMessage, upSocket: Duplex, upHead: Buffer) => {
				const lines = [`HTTP/1.1 101 Switching Protocols`];
				for (const [k, v] of Object.entries(up.headers)) {
					if (v === undefined || k === "set-cookie") continue;
					for (const item of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${item}`);
				}
				socket.write(`${lines.join("\r\n")}\r\n\r\n`);
				if (upHead.length > 0) socket.write(upHead);
				if (head.length > 0) upSocket.write(head);
				upSocket.pipe(socket);
				socket.pipe(upSocket);
				upSocket.on("error", finish);
				upSocket.on("close", finish);
				socket.on("close", finish);
				socket.on("error", finish);
			});
			upstream.on("response", (up) => {
				// The tenant refused the upgrade (401, 404, ...): hand its status to the client and stop.
				reject(socket, up.statusCode ?? 502, up.statusMessage ?? "Bad Gateway");
				finish();
			});
			upstream.on("error", (err) => {
				deps.log.warn(`${LOG_PREFIX} WebSocket 代理到租户实例失败 user=${auth.userId}: ${err.message}`);
				reject(socket, 502, "Bad Gateway");
				finish();
			});
			upstream.end();
		})().catch((err: unknown) => {
			deps.log.error(`${LOG_PREFIX} 租户 WebSocket 升级失败: ${err instanceof Error ? err.message : String(err)}`);
			reject(socket, 500, "Internal Server Error");
		});
		return true;
	};

	return { handle, handleUpgrade };
}
