import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { verifyJwt } from "../src/jwt.ts";
import type { Runtime } from "../src/runtime/index.ts";
import { fakeClock, fakeDriver, type FakeDriver, sleepReal, startRtHub, type RtHub, waitFor } from "./rt-helpers.ts";

const decode = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split(".")[1] as string, "base64url").toString("utf8"));
const bearer = (value: unknown): string => String(value).replace(/^Bearer /, "");

interface Setup {
	t: RtHub;
	driver: FakeDriver;
	runtime: Runtime;
	root: { token: string; userId: string; orgId: string };
	bob: { token: string; userId: string };
	clock: ReturnType<typeof fakeClock>;
}

const open: RtHub[] = [];
afterEach(async () => {
	for (const t of open.splice(0)) await t.stop();
});

async function setup(env: Record<string, string> = {}, overrides: Parameters<typeof startRtHub>[0] = {}, driver: FakeDriver = fakeDriver()): Promise<Setup> {
	const clock = fakeClock();
	const t = await startRtHub({ drivers: [driver], tenantHubUrl: "http://hub.test", ...overrides }, { now: clock.now, env });
	open.push(t);
	const root = await t.bootstrap();
	const bob = await t.createUser(root.token, "bob@corp.test", "Bob", root.orgId);
	return { t, driver, runtime: t.hub.registry.require<Runtime>("runtime"), root, bob, clock };
}

