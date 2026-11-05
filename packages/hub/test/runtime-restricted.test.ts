import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silentLog } from "../src/log.ts";
import { buildTenantPolicy, detectReadOutsideDenySupport, TENANT_PLUGINS } from "../src/runtime/policy.ts";
import { restrictedRootFor } from "../src/runtime/index.ts";
import type { Runtime } from "../src/runtime/index.ts";
import { selectDriver } from "../src/runtime/select.ts";
import { fakeDriver, type FakeDriver, startRtHub, type RtHub } from "./rt-helpers.ts";

const open: RtHub[] = [];
afterEach(async () => {
	for (const t of open.splice(0)) await t.stop();
});

const unavailable = (kind: "docker" | "sandbox"): FakeDriver => ({ ...fakeDriver(kind), available: async () => false });

describe("driver selection in public mode", () => {
	it("never lets auto fall back to restricted, and says why", async () => {
		const logs: string[] = [];
		const drivers = [unavailable("docker"), unavailable("sandbox"), fakeDriver("restricted")];
		await expect(selectDriver("auto", drivers, { publicMode: true, log: (m) => logs.push(m) })).rejects.toMatchObject({ status: 503, code: "runtimeUnavailable" });
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("HUB_ALLOW_RESTRICTED=1");
	});

	it("refuses an explicit restricted unless HUB_ALLOW_RESTRICTED=1", async () => {
		const drivers = [fakeDriver("docker"), fakeDriver("restricted")];
		await expect(selectDriver("restricted", drivers, { publicMode: true })).rejects.toMatchObject({ code: "runtimeUnavailable" });
		expect((await selectDriver("restricted", drivers, { publicMode: true, allowRestricted: true })).kind).toBe("restricted");
	});

	it("still prefers isolation when it is available, and leaves private mode alone", async () => {
		const docker = fakeDriver("docker");
		expect((await selectDriver("auto", [docker, fakeDriver("restricted")], { publicMode: true })).kind).toBe("docker");
		const drivers = [unavailable("docker"), unavailable("sandbox"), fakeDriver("restricted")];
		expect((await selectDriver("auto", drivers, {})).kind).toBe("restricted");
		expect((await selectDriver("auto", drivers, { publicMode: true, allowRestricted: true })).kind).toBe("restricted");
	});

	it("fails a tenant start in a public hub that only has restricted", async () => {
		const driver = fakeDriver("restricted");
		const t = await startRtHub({ drivers: [driver], tenantHubUrl: "http://hub.test" }, { mode: "public" });
		open.push(t);
		const runtime = t.hub.registry.require<Runtime>("runtime");
		const root = await t.bootstrap();
		await expect(runtime.manager.ensureRunning(root.userId)).rejects.toMatchObject({ status: 503, code: "runtimeUnavailable" });
		expect(driver.starts).toBe(0);
	});

	it("starts restricted in a public hub with HUB_ALLOW_RESTRICTED=1", async () => {
		const driver = fakeDriver("restricted");
		const t = await startRtHub({ drivers: [driver], tenantHubUrl: "http://hub.test" }, { mode: "public", env: { HUB_ALLOW_RESTRICTED: "1" } });
		open.push(t);
		const runtime = t.hub.registry.require<Runtime>("runtime");
		const root = await t.bootstrap();
		await runtime.manager.ensureRunning(root.userId);
		expect(driver.starts).toBe(1);
	});
});

describe("restricted tenant policy", () => {
	const base = { userId: "u1", supportsDisabledTools: true, gateways: [], managedBy: "x" };

	it("drops every plugin that spawns commands", () => {
		const policy = buildTenantPolicy({ ...base, restricted: true });
		expect(policy.pluginAllowlist).not.toContain("mcp");
		expect(policy.pluginAllowlist).not.toContain("terminal");
		expect(policy.pluginAllowlist).toContain("team");
		// Non-restricted tenants keep the full set.
		expect(buildTenantPolicy({ ...base, restricted: false }).pluginAllowlist).toEqual([...TENANT_PLUGINS]);
	});

	it("denies reads outside the project when core supports it, otherwise keeps ask", () => {
		expect(buildTenantPolicy({ ...base, restricted: true, supportsReadOutsideDeny: true }).readOutsideProject).toBe("deny");
		expect(buildTenantPolicy({ ...base, restricted: true, supportsReadOutsideDeny: false }).readOutsideProject).toBe("ask");
		expect(buildTenantPolicy({ ...base, restricted: false, supportsReadOutsideDeny: true }).readOutsideProject).toBe("ask");
		expect(detectReadOutsideDenySupport({ HUB_TENANT_READ_DENY: "1" })).toBe(true);
		expect(detectReadOutsideDenySupport({ HUB_TENANT_READ_DENY: "0" })).toBe(false);
		expect(detectReadOutsideDenySupport({}, () => 'invalid(\'readOutsideProject must be "allow", "ask" or "deny"\')')).toBe(true);
		expect(detectReadOutsideDenySupport({}, () => 'invalid(\'readOutsideProject must be "allow" or "ask"\')')).toBe(false);
	});
});

describe("restricted tenant root", () => {
	const depsOf = (dataDir: string, env: Record<string, string> = {}, tenantRoot?: string): Parameters<typeof restrictedRootFor>[0] =>
		({ config: { dataDir }, env, runtimeOptions: tenantRoot ? { tenantRoot } : undefined, log: silentLog }) as unknown as Parameters<typeof restrictedRootFor>[0];

	it("lives next to, not inside, the data directory by default", () => {
		const dataDir = resolve("hub-data");
		const root = restrictedRootFor(depsOf(dataDir), join(dataDir, "tenants"));
		expect(root).toBe(resolve(".", "hub-data-restricted-tenants"));
		expect(root.startsWith(`${dataDir}${process.platform === "win32" ? "\\" : "/"}`)).toBe(false);
	});

	it("follows an explicit HUB_TENANT_ROOT", () => {
		expect(restrictedRootFor(depsOf("d", { HUB_TENANT_ROOT: "/srv/tenants" }), "/srv/tenants")).toBe("/srv/tenants");
	});
});
