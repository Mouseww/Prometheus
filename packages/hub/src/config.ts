import { join } from "node:path";
import type { HubLog } from "./log.ts";
import { parseTrustProxy, type TrustProxy } from "./net/trusted-proxy.ts";

export interface HubOptions {
	/** Hub data directory: secret.key, jwt.key, setup-code.txt, pgdata, repos. */
	dataDir: string;
	/** PostgreSQL URL; without it PGlite under `<dataDir>/pgdata` is used. */
	databaseUrl?: string;
	/** Keep PGlite in memory (tests). */
	memory?: boolean;
	/** Externally visible base URL; becomes the token issuer and the invitation link prefix. */
	publicUrl?: string;
	/** Prefix the host mounts the Hub under, e.g. `/plugins/team`. `handle` strips it. */
	basePath?: string;
	log?: HubLog;
	env?: NodeJS.ProcessEnv;
	/** Overrides HUB_DB_APP_ROLE. */
	appRole?: string;
	/** Overrides HUB_SECRET_KEY (32 bytes, base64). */
	secretKey?: string;
	/** Overrides HUB_ORG_NAME. */
	orgName?: string;
	/** Initial value of the platform setting; changed later through the admin API. */
	allowPersonalTeams?: boolean;
	/** Trust X-Forwarded-For for rate limiting (behind a reverse proxy). Overrides HUB_TRUST_PROXY: `true` trusts the immediate peer, a list restricts it to those proxy IPs/CIDRs. */
	trustProxy?: TrustProxy;
	/** Tests only: let workspace import and upstream remotes be local paths or file:// URLs. Never set in production. */
	allowLocalGitRemotes?: boolean;
	version?: string;
	now?: () => number;
	/** Overrides HUB_MODE: `public` is the online service, `private` (default) a company deployment. */
	mode?: "private" | "public";
	/** Overrides HUB_BILLING: credits billing for the LLM proxy; always on in public mode. */
	billing?: boolean;
	/** Overrides HUB_RUNTIME_ORIGIN: the separate origin (e.g. https://rt.example.com) that serves the tenant workbench under `/rt`. */
	runtimeOrigin?: string;
}

export interface HubConfig {
	dataDir: string;
	publicUrl: string;
	issuer: string;
	basePath: string;
	appRole: string;
	orgName: string;
	trustProxy: TrustProxy;
	allowLocalGitRemotes: boolean;
	version: string;
	mode: "private" | "public";
	/** True in public mode, or in private mode with HUB_BILLING=on. */
	billingEnabled: boolean;
	/** HUB_BYOK_ALLOWED_PORTS: ports besides 443 that user gateways may use in public mode. */
	byokAllowedPorts: number[];
	/** HUB_BYOK_BLOCK_PRIVATE=1: user gateways may not target intranet addresses even in private mode. */
	byokBlockPrivate: boolean;
	/** HUB_STRIPE_SECRET / HUB_STRIPE_WEBHOOK_SECRET; the stripe provider is available when both are set. */
	stripeSecret: string | undefined;
	stripeWebhookSecret: string | undefined;
	/** HUB_STRIPE_API_BASE: points the stripe provider at a mock (tests, local development); default https://api.stripe.com. */
	stripeApiBase: string | undefined;
	/**
	 * HUB_RUNTIME_ORIGIN: the tenant workbench proxies a user-directed agent's web UI, so it must not share the Hub UI's origin
	 * (cookies, storage, same-origin requests). When set, `/rt` is served only to requests whose Host is this origin, the
	 * Hub UI host refuses `/rt`, and the origin serves nothing but `/rt`. Undefined: same-origin proxy (private deployments).
	 */
	runtimeOrigin: string | undefined;
}

/** `https://rt.example.com` -> the origin; anything with a path, query or non-http(s) scheme is rejected at startup. */
export function parseRuntimeOrigin(raw: string | undefined): string | undefined {
	const text = raw?.trim();
	if (!text) return undefined;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new Error(`HUB_RUNTIME_ORIGIN 无效: ${text}（需要形如 https://rt.example.com 的源）`);
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username) {
		throw new Error(`HUB_RUNTIME_ORIGIN 无效: ${text}（只能是 http(s) 源，不能带路径、查询或账号）`);
	}
	return url.origin;
}

export const JWT_AUDIENCE = "prometheus";
export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A just-rotated refresh token presented again within this window (two tabs sharing one stored token) is not theft: it gets a fresh token of the same family. */
export const REFRESH_REUSE_GRACE_MS = 20 * 1000;
export const RATE_LIMIT_PER_IP = 10;
export const RATE_LIMIT_PER_ACCOUNT = 5;

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

export function resolveConfig(options: HubOptions): HubConfig {
	const env = options.env ?? process.env;
	const publicUrl = trimSlash(options.publicUrl ?? env.HUB_PUBLIC_URL ?? "");
	const basePath = trimSlash(options.basePath ?? "");
	const mode = options.mode ?? env.HUB_MODE ?? "private";
	if (mode !== "private" && mode !== "public") throw new Error(`HUB_MODE 必须是 private 或 public，当前为: ${mode}`);
	const billingFlag = options.billing ?? ["on", "1", "true"].includes((env.HUB_BILLING ?? "").toLowerCase());
	return {
		dataDir: options.dataDir,
		publicUrl,
		issuer: publicUrl || "prometheus-hub",
		basePath,
		appRole: options.appRole ?? env.HUB_DB_APP_ROLE ?? "prometheus_app",
		orgName: options.orgName ?? env.HUB_ORG_NAME ?? "我的团队",
		trustProxy: options.trustProxy ?? parseTrustProxy(env.HUB_TRUST_PROXY),
		allowLocalGitRemotes: options.allowLocalGitRemotes ?? false,
		version: options.version ?? "0.1.0",
		mode,
		billingEnabled: mode === "public" || billingFlag,
		byokAllowedPorts: parsePorts(env.HUB_BYOK_ALLOWED_PORTS),
		byokBlockPrivate: ["1", "true", "on"].includes((env.HUB_BYOK_BLOCK_PRIVATE ?? "").toLowerCase()),
		stripeSecret: env.HUB_STRIPE_SECRET || undefined,
		stripeWebhookSecret: env.HUB_STRIPE_WEBHOOK_SECRET || undefined,
		stripeApiBase: env.HUB_STRIPE_API_BASE || undefined,
		runtimeOrigin: parseRuntimeOrigin(options.runtimeOrigin ?? env.HUB_RUNTIME_ORIGIN),
	};
}

/** `8443,9443` -> [8443, 9443]; invalid entries are ignored. */
function parsePorts(raw: string | undefined): number[] {
	return (raw ?? "")
		.split(",")
		.map((s) => Number(s.trim()))
		.filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
}

export const pgDataDir = (dataDir: string): string => join(dataDir, "pgdata");
