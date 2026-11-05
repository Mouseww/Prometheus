/**
 * Access tokens minted for a tenant instance (`scope: "tenant"`) are accepted on this allowlist only. A tenant runs
 * user-directed agent code, so its token must not reach admin, billing, account, invitation, team or organization management
 * or the workbench. Everything not listed here is refused with 403 by the dispatcher, no matter which route it is.
 * (WebSocket, `/git/*`, `/llm/*` and `/rt/*` authenticate themselves; see ws.ts, routes/git.ts, llm/proxy.ts and runtime/proxy.ts.)
 */
interface Rule {
	methods: readonly string[];
	pattern: RegExp;
}

const READ = ["GET", "HEAD"] as const;
const ANY = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

const RULES: readonly Rule[] = [
	{ methods: READ, pattern: /^\/api\/meta$/ },
	{ methods: READ, pattern: /^\/api\/me$/ },
	{ methods: READ, pattern: /^\/api\/models$/ },
	// Session mirroring, relay actions, handoff and exec mode of the user's own sessions.
	{ methods: ANY, pattern: /^\/api\/sessions(\/[^/]+(\/(exec|handoff|events|transcript|actions|files|fork))?)?$/ },
	// Registering and listing sessions of a workspace, reading workspace metadata and files, opening merge requests.
	{ methods: ANY, pattern: /^\/api\/workspaces\/[^/]+\/(sessions|merge-requests)$/ },
	{ methods: READ, pattern: /^\/api\/workspaces\/[^/]+(\/files)?$/ },
	{ methods: ["GET", "HEAD", "POST"], pattern: /^\/api\/merge-requests\/[^/]+(\/(diff|refresh))?$/ },
];

/** Whether a tenant-scoped access token may call `method path` (path relative to the Hub base). */
export function tenantScopeAllows(method: string, path: string): boolean {
	const m = method.toUpperCase();
	const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
	return RULES.some((r) => r.methods.includes(m) && r.pattern.test(clean));
}
