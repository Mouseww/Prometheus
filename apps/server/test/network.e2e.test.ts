import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { Agent, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** The developer shell may route Node's own requests (even to loopback) through a proxy; these tests need direct sockets. */
const NO_PROXY_ENV = { HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", NODE_USE_ENV_PROXY: "", NO_PROXY: "*" };
const direct = new Agent({ proxyEnv: {} } as ConstructorParameters<typeof Agent>[0]);
const MAIN = 17531;
const LAN = 17532;
const PASSWORD = "correct horse battery";
let child: ChildProcess;
let home: string;

/** An IPv4 address of this machine that is not loopback, to prove LAN connections are checked differently. */
async function lanIp(): Promise<string | undefined> {
	const { networkInterfaces } = await import("node:os");
	for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
	return undefined;
}

function http(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown; host?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
	return new Promise((resolve, reject) => {
		const req = request({ agent: direct, host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { ...(opts.host ? { host: opts.host } : {}), ...(opts.body ? { "content-type": "application/json" } : {}), ...opts.headers } }, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
		});
		req.on("error", reject);
		if (opts.body) req.write(JSON.stringify(opts.body));
		req.end();
	});
}

interface Conn {
	ws: WebSocket;
	frames: Record<string, unknown>[];
	closed: Promise<number>;
	next(pred: (f: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
	send(f: unknown): void;
}

function connect(port: number, headers: Record<string, string> = {}): Promise<Conn | { refused: number }> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers, agent: direct });
		const frames: Record<string, unknown>[] = [];
		const waiters: { pred: (f: Record<string, unknown>) => boolean; ok: (f: Record<string, unknown>) => void }[] = [];
		let onClose!: (c: number) => void;
		const closed = new Promise<number>((r) => (onClose = r));
		ws.on("unexpected-response", (_req, res) => resolve({ refused: res.statusCode ?? 0 }));
		ws.on("error", () => {});
		ws.on("message", (raw) => {
			const f = JSON.parse(raw.toString()) as Record<string, unknown>;
			frames.push(f);
			for (const w of [...waiters]) if (w.pred(f)) waiters.splice(waiters.indexOf(w), 1), w.ok(f);
		});
		ws.on("close", (code) => onClose(code));
		ws.on("open", () =>
			resolve({
				ws,
				frames,
				closed,
				send: (f) => ws.send(JSON.stringify(f)),
				next: (pred, ms = 4000) => {
					const have = frames.find(pred);
					if (have) return Promise.resolve(have);
					return new Promise((ok, no) => {
						waiters.push({ pred, ok });
						setTimeout(() => no(new Error("timeout waiting for frame")), ms);
					});
				},
			}),
		);
	});
}

const isConn = (c: Conn | { refused: number }): c is Conn => "ws" in c;
const type = (t: string) => (f: Record<string, unknown>) => f.type === t;

async function rpc(c: Conn, method: string, params: unknown = {}) {
	const id = `t${Math.random().toString(36).slice(2)}`;
	c.send({ type: "rpc", id, method, params });
	return (await c.next((f) => f.type === "response" && f.id === id)) as { ok: boolean; data?: any; error?: string };
}

async function waitReady(): Promise<void> {
	for (let i = 0; i < 120; i++) {
		try {
			if ((await http(MAIN, "/api/health")).status === 200) return;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("server did not start");
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "prom-net-"));
	child = spawn(process.execPath, [entry], { env: { ...process.env, ...NO_PROXY_ENV, PROMETHEUS_PORT: String(MAIN), PROMETHEUS_HOME: home, PROMETHEUS_HOST: "127.0.0.1", PROMETHEUS_TOKEN: "" }, stdio: "ignore" });
	await waitReady();
}, 90_000);

afterAll(() => {
	child?.kill();
});

