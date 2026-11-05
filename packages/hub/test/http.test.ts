import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HubError } from "../src/errors.ts";
import { dispatch, relativePath } from "../src/http/dispatch.ts";
import { HANDLED, Reply, Router } from "../src/http/router.ts";
import { resolveConfig } from "../src/config.ts";
import { generateKeyPair, signJwt } from "../src/jwt.ts";
import { silentLog } from "../src/log.ts";
import type { Actor } from "../src/permissions.ts";
import { startHub, type TestHub } from "./hub-helpers.ts";

describe("Router", () => {
	const noop = async (): Promise<null> => null;

	it("matches methods, params and trailing wildcards", () => {
		const r = new Router();
		r.get("/api/teams/:id/members/:userId", noop).post("/api/teams", noop).get("/git/*", noop);
		const m = r.match("GET", "/api/teams/t1/members/u%201");
		expect(m).toMatchObject({ kind: "match", params: { id: "t1", userId: "u 1" } });
		expect(r.match("GET", "/git/ws1.git/info/refs")).toMatchObject({ kind: "match", params: { "*": "ws1.git/info/refs" } });
		expect(r.match("POST", "/api/teams")).toMatchObject({ kind: "match" });
		expect(r.match("GET", "/api/teams/t1")).toEqual({ kind: "none" });
		expect(r.match("DELETE", "/api/teams")).toEqual({ kind: "methodNotAllowed", allow: ["POST"] });
		expect(r.match("GET", "/nothing")).toEqual({ kind: "none" });
	});

	it("tolerates trailing slashes and rejects bad percent-encoding", () => {
		const r = new Router().get("/api/x/:id", noop);
		expect(r.match("GET", "/api/x/1/")).toMatchObject({ kind: "match", params: { id: "1" } });
		expect(r.match("GET", "/api/x/%E0%A4%A")).toEqual({ kind: "none" });
	});

	it("mounts a child router under a prefix", () => {
		const child = new Router().get("/users/:id", noop, { auth: "public" });
		const parent = new Router().mount("/api/v1", child);
		const m = parent.match("GET", "/api/v1/users/9");
		expect(m).toMatchObject({ kind: "match", params: { id: "9" } });
		expect(m.kind === "match" && m.route.auth).toBe("public");
		expect(parent.match("GET", "/users/9")).toEqual({ kind: "none" });
	});

	it("defaults to user auth", () => {
		const m = new Router().get("/a", noop).match("GET", "/a");
		expect(m.kind === "match" && m.route.auth).toBe("user");
	});
});

describe("relativePath", () => {
	it("strips the base path and rejects outsiders", () => {
		const cfg = resolveConfig({ dataDir: "x", basePath: "/plugins/team/", env: {} });
		expect(relativePath(cfg, "/plugins/team/api/meta")).toBe("/api/meta");
		expect(relativePath(cfg, "/plugins/team")).toBe("/");
		expect(relativePath(cfg, "/plugins/teammate/api")).toBeUndefined();
		expect(relativePath(cfg, "/api/meta")).toBeUndefined();
		expect(relativePath(resolveConfig({ dataDir: "x", env: {} }), "/api/meta")).toBe("/api/meta");
	});
});

