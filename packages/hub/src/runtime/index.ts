import { join } from "node:path";
import type { HubDeps } from "../deps.ts";
import { createDockerClient, parseDockerUrl } from "./docker-api.ts";
import { createDockerDriver } from "./docker-driver.ts";
import type { RuntimeDriver } from "./driver.ts";
import { createTenantManager, DEFAULT_HEALTH_INTERVAL_MS, IDLE_SWEEP_INTERVAL_MS, type TenantManager } from "./manager.ts";
import { createNodesService, type NodesService } from "./nodes.ts";
import { createProcessDriver } from "./process-driver.ts";
import { createRuntimeProxy, type RuntimeProxy } from "./proxy.ts";
import { createSandboxDriver } from "./sandbox-driver.ts";
import { LOG_PREFIX } from "../log.ts";

export interface Runtime {
	manager: TenantManager;
	nodes: NodesService;
	proxy: RuntimeProxy;
}

const positive = (raw: string | undefined, fallback: number): number => {
	const n = Number(raw);
	return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
};

export function defaultDrivers(deps: HubDeps): RuntimeDriver[] {
	const info = (m: string): void => deps.log.info(`${LOG_PREFIX} ${m}`);
	return [
		createDockerDriver({ env: deps.env, log: info }),
		createSandboxDriver({ dataDir: deps.config.dataDir, env: deps.env, log: info }),
		// No sandbox: the hub owner keeps normal rights, everyone else gets the restricted policy (decided per user in the manager).
		createProcessDriver({ kind: "restricted", env: deps.env }),
	];
}

/** Assembles drivers, nodes, manager and proxy, starts the background timers and registers the `runtime` service. */
export function createRuntime(deps: HubDeps): Runtime {
	const ov = deps.runtimeOptions ?? {};
	const tenantRoot = ov.tenantRoot ?? (deps.env.HUB_TENANT_ROOT?.trim() || join(deps.config.dataDir, "tenants"));
	const nodes = createNodesService({
		db: deps.db,
		log: deps.log,
		now: deps.now,
		audit: deps.services.audit,
		defaults: { cpu: positive(deps.env.HUB_TENANT_CPU, 1), memMb: positive(deps.env.HUB_TENANT_MEM_MB, 2048) },
		pingNode: (node) => createDockerClient({ endpoint: parseDockerUrl(node.dockerUrl, node.tlsDir) }).ping(),
	});
	const manager = createTenantManager(deps, { drivers: ov.drivers ?? defaultDrivers(deps), nodes, tenantRoot });
	const proxy = createRuntimeProxy(deps, manager);

	const interval = ov.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
	if (interval > 0) {
		const warn = (what: string) => (err: unknown): void => deps.log.warn(`${LOG_PREFIX} ${what}失败: ${err instanceof Error ? err.message : String(err)}`);
		const health = setInterval(() => void manager.sweepHealth().catch(warn("租户健康检查")), interval);
		const idle = setInterval(() => void manager.sweepIdle().catch(warn("闲置租户清理")), Math.min(IDLE_SWEEP_INTERVAL_MS, Math.max(interval, 1000)));
		health.unref();
		idle.unref();
		deps.onClose(() => {
			clearInterval(health);
			clearInterval(idle);
		});
	}
	deps.onClose(() => manager.shutdown());
	deps.setUpgradeHandler(proxy.handleUpgrade);

	const runtime: Runtime = { manager, nodes, proxy };
	deps.registry.register("runtime", runtime);
	return runtime;
}
