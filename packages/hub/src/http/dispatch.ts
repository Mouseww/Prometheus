import type { IncomingMessage, ServerResponse } from "node:http";
import { type HubConfig, JWT_AUDIENCE } from "../config.ts";
import { TENANT_SCOPE, type TenantCredentials } from "../auth/tenant-credentials.ts";
import { forbidden, unauthorized } from "../errors.ts";
import { type JwtClaims, verifyJwt } from "../jwt.ts";
import type { HubLog } from "../log.ts";
import { resolveClientIp, type TrustProxy } from "../net/trusted-proxy.ts";
import type { Actor } from "../permissions.ts";
import { createContext } from "./context.ts";
import { writeError, writeOk, writeThrown } from "./envelope.ts";
import { HANDLED, Reply, type Router } from "./router.ts";
import { tenantScopeAllows } from "./tenant-scope.ts";

export interface DispatchDeps {
	router: Router;
	config: HubConfig;
	log: HubLog;
	publicKey: string;
	loadActor(userId: string): Promise<Actor>;
	/** Needed to accept `scope: "tenant"` access tokens; without it they are rejected. */
	tenantCredentials?: TenantCredentials;
}

/** The request path relative to the Hub base, or undefined when the request is outside the base. */
export function relativePath(config: HubConfig, pathname: string): string | undefined {
	const base = config.basePath;
	if (!base) return pathname;
	if (pathname === base) return "/";
	return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : undefined;
}

/** Whether the request was addressed to `origin` (`https://rt.example.com`): compares the Host header, so a reverse proxy must pass it through. */
export function hostMatchesOrigin(req: IncomingMessage, origin: string): boolean {
	const host = req.headers.host?.trim().toLowerCase();
	return host !== undefined && host === new URL(origin).host.toLowerCase();
}

export function clientIp(req: IncomingMessage, trustProxy: TrustProxy): string {
	return resolveClientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"], trustProxy);
}

export function bearerToken(req: IncomingMessage): string | undefined {
	const header = req.headers.authorization;
	if (!header) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(header);
	return match?.[1]?.trim();
}

/**
 * Decodes the bearer access token. A token minted for a tenant instance (`scope: "tenant"`) is checked centrally: it must still
 * be backed by a live tenant credential and the route must be on the tenant allowlist (http/tenant-scope.ts), otherwise 401/403.
 */
async function authenticate(deps: DispatchDeps, req: IncomingMessage, method: string, path: string): Promise<JwtClaims | undefined> {
	const token = bearerToken(req);
	if (!token) return undefined;
	const claims = verifyJwt(token, { publicKey: deps.publicKey, issuer: deps.config.issuer, audience: JWT_AUDIENCE });
	if (!claims || claims.scope === undefined) return claims;
	if (claims.scope !== TENANT_SCOPE || !deps.tenantCredentials) return undefined;
	if (!(await deps.tenantCredentials.accessTokenActive(claims))) return undefined;
	if (!tenantScopeAllows(method, path)) throw forbidden("租户凭证不能访问该接口", "tenantScope");
	return claims;
}

/** Handles one request. Returns false when the path is not a Hub route so the host can continue with its own handling. */
export async function dispatch(deps: DispatchDeps, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
	const url = new URL(req.url ?? "/", "http://hub.local");
	const path = relativePath(deps.config, url.pathname);
	if (path === undefined) return false;
	const method = (req.method ?? "GET").toUpperCase();
	// The workbench origin serves the tenant workbench and nothing else: no Hub API, no git, no sockets of the Hub.
	if (deps.config.runtimeOrigin && hostMatchesOrigin(req, deps.config.runtimeOrigin) && path !== "/rt" && !path.startsWith("/rt/")) {
		writeError(res, 404, "notFound", "接口不存在");
		return true;
	}

	const match = deps.router.match(method, path);
	if (match.kind === "none") {
		if (!path.startsWith("/api/")) return false;
		writeError(res, 404, "notFound", "接口不存在");
		return true;
	}
	if (match.kind === "methodNotAllowed") {
		writeError(res, 405, "methodNotAllowed", "不支持的请求方法", { allow: match.allow.join(", ") });
		return true;
	}

	try {
		const { route, params } = match;
		let identity: JwtClaims | undefined;
		if (route.auth !== "none") {
			identity = await authenticate(deps, req, method, path);
			if (route.auth === "user" && !identity) throw unauthorized(bearerToken(req) ? "访问令牌无效或已过期" : "需要登录", "invalidToken");
		}
		const ctx = createContext({
			req,
			res,
			method,
			path,
			params,
			searchParams: url.searchParams,
			client: { ip: clientIp(req, deps.config.trustProxy), userAgent: req.headers["user-agent"] },
			identity,
			loadActor: deps.loadActor,
		});
		const result = await route.handler(ctx);
		if (result === HANDLED) return true;
		if (result instanceof Reply) writeOk(res, result.data, result.status, result.headers);
		else writeOk(res, result ?? null);
	} catch (err) {
		writeThrown(res, err, deps.log);
	}
	return true;
}