describe("dispatch: envelope, validation and auth", () => {
	const keys = generateKeyPair();
	const config = resolveConfig({ dataDir: "x", env: {} });
	const actor: Actor = { userId: "u1", operator: false, orgRoles: {}, teamRoles: {} };
	const router = new Router();
	const Body = Type.Object({ name: Type.String({ minLength: 2 }), age: Type.Optional(Type.Integer({ minimum: 0 })) });
	const Query = Type.Object({ n: Type.Integer({ minimum: 1 }), flag: Type.Optional(Type.Boolean()) });
	router
		.post("/api/echo", async (ctx) => ctx.json(Body), { auth: "public" })
		.get("/api/q", async (ctx) => ctx.query(Query), { auth: "public" })
		.post("/api/created", async () => new Reply(201, { id: 1 }, { location: "/api/created/1" }), { auth: "public" })
		.get("/api/hub-error", async () => {
			throw new HubError(418, "teapot", "我是茶壶");
		}, { auth: "public" })
		.get("/api/boom", async () => {
			throw new Error("secret database detail");
		}, { auth: "public" })
		.get("/api/who", async (ctx) => ({ userId: ctx.userId(), actor: (await ctx.actor()).userId }))
		.get("/api/raw", async (ctx) => {
			ctx.res.writeHead(200, { "content-type": "text/plain" });
			ctx.res.end("raw!");
			return HANDLED;
		}, { auth: "none" })
		.get("/api/none", async (ctx) => ({ identity: ctx.identity ?? null }), { auth: "none" })
		.get("/api/nothing", async () => undefined, { auth: "public" });

	const errors: string[] = [];
	const log = { info: () => {}, warn: () => {}, error: (m: string) => void errors.push(m) };
	let base = "";
	let server: ReturnType<typeof createServer>;
	beforeAll(async () => {
		server = createServer((req, res) => {
			void dispatch({ router, config, log, publicKey: keys.publicKey, loadActor: async () => actor }, req, res).then((h) => {
				if (!h) {
					res.writeHead(404);
					res.end("unhandled");
				}
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => new Promise<void>((r) => server.close(() => r())));

	const token = (over: Record<string, unknown> = {}, key = keys.privateKey): string => {
		const iat = Math.floor(Date.now() / 1000);
		return signJwt({ sub: "u1", iss: "prometheus-hub", aud: "prometheus", iat, exp: iat + 600, ...over }, key);
	};
	const call = async (method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
		const res = await fetch(`${base}${path}`, { method, headers: init.headers, body: init.body });
		const text = await res.text();
		return { res, status: res.status, json: text.startsWith("{") ? JSON.parse(text) : text };
	};

	it("wraps success in {ok:true,data}", async () => {
		const r = await call("POST", "/api/echo", { body: JSON.stringify({ name: "ab", age: 3 }), headers: { "content-type": "application/json" } });
		expect(r.status).toBe(200);
		expect(r.json).toEqual({ ok: true, data: { name: "ab", age: 3 } });
		expect(r.res.headers.get("content-type")).toContain("application/json");
	});

	it("honours Reply status and headers; undefined becomes null", async () => {
		const r = await call("POST", "/api/created");
		expect(r.status).toBe(201);
		expect(r.res.headers.get("location")).toBe("/api/created/1");
		expect(r.json).toEqual({ ok: true, data: { id: 1 } });
		expect((await call("GET", "/api/nothing")).json).toEqual({ ok: true, data: null });
	});

	it("validates bodies with TypeBox and reports the failing field", async () => {
		const bad = await call("POST", "/api/echo", { body: JSON.stringify({ name: "a" }) });
		expect(bad.status).toBe(400);
		expect(bad.json.ok).toBe(false);
		expect(bad.json.error.code).toBe("validationError");
		expect(bad.json.error.message).toContain("name");
		expect((await call("POST", "/api/echo", { body: JSON.stringify({ name: "ab", age: -1 }) })).json.error.message).toContain("age");
		expect((await call("POST", "/api/echo", { body: "{not json" })).json.error.code).toBe("invalidJson");
		expect((await call("POST", "/api/echo")).json.error.code).toBe("validationError");
		expect((await call("POST", "/api/echo", { body: "[]" })).status).toBe(400);
	});

	it("rejects oversized bodies", async () => {
		const r = await call("POST", "/api/echo", { body: JSON.stringify({ name: "x".repeat(1024 * 1024 + 10) }) });
		expect(r.status).toBe(400);
		expect(r.json.error.code).toBe("payloadTooLarge");
	});

	it("converts and validates query strings", async () => {
		expect((await call("GET", "/api/q?n=5&flag=true")).json.data).toEqual({ n: 5, flag: true });
		expect((await call("GET", "/api/q?n=abc")).status).toBe(400);
		expect((await call("GET", "/api/q")).json.error.code).toBe("validationError");
	});

	it("maps HubError and hides unexpected errors", async () => {
		const known = await call("GET", "/api/hub-error");
		expect(known.status).toBe(418);
		expect(known.json).toEqual({ ok: false, error: { code: "teapot", message: "我是茶壶" } });
		const unknown = await call("GET", "/api/boom");
		expect(unknown.status).toBe(500);
		expect(unknown.json).toEqual({ ok: false, error: { code: "internalError", message: "服务器内部错误" } });
		expect(errors.some((e) => e.includes("[prometheus-hub]") && e.includes("secret database detail"))).toBe(true);
		expect(JSON.stringify(unknown.json)).not.toContain("secret");
	});

	it("answers 404 for unknown /api paths, 405 for wrong methods, and passes other paths through", async () => {
		const nf = await call("GET", "/api/unknown");
		expect(nf.status).toBe(404);
		expect(nf.json).toEqual({ ok: false, error: { code: "notFound", message: "接口不存在" } });
		const mna = await call("DELETE", "/api/echo");
		expect(mna.status).toBe(405);
		expect(mna.res.headers.get("allow")).toBe("POST");
		expect(await call("GET", "/elsewhere")).toMatchObject({ status: 404, json: "unhandled" });
	});

	it("requires a valid bearer token on user routes", async () => {
		expect((await call("GET", "/api/who")).json.error.code).toBe("invalidToken");
		const ok = await call("GET", "/api/who", { headers: { authorization: `Bearer ${token()}` } });
		expect(ok.json).toEqual({ ok: true, data: { userId: "u1", actor: "u1" } });
		const bearerless = await call("GET", "/api/who", { headers: { authorization: `Basic ${token()}` } });
		expect(bearerless.status).toBe(401);
	});

	it("rejects tokens with the wrong issuer, audience, signature or expiry", async () => {
		const other = generateKeyPair();
		const cases = [token({ iss: "someone-else" }), token({ aud: "other" }), token({}, other.privateKey), token({ exp: Math.floor(Date.now() / 1000) - 3600 })];
		for (const t of cases) expect((await call("GET", "/api/who", { headers: { authorization: `Bearer ${t}` } })).status).toBe(401);
	});

	it("public routes decode a token when present, none routes never look at it, raw handlers write directly", async () => {
		expect((await call("GET", "/api/none", { headers: { authorization: `Bearer ${token()}` } })).json.data).toEqual({ identity: null });
		expect(await call("GET", "/api/raw")).toMatchObject({ status: 200, json: "raw!" });
	});
});

describe("hub base path and unhandled requests (end to end)", () => {
	let t: TestHub;
	beforeAll(async () => {
		t = await startHub({ basePath: "/plugins/team" });
	});
	afterAll(() => t.stop());

	it("serves under the base path only", async () => {
		expect((await t.api("GET", "/api/meta")).data.needsSetup).toBe(true);
		const outside = await fetch(`${t.baseUrl.replace("/plugins/team", "")}/api/meta`);
		expect(outside.status).toBe(404);
		expect(await outside.text()).toBe("not handled");
		expect((await fetch(`${t.baseUrl}/something-else`)).status).toBe(404);
	});

	it("handleUpgrade is false until a handler is installed", async () => {
		expect(t.hub.handleUpgrade({} as never, {} as never, Buffer.alloc(0))).toBe(false);
		t.hub.deps.setUpgradeHandler(() => true);
		expect(t.hub.handleUpgrade({} as never, {} as never, Buffer.alloc(0))).toBe(true);
	});
});

describe("extension seams for blocks 2B and 2C", () => {
	let t: TestHub;
	beforeAll(async () => {
		t = await startHub();
	});
	afterAll(() => t.stop());

	it("the service registry registers once and requires existing names", () => {
		const reg = t.hub.registry;
		reg.register("workspaces", { name: "ws" });
		expect(reg.has("workspaces")).toBe(true);
		expect(reg.require<{ name: string }>("workspaces").name).toBe("ws");
		expect(() => reg.register("workspaces", {})).toThrow(/已注册/);
		expect(() => reg.require("nope")).toThrow(/未注册/);
		expect(reg.get("nope")).toBeUndefined();
	});

	it("close hooks run in reverse order and close is idempotent", async () => {
		const order: string[] = [];
		const closing = await startHub();
		closing.hub.deps.onClose(() => void order.push("a"));
		closing.hub.deps.onClose(() => {
			throw new Error("boom");
		});
		closing.hub.deps.onClose(() => void order.push("c"));
		await closing.stop();
		await closing.hub.close();
		expect(order).toEqual(["c", "a"]);
	});
});
