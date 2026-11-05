import type { RuntimeDriver } from "./driver.ts";

// Adds `HubOptions.runtime` without touching config.ts, which other blocks edit concurrently.
declare module "../config.ts" {
	interface HubOptions {
		runtime?: RuntimeOverrides;
	}
}

/** Test and embedding hooks for the tenant runtime; every field has a production default. */
export interface RuntimeOverrides {
	/** Replaces the built-in docker, sandbox and restricted drivers. */
	drivers?: RuntimeDriver[];
	/** Where tenant directories live; default `<dataDir>/tenants`. */
	tenantRoot?: string;
	sleep?: (ms: number) => Promise<void>;
	/** How long a started tenant may take to answer `/api/health` (default 90 s). */
	startTimeoutMs?: number;
	/** Health polling period for running tenants; 0 turns the background timers off (tests drive `sweep` themselves). */
	healthIntervalMs?: number;
	/** Capacity queue: retry period (default 30 s) and the total wait (default 10 min). */
	queueRetryMs?: number;
	queueTimeoutMs?: number;
	/** Force or forbid `disabledTools` in restricted policies (default: detect from core). */
	supportsDisabledTools?: boolean;
	/** Force or forbid `readOutsideProject: "deny"` in restricted policies (default: detect from core). */
	supportsReadOutsideDeny?: boolean;
	/** URL tenants use to reach this Hub (including the base path); default `publicUrl` + `basePath`. */
	tenantHubUrl?: string;
}
