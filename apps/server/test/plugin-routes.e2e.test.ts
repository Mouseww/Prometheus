import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const NO_PROXY_ENV = { HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", NODE_USE_ENV_PROXY: "", NO_PROXY: "*" };
const direct = new Agent({ proxyEnv: {} } as ConstructorParameters<typeof Agent>[0]);
const PORT = 17541;
const HUB_PORT = 17542;
const TOKEN = "e2e-token-0123456789";

const PLUGIN = `export default {
	name: "e2e",
	setup(ctx) {
		ctx.route("GET", "/api/*", (req, res) => { res.end("prefix:" + req.url); }, { auth: "public" });
		ctx.route("GET", "/api/exact", (req, res) => { res.end("exact"); }, { auth: "public" });
		ctx.route("GET", "/private/*", (req, res) => { res.end("private:" + req.url); });
		ctx.wsRoute("/pub", (ws) => { ws.send("hello-public"); }, { auth: "public" });
		ctx.wsRoute("/priv/*", (ws, req) => { ws.send("hello-private:" + req.url); });
	},
};
`;

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ agent: direct, host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
		});
		req.on("error", reject);
		req.end();
	});
}

function socket(port: number, path: string, headers: Record<string, string> = {}): Promise<{ message: string } | { refused: number }> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, agent: direct });
		ws.on("unexpected-response", (_req, res) => resolve({ refused: res.statusCode ?? 0 }));
		ws.on("error", () => {});
		ws.on("message", (raw) => {
			resolve({ message: raw.toString() });
			ws.close();
		});
	});
}

function start(port: number, home: string, extra: Record<string, string>, args: string[] = []): Promise<ChildProcess> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", entry, ...args], { env: { ...process.env, ...NO_PROXY_ENV, PROMETHEUS_HOME: home, PROMETHEUS_PORT: String(port), PROMETHEUS_TOKEN: TOKEN, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => reject(new Error("server did not start")), 40_000);
		child.stdout?.on("data", (c: Buffer) => {
			if (c.toString().includes("PROMETHEUS_READY")) {
				clearTimeout(timer);
				resolve(child);
			}
		});
		child.on("exit", (code) => reject(new Error(`server exited early: ${code}`)));
	});
}

let server: ChildProcess;
let hub: ChildProcess;

beforeAll(async () => {
	const home = mkdtempSync(join(tmpdir(), "prom-routes-"));
	const dir = join(home, "plugins", "e2e");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "e2e", main: "index.mjs" }));
	writeFileSync(join(dir, "index.mjs"), PLUGIN);
	server = await start(PORT, home, {});
	hub = await start(HUB_PORT, mkdtempSync(join(tmpdir(), "prom-hub-")), {}, ["--role", "hub"]);
}, 90_000);

afterAll(() => {
	server?.kill();
	hub?.kill();
});

describe("plugin routes and role over a real server", () => {
	it("health reports the role", async () => {
		expect(JSON.parse((await get(PORT, "/api/health")).body).role).toBe("server");
		expect(JSON.parse((await get(HUB_PORT, "/api/health")).body).role).toBe("hub");
	});

	it("prefix routes get the full url and exact routes win", async () => {
		expect(await get(PORT, "/plugins/e2e/api/exact")).toEqual({ status: 200, body: "exact" });
		expect(await get(PORT, "/plugins/e2e/api/a/b?x=1")).toEqual({ status: 200, body: "prefix:/plugins/e2e/api/a/b?x=1" });
	});

	it("host routes still need the login", async () => {
		expect((await get(PORT, "/plugins/e2e/private/x")).status).toBe(401);
		expect(await get(PORT, "/plugins/e2e/private/x", { authorization: `Bearer ${TOKEN}` })).toEqual({ status: 200, body: "private:/plugins/e2e/private/x" });
	});

	it("websocket routes follow the same auth rules", async () => {
		expect(await socket(PORT, "/plugins/e2e/pub")).toEqual({ message: "hello-public" });
		expect(await socket(PORT, "/plugins/e2e/priv/a/b")).toEqual({ refused: 401 });
		expect(await socket(PORT, "/plugins/e2e/priv/a/b", { authorization: `Bearer ${TOKEN}` })).toEqual({ message: "hello-private:/plugins/e2e/priv/a/b" });
		expect(await socket(PORT, "/plugins/e2e/nope", { authorization: `Bearer ${TOKEN}` })).toEqual({ refused: 404 });
		expect(await socket(PORT, "/plugins/e2e/nope")).toEqual({ refused: 401 });
	});
});
