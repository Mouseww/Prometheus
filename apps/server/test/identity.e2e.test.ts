import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair, signJwt } from "@prometheus/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

// A real server that trusts a Hub key and names its owner: what a signed-in Hub user may and may not do over the WebSocket.
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const NO_PROXY_ENV = { HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", NODE_USE_ENV_PROXY: "", NO_PROXY: "*" };
const direct = new Agent({ proxyEnv: {} } as ConstructorParameters<typeof Agent>[0]);
const PORT = 17551;
const TOKEN = "identity-token-0123456789";
const keys = generateKeyPair();
const now = () => Math.floor(Date.now() / 1000);
const jwt = (claims: { sub: string; acts_for?: string[] }, ttl = 600) => signJwt({ iat: now(), exp: now() + ttl, ...claims }, keys.privateKey);

const PLUGIN = `export default {
	name: "who",
	setup(ctx) {
		ctx.route("GET", "/me", (req, res, c) => { res.end(JSON.stringify(c.identity ?? null)); });
	},
};
`;

interface Conn {
	ws: WebSocket;
	rpc(method: string, params: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
	closed: Promise<{ code: number; reason: string }>;
}

/** Opens /ws and signs in with `token`; resolves with the connection, or rejects with the close code when the server refuses. */
function connect(token: string): Promise<Conn> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { agent: direct });
		const waiting = new Map<string, (frame: Record<string, unknown>) => void>();
		let seq = 0;
		const closed = new Promise<{ code: number; reason: string }>((done) => ws.on("close", (code, reason) => done({ code, reason: reason.toString() })));
		ws.on("error", () => {});
		ws.on("close", (code) => reject(new Error(`closed ${code}`)));
		ws.on("message", (raw) => {
			const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
			if (frame.type === "hello") return ws.send(JSON.stringify({ type: "auth", token }));
			if (frame.type === "auth_ok") {
				return resolve({
					ws,
					closed,
					rpc: (method, params) =>
						new Promise((res) => {
							const id = `r${++seq}`;
							waiting.set(id, (f) => res(f.ok ? { ok: true, data: f.data } : { ok: false, error: String(f.error) }));
							ws.send(JSON.stringify({ type: "rpc", id, method, params }));
						}),
				});
			}
			if (frame.type === "response") waiting.get(String(frame.id))?.(frame);
		});
	});
}

function startServer(port: number, home: string, extra: Record<string, string>): Promise<ChildProcess> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", entry], { env: { ...process.env, ...NO_PROXY_ENV, PROMETHEUS_HOME: home, PROMETHEUS_PORT: String(port), PROMETHEUS_TOKEN: TOKEN, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
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

/** Runs the server to its exit and returns what it printed; it is expected to refuse to start. */
function startRefused(home: string, extra: Record<string, string>): Promise<{ code: number | null; err: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", entry], { env: { ...process.env, ...NO_PROXY_ENV, PROMETHEUS_HOME: home, PROMETHEUS_PORT: String(PORT + 1), PROMETHEUS_TOKEN: TOKEN, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
		const timer = setTimeout(() => child.kill(), 40_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, err });
		});
	});
}

function get(path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ agent: direct, host: "127.0.0.1", port: PORT, path, method: "GET", headers: {} }, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
		});
		req.on("error", reject);
		req.end();
	});
}

let server: ChildProcess;
let home: string;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "prom-identity-"));
	mkdirSync(join(home, "sessions"), { recursive: true });
	writeFileSync(join(home, "policy.json"), JSON.stringify({ serverOwner: "owner" }));
	// A session that belongs to someone else, as one imported or created before the owner was named would.
	writeFileSync(join(home, "sessions", "owners.json"), JSON.stringify({ version: 1, owners: { "sess-alice": "alice" } }));
	const dir = join(home, "plugins", "who");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "who", main: "index.mjs" }));
	writeFileSync(join(dir, "index.mjs"), PLUGIN);
	server = await startServer(PORT, home, { PROMETHEUS_TRUST_KEY: keys.publicKey, PROMETHEUS_TRUST_SKEW_SEC: "0" });
}, 90_000);

afterAll(() => server?.kill());

