import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ALLOWLIST, RuleSet, builtinRules } from "../src/engine/rules.ts";
import { RestoreWindow } from "../src/engine/sliding.ts";
import { MappingStore } from "../src/engine/store.ts";
import { VeilRelay, restoreEventStream } from "../src/proxy/relay.ts";
import { formatProxyUrl, parseProxyUrl } from "../src/proxy/transport.ts";

describe("parseProxyUrl", () => {
	it("parses http with credentials", () => {
		const p = parseProxyUrl("http://user:pa%40ss@127.0.0.1:8080");
		expect(p).toEqual({ kind: "http", server: "127.0.0.1:8080", username: "user", password: "pa@ss" });
	});

	it("parses socks5 and defaults the port", () => {
		const p = parseProxyUrl("socks5://10.0.0.2");
		expect(p.kind).toBe("socks5");
		expect(p.server).toBe("10.0.0.2:1080");
	});

	it("treats a bare host:port as http", () => {
		expect(parseProxyUrl("127.0.0.1:7890").kind).toBe("http");
	});

	it("returns none for an empty string", () => {
		expect(parseProxyUrl("").kind).toBe("none");
	});

	it("rejects unsupported schemes", () => {
		expect(() => parseProxyUrl("ftp://x:21")).toThrow(/不支持的代理协议/);
	});

	it("round-trips and can mask the password", () => {
		const p = parseProxyUrl("socks5://u:secret@1.2.3.4:1080");
		expect(formatProxyUrl(p)).toBe("socks5://u:secret@1.2.3.4:1080");
		expect(formatProxyUrl(p, true)).toContain("••••");
	});
});

