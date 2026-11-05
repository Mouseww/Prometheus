import type { RouteContext } from "./context.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * - `user` (default): a valid bearer access token is required.
 * - `public`: no token required; a valid one is still decoded into `ctx.identity`.
 * - `none`: the handler authenticates itself (git smart HTTP uses Basic auth, WebSocket uses a query token).
 */
export type AuthMode = "user" | "public" | "none";

/** A JSON reply with a status other than 200. */
export class Reply {
	readonly status: number;
	readonly data: unknown;
	readonly headers: Record<string, string> | undefined;

	constructor(status: number, data: unknown, headers?: Record<string, string>) {
		this.status = status;
		this.data = data;
		this.headers = headers;
	}
}

/** Returned by raw handlers that wrote the response themselves. */
export const HANDLED: unique symbol = Symbol("hub.handled");

export type Handler = (ctx: RouteContext) => Promise<unknown | Reply | typeof HANDLED>;

export interface RouteOptions {
	auth?: AuthMode;
}

export interface Route {
	method: HttpMethod;
	pattern: string;
	segments: string[];
	handler: Handler;
	auth: AuthMode;
}

export type MatchResult = { kind: "match"; route: Route; params: Record<string, string> } | { kind: "methodNotAllowed"; allow: string[] } | { kind: "none" };

const splitPath = (path: string): string[] => path.split("/").filter((s) => s.length > 0);

function matchSegments(route: Route, parts: string[]): Record<string, string> | undefined {
	const params: Record<string, string> = {};
	for (let i = 0; i < route.segments.length; i++) {
		const seg = route.segments[i] as string;
		if (seg === "*") {
			// Trailing wildcard swallows the rest of the path.
			params["*"] = parts.slice(i).map(decodeURIComponent).join("/");
			return params;
		}
		const part = parts[i];
		if (part === undefined) return undefined;
		if (seg.startsWith(":")) {
			try {
				params[seg.slice(1)] = decodeURIComponent(part);
			} catch {
				return undefined;
			}
		} else if (seg !== part) {
			return undefined;
		}
	}
	return parts.length === route.segments.length ? params : undefined;
}

/** Method + path-pattern router. Patterns use `:param` segments and an optional trailing `*`. */
export class Router {
	readonly #routes: Route[] = [];

	route(method: HttpMethod, pattern: string, handler: Handler, opts: RouteOptions = {}): this {
		this.#routes.push({ method, pattern, segments: splitPath(pattern), handler, auth: opts.auth ?? "user" });
		return this;
	}

	get = (pattern: string, handler: Handler, opts?: RouteOptions): this => this.route("GET", pattern, handler, opts);
	post = (pattern: string, handler: Handler, opts?: RouteOptions): this => this.route("POST", pattern, handler, opts);
	put = (pattern: string, handler: Handler, opts?: RouteOptions): this => this.route("PUT", pattern, handler, opts);
	patch = (pattern: string, handler: Handler, opts?: RouteOptions): this => this.route("PATCH", pattern, handler, opts);
	delete = (pattern: string, handler: Handler, opts?: RouteOptions): this => this.route("DELETE", pattern, handler, opts);

	/** Copies every route of `child` under `prefix` (e.g. `/api`). */
	mount(prefix: string, child: Router): this {
		const base = splitPath(prefix);
		for (const r of child.#routes) {
			this.#routes.push({ ...r, pattern: `/${[...base, ...r.segments].join("/")}`, segments: [...base, ...r.segments] });
		}
		return this;
	}

	match(method: string, path: string): MatchResult {
		const parts = splitPath(path);
		const allow = new Set<string>();
		for (const route of this.#routes) {
			const params = matchSegments(route, parts);
			if (!params) continue;
			if (route.method === method) return { kind: "match", route, params };
			allow.add(route.method);
		}
		return allow.size > 0 ? { kind: "methodNotAllowed", allow: [...allow] } : { kind: "none" };
	}

	get size(): number {
		return this.#routes.length;
	}
}
