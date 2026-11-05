import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProcessDriver } from "../src/runtime/process-driver.ts";
import type { Runtime } from "../src/runtime/index.ts";
import { fakeClock, type RtHub, startRtHub, waitFor } from "./rt-helpers.ts";

/** These tests start the real `apps/server/src/main.ts` on 127.0.0.1 through the process driver. */
describe("tenant lifecycle with the real server", () => {
	let t: RtHub;
	let runtime: Runtime;
	let root: { token: string; userId: string; orgId: string };
	let bob: { token: string; userId: string };
	let driver: ReturnType<typeof createProcessDriver>;
	const clock = fakeClock();

	beforeAll(async () => {
		driver = createProcessDriver({ kind: "restricted", env: process.env });
		t = await startRtHub({ drivers: [driver], startTimeoutMs: 120_000, tenantHubUrl: "http://127.0.0.1:1" }, { now: clock.now, env: { HUB_TENANT_IDLE_MINUTES: "30", HUB_TENANT_MAX: "5" } });
		root = await t.bootstrap();
		bob = await t.createUser(root.token, "bob@corp.test", "Bob", root.orgId);
		runtime = t.hub.registry.require<Runtime>("runtime");
	}, 60_000);

	afterAll(async () => {
		await t?.stop();
	}, 60_000);

	const jwtFor = (sub: string, aud = "prometheus"): string => t.hub.deps.signToken({ sub, aud, exp: Math.floor(Date.now() / 1000) + 600 });
	const direct = async (port: number, token: string | undefined, path = "/plugins/none"): Promise<number> => (await fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).status;

	it("starts on demand, answers health, and the proxy reaches it with a JWT", async () => {
		const res = await fetch(`${t.baseUrl}/rt/plugins/none`, { headers: { authorization: `Bearer ${bob.token}` } });
		// 404 from the tenant itself proves the tenant accepted the per-user JWT (an unknown path without auth is 401).
		expect(res.status).toBe(404);
		const handle = runtime.manager.target(bob.userId);
		expect(handle).toBeDefined();
		const health = await fetch(`http://127.0.0.1:${handle?.port}/api/health`);
		expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
		expect(await direct(handle?.port ?? 0, undefined)).toBe(401);
		const list = await t.api("GET", "/api/admin/runtimes", { token: root.token });
		expect(list.data.items.find((r: any) => r.userId === bob.userId)).toMatchObject({ status: "running", driver: "restricted" });
	}, 150_000);

	it("the tenant accepts its owner's JWT and rejects a JWT for another user (serverOwner)", async () => {
		const handle = runtime.manager.target(bob.userId);
		const port = handle?.port ?? 0;
		expect(await direct(port, jwtFor(bob.userId))).toBe(404);
		expect(await direct(port, jwtFor(root.userId))).toBe(401);
		expect(await direct(port, jwtFor(bob.userId, "someone-else"))).toBe(401);
		// A Hub token that was never signed by this Hub.
		expect(await direct(port, `${jwtFor(bob.userId).split(".").slice(0, 2).join(".")}.AAAA`)).toBe(401);
	});

	it("keeps two users on two separate instances", async () => {
		await t.api("GET", "/rt/plugins/none", { token: root.token });
		const a = runtime.manager.target(root.userId);
		const b = runtime.manager.target(bob.userId);
		expect(a?.port).not.toBe(b?.port);
		expect(await direct(a?.port ?? 0, jwtFor(root.userId))).toBe(404);
		expect(await direct(a?.port ?? 0, jwtFor(bob.userId))).toBe(401);
	}, 150_000);

	it("restarts a crashed instance", async () => {
		const before = runtime.manager.target(bob.userId);
		process.kill(before?.pid ?? 0);
		const after = await waitFor(() => {
			const h = runtime.manager.target(bob.userId);
			return h && h.pid !== before?.pid ? h : undefined;
		}, 120_000, "崩溃后重启");
		expect(await direct(after.port, jwtFor(bob.userId))).toBe(404);
	}, 150_000);

	it("stops an idle instance after HUB_TENANT_IDLE_MINUTES", async () => {
		const handle = runtime.manager.target(bob.userId);
		clock.advance(31 * 60_000);
		const stopped = await runtime.manager.sweepIdle();
		expect(stopped).toContain(bob.userId);
		expect(runtime.manager.target(bob.userId)).toBeUndefined();
		await expect(fetch(`http://127.0.0.1:${handle?.port}/api/health`)).rejects.toThrow();
		// The data directory stays, and the next request starts it again.
		expect((await t.api("GET", "/rt/plugins/none", { token: bob.token })).status).toBe(404);
		expect(runtime.manager.target(bob.userId)).toBeDefined();
	}, 150_000);
});
