import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpMethod, PluginWebSocket, RouteAuth, RouteHandler, WsRouteHandler } from "@prometheus/plugin-sdk";
import WebSocket, { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HubLike, setupHubRole } from "../src/hub-role.ts";
import { PASSWORD, sleep, waitFor } from "./harness.ts";

interface Route {
	method: HttpMethod;
	path: string;
	handler: RouteHandler;
	opts?: { auth?: RouteAuth };
}

const T = 120_000;
let dir: string;
let hub: HubLike;
let server: Server;
let wss: WebSocketServer;
let port = 0;
const logs: string[] = [];
const routes: Route[] = [];
const wsRoutes: { path: string; handler: WsRouteHandler; opts?: { auth?: RouteAuth } }[] = [];
const disposers: (() => void | Promise<void>)[] = [];

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "team-hub-role-"));
	hub = await setupHubRole(
		{
			dataDir: dir,
			log: { info: (m) => void logs.push(m), warn: (m) => void logs.push(m), error: (m) => void logs.push(m) },
			route: (method, path, handler, opts) => void routes.push({ method, path, handler, opts }),
			wsRoute: (path, handler, opts) => void wsRoutes.push({ path, handler, opts }),
			onDispose: (fn) => void disposers.push(fn),
		},
		// The real Hub, loaded the way production does it: through a dynamic import. Its data lives in a temporary folder.
		{ env: {} },
	);

	// What the plugin host does: dispatch to the matching `/*` route and hand upgraded sockets to the ws route.
	server = createServer((req, res) => {
		const route = routes.find((r) => r.method === req.method && r.path === "/*");
		if (!route) {
			res.writeHead(500).end("no route");
			return;
		}
		void route.handler(req, res, {});
	});
	wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req: IncomingMessage, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => void wsRoutes[0]?.handler(ws as unknown as PluginWebSocket, req, {}));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
}, T);

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	wss.close();
	for (const fn of [...disposers].reverse()) await fn();
});

const url = (path: string) => `http://127.0.0.1:${port}${path}`;
const json = async (method: string, path: string, body?: unknown, token?: string) => {
	const res = await fetch(url(path), {
		method,
		headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as any };
};

describe("Hub role", () => {
	it("registers public prefix routes for every method and a public ws route", () => {
		expect(routes.map((r) => r.method).sort()).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
		expect(routes.every((r) => r.path === "/*" && r.opts?.auth === "public")).toBe(true);
		expect(wsRoutes).toHaveLength(1);
		expect(wsRoutes[0]).toMatchObject({ path: "/ws", opts: { auth: "public" } });
	});

	it("logs where the first account's setup code is, in Chinese", async () => {
		const code = join(dir, "hub", "setup-code.txt");
		expect(logs.some((l) => l.includes("[prometheus-team]") && l.includes(code) && l.includes("设置码"))).toBe(true);
	});

	it("delegates /plugins/team/api/* to the Hub and answers 404 in the envelope for anything else", async () => {
		const meta = await json("GET", "/plugins/team/api/meta");
		expect(meta.status).toBe(200);
		expect(meta.body).toMatchObject({ ok: true, data: { needsSetup: true } });

		const other = await json("GET", "/plugins/team/not-a-hub-path");
		expect(other.status).toBe(404);
		expect(other.body).toMatchObject({ ok: false, error: { code: "notFound" } });

		const unknownApi = await json("GET", "/plugins/team/api/nope");
		expect(unknownApi.status).toBe(404);
		expect(unknownApi.body.ok).toBe(false);
	});

	it("serves POST registration and bridges the WebSocket through attach()", async () => {
		const setup = (await readFile(join(dir, "hub", "setup-code.txt"), "utf8")).trim();
		const reg = await json("POST", "/plugins/team/api/auth/register", { email: "root@corp.test", password: PASSWORD, displayName: "Root", setupCode: setup });
		expect(reg.status).toBe(201);
		const login = await json("POST", "/plugins/team/api/auth/login", { email: "root@corp.test", password: PASSWORD });
		expect(login.status).toBe(200);
		const token = login.body.data.accessToken as string;
		const me = await json("GET", "/plugins/team/api/me", undefined, token);
		expect(me.body.ok).toBe(true);

		const frames: any[] = [];
		const ws = new WebSocket(`ws://127.0.0.1:${port}/plugins/team/ws?token=${encodeURIComponent(token)}`);
		ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		ws.send(JSON.stringify({ type: "subscribe", topic: "user" }));
		await waitFor(() => frames.some((f) => f.type === "subscribed" && f.topic === "user"), "subscribed");
		expect(frames.find((f) => f.type === "ready")).toMatchObject({ userId: me.body.data.user.id });
		ws.close();

		const bad = new WebSocket(`ws://127.0.0.1:${port}/plugins/team/ws?token=nope`);
		const code = await new Promise<number>((resolve) => bad.once("close", (c) => resolve(c)));
		expect(code).toBe(4401);
		await sleep(10);
	});

	it("closes the Hub when the plugin is disposed", async () => {
		expect(disposers).toHaveLength(1);
		// Disposed twice is harmless (the afterAll hook runs it again).
		await disposers[0]!();
		await expect(hub.close()).resolves.toBeUndefined();
	});
});
