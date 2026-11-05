import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TenantCredentials } from "../auth/tenant-credentials.ts";
import type { Queryable } from "../db/db.ts";
import { toIso } from "../db/db.ts";
import type { HubDeps } from "../deps.ts";
import { badRequest, forbidden, HubError, notFound } from "../errors.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { ModelsService } from "../services/models.ts";
import type { NotificationsService } from "../services/notifications.ts";
import { scopeOf } from "../services/common.ts";
import { LOG_PREFIX } from "../log.ts";
import type { WsGateway } from "../ws.ts";
import { hostLayout, type RuntimeDriver, type RuntimeKind, type TenantHandle } from "./driver.ts";
import type { NodesService, Placement } from "./nodes.ts";
import { buildTenantPolicy, detectDisabledToolsSupport, detectReadOutsideDenySupport } from "./policy.ts";
import { type DriverStatus, driverStatuses, parseRuntimeMode, type RuntimeMode, selectDriver } from "./select.ts";
import {
	buildPolicyGateways,
	buildTenantEnv,
	GATEWAY_TOKEN_TTL_SEC,
	layoutFor,
	newServerToken,
	TENANT_TOKEN_TTL_SEC,
} from "./tenant-env.ts";

export const MAX_CRASHES = 3;
export const CRASH_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_QUEUE_RETRY_MS = 30_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HEALTH_INTERVAL_MS = 15_000;
const IDLE_SWEEP_INTERVAL_MS = 60_000;
const HEALTH_FAILURES_BEFORE_CRASH = 2;

export type RuntimeStatus = "stopped" | "starting" | "running" | "stopping" | "failed";

export interface RuntimeView {
	userId: string;
	orgId: string | null;
	driver: RuntimeKind | null;
	nodeId: string | null;
	status: RuntimeStatus;
	port: number | null;
	containerId: string | null;
	pid: number | null;
	startedAt: string | null;
	lastSeenAt: string | null;
	cpuLimit: number | null;
	memLimitMb: number | null;
	lastError: string | null;
	/** Open proxied requests and WebSockets right now. */
	activeConnections: number;
	/** True while the tenant runs with limits older than the stored ones. */
	restartRequired: boolean;
}

export interface TenantManager {
	/** Starts the user's tenant when needed (queueing when full) and returns where it listens. */
	ensureRunning(userId: string): Promise<TenantHandle>;
	/** Where the user's tenant listens right now; undefined when it is not running. */
	target(userId: string): TenantHandle | undefined;
	/** Marks activity (a proxied request) so the idle timer restarts. */
	touch(userId: string): void;
	/** Counts an open proxied request or WebSocket; call the returned function when it ends. */
	openConnection(userId: string): () => void;
	stop(userId: string, reason?: string): Promise<void>;
	/** The caller's own tenant status (any signed-in user); `restricted` drives the UI's restricted-mode badge. */
	me(actor: Actor): Promise<RuntimeView & { restricted: boolean; workbenchUrl: string }>;
	list(actor: Actor): Promise<RuntimeView[]>;
	adminStop(actor: Actor, userId: string): Promise<RuntimeView>;
	setLimits(actor: Actor, userId: string, limits: { cpuLimit?: number | null | undefined; memLimitMb?: number | null | undefined }): Promise<RuntimeView>;
	/** Stops tenants that have been idle for HUB_TENANT_IDLE_MINUTES. Runs on a timer; exposed for tests. */
	sweepIdle(): Promise<string[]>;
	/** Polls `/api/health` of running tenants and restarts crashed ones. Runs on a timer; exposed for tests. */
	sweepHealth(): Promise<void>;
	drivers(): Promise<{ mode: RuntimeMode; selected: RuntimeKind | null; drivers: DriverStatus[] }>;
	/** Stops every tenant (Hub shutdown). */
	shutdown(): Promise<void>;
}

interface Entry {
	userId: string;
	status: "queued" | "starting" | "running" | "stopping";
	driver?: RuntimeDriver;
	handle?: TenantHandle;
	lastActivity: number;
	conns: number;
	crashes: number[];
	healthFails: number;
	cancelled: boolean;
	startPromise?: Promise<TenantHandle>;
	stopPromise?: Promise<void>;
	/** Limits the running instance was started with. */
	limits?: { cpu: number; memMb: number };
}

