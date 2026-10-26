import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GatewayConfig } from "@prometheus/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayRelay, gatewayAuth, upstreamUrl } from "../src/agent/relay/gateway-relay.ts";

let upstream: Server;
let seen: { url: string; headers: IncomingHttpHeaders; body: string }[];
let respond: (res: import("node:http").ServerResponse) => void;
let relay: GatewayRelay;
let gw: GatewayConfig;

const make = (over: Partial<GatewayConfig> = {}): GatewayConfig => ({
	id: "g1",
	name: "g",
	format: "anthropic-messages",
	baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
	auth: { type: "native" },
	apiKey: "REAL-KEY",
	models: [],
	...over,
});

beforeEach(async () => {
	seen = [];
	respond = (res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	};
	upstream = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
			respond(res);
		});
	});
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
	gw = make();
});
afterEach(async () => {
	await relay?.stop();
	await new Promise<void>((r) => upstream.close(() => r()));
});

describe("GatewayRelay", () => {
	it("injects the real key, drops the session token, and forwards path and body", async () => {
		relay = new GatewayRelay();
		await relay.start();
		const grant = relay.grant("s1", "g1", () => gw);
		const res = await fetch(`${grant.baseUrl}/v1/messages?beta=1`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${grant.token}`, "anthropic-version": "2023-06-01" },
			body: JSON.stringify({ hi: 1 }),
		});
		expect(await res.json()).toEqual({ ok: true });
		expect(seen).toHaveLength(1);
		expect(seen[0]!.url).toBe("/v1/messages?beta=1");
		expect(seen[0]!.body).toBe('{"hi":1}');
		expect(seen[0]!.headers["x-api-key"]).toBe("REAL-KEY");
		expect(seen[0]!.headers.authorization).toBeUndefined();
		expect(JSON.stringify(seen[0]!.headers)).not.toContain(grant.token);
		expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
	});

	it("rejects unknown and revoked tokens, also via x-api-key", async () => {
		relay = new GatewayRelay();
		await relay.start();
		const grant = relay.grant("s1", "g1", () => gw);
		expect((await fetch(`${grant.baseUrl}/v1/x`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
		expect((await fetch(`${grant.baseUrl}/v1/x`, { headers: { "x-api-key": grant.token } })).status).toBe(200);
		grant.revoke();
		expect((await fetch(`${grant.baseUrl}/v1/x`, { headers: { "x-api-key": grant.token } })).status).toBe(401);
		expect(seen).toHaveLength(1);
	});

	it("reads the gateway per request so a rotated key applies to running sessions", async () => {
		relay = new GatewayRelay();
		await relay.start();
		const grant = relay.grant("s1", "g1", () => gw);
		await fetch(`${grant.baseUrl}/v1/x`, { headers: { authorization: `Bearer ${grant.token}` } });
		gw = { ...gw, apiKey: "ROTATED" };
		await fetch(`${grant.baseUrl}/v1/x`, { headers: { authorization: `Bearer ${grant.token}` } });
		expect(seen.map((s) => s.headers["x-api-key"])).toEqual(["REAL-KEY", "ROTATED"]);
		gw = { ...gw, enabled: false };
		expect((await fetch(`${grant.baseUrl}/v1/x`, { headers: { authorization: `Bearer ${grant.token}` } })).status).toBe(502);
	});

	it("applies request and response hooks and reports the exchange", async () => {
		const exchanges: any[] = [];
		relay = new GatewayRelay({
			onRequest: (_i, body) => Buffer.from(body.toString().replace("secret", "<P1>")),
			onResponse: () => ({ write: (t) => t.replaceAll("<P1>", "secret"), end: () => "" }),
			onExchange: (e) => exchanges.push(e),
		});
		await relay.start();
		respond = (res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: <P");
			setTimeout(() => res.end("1> done\n\n"), 10);
		};
		const grant = relay.grant("s1", "g1", () => gw);
		const res = await fetch(`${grant.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${grant.token}` }, body: "my secret" });
		const text = await res.text();
		expect(seen[0]!.body).toBe("my <P1>");
		// the rewriter in this test is naive (no window), so only the whole placeholder is restored
		expect(text).toContain("data: <P");
		expect(exchanges).toHaveLength(1);
		expect(exchanges[0]).toMatchObject({ sessionId: "s1", gatewayId: "g1", path: "/v1/messages", status: 200 });
	});

	it("fails the request when the request hook throws, without contacting upstream", async () => {
		relay = new GatewayRelay({ onRequest: () => { throw new Error("rules broke"); } });
		await relay.start();
		const grant = relay.grant("s1", "g1", () => gw);
		const res = await fetch(`${grant.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${grant.token}` }, body: "x" });
		expect(res.status).toBe(502);
		expect(await res.text()).toContain("rules broke");
		expect(seen).toHaveLength(0);
	});

	it("streams upstream chunks as they arrive", async () => {
		relay = new GatewayRelay();
		await relay.start();
		respond = (res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: 1\n\n");
			setTimeout(() => res.end("data: 2\n\n"), 80);
		};
		const grant = relay.grant("s1", "g1", () => gw);
		const res = await fetch(`${grant.baseUrl}/v1/messages`, { headers: { authorization: `Bearer ${grant.token}` } });
		const reader = res.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toBe("data: 1\n\n");
		const rest = new TextDecoder().decode((await reader.read()).value);
		expect(rest).toBe("data: 2\n\n");
	});
});

describe("helpers", () => {
	const g = (over: Partial<GatewayConfig>): GatewayConfig => ({ id: "g", name: "g", format: "openai-responses", baseUrl: "https://api.example.com/v1", auth: { type: "bearer" }, apiKey: "K", models: [], ...over });
	it("joins base and path without doubling /v1", () => {
		expect(upstreamUrl(g({}), new URL("/v1/responses?x=1", "http://r")).toString()).toBe("https://api.example.com/v1/responses?x=1");
		expect(upstreamUrl(g({ baseUrl: "https://a.com/" }), new URL("/v1/messages", "http://r")).toString()).toBe("https://a.com/v1/messages");
		expect(upstreamUrl(g({ baseUrl: "https://a.com/api/v1" }), new URL("/v1/chat", "http://r")).toString()).toBe("https://a.com/api/v1/chat");
	});
	it("builds auth headers per mode", () => {
		expect(gatewayAuth(g({}))).toEqual({ authorization: "Bearer K" });
		expect(gatewayAuth(g({ format: "anthropic-messages", auth: { type: "native" } }))).toEqual({ "x-api-key": "K" });
		expect(gatewayAuth(g({ auth: { type: "header", header: "x-k", prefix: "t " }, headers: { a: "b" } }))).toEqual({ a: "b", "x-k": "t K" });
		expect(gatewayAuth(g({ auth: { type: "none" } }))).toEqual({});
	});
});
