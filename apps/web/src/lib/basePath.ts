// The web UI can be served under a path prefix: a tenant runtime sits behind the Hub's `<hub base>/rt/` reverse proxy
// (for example `/plugins/team/rt/`). Every URL the app builds itself (fetch, WebSocket, links) goes through this file.
// Root deployments (`/`), the Vite dev server and the desktop shell all resolve to the empty prefix.

/**
 * Marker of the tenant proxy: everything up to and including `/rt/` is the prefix. The inline script in index.html applies
 * the same rule to pick the `<base href>` for assets (kept in sync by test/basePath.test.ts).
 */
export const PROXY_PREFIX_PATTERN = "^(/.*?/rt)(?:/|$)";

/** `/plugins/team/rt/foo/bar` gives `/plugins/team/rt`; a path outside the proxy gives "" (never a trailing slash). */
export function basePathFromPathname(pathname: string): string {
	const m = new RegExp(PROXY_PREFIX_PATTERN).exec(pathname);
	return m?.[1] ?? "";
}

/** The prefix of the page the app runs in. Empty outside a browser. */
export function basePath(): string {
	return typeof location === "undefined" ? "" : basePathFromPathname(location.pathname);
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
	return `${proto}//${loc.host}${withBase(path, basePathFromPathname(loc.pathname))}`;
}