interface RuntimeRow {
	user_id: string;
	org_id: string | null;
	driver: RuntimeKind | null;
	node_id: string | null;
	status: RuntimeStatus;
	port: number | null;
	container_id: string | null;
	pid: number | null;
	started_at: Date | string | null;
	last_seen_at: Date | string | null;
	cpu_limit: number | string | null;
	mem_limit_mb: number | null;
	last_error: string | null;
}

const COLUMNS = "user_id, org_id, driver, node_id, status, port, container_id, pid, started_at, last_seen_at, cpu_limit, mem_limit_mb, last_error";
const WRITABLE = new Set(["org_id", "driver", "node_id", "status", "port", "container_id", "pid", "started_at", "last_seen_at", "cpu_limit", "mem_limit_mb", "last_error"]);

const positive = (raw: string | undefined, fallback: number): number => {
	const n = Number(raw);
	return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Serialises async sections (capacity check plus reservation). */
class Mutex {
	#tail: Promise<unknown> = Promise.resolve();
	run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.#tail.then(fn, fn);
		this.#tail = next.catch(() => {});
		return next;
	}
}

export interface TenantManagerParts {
	drivers: RuntimeDriver[];
	nodes: NodesService;
	tenantRoot: string;
	/** Where `restricted` tenants live: outside the directory with jwt.key, secret.key and pgdata (they share the Hub's OS user). Defaults to `tenantRoot`. */
	restrictedTenantRoot?: string;
}

