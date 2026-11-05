import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type TenantCredentials } from "../src/auth/tenant-credentials.ts";
import { tenantScopeAllows } from "../src/http/tenant-scope.ts";
import { verifyJwt } from "../src/jwt.ts";
import type { Runtime } from "../src/runtime/index.ts";
import { createWsGateway, type WsGateway } from "../src/ws.ts";
import { fakeDriver, type FakeDriver, startRtHub, type RtHub, waitFor } from "./rt-helpers.ts";
import { connectWs, sleep } from "./s-helpers.ts";

interface Setup {
	t: RtHub;
	driver: FakeDriver;
	runtime: Runtime;
	creds: TenantCredentials;
	gateway: WsGateway;
	root: { token: string; userId: string; orgId: string };
	bob: { token: string; userId: string };
}

const open: RtHub[] = [];
const extra: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of extra.splice(0)) await stop();
	for (const t of open.splice(0)) await t.stop();
});

async function setup(): Promise<Setup> {
	const driver = fakeDriver();
	const t = await startRtHub({ drivers: [driver], tenantHubUrl: "http://hub.test" });
	open.push(t);
	const root = await t.bootstrap();
	const bob = await t.createUser(root.token, "bob@corp.test", "Bob", root.orgId);
	return {
		t,
		driver,
		runtime: t.hub.registry.require<Runtime>("runtime"),
		creds: t.hub.registry.require<TenantCredentials>("tenantCredentials"),
		gateway: t.hub.registry.require<WsGateway>("realtime"),
		root,
		bob,
	};
}

/** Exchanges a tenant credential for the scope=tenant access token a tenant instance really uses. */
async function exchange(s: Setup, credential: string): Promise<{ status: number; accessToken?: string }> {
	const r = await s.t.api("POST", "/api/auth/tenant-token", { token: credential });
	return { status: r.status, accessToken: r.status === 200 ? (r.data as { accessToken: string }).accessToken : undefined };
}

const wsClosed = (ws: import("ws").WebSocket): Promise<number> => new Promise((resolve) => ws.once("close", (code) => resolve(code)));

describe("tenant scope allowlist", () => {
	it("allows what a tenant needs and nothing else", () => {
		for (const [m, p] of [
			["GET", "/api/me"],
			["POST", "/api/workspaces/w1/sessions"],
			["PATCH", "/api/sessions/s1"],
			["POST", "/api/sessions/s1/events"],
			["PUT", "/api/sessions/s1/transcript"],
			["POST", "/api/sessions/s1/handoff"],
			["PATCH", "/api/sessions/s1/exec"],
			["POST", "/api/merge-requests/m1/refresh"],
		] as const) {
			expect(tenantScopeAllows(m, p), `${m} ${p}`).toBe(true);
		}
		for (const [m, p] of [
			["GET", "/api/admin/users"],
			["POST", "/api/admin/users"],
			["GET", "/api/billing/summary"],
			["POST", "/api/billing/checkout"],
			["POST", "/api/invitations"],
			["POST", "/api/teams"],
			["PUT", "/api/teams/t1/members"],
			["POST", "/api/orgs"],
			["GET", "/api/runtime"],
			["POST", "/api/runtime/start"],
			["POST", "/api/sessions/s1/grants"],
			["POST", "/api/merge-requests/m1/approve"],
			["POST", "/api/auth/login"],
			["GET", "/api/me/gateways"],
			["GET", "/api/workspaces/w1/reports"],
		] as const) {
			expect(tenantScopeAllows(m, p), `${m} ${p}`).toBe(false);
		}
	});
});

