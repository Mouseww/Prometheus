import { request, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parseRuntimeOrigin } from "../src/config.ts";
import { fakeDriver, startRtHub, type RtHub } from "./rt-helpers.ts";

const open: RtHub[] = [];
afterEach(async () => {
	for (const t of open.splice(0)) await t.stop();
});

const RT_HOST = "rt.example.test";

async function setup(runtimeOrigin?: string): Promise<{ t: RtHub; bob: { token: string; userId: string } }> {
	const t = await startRtHub({ drivers: [fakeDriver()], tenantHubUrl: "http://hub.test" }, { ...(runtimeOrigin ? { runtimeOrigin } : {}) });
	open.push(t);
	const root = await t.bootstrap();
	const bob = await t.createUser(root.token, "bob@corp.test", "Bob", root.orgId);
	return { t, bob };
}

/** `fetch` cannot set Host; the workbench origin is told apart by it. */
function get(t: RtHub, path: string, opts: { host?: string; token?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
	const url = new URL(path, t.baseUrl);
	return new Promise((resolve, reject) => {
		const req = request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET", headers: { ...(opts.host ? { host: opts.host } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end();
	});
}

describe("HUB_RUNTIME_ORIGIN", () => {
	it("parses an origin and rejects anything else", () => {
		expect(parseRuntimeOrigin(undefined)).toBeUndefined();
		expect(parseRuntimeOrigin("  ")).toBeUndefined();
		expect(parseRuntimeOrigin("https://rt.example.com/")).toBe("https://rt.example.com");
		expect(parseRuntimeOrigin("http://rt.localhost:8443")).toBe("http://rt.localhost:8443");
		for (const bad of ["rt.example.com", "ftp://rt.example.com", "https://rt.example.com/app", "https://rt.example.com/?x=1", "https://u:p@rt.example.com"]) {
			expect(() => parseRuntimeOrigin(bad), bad).toThrow(/HUB_RUNTIME_ORIGIN/);
		}
	});

	it("serves /rt only on the workbench host, and that host serves nothing else", async () => {
		const { t, bob } = await setup(`https://${RT_HOST}`);
		// The Hub UI host (here 127.0.0.1:<port>) refuses /rt, with or without a valid token.
		expect((await get(t, "/rt/hello", { token: bob.token })).status).toBe(404);
		expect((await get(t, "/rt/hello")).status).toBe(404);

		const ok = await get(t, "/rt/hello", { host: RT_HOST, token: bob.token });
		expect(ok.status).toBe(200);
		expect(JSON.parse(ok.body).url).toBe("/hello");

		// The workbench origin has no Hub API.
		expect((await get(t, "/api/me", { host: RT_HOST, token: bob.token })).status).toBe(404);
		expect((await get(t, "/api/meta", { host: RT_HOST })).status).toBe(404);
		expect((await get(t, "/api/me", { token: bob.token })).status).toBe(200);
	});

	it("hands the first-load token cookie over with SameSite=Lax so a cross-site navigation keeps it", async () => {
		const { t, bob } = await setup(`https://${RT_HOST}`);
		const first = await get(t, `/rt/?token=${encodeURIComponent(bob.token)}`, { host: RT_HOST });
		expect(first.status).toBe(302);
		const cookie = String(first.headers["set-cookie"]);
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
	});

	it("reports the workbench URL on the dedicated origin", async () => {
		const { t, bob } = await setup(`https://${RT_HOST}`);
		const me = await t.api("GET", "/api/runtime", { token: bob.token });
		expect(me.data.workbenchUrl).toBe(`https://${RT_HOST}/rt/`);
		const started = await t.api("POST", "/api/runtime/start", { token: bob.token });
		expect(started.data.workbenchUrl).toBe(`https://${RT_HOST}/rt/`);
	});

	it("keeps the same-origin proxy when unset and reports a host relative URL", async () => {
		const { t, bob } = await setup();
		expect((await t.api("GET", "/api/runtime", { token: bob.token })).data.workbenchUrl).toBe("/rt/");
		const res = await get(t, "/rt/hello", { token: bob.token });
		expect(res.status).toBe(200);
	});
});

describe("workbench response headers", () => {
	it("adds nosniff and a frame-ancestors only CSP, and keeps the tenant's own CSP", async () => {
		const { t, bob } = await setup();
		const res = await get(t, "/rt/hello", { token: bob.token });
		expect(res.headers["x-content-type-options"]).toBe("nosniff");
		expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
		// Redirects carry them too.
		const redirect = await get(t, "/rt/redirect", { token: bob.token });
		expect(redirect.status).toBe(302);
		expect(redirect.headers["x-content-type-options"]).toBe("nosniff");
	});

	it("lets the Hub UI origin frame the workbench when it lives on its own origin", async () => {
		const t = await startRtHub({ drivers: [fakeDriver()], tenantHubUrl: "http://hub.test" }, { runtimeOrigin: `https://${RT_HOST}`, publicUrl: "https://hub.example.test" });
		open.push(t);
		const root = await t.bootstrap();
		const res = await get(t, "/rt/hello", { host: RT_HOST, token: root.token });
		expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'self' https://hub.example.test");
	});
});
