import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantCredentials } from "../src/auth/tenant-credentials.ts";
import { HandRouter, type HandPeer } from "../src/services/hands.ts";
import type { WsGateway } from "../src/ws.ts";
import { type Collab, connectWs, sleep, startCollab, type WsClient, wsUrl } from "./s-helpers.ts";

let c: Collab;
let gateway: WsGateway;
beforeAll(async () => {
	c = await startCollab();
	gateway = c.t.hub.registry.require<WsGateway>("realtime");
});
afterAll(async () => {
	await c.stop();
});

/** A live, revocable tenant credential, issued the way the runtime manager issues it. */
const tenantToken = async (userId: string): Promise<string> => (await c.t.hub.registry.require<TenantCredentials>("tenantCredentials").issue(userId, "tenant", 3600)).token;

const connectTenant = async (userId: string): Promise<WsClient> => connectWs(c.t.baseUrl, await tenantToken(userId));

const call = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "hand.call", callId: "c1", fromSession: "s1", tool: "local_read", input: { path: "a.txt" }, target: "local", ...over });

describe("connection kinds", () => {
	it("accepts a tenant credential on /ws and marks the connection as tenant", async () => {
		const tenant = await connectTenant(c.alice.userId);
		// connectWs consumes the greeting but keeps it in `frames`.
		expect(tenant.frames.find((f) => f.type === "ready")?.kind).toBe("tenant");
		const local = await connectWs(c.t.baseUrl, c.alice.token);
		expect(local.frames.find((f) => f.type === "ready")?.kind).toBe("local");
		expect(gateway.connectionCount(c.alice.userId, "tenant")).toBe(1);
		expect(gateway.connectionCount(c.alice.userId, "local")).toBe(1);
		await tenant.close();
		await local.close();
	});

	it("rejects a tenant credential without the tenant claim and a user token posing as tenant", async () => {
		const plain = c.t.hub.deps.signToken({ sub: c.alice.userId, aud: "prometheus-tenant", exp: Math.floor(Date.now() / 1000) + 3600 });
		await expect(connectWs(c.t.baseUrl, plain)).rejects.toThrow(/401/);
		const posing = new WebSocket(`${wsUrl(c.t.baseUrl, c.alice.token)}&kind=tenant`);
		await expect(new Promise((resolve, reject) => (posing.once("open", resolve), posing.once("unexpected-response", (_r, res) => reject(new Error(String(res.statusCode)))), posing.once("error", reject)))).rejects.toThrow(/401/);
	});
});

