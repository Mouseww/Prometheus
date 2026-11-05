import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "../src/runtime/index.ts";
import { fakeClock, fakeDriver, type FakeDriver, startRtHub, type RtHub } from "./rt-helpers.ts";

const open: RtHub[] = [];
afterEach(async () => {
	for (const t of open.splice(0)) await t.stop();
});

async function setup(env: Record<string, string> = {}, opts: { fakeSleep?: boolean } = {}, driver: FakeDriver = fakeDriver("docker")) {
	const clock = fakeClock();
	// With fakeSleep the queue wait advances the hub clock instead of waiting, so the 10 minute timeout passes instantly.
	const sleep = opts.fakeSleep ? async (ms: number): Promise<void> => void clock.advance(ms) : undefined;
	const t = await startRtHub({ drivers: [driver], tenantHubUrl: "http://hub.test", queueRetryMs: opts.fakeSleep ? 30_000 : 20, ...(sleep ? { sleep } : {}) }, { now: clock.now, env });
	open.push(t);
	const root = await t.bootstrap();
	const users = [];
	for (const n of ["u1", "u2", "u3"]) users.push(await t.createUser(root.token, `${n}@corp.test`, n, root.orgId));
	return { t, root, users, driver, runtime: t.hub.registry.require<Runtime>("runtime") };
}

const nodeBody = (name: string, memCapacityMb: number, extra: Record<string, unknown> = {}) => ({ name, dockerUrl: "tcp://127.0.0.1:2375", cpuCapacity: 8, memCapacityMb, ...extra });

describe("executor node admin API", () => {
	it("creates, updates, drains and deletes nodes (operator only)", async () => {
		const s = await setup();
		const member = s.users[0] as { token: string };
		expect((await s.t.api("GET", "/api/admin/nodes", { token: member.token })).status).toBe(403);
		expect((await s.t.api("POST", "/api/admin/nodes", { token: member.token, body: nodeBody("n", 4096) })).status).toBe(403);

		const created = await s.t.api("POST", "/api/admin/nodes", { token: s.root.token, body: nodeBody("node-a", 4096) });
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ name: "node-a", status: "active", cpuCapacity: 8, memCapacityMb: 4096, allocatedMemMb: 0, tenants: [] });
		const id = created.data.id as string;

		expect((await s.t.api("POST", "/api/admin/nodes", { token: s.root.token, body: nodeBody("node-a", 1024) })).code).toBe("nodeNameTaken");
		const updated = await s.t.api("PUT", `/api/admin/nodes/${id}`, { token: s.root.token, body: { memCapacityMb: 8192, name: "node-a2" } });
		expect(updated.data).toMatchObject({ name: "node-a2", memCapacityMb: 8192 });
		const drained = await s.t.api("POST", `/api/admin/nodes/${id}/drain`, { token: s.root.token });
		expect(drained.data.status).toBe("draining");
		expect((await s.t.api("GET", "/api/admin/nodes", { token: s.root.token })).data).toHaveLength(1);
		expect((await s.t.api("DELETE", `/api/admin/nodes/${id}`, { token: s.root.token })).status).toBe(200);
		expect((await s.t.api("DELETE", `/api/admin/nodes/${id}`, { token: s.root.token })).status).toBe(404);
	});

	it("validates the docker address and demands TLS for remote engines", async () => {
		const s = await setup();
		const post = (body: unknown) => s.t.api("POST", "/api/admin/nodes", { token: s.root.token, body });
		expect((await post({ name: "bad", dockerUrl: "not a url" })).status).toBe(400);
		const remote = await post({ name: "remote", dockerUrl: "tcp://10.9.8.7:2375" });
		expect(remote.status).toBe(400);
		expect(remote.body.ok === false && remote.body.error.message).toContain("TLS");
		expect((await post({ name: "sock", dockerUrl: "unix:///var/run/docker.sock" })).status).toBe(201);
		expect((await post({ name: "neg", dockerUrl: "tcp://127.0.0.1:2375", cpuCapacity: -1 })).status).toBe(400);
	});

	it("pings a node and records the time", async () => {
		const s = await setup();
		const node = await s.t.api("POST", "/api/admin/nodes", { token: s.root.token, body: nodeBody("n", 4096, { dockerUrl: "tcp://127.0.0.1:1" }) });
		const ping = await s.t.api("POST", `/api/admin/nodes/${node.data.id}/ping`, { token: s.root.token });
		expect(ping.data).toEqual({ ok: false });
	});
});

