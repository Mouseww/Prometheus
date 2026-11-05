import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { HubConfig } from "./config.ts";
import type { SecretBox } from "./crypto.ts";
import type { Db } from "./db/db.ts";
import type { JwtClaims } from "./jwt.ts";
import type { HubLog } from "./log.ts";
import type { RuntimeOverrides } from "./runtime/options.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { AccountsService } from "./services/accounts.ts";
import type { ActorService } from "./services/actors.ts";
import type { AdminUsersService } from "./services/admin-users.ts";
import type { AuditService } from "./services/audit.ts";
import type { InvitationsService } from "./services/invitations.ts";
import type { OrgsService } from "./services/orgs.ts";
import type { RegistrationService } from "./services/registration.ts";
import type { SettingsService } from "./services/settings.ts";
import type { TeamsService } from "./services/teams.ts";

/** Services owned by block 2A. Blocks 2B/2C add theirs to the `ServiceRegistry`. */
export interface HubServices {
	audit: AuditService;
	settings: SettingsService;
	actors: ActorService;
	registration: RegistrationService;
	accounts: AccountsService;
	adminUsers: AdminUsersService;
	invitations: InvitationsService;
	orgs: OrgsService;
	teams: TeamsService;
}

/**
 * Name -> service map for services contributed by other blocks (`workspaces`, `mergeRequests`, `sessions`, `models`, ...).
 * Typed access: `registry.require<WorkspacesService>("workspaces")`.
 */
export class ServiceRegistry {
	readonly #items = new Map<string, unknown>();

	register<T>(name: string, service: T): T {
		if (this.#items.has(name)) throw new Error(`服务已注册: ${name}`);
		this.#items.set(name, service);
		return service;
	}
	has(name: string): boolean {
		return this.#items.has(name);
	}
	get<T>(name: string): T | undefined {
		return this.#items.get(name) as T | undefined;
	}
	require<T>(name: string): T {
		if (!this.#items.has(name)) throw new Error(`服务未注册: ${name}`);
		return this.#items.get(name) as T;
	}
}

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;

/** Everything a route module or a later block needs. Passed to every `register*Routes`. */
export interface HubDeps {
	db: Db;
	config: HubConfig;
	log: HubLog;
	now: () => number;
	services: HubServices;
	registry: ServiceRegistry;
	secretBox: SecretBox;
	limiter: RateLimiter;
	publicKeyPem: string;
	/** Environment the Hub was created with (`options.env ?? process.env`); blocks read their HUB_* settings from here. */
	env: NodeJS.ProcessEnv;
	/** Signs a Hub JWT (EdDSA) with the Hub key; `iss` and `iat` are filled in. */
	signToken(claims: Omit<JwtClaims, "iss" | "iat"> & Record<string, unknown>): string;
	/** Runtime overrides from `HubOptions.runtime` (tests and embedding). */
	runtimeOptions: RuntimeOverrides | undefined;
	/** Runs on `hub.close()`, in reverse registration order (schedulers, sockets). */
	onClose(fn: () => Promise<void> | void): void;
	/** Installs a WebSocket upgrade handler. Handlers are tried in registration order; the first to return true owns the socket. */
	setUpgradeHandler(fn: UpgradeHandler): void;
}
