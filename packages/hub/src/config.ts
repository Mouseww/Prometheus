import { join } from "node:path";
import type { HubLog } from "./log.ts";

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
	/** Trust X-Forwarded-For for rate limiting (behind a reverse proxy). */
	trustProxy?: boolean;
	/** Tests only: let workspace import and upstream remotes be local paths or file:// URLs. Never set in production. */
	allowLocalGitRemotes?: boolean;
	version?: string;
	now?: () => number;
}

export interface HubConfig {
	dataDir: string;
	publicUrl: string;
	issuer: string;
	basePath: string;
	appRole: string;
	orgName: string;
	trustProxy: boolean;
	allowLocalGitRemotes: boolean;
	version: string;
}

export const JWT_AUDIENCE = "prometheus";
export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RATE_LIMIT_PER_IP = 10;
export const RATE_LIMIT_PER_ACCOUNT = 5;

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

export function resolveConfig(options: HubOptions): HubConfig {
	const env = options.env ?? process.env;
	const publicUrl = trimSlash(options.publicUrl ?? env.HUB_PUBLIC_URL ?? "");
	const basePath = trimSlash(options.basePath ?? "");
	return {
		dataDir: options.dataDir,
		publicUrl,
		issuer: publicUrl || "prometheus-hub",
		basePath,
		appRole: options.appRole ?? env.HUB_DB_APP_ROLE ?? "prometheus_app",
		orgName: options.orgName ?? env.HUB_ORG_NAME ?? "我的团队",
		trustProxy: options.trustProxy ?? false,
		allowLocalGitRemotes: options.allowLocalGitRemotes ?? false,
		version: options.version ?? "0.1.0",
	};
}

export const pgDataDir = (dataDir: string): string => join(dataDir, "pgdata");
