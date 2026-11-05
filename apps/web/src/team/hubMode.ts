// Hub mode: the same web bundle is served by a Hub (`--role hub`). /api/health says which role this server has.
import { withBase } from "../lib/basePath.ts";

export interface HealthLike {
	role?: unknown;
}

export const isHubRole = (health: unknown): boolean => typeof health === "object" && health !== null && (health as HealthLike).role === "hub";

/** True when this origin is a Hub. Any failure (offline, desktop shell, old server without `role`) means "not a Hub". */
export async function detectHubMode(fetchImpl: typeof fetch = (...a) => fetch(...a), timeoutMs = 2500): Promise<boolean> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetchImpl(withBase("/api/health"), { signal: ctrl.signal, headers: { accept: "application/json" } });
		if (!res.ok) return false;
		return isHubRole(await res.json());
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** `/invite/<token>` (the link the Hub hands out) to the token, otherwise undefined. */
export function inviteTokenFromPath(pathname: string): string | undefined {
	const m = /^\/invite\/([^/?#]+)\/?$/.exec(pathname);
	if (!m?.[1]) return undefined;
	try {
		return decodeURIComponent(m[1]);
	} catch {
		return undefined;
	}
}
