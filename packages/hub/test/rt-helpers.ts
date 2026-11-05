import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { HubOptions } from "../src/config.ts";
import type { RuntimeDriver, TenantHandle, TenantSpec } from "../src/runtime/driver.ts";
import type { RuntimeOverrides } from "../src/runtime/options.ts";
import { tempDir } from "./helpers.ts";
import { startHub, type TestHub } from "./hub-helpers.ts";

export interface SeenRequest {
	method: string;
	url: string;
	headers: IncomingHttpHeaders;
}

export interface FakeTenant {
	port: number;
	seen: SeenRequest[];
	close(): Promise<void>;
}

/** A stand-in tenant: `/api/health`, an echo of the request for everything else, and a WebSocket echo. */
export async function startFakeTenant(): Promise<FakeTenant> {
	const seen: SeenRequest[] = [];
	const sockets = new Set<Duplex>();
	const wss = new WebSocketServer({ noServer: true });
	const server: Server = createServer((req, res) => {
		seen.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers });
		if (req.url === "/api/health") {
			res.writeHead(200, { "content-type": "application/json" });
			return void res.end(JSON.stringify({ ok: true }));
		}
		if (req.url?.startsWith("/redirect")) {
			res.writeHead(302, { location: "/landing", "set-cookie": "tenant=1; Path=/" });
			return void res.end();
		}
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json", "set-cookie": "tenant=1; Path=/" });
			res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
	});
	server.on("connection", (s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
	});
	server.on("upgrade", (req, socket, head) => {
		seen.push({ method: "UPGRADE", url: req.url ?? "/", headers: req.headers });
		wss.handleUpgrade(req, socket, head, (ws) => {
			ws.send(JSON.stringify({ hello: req.headers.authorization ?? null }));
			ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		port: (server.address() as AddressInfo).port,
		seen,
		async close() {
			for (const c of wss.clients) c.terminate();
			for (const s of sockets) s.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export interface FakeDriver extends RuntimeDriver {
	specs: TenantSpec[];
	starts: number;
	tenants: Map<string, FakeTenant>;
	/** Simulates the tenant process dying. */
	crash(userId: string): Promise<void>;
	/** Make the next starts fail. */
	failStarts: boolean;
}

/** A driver whose "processes" are fake tenants in this test process. */
export function fakeDriver(kind: RuntimeDriver["kind"] = "restricted"): FakeDriver {
	const exits = new Map<string, (info: { code: number | null }) => void>();
	const driver: FakeDriver = {
		kind,
		specs: [],
		starts: 0,
		tenants: new Map(),
		failStarts: false,
		async available() {
			return true;
		},
		async start(spec) {
			driver.starts += 1;
			if (driver.failStarts) throw new Error("fake start failure");
			driver.specs.push(spec);
			const tenant = await startFakeTenant();
			driver.tenants.set(spec.userId, tenant);
			const handle: TenantHandle = { userId: spec.userId, host: "127.0.0.1", port: tenant.port, pid: driver.starts };
			return handle;
		},
		async stop(handle) {
			exits.delete(handle.userId);
			const t = driver.tenants.get(handle.userId);
			driver.tenants.delete(handle.userId);
			await t?.close();
		},
		async stats() {
			return {};
		},
		onExit(handle, cb) {
			exits.set(handle.userId, cb);
		},
		async crash(userId) {
			const cb = exits.get(userId);
			const t = driver.tenants.get(userId);
			driver.tenants.delete(userId);
			await t?.close();
			cb?.({ code: 1 });
		},
	};
	return driver;
}

export interface FakeClock {
	now(): number;
	advance(ms: number): void;
}

export const fakeClock = (start = Date.now()): FakeClock => {
	let t = start;
	return { now: () => t, advance: (ms) => void (t += ms) };
};

export interface RtHub extends TestHub {
	/** Wires WebSocket upgrades from the test server into the Hub. */
	upgradeUrl(path: string): string;
}

export async function startRtHub(runtime: RuntimeOverrides, options: Partial<HubOptions> = {}): Promise<RtHub> {
	// Without an explicit root, restricted tenants would go to a sibling of the data directory (outside the temp dir that gets cleaned up).
	const tenantRoot = runtime.tenantRoot ?? join(await tempDir(), "tenants");
	const th = await startHub({ runtime: { healthIntervalMs: 0, tenantRoot, ...runtime }, ...options });
	th.server.on("upgrade", (req, socket, head) => {
		if (!th.hub.handleUpgrade(req, socket, head)) socket.destroy();
	});
	return { ...th, upgradeUrl: (path) => th.baseUrl.replace(/^http/, "ws") + path };
}

export const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 10_000, what = "条件"): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v !== undefined && v !== false) return v;
		if (Date.now() > end) throw new Error(`等待超时: ${what}`);
		await sleepReal(50);
	}
}