describe("restoreEventStream", () => {
	let dir: string;
	let store: MappingStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "veil-sse-"));
		store = new MappingStore({ path: join(dir, "m.json"), ttlDays: 0 });
	});
	afterEach(async () => {
		await store.flush();
		await rm(dir, { recursive: true, force: true });
	});

	it("restores a placeholder inside an anthropic text delta", () => {
		const token = store.getOrInsert("PHONE", "13800138000");
		const window = new RestoreWindow(store);
		const event = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: `call ${token}` } })}\n\n`;
		const { out } = restoreEventStream(event, window, false);
		expect(out).toContain("13800138000");
		expect(out).not.toContain("{{PHONE_");
	});

	it("restores an openai choices[0].delta.content", () => {
		const token = store.getOrInsert("PHONE", "13800138000");
		const window = new RestoreWindow(store);
		const event = `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`;
		const { out } = restoreEventStream(event, window, false);
		expect(out).toContain("13800138000");
	});

	it("holds a placeholder split across two events", () => {
		const token = store.getOrInsert("PHONE", "13800138000");
		const mid = Math.floor(token.length / 2);
		const window = new RestoreWindow(store);
		const first = `data: ${JSON.stringify({ choices: [{ delta: { content: token.slice(0, mid) } }] })}\n\n`;
		const second = `data: ${JSON.stringify({ choices: [{ delta: { content: token.slice(mid) } }] })}\n\n`;
		let out = restoreEventStream(first, window, false).out;
		out += restoreEventStream(second, window, false).out;
		out += window.flush();
		expect(out).toContain("13800138000");
	});

	it("passes [DONE] through untouched", () => {
		const window = new RestoreWindow(store);
		const { out } = restoreEventStream("data: [DONE]\n\n", window, false);
		expect(out.trim()).toBe("data: [DONE]");
	});

	it("leaves an unfinished event in the remainder", () => {
		const window = new RestoreWindow(store);
		const { out, rest } = restoreEventStream("data: {\"a\":1}\n\ndata: {\"b\"", window, false);
		expect(out).toContain('{"a":1}');
		expect(rest).toBe('data: {"b"');
	});
});

describe("VeilRelay", () => {
	let upstream: Server;
	let relay: VeilRelay;
	let dir: string;
	let store: MappingStore;
	let seen: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];

	const startUpstream = (): Promise<number> =>
		new Promise((resolve) => {
			upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as AddressInfo).port));
		});

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "veil-relay-"));
		store = new MappingStore({ path: join(dir, "m.json"), ttlDays: 0 });
		seen = [];
		upstream = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				seen.push({ body, headers: req.headers });
				const parsed = body ? (JSON.parse(body) as { echo?: string }) : {};
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, echo: parsed.echo ?? null }));
			});
		});
		const port = await startUpstream();
		relay = new VeilRelay({
			host: "127.0.0.1",
			port: 0,
			rules: () => new RuleSet({ rules: builtinRules(), allowlist: DEFAULT_ALLOWLIST }),
			store,
			proxy: () => ({ kind: "none", server: "" }),
			acceptLanguage: () => "en-US,en;q=0.9",
			regionNeutral: () => true,
			bodyLimitBytes: () => 1024 * 1024,
			routes: () => ({}),
			defaultUpstream: () => "",
			log: { info: () => {}, warn: () => {}, error: () => {} },
		});
		// Point the relay at the upstream by giving every request an absolute URL.
		relayPortUpstream = port;
		await relay.start();
	});

	afterEach(async () => {
		await relay.stop();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		await store.flush();
		await rm(dir, { recursive: true, force: true });
	});

	let relayPortUpstream = 0;

	it("starts listening and reports a base url", () => {
		const status = relay.status();
		expect(status.running).toBe(true);
		expect(status.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	});

	it("masks the outbound request body and restores the response", async () => {
		const status = relay.status();
		// A proxy-shaped request carries the absolute URL; the relay forwards to that host.
		const res = await fetch(`${status.baseUrl}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-veil-upstream": `http://127.0.0.1:${relayPortUpstream}` },
			body: JSON.stringify({ echo: "call 13800138000" }),
		});
		expect(res.status).toBe(200);
		// The upstream must never see the raw phone number.
		expect(seen[0]?.body).not.toContain("13800138000");
		expect(seen[0]?.body).toContain("{{PHONE_");
		// The caller gets the original back.
		const json = (await res.json()) as { echo: string };
		expect(json.echo).toBe("call 13800138000");
	});

	it("forces a region-neutral Accept-Language", async () => {
		await fetch(`${relay.status().baseUrl}/v1/x`, {
			headers: { "x-veil-upstream": `http://127.0.0.1:${relayPortUpstream}`, "accept-language": "zh-CN" },
		});
		expect(seen[0]?.headers["accept-language"]).toBe("en-US,en;q=0.9");
		expect(seen[0]?.headers["accept-encoding"]).toBe("identity");
	});

	it("records a hit for the panel", async () => {
		await fetch(`${relay.status().baseUrl}/v1/x`, {
			method: "POST",
			headers: { "x-veil-upstream": `http://127.0.0.1:${relayPortUpstream}`, "content-type": "application/json" },
			body: JSON.stringify({ echo: "13800138000" }),
		});
		const hits = relay.recentHits();
		expect(hits).toHaveLength(1);
		expect(hits[0]?.types).toContain("PHONE");
		expect(hits[0]?.status).toBe(200);
	});

	it("refuses a bare path with no upstream configured", async () => {
		const res = await fetch(`${relay.status().baseUrl}/v1/messages`, { method: "POST", body: "{}" });
		expect(res.status).toBe(500);
	});

	it("forwards a bare SDK path to the route's real upstream", async () => {
		// The SDK sends /v1/x with no host hint; the route table supplies the destination.
		const routed = new VeilRelay({
			host: "127.0.0.1",
			port: 0,
			rules: () => new RuleSet({ rules: builtinRules(), allowlist: DEFAULT_ALLOWLIST }),
			store,
			proxy: () => ({ kind: "none", server: "" }),
			acceptLanguage: () => "en-US,en;q=0.9",
			regionNeutral: () => true,
			bodyLimitBytes: () => 1024 * 1024,
			routes: () => ({ gw: `http://127.0.0.1:${relayPortUpstream}` }),
			defaultUpstream: () => "",
			log: { info: () => {}, warn: () => {}, error: () => {} },
		});
		const started = await routed.start();
		try {
			const res = await fetch(`${started.baseUrl}/v1/x`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ echo: "13800138000" }),
			});
			expect(res.status).toBe(200);
			expect(seen[0]?.body).not.toContain("13800138000");
			expect(((await res.json()) as { echo: string }).echo).toBe("13800138000");
		} finally {
			await routed.stop();
		}
	});
});
