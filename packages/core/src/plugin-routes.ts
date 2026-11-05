/** A route path ending in "/*" matches every sub-path under it. */
export function isPrefixRoute(path: string): boolean {
	return path.endsWith("/*");
}

/**
 * The route that serves `pathname`: an exact match first, otherwise the longest "/*" prefix. `method` is compared only
 * for routes that have one (WebSocket routes do not).
 */
export function matchPluginRoute<T extends { method?: string; path: string }>(routes: readonly T[], method: string | undefined, pathname: string): T | undefined {
	let best: T | undefined;
	let bestLength = -1;
	for (const r of routes) {
		if (r.method !== undefined && r.method !== method) continue;
		if (r.path === pathname) return r;
		if (!isPrefixRoute(r.path)) continue;
		const base = r.path.slice(0, -1);
		if ((pathname.startsWith(base) || pathname === base.slice(0, -1)) && base.length > bestLength) {
			best = r;
			bestLength = base.length;
		}
	}
	return best;
}