describe("a Hub user's WebSocket identity", () => {
	const delegate = () => jwt({ sub: "hub", acts_for: ["owner"] });

	it("cannot prompt, answer or delete a session that belongs to someone else", async () => {
		const c = await connect(delegate());
		const calls: [string, unknown][] = [
			["chat.prompt", { sessionId: "sess-alice", text: "hi" }],
			["ui.respond", { sessionId: "sess-alice", requestId: "r", response: { cancelled: true } }],
			["session.delete", { sessionId: "sess-alice" }],
		];
		for (const [method, params] of calls) {
			const r = await c.rpc(method, params);
			expect(r.ok, method).toBe(false);
			expect(r.ok ? "" : r.error, method).toContain("sessionForbidden");
		}
		c.ws.close();
	});

	it("is checked as the delegate it is, so a call without a session id is refused too", async () => {
		const c = await connect(delegate());
		const r = await c.rpc("chat.prompt", { text: "hi" });
		expect(r.ok ? "" : r.error).toContain("invalidParams");
		c.ws.close();
	});

	it("may not call host administration, plugins or network settings", async () => {
		const c = await connect(delegate());
		for (const [method, params] of [["plugin.call", { plugin: "who", method: "x" }], ["settings.set", {}], ["gateway.save", {}], ["workspace.add", { path: home }]] as const) {
			const r = await c.rpc(method, params);
			expect(r.ok ? "" : r.error, method).toContain("identityForbidden");
		}
		for (const [method, params] of [["network.set", { lan: true }], ["runtime.env", { bins: [], env: {} }]] as const) {
			const r = await c.rpc(method, params);
			expect(r.ok ? "" : r.error, method).toContain("networkLocalOnly");
		}
		const read = await c.rpc("session.list", {});
		expect(read.ok).toBe(true);
		c.ws.close();
	});

	it("cannot sign in at all when it is neither the owner nor acting for them", async () => {
		await expect(connect(jwt({ sub: "mallory" }))).rejects.toThrow(/closed 4003/);
	});

	it("is closed when the token has expired", async () => {
		const c = await connect(jwt({ sub: "owner" }, 2));
		const closed = await Promise.race([c.closed, new Promise<undefined>((r) => setTimeout(() => r(undefined), 8000))]);
		expect(closed).toMatchObject({ code: 4003, reason: "token expired" });
	}, 15_000);

	it("stays open while the token is valid", async () => {
		const c = await connect(jwt({ sub: "owner" }, 600));
		const closed = await Promise.race([c.closed, new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000))]);
		expect(closed).toBeUndefined();
		c.ws.close();
	}, 10_000);

	it("gives a panel pass the identity of the client that asked for it", async () => {
		const c = await connect(delegate());
		const link = await c.rpc("panel.link", {});
		expect(link.ok).toBe(true);
		const id = (link.ok ? (link.data as { id: string }).id : "");
		const page = await get(`/plugins/who/me?pt=${encodeURIComponent(id)}`);
		expect(page.status).toBe(200);
		expect(JSON.parse(page.body)).toEqual({ userId: "hub", actsFor: ["owner"] });
		c.ws.close();
	});

	it("rejects a guessed panel pass", async () => {
		expect((await get("/plugins/who/me?pt=guess")).status).toBe(401);
	});
});

describe("startup refusals", () => {
	it("refuses a trust key without a serverOwner", async () => {
		const empty = mkdtempSync(join(tmpdir(), "prom-identity-noowner-"));
		const r = await startRefused(empty, { PROMETHEUS_TRUST_KEY: keys.publicKey });
		expect(r.code).toBe(1);
		expect(r.err).toContain("serverOwner");
	}, 60_000);

	it("refuses a trust key that is not an Ed25519 public key", async () => {
		const other = mkdtempSync(join(tmpdir(), "prom-identity-rsa-"));
		writeFileSync(join(other, "policy.json"), JSON.stringify({ serverOwner: "owner" }));
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
		const r = await startRefused(other, { PROMETHEUS_TRUST_KEY: rsa });
		expect(r.code).toBe(1);
		expect(r.err).toContain("Ed25519");
	}, 60_000);
});