describe("tenant credentials", () => {
	it("trades a credential for a scope=tenant access token that only reaches the tenant allowlist", async () => {
		const s = await setup();
		const { token } = await s.creds.issue(s.bob.userId, "tenant", 3600);
		const ex = await exchange(s, token);
		expect(ex.status).toBe(200);
		const claims = verifyJwt(ex.accessToken as string, { publicKey: s.t.hub.publicKeyPem, issuer: s.t.hub.config.issuer, audience: "prometheus" });
		expect(claims).toMatchObject({ sub: s.bob.userId, scope: "tenant" });
		expect(claims?.jti).toBeTruthy();
		expect(claims?.cid).toBeTruthy();

		const at = ex.accessToken as string;
		expect((await s.t.api("GET", "/api/me", { token: at })).status).toBe(200);
		// Everything else, however harmless the caller's role: 403 tenantScope.
		for (const [method, path] of [
			["GET", "/api/admin/users"],
			["GET", "/api/billing/summary"],
			["GET", "/api/runtime"],
			["GET", "/api/teams"],
			["GET", "/api/me/gateways"],
		] as const) {
			const r = await s.t.api(method, path, { token: at });
			expect(r.status, `${method} ${path}`).toBe(403);
			expect(r.code).toBe("tenantScope");
		}
		// The workbench is never opened with it, and the model gateway refuses it.
		expect((await s.t.api("GET", "/rt/x", { token: at })).status).toBe(401);
		expect((await s.t.api("GET", "/llm/openai/v1/models", { token: at })).status).toBe(403);
		// A plain access token of the same user is unaffected.
		expect((await s.t.api("GET", "/api/me", { token: s.bob.token })).status).toBe(200);
	});

	it("gives the model gateway its own audience: accepted by /llm only", async () => {
		const s = await setup();
		const { token } = await s.creds.issue(s.bob.userId, "gateway", 3600);
		// Not an API token ...
		expect((await s.t.api("GET", "/api/me", { token })).status).toBe(401);
		// ... but /llm lets it through to gateway selection (there is no gateway in this hub).
		const r = await s.t.api("GET", "/llm/openai/v1/models", { token });
		expect(r.status).toBe(404);
		expect(r.code).toBe("noGateway");
		// A tenant credential is no gateway token.
		const cred = await s.creds.issue(s.bob.userId, "tenant", 3600);
		expect((await s.t.api("GET", "/llm/openai/v1/models", { token: cred.token })).status).toBe(401);
	});

	it("refuses legacy credentials without a recorded jti", async () => {
		const s = await setup();
		const legacy = s.t.hub.deps.signToken({ sub: s.bob.userId, aud: "prometheus-tenant", tenant: true, exp: Math.floor(Date.now() / 1000) + 600 });
		expect((await exchange(s, legacy)).status).toBe(401);
	});

	it("revokes the credentials of a user when the account is disabled", async () => {
		const s = await setup();
		const tenant = await s.creds.issue(s.bob.userId, "tenant", 3600);
		const gateway = await s.creds.issue(s.bob.userId, "gateway", 3600);
		const rows = (): Promise<{ jti: string; revoked_at: Date | null }[]> =>
			s.t.hub.db.query("SELECT jti, revoked_at FROM tenant_credentials WHERE user_id = $1", [s.bob.userId]);
		expect((await rows()).every((r) => r.revoked_at === null)).toBe(true);
		expect((await s.t.api("POST", `/api/admin/users/${s.bob.userId}/disable`, { token: s.root.token })).status).toBe(200);
		const after = await rows();
		expect(after.map((r) => r.jti).sort()).toEqual([tenant.jti, gateway.jti].sort());
		expect(after.every((r) => r.revoked_at !== null)).toBe(true);
	});

	it("stops accepting a scope=tenant access token on git smart HTTP once its credential is revoked", async () => {
		const s = await setup();
		const { token } = await s.creds.issue(s.bob.userId, "tenant", 3600);
		const at = (await exchange(s, token)).accessToken as string;
		const probe = "/git/nosuchworkspace.git/info/refs?service=git-upload-pack";
		// Credential live: authentication passes and the unknown repository answers 404.
		expect((await s.t.api("GET", probe, { token: at })).status).toBe(404);
		expect(await s.creds.revokeUser(s.bob.userId, "tenant")).toBeGreaterThan(0);
		expect((await s.t.api("GET", probe, { token: at })).status).toBe(401);
		// A plain access token is not tied to a credential.
		expect((await s.t.api("GET", probe, { token: s.bob.token })).status).toBe(404);
	});

	it("revokes everything when the runtime stops and when a new credential is issued", async () => {
		const s = await setup();
		await s.runtime.manager.ensureRunning(s.bob.userId);
		const first = s.driver.specs.at(-1)?.env.TEAM_TENANT_TOKEN as string;
		const firstAccess = (await exchange(s, first)).accessToken as string;
		expect((await s.t.api("GET", "/api/me", { token: firstAccess })).status).toBe(200);

		await s.runtime.manager.stop(s.bob.userId);
		expect((await exchange(s, first)).status).toBe(401);
		expect((await s.t.api("GET", "/api/me", { token: firstAccess })).status).toBe(401);

		// A restart issues new credentials; the old ones stay dead.
		await s.runtime.manager.ensureRunning(s.bob.userId);
		const second = s.driver.specs.at(-1)?.env.TEAM_TENANT_TOKEN as string;
		expect(second).not.toBe(first);
		expect((await exchange(s, first)).status).toBe(401);
		expect((await exchange(s, second)).status).toBe(200);

		// A new credential for the same user replaces the previous one.
		await s.creds.revokeUser(s.bob.userId);
		const fresh = await s.creds.issue(s.bob.userId, "tenant", 3600);
		expect((await exchange(s, second)).status).toBe(401);
		expect((await exchange(s, fresh.token)).status).toBe(200);
	});

	it("stops working at once for a disabled account", async () => {
		const s = await setup();
		const { token } = await s.creds.issue(s.bob.userId, "tenant", 3600);
		const at = (await exchange(s, token)).accessToken as string;
		await s.t.hub.db.query("UPDATE users SET status = 'disabled' WHERE id = $1", [s.bob.userId]);
		expect((await exchange(s, token)).status).toBe(401);
		expect((await s.t.api("GET", "/api/me", { token: at })).status).toBe(401);
		expect(await s.creds.verify(token, "tenant")).toBeUndefined();
	});
});