export function createTenantManager(deps: HubDeps, parts: TenantManagerParts): TenantManager {
	const env = deps.env;
	const ov = deps.runtimeOptions ?? {};
	const mode = parseRuntimeMode(env.HUB_RUNTIME);
	const idleMs = positive(env.HUB_TENANT_IDLE_MINUTES, 30) * 60_000;
	const maxTenants = Math.floor(positive(env.HUB_TENANT_MAX, 3));
	const defaults = { cpu: positive(env.HUB_TENANT_CPU, 1), memMb: positive(env.HUB_TENANT_MEM_MB, 2048) };
	const startTimeoutMs = ov.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
	const queueRetryMs = ov.queueRetryMs ?? DEFAULT_QUEUE_RETRY_MS;
	const queueTimeoutMs = ov.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
	const sleep = ov.sleep ?? wait;
	const supportsDisabledTools = ov.supportsDisabledTools ?? detectDisabledToolsSupport(env);
	const supportsReadOutsideDeny = ov.supportsReadOutsideDeny ?? detectReadOutsideDenySupport(env);
	const publicMode = deps.config.mode === "public";
	const allowRestricted = env.HUB_ALLOW_RESTRICTED?.trim() === "1";
	const baseHubUrl = (ov.tenantHubUrl ?? `${deps.config.publicUrl}${deps.config.basePath}`).replace(/\/+$/, "");

	/** Where the tenant workbench is opened: the dedicated origin when HUB_RUNTIME_ORIGIN is set, else the Hub's own host (relative). The caller appends `?token=`. */
	const workbenchUrl = `${deps.config.runtimeOrigin ?? ""}${deps.config.basePath}/rt/`;

	const entries = new Map<string, Entry>();
	const reserve = new Mutex();
	let shuttingDown = false;
	let lastSelected: RuntimeKind | null = null;

	const log = (msg: string): void => deps.log.info(`${LOG_PREFIX} ${msg}`);

	// ---------- persistence ----------

	async function upsert(userId: string, fields: Record<string, unknown>, q?: Queryable): Promise<void> {
		const keys = Object.keys(fields).filter((k) => WRITABLE.has(k));
		const run = async (qq: Queryable): Promise<void> => {
			const cols = ["user_id", ...keys, "updated_at"];
			const values = [userId, ...keys.map((k) => fields[k]), new Date(deps.now()).toISOString()];
			const placeholders = values.map((_, i) => `$${i + 1}`);
			const sets = [...keys, "updated_at"].map((c) => `${c} = EXCLUDED.${c}`);
			await qq.query(`INSERT INTO tenant_runtimes (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT (user_id) DO UPDATE SET ${sets.join(", ")}`, values);
		};
		if (q) return run(q);
		await deps.db.tx({ system: true }, run);
	}

	const persist = (userId: string, fields: Record<string, unknown>): Promise<void> =>
		upsert(userId, fields).catch((err: unknown) => {
			deps.log.warn(`${LOG_PREFIX} 保存租户运行状态失败: ${errText(err)}`);
		});

	async function limitsRow(userId: string): Promise<{ cpu: number; memMb: number }> {
		const rows = await deps.db.tx({ system: true }, (q) => q.query<{ cpu_limit: number | string | null; mem_limit_mb: number | null }>("SELECT cpu_limit, mem_limit_mb FROM tenant_runtimes WHERE user_id = $1", [userId]));
		const r = rows[0];
		return { cpu: r?.cpu_limit != null ? Number(r.cpu_limit) : defaults.cpu, memMb: r?.mem_limit_mb ?? defaults.memMb };
	}

	// A previous Hub process may have left rows marked running; its tenants are not ours any more (containers are replaced by name on start).
	const ready: Promise<void> = deps.db
		.tx({ system: true }, async (q) => {
			await q.query("UPDATE tenant_runtimes SET status = 'stopped', port = NULL, container_id = NULL, pid = NULL WHERE status IN ('starting', 'running', 'stopping')");
			// The credentials of those tenants die with them; a restarted tenant gets fresh ones.
			await q.query("UPDATE tenant_credentials SET revoked_at = now() WHERE revoked_at IS NULL");
		})
		.then(() => undefined)
		.catch((err: unknown) => {
			deps.log.warn(`${LOG_PREFIX} 重置租户运行状态失败: ${errText(err)}`);
		});

	// ---------- helpers ----------

	const activeCount = (except: Entry): number => [...entries.values()].filter((e) => e !== except && (e.status === "starting" || e.status === "running" || e.status === "stopping")).length;

	function hubUrlFor(kind: RuntimeKind): string {
		if (kind !== "docker" || ov.tenantHubUrl) return baseHubUrl;
		return baseHubUrl.replace(/\/\/(127\.0\.0\.1|localhost|\[::1\])/, "//host.docker.internal");
	}

	async function healthOk(handle: TenantHandle): Promise<boolean> {
		try {
			const res = await fetch(`http://${handle.host}:${handle.port}/api/health`, { signal: AbortSignal.timeout(3000) });
			return res.ok;
		} catch {
			return false;
		}
	}

	async function notifyFailure(userId: string, orgId: string | null, reason: string): Promise<void> {
		const notifications = deps.registry.get<NotificationsService>("notifications");
		if (!notifications) return;
		await notifications.notify(userId, "tenant.failed", { reason }, orgId).catch(() => {});
	}

	const credentials = (): TenantCredentials => deps.registry.require<TenantCredentials>("tenantCredentials");

	/**
	 * Credential files are private to the Hub's OS user (0600; best effort on Windows). Docker is the exception: the container
	 * runs as another uid and reads them through a bind mount, so they stay world readable on the host (the tenant root is the guard).
	 */
	async function writePrivate(file: string, content: string, kind: RuntimeKind): Promise<void> {
		const mode = kind === "docker" ? 0o644 : 0o600;
		await writeFile(file, content, { mode });
		await chmod(file, mode).catch(() => {});
	}

	async function writeTenantFiles(userId: string, root: string, kind: RuntimeKind, restricted: boolean, actor: Actor): Promise<{ tenantToken: string; serverToken: string }> {
		const host = hostLayout(root, join);
		for (const dir of [host.data, host.work, host.policyDir, join(host.data, "tmp")]) await mkdir(dir, { recursive: true });
		const hubUrl = hubUrlFor(kind);
		// A new credential replaces every earlier one of this user.
		await credentials().revokeUser(userId);
		const gatewayToken = (await credentials().issue(userId, "gateway", GATEWAY_TOKEN_TTL_SEC)).token;
		const models = deps.registry.get<ModelsService>("models");
		const visible = models ? await models.visibleModels(actor).catch(() => []) : [];
		const policy = buildTenantPolicy({
			userId,
			restricted,
			supportsDisabledTools,
			supportsReadOutsideDeny,
			gateways: buildPolicyGateways(visible, hubUrl, gatewayToken),
			managedBy: `prometheus-hub:${deps.config.orgName}`,
		});
		await writePrivate(host.policyFile, `${JSON.stringify(policy, null, "\t")}\n`, kind);
		await writePrivate(host.keyFile, deps.publicKeyPem, kind);
		const tenantToken = (await credentials().issue(userId, "tenant", TENANT_TOKEN_TTL_SEC)).token;
		return { tenantToken, serverToken: newServerToken() };
	}

	// ---------- start ----------

	async function reserveSlot(entry: Entry, driver: RuntimeDriver, need: { cpu: number; memMb: number }): Promise<Placement | "wait"> {
		return reserve.run(async () => {
			const placement = driver.kind === "docker" ? await parts.nodes.place(need) : ({ kind: "local" } as const);
			if (placement.kind === "exhausted") return "wait";
			if (placement.kind === "local" && activeCount(entry) >= maxTenants) return "wait";
			entry.status = "starting";
			await upsert(entry.userId, { driver: driver.kind, node_id: placement.kind === "node" ? placement.node.id : null, status: "starting", last_error: null });
			return placement;
		});
	}

	async function startEntry(entry: Entry): Promise<TenantHandle> {
		const { userId } = entry;
		const actor = await deps.services.actors.load(userId);
		const driver = await selectDriver(mode, parts.drivers, { publicMode, allowRestricted, log: (m) => deps.log.warn(`${LOG_PREFIX} ${m}`) });
		lastSelected = driver.kind;
		const limits = await limitsRow(userId);
		const started = deps.now();
		let placement = await reserveSlot(entry, driver, limits);
		while (placement === "wait") {
			if (entry.cancelled || shuttingDown) throw new HubError(503, "startCancelled", "租户启动已取消");
			if (deps.now() - started >= queueTimeoutMs) {
				entries.delete(userId);
				throw new HubError(503, "capacityExhausted", "服务器资源已满，请稍后再试", { "retry-after": "30" });
			}
			await sleep(queueRetryMs);
			placement = await reserveSlot(entry, driver, limits);
		}
		entry.driver = driver;
		const node = placement.kind === "node" ? placement.node : undefined;
		const root = join(driver.kind === "restricted" ? (parts.restrictedTenantRoot ?? parts.tenantRoot) : parts.tenantRoot, userId);
		const restricted = driver.kind === "restricted" && !actor.operator;
		try {
			const { tenantToken, serverToken } = await writeTenantFiles(userId, root, driver.kind, restricted, actor);
			const containerized = driver.kind === "docker";
			const layout = layoutFor(containerized, hostLayout(root, join));
			const tenantEnv = buildTenantEnv({ userId, layout, containerized, hubUrl: hubUrlFor(driver.kind), issuer: deps.config.issuer, tenantToken, serverToken });
			const handle = await driver.start({ userId, root, env: tenantEnv, cpuLimit: limits.cpu, memLimitMb: limits.memMb, node });
			entry.handle = handle;
			let exited: { code: number | null } | undefined;
			driver.onExit?.(handle, (info) => {
				exited = info;
				if (entry.status === "running") void handleCrash(entry, `进程退出 (code ${String(info.code)})`);
			});
			const deadline = Date.now() + startTimeoutMs;
			let healthy = false;
			while (Date.now() < deadline && !exited && !entry.cancelled) {
				if (await healthOk(handle)) {
					healthy = true;
					break;
				}
				await wait(250);
			}
			if (!healthy) {
				const tail = driver.tail?.(userId);
				await driver.stop(handle).catch(() => {});
				throw new HubError(502, "tenantStartFailed", `租户实例没有在 ${Math.round(startTimeoutMs / 1000)} 秒内就绪${exited ? `（进程已退出 ${String(exited.code)}）` : ""}${tail ? `\n${tail.slice(-600)}` : ""}`);
			}
			if (entry.cancelled || shuttingDown) {
				await driver.stop(handle).catch(() => {});
				throw new HubError(503, "startCancelled", "租户启动已取消");
			}
			entry.status = "running";
			entry.limits = { cpu: limits.cpu, memMb: limits.memMb };
			entry.lastActivity = deps.now();
			entry.healthFails = 0;
			await upsert(userId, {
				org_id: Object.keys(actor.orgRoles)[0] ?? null,
				status: "running",
				port: handle.port,
				container_id: handle.containerId ?? null,
				pid: handle.pid ?? null,
				started_at: new Date(deps.now()).toISOString(),
				last_seen_at: new Date(deps.now()).toISOString(),
				last_error: null,
			});
			log(`租户实例已启动 user=${userId} driver=${driver.kind} port=${handle.port}`);
			return handle;
		} catch (err) {
			entries.delete(userId);
			await persist(userId, { status: "failed", port: null, container_id: null, pid: null, last_error: errText(err).slice(0, 500) });
				await credentials().revokeUser(userId).catch(() => {});
			if (err instanceof HubError) throw err;
			if ((err as { code?: unknown }).code === "adminRequired") throw new HubError(503, "adminRequired", errText(err));
			throw new HubError(502, "tenantStartFailed", `租户实例启动失败: ${errText(err)}`);
		}
	}

	function begin(entry: Entry): Promise<TenantHandle> {
		entry.startPromise = startEntry(entry).finally(() => {
			entry.startPromise = undefined;
		});
		return entry.startPromise;
	}

	async function handleCrash(entry: Entry, reason: string): Promise<void> {
		if (entry.status !== "running" || shuttingDown) return;
		const { userId } = entry;
		const now = deps.now();
		entry.crashes = [...entry.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
		deps.log.warn(`${LOG_PREFIX} 租户实例异常 user=${userId}: ${reason}（${CRASH_WINDOW_MS / 60_000} 分钟内第 ${entry.crashes.length} 次）`);
		const handle = entry.handle;
		entry.status = "starting";
		// The restart is the entry's start promise from the first tick, so ensureRunning callers wait for it instead of racing a second start.
		const restart = (async (): Promise<TenantHandle> => {
			if (handle) await entry.driver?.stop(handle).catch(() => {});
			entry.handle = undefined;
			if (entry.crashes.length > MAX_CRASHES) {
				entries.delete(userId);
				await persist(userId, { status: "failed", port: null, container_id: null, pid: null, last_error: `连续崩溃: ${reason}`.slice(0, 500) });
					await credentials().revokeUser(userId).catch(() => {});
				const rows = await deps.db.tx({ system: true }, (q) => q.query<{ org_id: string | null }>("SELECT org_id FROM tenant_runtimes WHERE user_id = $1", [userId])).catch(() => []);
				await notifyFailure(userId, rows[0]?.org_id ?? null, `租户实例连续崩溃，已停止自动重启: ${reason}`);
				throw new HubError(503, "tenantFailed", "租户实例连续崩溃，已停止自动重启");
			}
			return startEntry(entry);
		})();
		entry.startPromise = restart.finally(() => {
			entry.startPromise = undefined;
		});
		await entry.startPromise.catch((err: unknown) => {
			deps.log.error(`${LOG_PREFIX} 租户实例重启失败 user=${userId}: ${errText(err)}`);
		});
	}

	// ---------- stop ----------

	async function stopEntry(entry: Entry, reason: string): Promise<void> {
		if (entry.stopPromise) return entry.stopPromise;
		entry.cancelled = true;
		entry.stopPromise = (async () => {
			const { userId } = entry;
			if (entry.startPromise) await entry.startPromise.catch(() => {});
			entry.status = "stopping";
			await persist(userId, { status: "stopping" });
			if (entry.handle) await entry.driver?.stop(entry.handle).catch((err: unknown) => deps.log.warn(`${LOG_PREFIX} 停止租户实例出错 user=${userId}: ${errText(err)}`));
			entries.delete(userId);
			await persist(userId, { status: "stopped", port: null, container_id: null, pid: null });
				// Whatever the stopped instance still holds (credential, gateway token, minted access tokens) stops working now.
				await credentials().revokeUser(userId).catch((err: unknown) => deps.log.warn(`${LOG_PREFIX} 吊销租户凭证失败 user=${userId}: ${errText(err)}`));
				deps.registry.get<WsGateway>("realtime")?.disconnectUser(userId, "tenant");
			log(`租户实例已停止 user=${userId}（${reason}）`);
		})();
		return entry.stopPromise;
	}

	// ---------- views and admin ----------

	const toView = (r: RuntimeRow): RuntimeView => {
		const live = entries.get(r.user_id);
		const cpu = r.cpu_limit != null ? Number(r.cpu_limit) : defaults.cpu;
		const mem = r.mem_limit_mb ?? defaults.memMb;
		return {
			userId: r.user_id,
			orgId: r.org_id,
			driver: r.driver,
			nodeId: r.node_id,
			status: live?.status === "queued" ? "starting" : r.status,
			port: r.port,
			containerId: r.container_id,
			pid: r.pid,
			startedAt: toIso(r.started_at),
			lastSeenAt: toIso(r.last_seen_at),
			cpuLimit: r.cpu_limit != null ? Number(r.cpu_limit) : null,
			memLimitMb: r.mem_limit_mb,
			lastError: r.last_error,
			activeConnections: live?.conns ?? 0,
			restartRequired: Boolean(live?.limits && (live.limits.cpu !== cpu || live.limits.memMb !== mem)),
		};
	};

	const manageableOrgs = (actor: Actor): string[] => Object.entries(actor.orgRoles).filter(([, role]) => role === "owner" || role === "admin").map(([id]) => id);

	async function loadRow(userId: string): Promise<RuntimeRow | undefined> {
		const rows = await deps.db.tx({ system: true }, (q) => q.query<RuntimeRow>(`SELECT ${COLUMNS} FROM tenant_runtimes WHERE user_id = $1`, [userId]));
		return rows[0];
	}

	async function requireManage(actor: Actor, userId: string): Promise<RuntimeRow | undefined> {
		const row = await loadRow(userId);
		if (actor.operator) return row;
		if (row?.org_id && can(actor, "org.manage", { orgId: row.org_id })) return row;
		throw forbidden();
	}

	return {
		async ensureRunning(userId) {
			if (shuttingDown) throw new HubError(503, "shuttingDown", "Hub 正在关闭");
			await ready;
			for (;;) {
				const existing = entries.get(userId);
				if (existing?.stopPromise) {
					await existing.stopPromise;
					continue;
				}
				if (existing?.status === "running" && existing.handle) {
					existing.lastActivity = deps.now();
					return existing.handle;
				}
				if (existing?.startPromise) return existing.startPromise;
				const entry: Entry = { userId, status: "queued", lastActivity: deps.now(), conns: 0, crashes: existing?.crashes ?? [], healthFails: 0, cancelled: false };
				entries.set(userId, entry);
				return begin(entry);
			}
		},

		target(userId) {
			const e = entries.get(userId);
			return e?.status === "running" ? e.handle : undefined;
		},

		touch(userId) {
			const e = entries.get(userId);
			if (e) e.lastActivity = deps.now();
		},

		openConnection(userId) {
			const e = entries.get(userId);
			if (!e) return () => {};
			e.conns += 1;
			e.lastActivity = deps.now();
			let released = false;
			return () => {
				if (released) return;
				released = true;
				e.conns = Math.max(0, e.conns - 1);
				e.lastActivity = deps.now();
			};
		},

		async stop(userId, reason = "手动停止") {
			const e = entries.get(userId);
			if (e) await stopEntry(e, reason);
		},

		async me(actor) {
			const row = await loadRow(actor.userId);
			const view: RuntimeView = row
				? toView(row)
				: { userId: actor.userId, orgId: null, driver: null, nodeId: null, status: "stopped", port: null, containerId: null, pid: null, startedAt: null, lastSeenAt: null, cpuLimit: null, memLimitMb: null, lastError: null, activeConnections: 0, restartRequired: false };
			return { ...view, restricted: view.driver === "restricted" && !actor.operator, workbenchUrl };
		},

		async list(actor) {
			const orgs = manageableOrgs(actor);
			if (!actor.operator && orgs.length === 0) throw forbidden();
			const rows = await deps.db.tx(scopeOf(actor), (q) =>
				actor.operator
					? q.query<RuntimeRow>(`SELECT ${COLUMNS} FROM tenant_runtimes ORDER BY user_id`)
					: q.query<RuntimeRow>(`SELECT ${COLUMNS} FROM tenant_runtimes WHERE org_id = ANY($1::text[]) ORDER BY user_id`, [orgs]),
			);
			return rows.map(toView);
		},

		async adminStop(actor, userId) {
			const row = await requireManage(actor, userId);
			if (!row) throw notFound("该用户没有租户实例");
			const e = entries.get(userId);
			if (e) await stopEntry(e, `管理员 ${actor.userId} 停止`);
			await deps.db.tx(scopeOf(actor), (q) => deps.services.audit.write(q, { actorId: actor.userId, orgId: row.org_id, action: "runtime.stop", targetType: "tenant_runtime", targetId: userId }));
			const fresh = await loadRow(userId);
			return toView(fresh as RuntimeRow);
		},

		async setLimits(actor, userId, limits) {
			const row = await requireManage(actor, userId);
			if (limits.cpuLimit !== undefined && limits.cpuLimit !== null && !(limits.cpuLimit > 0)) throw badRequest("cpuLimit 必须大于 0");
			if (limits.memLimitMb !== undefined && limits.memLimitMb !== null && !(limits.memLimitMb >= 64)) throw badRequest("memLimitMb 至少 64");
			const users = await deps.db.tx({ system: true }, (q) => q.query<{ id: string }>("SELECT id FROM users WHERE id = $1", [userId]));
			if (users.length === 0) throw notFound("用户不存在");
			const fields: Record<string, unknown> = {};
			if (limits.cpuLimit !== undefined) fields.cpu_limit = limits.cpuLimit;
			if (limits.memLimitMb !== undefined) fields.mem_limit_mb = limits.memLimitMb;
			await deps.db.tx(scopeOf(actor), async (q) => {
				await upsert(userId, fields, q);
				await deps.services.audit.write(q, { actorId: actor.userId, orgId: row?.org_id ?? null, action: "runtime.limits", targetType: "tenant_runtime", targetId: userId, detail: { ...limits } });
			});
			const fresh = await loadRow(userId);
			return toView(fresh as RuntimeRow);
		},

		async sweepIdle() {
			const stopped: string[] = [];
			const now = deps.now();
			for (const e of [...entries.values()]) {
				if (e.status !== "running" || e.conns > 0 || now - e.lastActivity < idleMs) continue;
				await stopEntry(e, "闲置超时");
				stopped.push(e.userId);
			}
			return stopped;
		},

		async sweepHealth() {
			for (const e of [...entries.values()]) {
				if (e.status !== "running" || !e.handle) continue;
				// A disabled or banned account must not keep a running instance.
				const active = await deps.services.actors.load(e.userId).then(() => true, (err: unknown) => !(err instanceof HubError && err.status === 401));
				if (!active) {
					await stopEntry(e, "账号不可用");
					continue;
				}
				if (await healthOk(e.handle)) {
					e.healthFails = 0;
					void persist(e.userId, { last_seen_at: new Date(deps.now()).toISOString() });
					continue;
				}
				e.healthFails += 1;
				if (e.healthFails >= HEALTH_FAILURES_BEFORE_CRASH) await handleCrash(e, "健康检查连续失败");
			}
		},

		async drivers() {
			return { mode, selected: lastSelected, drivers: await driverStatuses(parts.drivers) };
		},

		async shutdown() {
			shuttingDown = true;
			await Promise.all([...entries.values()].map((e) => stopEntry(e, "Hub 关闭")));
		},
	};
}

export { DEFAULT_HEALTH_INTERVAL_MS, IDLE_SWEEP_INTERVAL_MS };