describe("hand.call routing", () => {
	it("round-trips a call from the local server to the tenant and back", async () => {
		const local = await connectWs(c.t.baseUrl, c.alice.token);
		const tenant = await connectTenant(c.alice.userId);
		local.send(call({ target: "team", tool: "team_read", callId: "r1" }));
		const delivered = await tenant.waitFor((f) => f.type === "hand.call");
		expect(delivered).toMatchObject({ callId: "r1", tool: "team_read", fromSession: "s1", input: { path: "a.txt" }, target: "team" });
		tenant.send({ type: "hand.result", callId: "r1", ok: true, output: "file body" });
		expect(await local.waitFor((f) => f.type === "hand.result")).toMatchObject({ callId: "r1", ok: true, output: "file body" });

		tenant.send(call({ target: "local", callId: "r2", tool: "local_ls" }));
		const back = await local.waitFor((f) => f.type === "hand.call");
		expect(back).toMatchObject({ callId: "r2", tool: "local_ls" });
		local.send({ type: "hand.result", callId: "r2", ok: false, error: "用户拒绝", code: "denied" });
		expect(await tenant.waitFor((f) => f.type === "hand.result")).toMatchObject({ callId: "r2", ok: false, error: "用户拒绝", code: "denied" });
		await local.close();
		await tenant.close();
	});

	it("answers handOffline at once when the target side is not connected", async () => {
		const local = await connectWs(c.t.baseUrl, c.alice.token);
		local.send(call({ target: "team", callId: "off1" }));
		expect(await local.waitFor((f) => f.type === "hand.result")).toMatchObject({ callId: "off1", ok: false, code: "handOffline" });
		await local.close();
		const tenant = await connectTenant(c.alice.userId);
		tenant.send(call({ target: "local", callId: "off2" }));
		expect(await tenant.waitFor((f) => f.type === "hand.result")).toMatchObject({ callId: "off2", ok: false, code: "handOffline" });
		await tenant.close();
	});

	it("never delivers across users and refuses a foreign targetUserId", async () => {
		const aliceLocal = await connectWs(c.t.baseUrl, c.alice.token);
		const bobTenant = await connectTenant(c.bob.userId);
		aliceLocal.send(call({ target: "team", callId: "x1" }));
		expect(await aliceLocal.waitFor((f) => f.type === "hand.result")).toMatchObject({ callId: "x1", code: "handOffline" });
		await sleep(30);
		expect(bobTenant.frames.some((f) => f.type === "hand.call")).toBe(false);

		const aliceTenant = await connectTenant(c.alice.userId);
		aliceLocal.send(call({ target: "team", callId: "x2", targetUserId: c.bob.userId }));
		expect(await aliceLocal.waitFor((f) => f.type === "hand.result" && f.callId === "x2")).toMatchObject({ ok: false, code: "handForbidden" });
		await sleep(30);
		expect(bobTenant.frames.some((f) => f.type === "hand.call")).toBe(false);
		expect(aliceTenant.frames.some((f) => f.type === "hand.call")).toBe(false);

		// Bob cannot answer Alice's call either.
		aliceLocal.send(call({ target: "team", callId: "x3" }));
		await aliceTenant.waitFor((f) => f.type === "hand.call" && f.callId === "x3");
		bobTenant.send({ type: "hand.result", callId: "x3", ok: true, output: "forged" });
		await sleep(30);
		expect(aliceLocal.frames.some((f) => f.type === "hand.result" && f.callId === "x3")).toBe(false);
		aliceTenant.send({ type: "hand.result", callId: "x3", ok: true, output: "real" });
		expect(await aliceLocal.waitFor((f) => f.type === "hand.result" && f.callId === "x3")).toMatchObject({ output: "real" });
		await aliceLocal.close();
		await aliceTenant.close();
		await bobTenant.close();
	});

	it("refuses a call aimed at the caller's own side and malformed calls", async () => {
		const local = await connectWs(c.t.baseUrl, c.alice.token);
		local.send(call({ target: "local", callId: "same" }));
		expect(await local.waitFor((f) => f.type === "hand.result")).toMatchObject({ callId: "same", code: "handTarget" });
		local.send(call({ target: "moon", callId: "bad1" }));
		expect(await local.waitFor((f) => f.type === "hand.result" && f.callId === "bad1")).toMatchObject({ code: "invalidMessage" });
		local.send(call({ tool: "../x", callId: "bad2" }));
		expect(await local.waitFor((f) => f.type === "hand.result" && f.callId === "bad2")).toMatchObject({ code: "invalidMessage" });
		local.send({ type: "hand.call", target: "team" });
		expect((await local.waitFor((f) => f.type === "error")).code).toBe("invalidMessage");
		await local.close();
	});

	it("fails an in-flight call when the target disconnects", async () => {
		const local = await connectWs(c.t.baseUrl, c.alice.token);
		const tenant = await connectTenant(c.alice.userId);
		local.send(call({ target: "team", callId: "drop1" }));
		await tenant.waitFor((f) => f.type === "hand.call");
		await tenant.close();
		expect(await local.waitFor((f) => f.type === "hand.result")).toMatchObject({ callId: "drop1", ok: false, code: "handOffline" });
		await local.close();
	});
});