describe("websocket revalidation", () => {
	it("closes a tenant connection whose credential was revoked, and a local one whose account was disabled", async () => {
		const s = await setup();
		const cred = await s.creds.issue(s.bob.userId, "tenant", 3600);
		const tenant = await connectWs(s.t.baseUrl, cred.token);
		const local = await connectWs(s.t.baseUrl, s.bob.token);
		expect(await s.gateway.revalidate()).toBe(0);
		expect(s.gateway.connectionCount(s.bob.userId)).toBe(2);

		const tenantClosed = wsClosed(tenant.ws);
		await s.creds.revokeUser(s.bob.userId);
		expect(await s.gateway.revalidate()).toBe(1);
		expect(await tenantClosed).toBe(4401);
		expect(s.gateway.connectionCount(s.bob.userId, "local")).toBe(1);

		const localClosed = wsClosed(local.ws);
		await s.t.hub.db.query("UPDATE users SET status = 'disabled' WHERE id = $1", [s.bob.userId]);
		expect(await s.gateway.revalidate()).toBe(1);
		expect(await localClosed).toBe(4401);
		expect(s.gateway.connectionCount(s.bob.userId)).toBe(0);
	});

	it("disconnectUser closes the user's connections, optionally one kind", async () => {
		const s = await setup();
		const cred = await s.creds.issue(s.bob.userId, "tenant", 3600);
		const tenant = await connectWs(s.t.baseUrl, cred.token);
		const local = await connectWs(s.t.baseUrl, s.bob.token);
		const tenantClosed = wsClosed(tenant.ws);
		expect(s.gateway.disconnectUser(s.bob.userId, "tenant")).toBe(1);
		expect(await tenantClosed).toBe(4401);
		expect(s.gateway.connectionCount(s.bob.userId, "local")).toBe(1);
		const localClosed = wsClosed(local.ws);
		expect(s.gateway.disconnectUser(s.bob.userId)).toBe(1);
		expect(await localClosed).toBe(4401);
	});

	it("a stopped runtime drops its tenant connection immediately", async () => {
		const s = await setup();
		await s.runtime.manager.ensureRunning(s.bob.userId);
		const credential = s.driver.specs.at(-1)?.env.TEAM_TENANT_TOKEN as string;
		const tenant = await connectWs(s.t.baseUrl, credential);
		const closed = wsClosed(tenant.ws);
		await s.runtime.manager.stop(s.bob.userId);
		expect(await closed).toBe(4401);
	});

	it("re-checks the subscriber's ACL on publish when the cached check is stale", async () => {
		const s = await setup();
		// A second gateway with a zero ACL TTL on its own socket server: every publish asks `canSubscribe` again.
		const gw = createWsGateway(s.t.hub.deps, { aclTtlMs: 0, revalidateMs: 3_600_000 });
		let allowed = true;
		gw.setHandlers({ canSubscribe: async () => allowed, onOnline: async () => 0, ownersWithLiveSessions: async () => [], markOwnerOffline: async () => 0 });
		const server: Server = createServer();
		server.on("upgrade", (req, socket, head) => void (gw.handleUpgrade(req, socket, head) || socket.destroy()));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		extra.push(async () => {
			await gw.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

		const client = await connectWs(base, s.bob.token);
		expect((await client.subscribe("workspace:w1")).type).toBe("subscribed");
		gw.publish("workspace:w1", { n: 1 });
		expect((await client.waitFor((f) => f.type === "event")).data).toEqual({ n: 1 });

		allowed = false;
		gw.publish("workspace:w1", { n: 2 });
		expect((await client.waitFor((f) => f.type === "error" && f.topic === "workspace:w1")).code).toBe("forbidden");
		// The subscription is gone: later events are not delivered, even once access would be granted again.
		allowed = true;
		gw.publish("workspace:w1", { n: 3 });
		await sleep(150);
		expect(client.frames.filter((f) => f.type === "event")).toHaveLength(1);
		await client.close();
		await waitFor(() => (gw.connectionCount() === 0 ? true : undefined));
	});
});
