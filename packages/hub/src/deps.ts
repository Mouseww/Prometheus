import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { HubConfig } from "./config.ts";
import type { SecretBox } from "./crypto.ts";
import type { Db } from "./db/db.ts";
import type { HubLog } from "./log.ts";
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
	/** Runs on `hub.close()`, in reverse registration order (schedulers, sockets). */
	onClose(fn: () => Promise<void> | void): void;
	/** Block 2C installs the WebSocket upgrade handler here; `hub.handleUpgrade` delegates to it. */
	setUpgradeHandler(fn: UpgradeHandler): void;
}