describe("snapshot messages", () => {
	const commit = "b".repeat(40);

	it("broadcasts snapshot.updated and snapshot.applied to the user's other connections only", async () => {
		const local = await connectWs(c.t.baseUrl, c.alice.token);
		const tenant = await connectTenant(c.alice.userId);
		const bob = await connectWs(c.t.baseUrl, c.bob.token);
		local.send({ type: "snapshot.updated", hubSessionId: "S1", side: "local", commit });
		expect(await tenant.waitFor((f) => f.type === "snapshot.updated")).toMatchObject({ hubSessionId: "S1", side: "local", commit });
		tenant.send({ type: "snapshot.applied", hubSessionId: "S1", side: "team", commit, conflictRef: "refs/x/conflict-1" });
		expect(await local.waitFor((f) => f.type === "snapshot.applied")).toMatchObject({ hubSessionId: "S1", side: "team", commit, conflictRef: "refs/x/conflict-1" });
		await sleep(30);
		expect(bob.frames.some((f) => f.type?.startsWith("snapshot."))).toBe(false);
		expect(local.frames.some((f) => f.type === "snapshot.updated")).toBe(false);
		local.send({ type: "snapshot.updated", hubSessionId: "S1", side: "local", commit: "nothex" });
		expect((await local.waitFor((f) => f.type === "error")).code).toBe("invalidMessage");
		await local.close();
		await tenant.close();
		await bob.close();
	});
});

describe("commands", () => {
	it("sends a command to one kind and resolves with its cmdResult", async () => {
		const tenant = await connectTenant(c.alice.userId);
		const pending = gateway.command(c.alice.userId, "tenant", "handoff.import", { x: 1 });
		const frame = await tenant.waitFor((f) => f.type === "cmd");
		expect(frame).toMatchObject({ cmd: "handoff.import", params: { x: 1 } });
		tenant.send({ type: "cmdResult", cmdId: frame.cmdId, ok: true, data: { sessionId: "t1" } });
		expect(await pending).toEqual({ kind: "ok", data: { sessionId: "t1" } });
		expect(await gateway.command(c.alice.userId, "local", "x", {})).toEqual({ kind: "offline" });
		const failing = gateway.command(c.alice.userId, "tenant", "x", {});
		const f2 = await tenant.waitFor((f) => f.type === "cmd");
		tenant.send({ type: "cmdResult", cmdId: f2.cmdId, ok: false, error: "boom", code: "agentBusy" });
		expect(await failing).toEqual({ kind: "failed", error: "boom", code: "agentBusy" });
		const slow = gateway.command(c.alice.userId, "tenant", "x", {}, 40);
		expect(await slow).toEqual({ kind: "timeout" });
		await tenant.close();
	});
});

describe("HandRouter wake", () => {
	it("starts the tenant for a team-targeted call and delivers once it connects", async () => {
		const sent: unknown[] = [];
		const tenantPeers: HandPeer[] = [];
		const tenant: HandPeer = { userId: "u1", kind: "tenant", send: (f) => void sent.push(f) };
		const origin: HandPeer = { userId: "u1", kind: "local", send: (f) => void sent.push({ to: "origin", f }) };
		const router = new HandRouter({
			peers: (_u, kind) => (kind === "tenant" ? tenantPeers : []),
			log: { info() {}, warn() {}, error() {} },
			wake: async () => void setTimeout(() => tenantPeers.push(tenant), 30),
			wakeWaitMs: 1000,
		});
		await router.call(origin, call({ target: "team" }));
		expect(sent[0]).toMatchObject({ type: "hand.call", tool: "local_read" });
		router.dispose();
	});

	it("reports handOffline when waking fails", async () => {
		const sent: unknown[] = [];
		const origin: HandPeer = { userId: "u1", kind: "local", send: (f) => void sent.push(f) };
		const router = new HandRouter({ peers: () => [], log: { info() {}, warn() {}, error() {} }, wake: async () => Promise.reject(new Error("no docker")) });
		await router.call(origin, call({ target: "team" }));
		expect(sent[0]).toMatchObject({ type: "hand.result", ok: false, code: "handOffline" });
	});
});
