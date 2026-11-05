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

/**
 * `auto`: docker if usable, else sandbox, else restricted. An explicit mode must be usable: silently running a user's agent
 * without the isolation the operator asked for would be worse than refusing.
 */
export async function selectDriver(mode: RuntimeMode, drivers: readonly RuntimeDriver[]): Promise<RuntimeDriver> {
	const byKind = new Map(drivers.map((d) => [d.kind, d]));
	const order = mode === "auto" ? AUTO_ORDER : [mode];
	for (const kind of order) {
		const driver = byKind.get(kind);
		if (driver && (await driver.available().catch(() => false))) return driver;
	}
	const reason = mode === "auto" ? undefined : byKind.get(mode)?.unavailableReason?.();
	const code = reason === "adminRequired" ? "adminRequired" : "runtimeUnavailable";
	throw new HubError(503, code, mode === "auto" ? "没有可用的租户运行时" : `租户运行时 ${mode} 不可用${reason ? `: ${reason}` : ""}`);
}
