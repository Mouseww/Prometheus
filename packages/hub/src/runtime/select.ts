import { HubError } from "../errors.ts";
import type { RuntimeDriver, RuntimeKind } from "./driver.ts";

export type RuntimeMode = "auto" | RuntimeKind;

const MODES: readonly RuntimeMode[] = ["auto", "docker", "sandbox", "restricted"];
const AUTO_ORDER: readonly RuntimeKind[] = ["docker", "sandbox", "restricted"];

export function parseRuntimeMode(value: string | undefined): RuntimeMode {
	const v = (value ?? "auto").trim().toLowerCase();
	if (!(MODES as readonly string[]).includes(v)) throw new Error(`HUB_RUNTIME 无效: ${value}（可选 ${MODES.join("、")}）`);
	return v as RuntimeMode;
}

export interface DriverStatus {
	kind: RuntimeKind;
	available: boolean;
	reason?: string;
}

export async function driverStatuses(drivers: readonly RuntimeDriver[]): Promise<DriverStatus[]> {
	return Promise.all(
		drivers.map(async (d) => {
			const available = await d.available().catch(() => false);
			const reason = available ? undefined : d.unavailableReason?.();
			return { kind: d.kind, available, ...(reason ? { reason } : {}) };
		}),
	);
}

export interface SelectOptions {
	/** HUB_MODE=public: tenants run code of strangers, so `restricted` (same OS user as the Hub, not a security boundary) is refused. */
	publicMode?: boolean;
	/** HUB_ALLOW_RESTRICTED=1: the operator explicitly accepts `restricted` in public mode. */
	allowRestricted?: boolean;
	log?: (message: string) => void;
}

const RESTRICTED_REFUSED = "公开模式下没有可用的隔离运行时（docker 或 sandbox），restricted 与 Hub 使用同一个系统账号，不是安全边界，已拒绝。请配置 docker 或 sandbox；确需使用时显式设置 HUB_ALLOW_RESTRICTED=1";

/**
 * `auto`: docker if usable, else sandbox, else restricted. An explicit mode must be usable: silently running a user's agent
 * without the isolation the operator asked for would be worse than refusing. In public mode `restricted` is never chosen
 * (neither by `auto` nor explicitly) unless `allowRestricted` is set.
 */
export async function selectDriver(mode: RuntimeMode, drivers: readonly RuntimeDriver[], options: SelectOptions = {}): Promise<RuntimeDriver> {
	const byKind = new Map(drivers.map((d) => [d.kind, d]));
	const restrictedOk = !options.publicMode || options.allowRestricted === true;
	if (mode === "restricted" && !restrictedOk) {
		options.log?.(RESTRICTED_REFUSED);
		throw new HubError(503, "runtimeUnavailable", RESTRICTED_REFUSED);
	}
	const order = (mode === "auto" ? AUTO_ORDER : [mode]).filter((k) => k !== "restricted" || restrictedOk);
	for (const kind of order) {
		const driver = byKind.get(kind);
		if (driver && (await driver.available().catch(() => false))) return driver;
	}
	if (mode === "auto" && !restrictedOk) {
		options.log?.(RESTRICTED_REFUSED);
		throw new HubError(503, "runtimeUnavailable", RESTRICTED_REFUSED);
	}
	const reason = mode === "auto" ? undefined : byKind.get(mode)?.unavailableReason?.();
	const code = reason === "adminRequired" ? "adminRequired" : "runtimeUnavailable";
	throw new HubError(503, code, mode === "auto" ? "没有可用的租户运行时" : `租户运行时 ${mode} 不可用${reason ? `: ${reason}` : ""}`);
}
