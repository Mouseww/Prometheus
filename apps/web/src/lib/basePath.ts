// The web UI can be served under a path prefix: a tenant runtime sits behind the Hub's `<hub base>/rt/` reverse proxy
// (for example `/plugins/team/rt/`). Every URL the app builds itself (fetch, WebSocket, links) goes through this file.
// Root deployments (`/`), the Vite dev server and the desktop shell all resolve to the empty prefix.

/**
 * Marker of the tenant proxy: everything up to and including `/rt/` is the prefix. The inline script in index.html applies
 * the same rule to pick the `<base href>` for assets (kept in sync by test/basePath.test.ts).
 */
export const PROXY_PREFIX_PATTERN = "^(/.*?/rt)(?:/|$)";

const FALLBACK_ORIGIN = "http://localhost";

/**
 * A prefix is only trusted when it stays on this origin: one leading `/` (not `//` or `/\`, which a browser reads as a
 * different host), no `\` or `:`, no `..` segments, and resolving it against `origin` must keep the origin and the path
 * byte for byte. `//evil.com/rt` would otherwise turn `<base href>` into a cross-origin script source.
 * index.html repeats this check inline; test/basePath.test.ts runs both over the same inputs.
 */
export function isSafePrefix(prefix: string, origin: string): boolean {
	if (!prefix.startsWith("/") || prefix[1] === "/" || prefix[1] === "\\") return false;
	// "%" is refused outright: a real prefix never needs escapes, and %2F / %5C / %2e are how the checks above get dodged.
	if (prefix.includes("\\") || prefix.includes(":") || prefix.includes("%") || prefix.split("/").includes("..")) return false;
	try {
		const u = new URL(`${prefix}/`, origin);
		return u.origin === origin && u.pathname === `${prefix}/`;
	} catch {
		return false;
	}
}

/**
 * `/plugins/team/rt/foo/bar` gives `/plugins/team/rt`; a path outside the proxy, or one whose prefix is not safe
 * (see isSafePrefix), gives "" (never a trailing slash).
 */
export function basePathFromPathname(pathname: string, origin: string = typeof location === "undefined" ? FALLBACK_ORIGIN : location.origin): string {
	const prefix = new RegExp(PROXY_PREFIX_PATTERN).exec(pathname)?.[1] ?? "";
	return prefix && isSafePrefix(prefix, origin) ? prefix : "";
}

/** The prefix of the page the app runs in. Empty outside a browser. */
export function basePath(): string {
	return typeof location === "undefined" ? "" : basePathFromPathname(location.pathname, location.origin);
}

/** `path` (starting with `/`) under the prefix: `/api/health` gives `/plugins/team/rt/api/health` behind the proxy. */
export function withBase(path: string, prefix: string = basePath()): string {
	if (!path.startsWith("/")) return path;
	return `${prefix}${path}`;
}

/** Origin plus prefix with no trailing slash: what a same-server `BackendTarget.httpBase` equals. */
export function appOrigin(): string {
	return typeof location === "undefined" ? "" : `${location.origin}${basePath()}`;
}

/** Absolute `ws(s)://host/prefix/path` for a same-server WebSocket. */
export function wsUrlFor(path: string, loc: Pick<Location, "protocol" | "host" | "pathname"> = location): string {
	const proto = loc.protocol === "https:" ? "wss:" : "ws:";
	const origin = `${loc.protocol}//${loc.host}`;
	return `${proto}//${loc.host}${withBase(path, basePathFromPathname(loc.pathname, origin))}`;
}