describe("reverse proxy /rt", () => {
	it("refuses callers without a valid Hub token", async () => {
		const s = await setup();
		expect((await s.t.api("GET", "/rt/anything")).status).toBe(401);
		expect((await s.t.api("GET", "/rt/anything", { token: "garbage" })).status).toBe(401);
		expect(s.driver.starts).toBe(0);
	});

	it("starts the tenant on demand and swaps the credentials for a fresh per-user JWT", async () => {
		const s = await setup();
		const res = await fetch(`${s.t.baseUrl}/rt/hello%20world?x=1&token=ignored-when-header-present`, {
			method: "POST",
			headers: { authorization: `Bearer ${s.bob.token}`, cookie: "prometheus_hub_rt=abc; other=1", origin: "http://evil.example", "x-forwarded-for": "1.2.3.4", "content-type": "text/plain" },
			body: "payload",
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toBeNull();
		const echo = (await res.json()) as { method: string; url: string; headers: Record<string, string>; body: string };
		expect(echo.method).toBe("POST");
		expect(echo.url).toBe("/hello%20world?x=1");
		expect(echo.body).toBe("payload");
		const sent = bearer(echo.headers.authorization);
		expect(sent).not.toBe(s.bob.token);
		const claims = verifyJwt(sent, { publicKey: s.t.hub.publicKeyPem, issuer: s.t.hub.config.issuer, audience: "prometheus" });
		expect(claims?.sub).toBe(s.bob.userId);
		expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(15 * 60);
		expect(echo.headers.cookie).toBeUndefined();
		expect(echo.headers["x-forwarded-for"]).toBeUndefined();
		expect(echo.headers.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(echo.headers.host).toMatch(/^127\.0\.0\.1:\d+$/);
		expect(s.driver.starts).toBe(1);
	});

	it("turns ?token= into a cookie and redirects without it", async () => {
		const s = await setup();
		const first = await fetch(`${s.t.baseUrl}/rt/app?token=${s.bob.token}&keep=1`, { redirect: "manual" });
		expect(first.status).toBe(302);
		expect(first.headers.get("location")).toBe("/rt/app?keep=1");
		const cookie = first.headers.get("set-cookie") ?? "";
		expect(cookie).toMatch(/^prometheus_hub_rt=/);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Path=/rt");
		expect(s.driver.starts).toBe(0);
		const next = await fetch(`${s.t.baseUrl}/rt/app?keep=1`, { headers: { cookie: cookie.split(";")[0] as string } });
		expect(next.status).toBe(200);
		const echo = (await next.json()) as { headers: Record<string, string> };
		expect(echo.headers.cookie).toBeUndefined();
		expect(decode(bearer(echo.headers.authorization)).sub).toBe(s.bob.userId);
	});

	it("sets the cookie on a header-authenticated GET and rewrites tenant redirects", async () => {
		const s = await setup();
		const res = await fetch(`${s.t.baseUrl}/rt/redirect`, { headers: { authorization: `Bearer ${s.bob.token}` }, redirect: "manual" });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/rt/landing");
		expect(res.headers.get("set-cookie")).toMatch(/^prometheus_hub_rt=/);
	});

	it("only ever reaches the caller's own tenant", async () => {
		const s = await setup();
		const a = (await (await fetch(`${s.t.baseUrl}/rt/who`, { headers: { authorization: `Bearer ${s.root.token}` } })).json()) as { headers: Record<string, string> };
		const b = (await (await fetch(`${s.t.baseUrl}/rt/who`, { headers: { authorization: `Bearer ${s.bob.token}`, "x-user-id": s.root.userId } })).json()) as { headers: Record<string, string> };
		expect(decode(bearer(a.headers.authorization)).sub).toBe(s.root.userId);
		expect(decode(bearer(b.headers.authorization)).sub).toBe(s.bob.userId);
		expect(s.driver.tenants.size).toBe(2);
		const rootTenant = s.driver.tenants.get(s.root.userId);
		const bobTenant = s.driver.tenants.get(s.bob.userId);
		expect(rootTenant?.seen.filter((r) => r.url === "/who")).toHaveLength(1);
		expect(bobTenant?.seen.filter((r) => r.url === "/who")).toHaveLength(1);
		expect(decode(bearer(bobTenant?.seen.find((r) => r.url === "/who")?.headers.authorization))).toMatchObject({ sub: s.bob.userId });
	});

	it("rejects a disabled account at once", async () => {
		const s = await setup();
		await s.t.api("POST", `/api/admin/users/${s.bob.userId}/disable`, { token: s.root.token });
		expect((await s.t.api("GET", "/rt/x", { token: s.bob.token })).status).toBe(401);
	});

	it("proxies WebSockets with the replaced credential and rejects anonymous upgrades", async () => {
		const s = await setup();
		const ws = new WebSocket(s.t.upgradeUrl(`/rt/socket?token=${s.bob.token}`));
		const first = await new Promise<string>((resolve, reject) => {
			ws.once("message", (d) => resolve(d.toString()));
			ws.once("error", reject);
		});
		expect(decode(bearer((JSON.parse(first) as { hello: string }).hello)).sub).toBe(s.bob.userId);
		const echoed = new Promise<string>((resolve) => ws.once("message", (d) => resolve(d.toString())));
		ws.send("ping-from-client");
		expect(await echoed).toBe("ping-from-client");
		const upgrade = s.driver.tenants.get(s.bob.userId)?.seen.find((r) => r.method === "UPGRADE");
		expect(upgrade?.url).toBe("/socket");
		ws.close();

		const anon = new WebSocket(s.t.upgradeUrl("/rt/socket"));
		const err = await new Promise<Error>((resolve) => anon.once("error", resolve));
		expect(err.message).toContain("401");
	});
});

describe("tenant files and environment", () => {
	it("writes the policy and gives the tenant the spec 3.1 environment", async () => {
		const s = await setup();
		await s.t.api("POST", "/api/admin/gateways", { token: s.root.token, body: { scope: "platform", name: "gw", format: "openai", baseUrl: "https://llm.example/v1", apiKey: "sk-secret", models: ["gpt-x"] } });
		await s.runtime.manager.ensureRunning(s.bob.userId);
		const spec = s.driver.specs[0];
		expect(spec?.userId).toBe(s.bob.userId);
		const env = spec?.env ?? {};
		expect(env.PROMETHEUS_HOST).toBe("127.0.0.1");
		expect(env.PROMETHEUS_TOKEN).toMatch(/^[0-9a-f]{48}$/);
		expect(env.PROMETHEUS_TRUST_AUDIENCE).toBe("prometheus");
		expect(env.PROMETHEUS_TRUST_ISSUER).toBe(s.t.hub.config.issuer);
		expect(env.TEAM_HUB_URL).toBe("http://hub.test");
		expect(env.PROMETHEUS_HOME).toBe(join(spec?.root ?? "", "data"));
		expect(env.PROMETHEUS_CWD).toBe(join(spec?.root ?? "", "work"));
		expect(env.PROMETHEUS_TRUST_KEY?.startsWith("@")).toBe(true);
		expect((await readFile((env.PROMETHEUS_TRUST_KEY as string).slice(1), "utf8")).trim()).toBe(s.t.hub.publicKeyPem.trim());
		const tenantToken = verifyJwt(env.TEAM_TENANT_TOKEN as string, { publicKey: s.t.hub.publicKeyPem, issuer: s.t.hub.config.issuer, audience: "prometheus-tenant" });
		expect(tenantToken).toMatchObject({ sub: s.bob.userId, tenant: true });

		const policy = JSON.parse(await readFile(env.PROMETHEUS_POLICY as string, "utf8")) as Record<string, any>;
		expect(policy).toMatchObject({ serverOwner: s.bob.userId, forbiddenModes: ["bypassPermissions", "auto"], readOutsideProject: "deny" });
		expect(policy.managedBy).toContain("prometheus-hub");
		expect(policy.pluginAllowlist).toContain("team");
		expect(policy.pluginAllowlist).not.toContain("computer-use");
		expect(policy.pluginAllowlist).not.toContain("ssh");
		expect(policy.pluginAllowlist).not.toContain("browser");
		// bob is not the hub owner and the driver is "restricted": no terminal plugin.
		expect(policy.pluginAllowlist).not.toContain("terminal");
		expect(policy.gateways).toHaveLength(1);
		expect(policy.gateways[0]).toMatchObject({ id: "hub-openai", format: "openai-completions", baseUrl: "http://hub.test/llm/openai", models: [{ id: "gpt-x", name: "gpt-x" }] });
		// The model gateway token has its own audience: it is no API access token (the dispatcher refuses it) and the LLM proxy takes it.
		expect(verifyJwt(policy.gateways[0].apiKey, { publicKey: s.t.hub.publicKeyPem, audience: "prometheus" })).toBeUndefined();
		const gwToken = verifyJwt(policy.gateways[0].apiKey, { publicKey: s.t.hub.publicKeyPem, audience: "prometheus-llm" });
		expect(gwToken?.sub).toBe(s.bob.userId);
		expect(gwToken?.jti).toBeTruthy();
		expect(tenantToken?.jti).toBeTruthy();
		// A restricted tenant has no OS boundary: nothing that spawns arbitrary commands.
		expect(policy.pluginAllowlist).not.toContain("mcp");
		if (process.platform !== "win32") {
			expect((await stat(env.PROMETHEUS_POLICY as string)).mode & 0o777).toBe(0o600);
		}
		expect(JSON.stringify(policy)).not.toContain("sk-secret");
	});

	it("gives the hub owner the normal policy even in restricted mode", async () => {
		const s = await setup({}, { supportsDisabledTools: true });
		await s.runtime.manager.ensureRunning(s.root.userId);
		await s.runtime.manager.ensureRunning(s.bob.userId);
		const read = async (userId: string): Promise<Record<string, any>> => {
			const spec = s.driver.specs.find((x) => x.userId === userId);
			return JSON.parse(await readFile(spec?.env.PROMETHEUS_POLICY as string, "utf8")) as Record<string, any>;
		};
		const owner = await read(s.root.userId);
		expect(owner.pluginAllowlist).toContain("terminal");
		expect(owner.disabledTools).toBeUndefined();
		const member = await read(s.bob.userId);
		expect(member.pluginAllowlist).not.toContain("terminal");
		expect(member.disabledTools).toEqual(["bash", "powershell"]);
	});

	it("omits disabledTools when core does not support it yet", async () => {
		const s = await setup({}, { supportsDisabledTools: false });
		await s.runtime.manager.ensureRunning(s.bob.userId);
		const policy = JSON.parse(await readFile(s.driver.specs[0]?.env.PROMETHEUS_POLICY as string, "utf8")) as Record<string, unknown>;
		expect("disabledTools" in policy).toBe(false);
	});
});

describe("lifecycle", () => {
	it("stops an idle tenant, but not while a WebSocket is open", async () => {
		const s = await setup({ HUB_TENANT_IDLE_MINUTES: "30" });
		const ws = new WebSocket(s.t.upgradeUrl(`/rt/socket?token=${s.bob.token}`));
		await new Promise<void>((resolve, reject) => {
			ws.once("message", () => resolve());
			ws.once("error", reject);
		});
		s.clock.advance(31 * 60_000);
		expect(await s.runtime.manager.sweepIdle()).toEqual([]);
		ws.close();
		await waitFor(async () => {
			const list = await s.t.api("GET", "/api/admin/runtimes", { token: s.root.token });
			return list.data.items.find((r: any) => r.userId === s.bob.userId)?.activeConnections === 0 ? true : undefined;
		}, 5000, "连接释放");
		s.clock.advance(31 * 60_000);
		expect(await s.runtime.manager.sweepIdle()).toEqual([s.bob.userId]);
		expect(s.runtime.manager.target(s.bob.userId)).toBeUndefined();
		expect(s.driver.tenants.size).toBe(0);
		const list = await s.t.api("GET", "/api/admin/runtimes", { token: s.root.token });
		expect(list.data.items.find((r: any) => r.userId === s.bob.userId)).toMatchObject({ status: "stopped", port: null });
		// A later request starts it again.
		expect((await s.t.api("GET", "/rt/again", { token: s.bob.token })).status).toBe(200);
		expect(s.driver.starts).toBe(2);
	});

	it("does not stop a tenant that was used recently", async () => {
		const s = await setup({ HUB_TENANT_IDLE_MINUTES: "30" });
		await s.t.api("GET", "/rt/a", { token: s.bob.token });
		s.clock.advance(20 * 60_000);
		await s.t.api("GET", "/rt/b", { token: s.bob.token });
		s.clock.advance(20 * 60_000);
		expect(await s.runtime.manager.sweepIdle()).toEqual([]);
	});

	it("restarts a crashed tenant and gives up after 3 crashes in 10 minutes", async () => {
		const s = await setup();
		await s.runtime.manager.ensureRunning(s.bob.userId);
		for (let i = 1; i <= 3; i++) {
			await s.driver.crash(s.bob.userId);
			await waitFor(() => (s.driver.starts === i + 1 && s.runtime.manager.target(s.bob.userId) ? true : undefined), 15_000, `第 ${i} 次重启`);
		}
		await s.driver.crash(s.bob.userId);
		await waitFor(async () => {
			const rows = await s.t.hub.db.query<{ status: string }>("SELECT status FROM tenant_runtimes WHERE user_id = $1", [s.bob.userId]);
			return rows[0]?.status === "failed" ? true : undefined;
		}, 15_000, "标记 failed");
		expect(s.driver.starts).toBe(4);
		expect(s.runtime.manager.target(s.bob.userId)).toBeUndefined();
		const notes = await s.t.hub.db.query<{ kind: string }>("SELECT kind FROM notifications WHERE user_id = $1", [s.bob.userId]);
		expect(notes.map((n) => n.kind)).toContain("tenant.failed");
		// An explicit request tries again with a fresh budget.
		expect((await s.t.api("GET", "/rt/retry", { token: s.bob.token })).status).toBe(200);
	});

	it("restarts after failed health checks", async () => {
		const s = await setup();
		await s.runtime.manager.ensureRunning(s.bob.userId);
		// Silently kill the fake tenant's server without telling the driver.
		await s.driver.tenants.get(s.bob.userId)?.close();
		await s.runtime.manager.sweepHealth();
		await s.runtime.manager.sweepHealth();
		await waitFor(() => (s.driver.starts === 2 && s.runtime.manager.target(s.bob.userId) ? true : undefined), 15_000, "健康检查重启");
	});

	it("reports start failures with a 502 and a stored error", async () => {
		const driver = fakeDriver();
		driver.failStarts = true;
		const s = await setup({}, {}, driver);
		const res = await s.t.api("GET", "/rt/x", { token: s.bob.token });
		expect(res.status).toBe(502);
		const rows = await s.t.hub.db.query<{ status: string; last_error: string }>("SELECT status, last_error FROM tenant_runtimes WHERE user_id = $1", [s.bob.userId]);
		expect(rows[0]?.status).toBe("failed");
		expect(rows[0]?.last_error).toContain("fake start failure");
	});

	it("queues beyond HUB_TENANT_MAX and starts the waiter when a slot frees", async () => {
		const s = await setup({ HUB_TENANT_MAX: "1" }, { queueRetryMs: 20 });
		await s.runtime.manager.ensureRunning(s.root.userId);
		const waiting = s.runtime.manager.ensureRunning(s.bob.userId);
		await sleepReal(150);
		expect(s.driver.starts).toBe(1);
		await s.runtime.manager.stop(s.root.userId);
		const handle = await waiting;
		expect(handle.userId).toBe(s.bob.userId);
		expect(s.driver.starts).toBe(2);
	});

	it("answers capacityExhausted after the queue timeout", async () => {
		const clock = fakeClock();
		const driver = fakeDriver();
		const t = await startRtHub({ drivers: [driver], sleep: async (ms) => clock.advance(ms) }, { now: clock.now, env: { HUB_TENANT_MAX: "1" } });
		open.push(t);
		const root = await t.bootstrap();
		const bob = await t.createUser(root.token, "bob@corp.test", "Bob", root.orgId);
		const runtime = t.hub.registry.require<Runtime>("runtime");
		await runtime.manager.ensureRunning(root.userId);
		const res = await t.api("GET", "/rt/x", { token: bob.token });
		expect(res.status).toBe(503);
		expect(res.code).toBe("capacityExhausted");
		expect(res.headers.get("retry-after")).toBe("30");
	});

	it("shares one start between concurrent requests", async () => {
		const s = await setup();
		const [a, b] = await Promise.all([s.runtime.manager.ensureRunning(s.bob.userId), s.runtime.manager.ensureRunning(s.bob.userId)]);
		expect(a.port).toBe(b.port);
		expect(s.driver.starts).toBe(1);
	});
});

describe("admin API", () => {
	it("lists, limits and stops runtimes with the right permissions", async () => {
		const s = await setup();
		await s.runtime.manager.ensureRunning(s.bob.userId);
		expect((await s.t.api("GET", "/api/admin/runtimes", { token: s.bob.token })).status).toBe(403);
		const list = await s.t.api("GET", "/api/admin/runtimes", { token: s.root.token });
		expect(list.data.mode).toBe("auto");
		expect(list.data.drivers).toEqual([{ kind: "restricted", available: true }]);
		expect(list.data.items).toHaveLength(1);
		expect(list.data.items[0]).toMatchObject({ userId: s.bob.userId, status: "running", driver: "restricted" });

		const limits = await s.t.api("PUT", `/api/admin/runtimes/${s.bob.userId}/limits`, { token: s.root.token, body: { cpuLimit: 2, memLimitMb: 512 } });
		expect(limits.data).toMatchObject({ cpuLimit: 2, memLimitMb: 512, restartRequired: true });
		expect((await s.t.api("PUT", `/api/admin/runtimes/${s.bob.userId}/limits`, { token: s.bob.token, body: { cpuLimit: 8 } })).status).toBe(403);
		expect((await s.t.api("PUT", `/api/admin/runtimes/${s.bob.userId}/limits`, { token: s.root.token, body: { cpuLimit: -1 } })).status).toBe(400);

		const stopped = await s.t.api("POST", `/api/admin/runtimes/${s.bob.userId}/stop`, { token: s.root.token });
		expect(stopped.data.status).toBe("stopped");
		await s.runtime.manager.ensureRunning(s.bob.userId);
		expect(s.driver.specs.at(-1)).toMatchObject({ cpuLimit: 2, memLimitMb: 512 });

		const me = await s.t.api("GET", "/api/runtime", { token: s.bob.token });
		expect(me.data).toMatchObject({ status: "running", restricted: true });
		const owner = await s.t.api("GET", "/api/runtime", { token: s.root.token });
		expect(owner.data).toMatchObject({ status: "stopped", restricted: false });
	});

	it("lets an org admin manage only their org's tenants", async () => {
		const s = await setup();
		const adminOrg = await s.t.api("POST", "/api/orgs", { token: s.root.token, body: { name: "Other" } });
		const otherOrg = adminOrg.data.id as string;
		const eve = await s.t.createUser(s.root.token, "eve@other.test", "Eve", otherOrg);
		await s.t.api("PUT", `/api/orgs/${otherOrg}/members/${eve.userId}`, { token: s.root.token, body: { role: "admin" } });
		await s.runtime.manager.ensureRunning(s.bob.userId);
		await s.runtime.manager.ensureRunning(eve.userId);
		const seen = await s.t.api("GET", "/api/admin/runtimes", { token: eve.token });
		expect(seen.status).toBe(200);
		expect(seen.data.items.map((r: any) => r.userId)).toEqual([eve.userId]);
		expect((await s.t.api("POST", `/api/admin/runtimes/${s.bob.userId}/stop`, { token: eve.token })).status).toBe(403);
	});
});