describe("network access (end to end)", () => {
	it("starts local-only: no login for a direct local client, and the settings are visible and editable", async () => {
		const c = await connect(MAIN);
		expect(isConn(c)).toBe(true);
		if (!isConn(c)) return;
		const hello = await c.next(type("hello"));
		expect(hello).toMatchObject({ authRequired: false, local: true });
		const status = await rpc(c, "network.get");
		expect(status.data).toMatchObject({ lan: false, passwordSet: false, listening: false, canEdit: true, managed: false });
		c.ws.close();
	});

	it("refuses a proxied request on the local port when no password exists (nothing to sign in with)", async () => {
		const r = await connect(MAIN, { "x-forwarded-for": "203.0.113.9" });
		expect(isConn(r)).toBe(false);
		expect((await http(MAIN, "/api/health", { headers: { "x-forwarded-for": "203.0.113.9" } })).status).toBe(403);
	});

	it("will not open LAN access without a password, and rejects weak passwords", async () => {
		const c = (await connect(MAIN)) as Conn;
		expect((await rpc(c, "network.set", { lan: true, port: LAN })).error).toMatch(/先设置登录密码/);
		expect((await rpc(c, "network.set", { password: "short" })).error).toMatch(/至少/);
		await expect(http(LAN, "/api/health")).rejects.toBeDefined();
		c.ws.close();
	});

	it("rejects bad ports and bad domains", async () => {
		const c = (await connect(MAIN)) as Conn;
		expect((await rpc(c, "network.set", { port: 80 })).error).toMatch(/1024/);
		expect((await rpc(c, "network.set", { port: MAIN })).error).toMatch(/占用/);
		expect((await rpc(c, "network.set", { allowedHosts: ["https://a.com"] })).error).toMatch(/域名格式/);
		c.ws.close();
	});

	it("sets a password and opens the network listener", async () => {
		const c = (await connect(MAIN)) as Conn;
		const res = await rpc(c, "network.set", { password: PASSWORD, lan: true, port: LAN, allowedHosts: ["agent.example.com", "*.corp.example.com"] });
		expect(res.ok).toBe(true);
		expect(res.data).toMatchObject({ lan: true, passwordSet: true, listening: true, port: LAN, allowedHosts: ["agent.example.com", "*.corp.example.com"] });
		expect(JSON.stringify(res.data)).not.toContain(PASSWORD);
		expect((await http(LAN, "/api/health")).status).toBe(200);
		c.ws.close();
	});

	it("asks the network listener for the password, even from loopback, and never hands out a session without it", async () => {
		const c = await connect(LAN);
		if (!isConn(c)) throw new Error("expected a connection");
		expect(await c.next(type("hello"))).toMatchObject({ authRequired: true, login: "password", local: false });
		const id = "x1";
		c.send({ type: "rpc", id, method: "host.info", params: {} });
		expect(await c.closed).toBe(4003);
	});

	it("signs in with the password, then accepts the returned session token on a new connection", async () => {
		const a = (await connect(LAN)) as Conn;
		await a.next(type("hello"));
		a.send({ type: "login", password: "wrong password!" });
		expect(await a.next(type("login_failed"))).toMatchObject({ message: "密码不正确" });
		a.send({ type: "login", password: PASSWORD });
		const ok = await a.next(type("auth_ok"));
		const token = String(ok.token);
		expect(token.startsWith("v1.")).toBe(true);
		expect((await rpc(a, "host.info")).ok).toBe(true);
		a.ws.close();

		const b = (await connect(LAN)) as Conn;
		await b.next(type("hello"));
		b.send({ type: "auth", token });
		await b.next(type("auth_ok"));
		expect((await rpc(b, "session.list")).ok).toBe(true);
		b.ws.close();

		const bad = (await connect(LAN)) as Conn;
		await bad.next(type("hello"));
		bad.send({ type: "auth", token: `${token}x` });
		expect(await bad.closed).toBe(4003);
	});

	it("never lets a network client change network settings, even after signing in", async () => {
		const c = (await connect(LAN)) as Conn;
		await c.next(type("hello"));
		c.send({ type: "login", password: PASSWORD });
		await c.next(type("auth_ok"));
		const set = await rpc(c, "network.set", { lan: false });
		expect(set.ok).toBe(false);
		expect(set.error).toMatch(/本机/);
		const get = await rpc(c, "network.get");
		expect(get.data.canEdit).toBe(false);
		c.ws.close();
	});

	it("checks the Host header on the network listener against the allow-list", async () => {
		expect((await http(LAN, "/api/health", { host: "evil.example.com" })).status).toBe(403);
		expect((await http(LAN, "/api/health", { host: "agent.example.com" })).status).toBe(200);
		expect((await http(LAN, "/api/health", { host: "a.corp.example.com" })).status).toBe(200);
		expect((await http(LAN, "/api/health", { host: "corp.example.com" })).status).toBe(403);
		const refused = await connect(LAN, { host: "evil.example.com" });
		expect(isConn(refused)).toBe(false);
		const viaProxy = await connect(LAN, { host: "agent.example.com", origin: "https://agent.example.com", "x-forwarded-for": "198.51.100.7" });
		expect(isConn(viaProxy)).toBe(true);
		if (isConn(viaProxy)) viaProxy.ws.close();
		const crossSite = await connect(LAN, { host: "agent.example.com", origin: "https://evil.example.com" });
		expect(isConn(crossSite)).toBe(false);
	});

	it("keeps plugin routes behind the password on the network listener", async () => {
		expect((await http(LAN, "/plugins/anything")).status).toBe(401);
		const login = await http(LAN, "/api/login", { method: "POST", body: { password: PASSWORD } });
		expect(login.status).toBe(200);
		const { token } = JSON.parse(login.body) as { token: string };
		const cookie = String(login.headers["set-cookie"]);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect((await http(LAN, "/plugins/anything", { headers: { cookie: `prometheus_token=${encodeURIComponent(token)}` } })).status).toBe(404);
		expect((await http(LAN, "/plugins/anything", { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
		expect((await http(LAN, "/plugins/anything", { headers: { authorization: "Bearer v1.9999999999999.x.y" } })).status).toBe(401);
		expect((await http(LAN, "/api/login", { method: "POST", body: { password: "nope nope nope" } })).status).toBe(401);
	});

	it("serves the proxied main port after a password exists: strangers must sign in, the local user still does not", async () => {
		const stranger = await connect(MAIN, { "x-forwarded-for": "203.0.113.9", host: "agent.example.com", origin: "https://agent.example.com" });
		if (!isConn(stranger)) throw new Error("expected the proxied socket to open");
		expect(await stranger.next(type("hello"))).toMatchObject({ authRequired: true, login: "password", local: false });
		stranger.send({ type: "rpc", id: "n", method: "network.get", params: {} });
		expect(await stranger.closed).toBe(4003);
		const direct = (await connect(MAIN)) as Conn;
		expect(await direct.next(type("hello"))).toMatchObject({ authRequired: false, local: true });
		direct.ws.close();
	});

	it("locks out repeated wrong passwords and then refuses even the right one for a while", async () => {
		let last: Record<string, unknown> = {};
		for (let i = 0; i < 8; i++) {
			const c = (await connect(LAN)) as Conn;
			await c.next(type("hello"));
			c.send({ type: "login", password: `guess number ${i} wrong` });
			last = await c.next(type("login_failed"));
			c.ws.close();
		}
		expect(String(last.message)).toMatch(/尝试次数过多/);
		const c = (await connect(LAN)) as Conn;
		await c.next(type("hello"));
		c.send({ type: "login", password: PASSWORD });
		expect(String((await c.next(type("login_failed"))).message)).toMatch(/尝试次数过多/);
		c.ws.close();
	}, 30_000);

	it("signs every device out when the password changes, and turns the listener off on request", async () => {
		const local = (await connect(MAIN)) as Conn;
		const off = await rpc(local, "network.set", { lan: false });
		expect(off.data).toMatchObject({ lan: false, listening: false });
		await expect(http(LAN, "/api/health")).rejects.toBeDefined();
		local.ws.close();
	});

	it("keeps the LAN setting and password across a restart", async () => {
		const first = (await connect(MAIN)) as Conn;
		await rpc(first, "network.set", { lan: true });
		first.ws.close();
		child.kill();
		await new Promise((r) => setTimeout(r, 1500));
		child = spawn(process.execPath, [entry], { env: { ...process.env, ...NO_PROXY_ENV, PROMETHEUS_PORT: String(MAIN), PROMETHEUS_HOME: home, PROMETHEUS_HOST: "127.0.0.1", PROMETHEUS_TOKEN: "" }, stdio: "ignore" });
		await waitReady();
		for (let i = 0; i < 20; i++) {
			try {
				if ((await http(LAN, "/api/health")).status === 200) break;
			} catch {
				await new Promise((r) => setTimeout(r, 300));
			}
		}
		expect((await http(LAN, "/api/health")).status).toBe(200);
		const c = (await connect(LAN)) as Conn;
		await c.next(type("hello"));
		c.send({ type: "login", password: PASSWORD });
		// The limiter is fresh after a restart, so the saved password still works.
		expect(await c.next((f) => f.type === "auth_ok" || f.type === "login_failed")).toMatchObject({ type: "auth_ok" });
		c.ws.close();
	}, 60_000);

	it("is reachable from the machine's LAN address too (the listener is not loopback-only)", async () => {
		const ip = await lanIp();
		if (!ip) return;
		const r = await new Promise<number>((resolve) => {
			const req = request({ agent: direct, host: ip, port: LAN, path: "/api/health" }, (res) => resolve(res.statusCode ?? 0));
			req.on("error", () => resolve(0));
			req.end();
		});
		expect(r).toBe(200);
	});
});

describe("network access in the desktop setup (loopback + access token)", () => {
	const PORT = 17533;
	const TOKEN = "desktop-token-0123456789";
	let proc: ChildProcess | undefined;
	let dir = "";

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "prom-net-desktop-"));
		proc = spawn(process.execPath, [entry], { env: { ...process.env, ...NO_PROXY_ENV, PROMETHEUS_PORT: String(PORT), PROMETHEUS_HOME: dir, PROMETHEUS_HOST: "127.0.0.1", PROMETHEUS_TOKEN: TOKEN }, stdio: "ignore" });
		for (let i = 0; i < 120; i++) {
			try {
				if ((await http(PORT, "/api/health")).status === 200) return;
			} catch {
				// not up yet
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new Error("server did not start");
	}, 90_000);

	afterAll(() => {
		proc?.kill();
	});

	it("lets the local app set a password even though it is guarded by a token", async () => {
		const c = (await connect(PORT)) as Conn;
		expect(await c.next(type("hello"))).toMatchObject({ authRequired: true, login: "token", local: true });
		c.send({ type: "auth", token: TOKEN });
		await c.next(type("auth_ok"));
		const status = await rpc(c, "network.get");
		expect(status.data).toMatchObject({ managed: false, canEdit: true, passwordSet: false });
		const set = await rpc(c, "network.set", { password: "desktop-pass-123" });
		expect(set.ok).toBe(true);
		expect(set.data).toMatchObject({ passwordSet: true });
		c.ws.close();
	});

	it("sends a proxied request on the local port to the password, not the token", async () => {
		const p = await connect(PORT, { "x-forwarded-for": "203.0.113.9" });
		if (!isConn(p)) throw new Error("expected the proxied socket to open");
		expect(await p.next(type("hello"))).toMatchObject({ authRequired: true, login: "password", local: false });
		p.ws.close();
	});
});
