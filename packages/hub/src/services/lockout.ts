import type { TenantCredentials } from "../auth/tenant-credentials.ts";
import type { ServiceRegistry } from "../deps.ts";
import { LOG_PREFIX } from "../log.ts";
import type { WsGateway } from "../ws.ts";

/** Whatever the runtime manager registers; looked up lazily because the runtime block may be absent. */
interface TenantStopper {
	stop?: (userId: string, reason?: string) => Promise<void>;
}

interface LockoutLog {
	warn(message: string): void;
}

/**
 * Cuts a disabled or banned account off everywhere the database change alone does not reach: every tenant and gateway credential is
 * revoked, every open WebSocket is closed, and the tenant instance is stopped. Each step is best effort and independent (the account
 * is already disabled), so one failure never skips the rest.
 */
export async function lockOutUser(deps: { registry: ServiceRegistry; log: LockoutLog }, userId: string, reason: "disabled" | "banned"): Promise<void> {
	const attempt = async (what: string, step: () => Promise<unknown> | unknown): Promise<void> => {
		try {
			await step();
		} catch (err) {
			deps.log.warn(`${LOG_PREFIX} ${reason === "banned" ? "封禁" : "禁用"}用户 ${userId} 时${what}失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	await attempt("吊销租户凭证", () => deps.registry.get<TenantCredentials>("tenantCredentials")?.revokeUser(userId));
	await attempt("断开实时连接", () => deps.registry.get<WsGateway>("realtime")?.disconnectUser(userId));
	// An explicit `tenants` service wins over `runtime.manager`.
	const runtime = deps.registry.get<TenantStopper & { manager?: TenantStopper }>("runtime");
	const stopper = deps.registry.get<TenantStopper>("tenants") ?? runtime?.manager ?? runtime;
	if (typeof stopper?.stop === "function") await attempt("停止租户实例", () => stopper.stop?.(userId, reason));
}