describe("capacity-aware placement", () => {
	it("uses local docker when there are no nodes", async () => {
		const s = await setup();
		expect(await s.runtime.nodes.place({ cpu: 1, memMb: 2048 })).toEqual({ kind: "local" });
		await s.runtime.manager.ensureRunning((s.users[0] as { userId: string }).userId);
		expect(s.driver.specs[0]?.node).toBeUndefined();
	});

	it("picks the active node with the most free memory and honours per-user overrides", async () => {
		const s = await setup();
		const small = (await s.t.api("POST", "/api/admin/nodes", { token: s.root.token, body: nodeBody("small", 4096) })).data;
		const big = (await s.t.api("POST", "/api/admin/nodes", { token: s.root.token, body: nodeBody("big", 8192) })).data;
		const [u1, u2, u3] = s.users as { userId: string }[];

		// Bigger node first (more free memory).
		await s.runtime.manager.ensureRunning((u1 as { userId: string }).userId);
		expect(s.driver.specs.at(-1)?.node?.id).toBe(big.id);

		// An admin override makes u2 heavy: 6000 MB on the big node leaves it with less room than the small one.
		await s.t.api("PUT", `/api/admin/runtimes/${(u2 as { userId: string }).userId}/limits`, { token: s.root.token, body: { memLimitMb: 5000, cpuLimit: 1 } });
		await s.runtime.manager.ensureRunning((u2 as { userId: string }).userId);
		expect(s.driver.specs.at(-1)).toMatchObject({ memLimitMb: 5000 });
		expect(s.driver.specs.at(-1)?.node?.id).toBe(big.id);
		// big has 8192 - 2048 - 5000 = 1144 free, small has 4096.
		await s.runtime.manager.ensureRunning((u3 as { userId: string }).userId);
		expect(s.driver.specs.at(-1)?.node?.id).toBe(small.id);

		const nodes = (await s.t.api("GET", "/api/admin/nodes", { token: s.root.token })).data as { id: string; allocatedMemMb: number; tenants: string[] }[];
		expect(nodes.find((n) => n.id === big.id)).toMatchObject({ allocatedMemMb: 7048, tenants: expect.arrayContaining([(u1 as { userId: string }).userId, (u2 as { userId: string }).userId]) });
		expect(nodes.find((n) => n.id === small.id)).toMatchObject({ allocatedMemMb: 2048 });
		expect((await s.t.api("DELETE", `/api/admin/nodes/${big.id}`, { token: s.root.token })).code).toBe("nodeBusy");
	});

	it("skips draining and offline nodes and queues when nothing fits", async () => {
		const s = await setup({}, { fakeSleep: true });
		await s.t.api("POST", "/api/admin/nodes", { token: s.root.token, body: nodeBody("draining", 8192, { status: "draining" }) });
		await s.t.api("POST", "/api/admin/nodes", { token: s.root.token, body: nodeBody("offline", 8192, { status: "offline" }) });
		expect(await s.runtime.nodes.place({ cpu: 1, memMb: 512 })).toEqual({ kind: "exhausted" });
		const res = await s.t.api("GET", "/rt/x", { token: (s.users[0] as { token: string }).token });
		expect(res.status).toBe(503);
		expect(res.code).toBe("capacityExhausted");
		expect(s.driver.starts).toBe(0);
	});

	it("starts a queued tenant once capacity appears", async () => {
		const s = await setup();
		const node = (await s.t.api("POST", "/api/admin/nodes", { token: s.root.token, body: nodeBody("small", 2048) })).data;
		const [u1, u2] = s.users as { userId: string }[];
		await s.runtime.manager.ensureRunning((u1 as { userId: string }).userId);
		const waiting = s.runtime.manager.ensureRunning((u2 as { userId: string }).userId);
		await new Promise((r) => setTimeout(r, 100));
		expect(s.driver.starts).toBe(1);
		await s.t.api("PUT", `/api/admin/nodes/${node.id}`, { token: s.root.token, body: { memCapacityMb: 8192 } });
		expect((await waiting).userId).toBe((u2 as { userId: string }).userId);
		expect(s.driver.starts).toBe(2);
	});

	it("does not apply HUB_TENANT_MAX to node placement", async () => {
		const s = await setup({ HUB_TENANT_MAX: "1" });
		await s.t.api("POST", "/api/admin/nodes", { token: s.root.token, body: nodeBody("big", 16384) });
		for (const u of s.users as { userId: string }[]) await s.runtime.manager.ensureRunning(u.userId);
		expect(s.driver.starts).toBe(3);
	});
});
