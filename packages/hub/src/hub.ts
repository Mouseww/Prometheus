import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { type HubConfig, type HubOptions, pgDataDir, resolveConfig } from "./config.ts";
import { loadJwtKeys, loadMasterKey, SecretBox } from "./crypto.ts";
import type { Db } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import { openPglite } from "./db/pglite.ts";
import { openPostgres } from "./db/postgres.ts";
import { type HubDeps, type HubServices, ServiceRegistry, type UpgradeHandler } from "./deps.ts";
import { dispatch } from "./http/dispatch.ts";
import { Router } from "./http/router.ts";
import { LOG_PREFIX, stderrLog } from "./log.ts";
import { RateLimiter } from "./rate-limit.ts";
import { registerRoutes } from "./routes/index.ts";
import { createSetupCode } from "./setup-code.ts";
import { createAccountsService } from "./services/accounts.ts";
import { createActorService } from "./services/actors.ts";
import { createAdminUsersService } from "./services/admin-users.ts";
import { createAuditService } from "./services/audit.ts";
import type { ServiceDeps } from "./services/common.ts";
import { createInvitationsService } from "./services/invitations.ts";
import { createOrgsService } from "./services/orgs.ts";
import { createRegistrationService } from "./services/registration.ts";
import { createSettingsService } from "./services/settings.ts";
import { createTeamsService } from "./services/teams.ts";

export interface Hub {
	/** Serves a Hub route. Resolves false when the request is not for the Hub so the host can handle it. */
	handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
	/** WebSocket upgrade; false until block 2C installs a handler. */
	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
	close(): Promise<void>;
	services: HubServices;
	registry: ServiceRegistry;
	deps: HubDeps;
	db: Db;
	config: HubConfig;
	publicKeyPem: string;
}

async function openDb(options: HubOptions, config: HubConfig, env: NodeJS.ProcessEnv): Promise<Db> {
	const url = options.databaseUrl ?? env.HUB_DATABASE_URL;
	if (url) return openPostgres(url, { appRole: config.appRole });
	return openPglite(options.memory ? "memory" : pgDataDir(config.dataDir), { appRole: config.appRole });
}

export async function createHub(options: HubOptions): Promise<Hub> {
	const env = options.env ?? process.env;
	const config = resolveConfig(options);
	const log = options.log ?? stderrLog();
	const now = options.now ?? Date.now;
	await mkdir(config.dataDir, { recursive: true });

	const db = await openDb(options, config, env);
	const closers: (() => Promise<void> | void)[] = [];
	try {
		await migrate(db, { appRole: config.appRole, log });
		const secretBox = new SecretBox(await loadMasterKey(config.dataDir, options.secretKey ?? env.HUB_SECRET_KEY));
		const keys = await loadJwtKeys(config.dataDir);
		const limiter = new RateLimiter(now);
		const setupCode = createSetupCode(config.dataDir);

		const base: ServiceDeps = { db, log, now };
		const audit = createAuditService(base);
		const settings = createSettingsService(base);
		const actors = createActorService(base);
		const registration = createRegistrationService(base, audit);
		const orgs = createOrgsService(base, audit);
		const teams = createTeamsService(base, audit, settings);
		const invitations = createInvitationsService(base, audit, teams, config.publicUrl);
		const accounts = createAccountsService(base, {
			config,
			privateKey: keys.privateKey,
			publicKey: keys.publicKey,
			audit,
			registration,
			invitations,
			settings,
			teams,
			setupCode,
			limiter,
		});
		const adminUsers = createAdminUsersService(base, audit, accounts, settings);
		const services: HubServices = { audit, settings, actors, registration, accounts, adminUsers, invitations, orgs, teams };

		if (options.allowPersonalTeams !== undefined) {
			await db.tx({ system: true }, (q) => settings.set(q, "allow_personal_teams", options.allowPersonalTeams));
		}
		const userCount = await db.query<{ n: string | number }>("SELECT count(*) AS n FROM users");
		if (Number(userCount[0]?.n ?? 0) === 0) await setupCode.ensure(log);

		let upgrade: UpgradeHandler | undefined;
		const registry = new ServiceRegistry();
		const deps: HubDeps = {
			db,
			config,
			log,
			now,
			services,
			registry,
			secretBox,
			limiter,
			publicKeyPem: keys.publicKey,
			onClose: (fn) => void closers.push(fn),
			setUpgradeHandler: (fn) => {
				upgrade = fn;
			},
		};
		const router = new Router();
		registerRoutes(router, deps);

		let closed = false;
		return {
			handle: (req, res) => dispatch({ router, config, log, publicKey: keys.publicKey, loadActor: (id) => actors.load(id) }, req, res),
			handleUpgrade: (req, socket, head) => upgrade?.(req, socket, head) ?? false,
			async close() {
				if (closed) return;
				closed = true;
				for (const fn of [...closers].reverse()) {
					try {
						await fn();
					} catch (err) {
						log.warn(`${LOG_PREFIX} 关闭组件时出错: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				await db.close();
			},
			services,
			registry,
			deps,
			db,
			config,
			publicKeyPem: keys.publicKey,
		};
	} catch (err) {
		await db.close().catch(() => {});
		throw err;
	}
}
