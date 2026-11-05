import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Collab, sleep, sse, startCollab, startUpstream, type Upstream } from "./s-helpers.ts";

let c: Collab;
let openai: Upstream;
let anthropic: Upstream;
let gemini: Upstream;
let openaiGw: string;
let anthropicGw: string;
let geminiGw: string;

const OPENAI_KEY = "sk-upstream-openai-1111";
const ANTHROPIC_KEY = "sk-ant-upstream-2222";
const GEMINI_KEY = "AIza-upstream-3333";

/** What the fake OpenAI upstream answers; tests replace it. */
let openaiReply: (req: { url: string; body: any }, res: import("node:http").ServerResponse) => void | Promise<void>;
let anthropicReply: (req: { url: string; body: any }, res: import("node:http").ServerResponse) => void | Promise<void>;
let geminiReply: (req: { url: string; body: any }, res: import("node:http").ServerResponse) => void | Promise<void>;

const parse = (body: string): any => {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
};
const json = (res: import("node:http").ServerResponse, body: unknown, status = 200): void => {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
};
const stream = (res: import("node:http").ServerResponse, text: string): void => {
	res.statusCode = 200;
	res.setHeader("content-type", "text/event-stream");
	res.setHeader("cache-control", "no-cache");
	res.end(text);
};

beforeAll(async () => {
	c = await startCollab();
	openai = await startUpstream((req, res, body) => openaiReply({ url: req.url ?? "", body: parse(body) }, res));
	anthropic = await startUpstream((req, res, body) => anthropicReply({ url: req.url ?? "", body: parse(body) }, res));
	gemini = await startUpstream((req, res, body) => geminiReply({ url: req.url ?? "", body: parse(body) }, res));
	const mk = async (body: Record<string, unknown>): Promise<string> => (await c.t.api("POST", "/api/admin/gateways", { token: c.root.token, body })).data.id;
	openaiGw = await mk({ scope: "platform", name: "openai", format: "openai", baseUrl: `${openai.url}/v1`, apiKey: OPENAI_KEY, models: ["gpt-x"] });
	anthropicGw = await mk({ scope: "platform", name: "anthropic", format: "anthropic", baseUrl: anthropic.url, apiKey: ANTHROPIC_KEY, models: ["claude-x"] });
	geminiGw = await mk({ scope: "platform", name: "gemini", format: "gemini", baseUrl: gemini.url, apiKey: GEMINI_KEY, models: ["gemini-x"] });
});
afterAll(async () => {
	await Promise.all([openai.stop(), anthropic.stop(), gemini.stop()]);
	await c.stop();
});

const call = (path: string, init: { token?: string; headers?: Record<string, string>; body?: unknown; method?: string; query?: string } = {}) => {
	const headers: Record<string, string> = { ...init.headers };
	if (init.token) headers.authorization = `Bearer ${init.token}`;
	if (init.body !== undefined) headers["content-type"] = "application/json";
	return fetch(`${c.t.baseUrl}/llm/${path}${init.query ?? ""}`, { method: init.method ?? "POST", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
};

const ledger = async (n: number): Promise<any[]> => {
	for (let i = 0; i < 100; i++) {
		const rows = await c.t.hub.db.query<any>("SELECT * FROM usage_ledger WHERE user_id <> 'system' ORDER BY id");
		if (rows.length >= n) return rows;
		await sleep(20);
	}
	return c.t.hub.db.query<any>("SELECT * FROM usage_ledger WHERE user_id <> 'system' ORDER BY id");
};
const resetLedger = (): Promise<unknown> => c.t.hub.db.tx({ system: true }, (q) => q.query("DELETE FROM usage_ledger"));
const headersOf = (u: Upstream, i = u.requests.length - 1): Record<string, string | string[] | undefined> => u.requests[i]!.headers;
const dump = (u: Upstream): string => JSON.stringify(u.requests);

describe("OpenAI format", () => {
	it("forwards a chat completion unchanged, authenticates upstream with the gateway key, books usage and never leaks the hub token", async () => {
		await resetLedger();
		const payload = { model: "gpt-x", messages: [{ role: "user", content: "hello" }], temperature: 0.2 };
		openaiReply = (_req, res) => json(res, { id: "c1", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
		const r = await call("openai/v1/chat/completions", { token: c.alice.token, body: payload, headers: { "x-api-key": "client-side-secret", cookie: "sid=1" } });
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ id: "c1", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });

		const up = openai.requests.at(-1)!;
		expect(up.url).toBe("/v1/chat/completions");
		expect(up.method).toBe("POST");
		expect(JSON.parse(up.body)).toEqual(payload);
		expect(up.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
		expect(up.headers["x-api-key"]).toBeUndefined();
		expect(up.headers.cookie).toBeUndefined();
		expect(dump(openai)).not.toContain(c.alice.token);
		expect(dump(openai)).not.toContain("client-side-secret");

		const rows = await ledger(1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ user_id: c.alice.userId, org_id: c.root.orgId, gateway_id: openaiGw, model: "gpt-x", source: "platform" });
		expect([Number(rows[0].input_tokens), Number(rows[0].output_tokens)]).toEqual([11, 7]);
	});

	it("serves the same path without the /v1 prefix", async () => {
		openaiReply = (_req, res) => json(res, { usage: { prompt_tokens: 1, completion_tokens: 1 } });
		const r = await call("openai/chat/completions", { token: c.alice.token, body: { model: "gpt-x" } });
		expect(r.status).toBe(200);
		expect(openai.requests.at(-1)!.url).toBe("/v1/chat/completions");
	});

	it("streams SSE through unchanged, asks upstream for usage, and books it from the final chunk", async () => {
		await resetLedger();
		const text = sse([
			{ data: { choices: [{ delta: { content: "Hel" } }], usage: null } },
			{ data: { choices: [{ delta: { content: "lo" } }], usage: null } },
			{ data: { choices: [], usage: { prompt_tokens: 40, completion_tokens: 6 } } },
			{ data: "[DONE]" },
		]);
		openaiReply = (_req, res) => stream(res, text);
		const r = await call("openai/v1/chat/completions", { token: c.bob.token, body: { model: "gpt-x", stream: true } });
		expect(r.headers.get("content-type")).toBe("text/event-stream");
		expect(await r.text()).toBe(text);
		expect(JSON.parse(openai.requests.at(-1)!.body)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
		const rows = await ledger(1);
		expect(rows[0]).toMatchObject({ user_id: c.bob.userId });
		expect([Number(rows[0].input_tokens), Number(rows[0].output_tokens)]).toEqual([40, 6]);
	});

	it("keeps other stream_options the client set", async () => {
		openaiReply = (_req, res) => stream(res, sse([{ data: "[DONE]" }]));
		await (await call("openai/v1/chat/completions", { token: c.bob.token, body: { model: "gpt-x", stream: true, stream_options: { foo: 1 } } })).text();
		expect(JSON.parse(openai.requests.at(-1)!.body).stream_options).toEqual({ foo: 1, include_usage: true });
	});

	it("handles the Responses API (JSON and SSE)", async () => {
		await resetLedger();
		openaiReply = (_req, res) => json(res, { output: [], usage: { input_tokens: 30, output_tokens: 4 } });
		expect((await call("openai/v1/responses", { token: c.alice.token, body: { model: "gpt-x", input: "x" } })).status).toBe(200);
		expect(openai.requests.at(-1)!.url).toBe("/v1/responses");
		const text = sse([
			{ event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "a" } },
			{ event: "response.completed", data: { type: "response.completed", response: { usage: { input_tokens: 50, output_tokens: 20 } } } },
		]);
		openaiReply = (_req, res) => stream(res, text);
		const r = await call("openai/v1/responses", { token: c.alice.token, body: { model: "gpt-x", input: "x", stream: true } });
		expect(await r.text()).toBe(text);
		// Responses requests are not rewritten.
		expect(JSON.parse(openai.requests.at(-1)!.body)).toEqual({ model: "gpt-x", input: "x", stream: true });
		const rows = await ledger(2);
		expect(rows.map((x) => [Number(x.input_tokens), Number(x.output_tokens)])).toEqual([
			[30, 4],
			[50, 20],
		]);
	});
});

describe("Anthropic format", () => {
	it("authenticates with x-api-key upstream, accepts the hub token as x-api-key, and books JSON usage", async () => {
		await resetLedger();
		anthropicReply = (_req, res) => json(res, { id: "m1", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 85, output_tokens: 9 } });
		const r = await call("anthropic/v1/messages", { headers: { "x-api-key": c.alice.token, "anthropic-version": "2024-01-01", "anthropic-beta": "tools-2024" }, body: { model: "claude-x", max_tokens: 10, messages: [] } });
		expect(r.status).toBe(200);
		const up = anthropic.requests.at(-1)!;
		expect(up.url).toBe("/v1/messages");
		expect(up.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
		expect(up.headers.authorization).toBeUndefined();
		expect(up.headers["anthropic-version"]).toBe("2024-01-01");
		expect(up.headers["anthropic-beta"]).toBe("tools-2024");
		expect(dump(anthropic)).not.toContain(c.alice.token);
		const rows = await ledger(1);
		expect(rows[0]).toMatchObject({ gateway_id: anthropicGw, model: "claude-x" });
		expect([Number(rows[0].input_tokens), Number(rows[0].output_tokens)]).toEqual([100, 9]);
	});

	it("adds a default anthropic-version when the client sent none", async () => {
		anthropicReply = (_req, res) => json(res, { usage: { input_tokens: 1, output_tokens: 1 } });
		await call("anthropic/v1/messages", { token: c.alice.token, body: { model: "claude-x" } });
		expect(headersOf(anthropic)["anthropic-version"]).toBe("2023-06-01");
	});

	it("streams events through and books message_start plus message_delta usage", async () => {
		await resetLedger();
		const text = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", usage: { input_tokens: 25, output_tokens: 1 } } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", delta: { type: "text_delta", text: "yo" } } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 33 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		anthropicReply = (_req, res) => stream(res, text);
		const r = await call("anthropic/v1/messages", { token: c.alice.token, body: { model: "claude-x", stream: true } });
		expect(await r.text()).toBe(text);
		const rows = await ledger(1);
		expect([Number(rows[0].input_tokens), Number(rows[0].output_tokens)]).toEqual([25, 33]);
	});
});

describe("Gemini format", () => {
	it("accepts the hub token as ?key=, sends x-goog-api-key upstream without the key param, and books usageMetadata", async () => {
		await resetLedger();
		geminiReply = (_req, res) => json(res, { candidates: [], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, thoughtsTokenCount: 2 } });
		const r = await call("gemini/v1beta/models/gemini-x:generateContent", { query: `?key=${c.alice.token}&alt=json`, body: { contents: [] } });
		expect(r.status).toBe(200);
		const up = gemini.requests.at(-1)!;
		expect(up.url).toBe("/v1beta/models/gemini-x:generateContent?alt=json");
		expect(up.headers["x-goog-api-key"]).toBe(GEMINI_KEY);
		expect(up.headers.authorization).toBeUndefined();
		expect(dump(gemini)).not.toContain(c.alice.token);
		const rows = await ledger(1);
		expect(rows[0]).toMatchObject({ gateway_id: geminiGw, model: "gemini-x" });
		expect([Number(rows[0].input_tokens), Number(rows[0].output_tokens)]).toEqual([9, 5]);
	});

	it("accepts x-goog-api-key from the client as well", async () => {
		geminiReply = (_req, res) => json(res, { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
		const r = await call("gemini/v1beta/models/gemini-x:generateContent", { headers: { "x-goog-api-key": c.bob.token }, body: {} });
		expect(r.status).toBe(200);
		expect(headersOf(gemini)["x-goog-api-key"]).toBe(GEMINI_KEY);
	});

	it("streams SSE and books the last usageMetadata", async () => {
		await resetLedger();
		const text = sse([
			{ data: { candidates: [{ content: { parts: [{ text: "a" }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1 } } },
			{ data: { candidates: [{ content: { parts: [{ text: "b" }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 } } },
		]);
		geminiReply = (_req, res) => stream(res, text);
		const r = await call("gemini/v1beta/models/gemini-x:streamGenerateContent", { token: c.alice.token, query: "?alt=sse", body: {} });
		expect(await r.text()).toBe(text);
		expect(gemini.requests.at(-1)!.url).toBe("/v1beta/models/gemini-x:streamGenerateContent?alt=sse");
		const rows = await ledger(1);
		expect([Number(rows[0].input_tokens), Number(rows[0].output_tokens)]).toEqual([8, 4]);
	});
});

describe("authentication and selection", () => {
	it("requires a valid hub access token for every format", async () => {
		for (const path of ["openai/v1/chat/completions", "anthropic/v1/messages", "gemini/v1beta/models/gemini-x:generateContent"]) {
			const none = await call(path, { body: {} });
			expect(none.status).toBe(401);
			expect((await call(path, { token: "garbage", body: {} })).status).toBe(401);
			expect(((await none.json()) as any).error.code).toBe("invalidToken");
		}
		// The gateway key itself is not an acceptable credential.
		expect((await call("openai/v1/chat/completions", { token: OPENAI_KEY, body: {} })).status).toBe(401);
	});

	it("rejects tokens of disabled users and unknown formats", async () => {
		const dave = await c.t.createUser(c.root.token, "dave@corp.test", "Dave");
		expect((await call("openai/v1/chat/completions", { token: dave.token, body: { model: "gpt-x" } })).status).toBe(200);
		await c.t.api("POST", `/api/admin/users/${dave.userId}/disable`, { token: c.root.token });
		expect((await call("openai/v1/chat/completions", { token: dave.token, body: { model: "gpt-x" } })).status).toBe(401);
		expect((await call("cohere/v1/chat", { token: c.alice.token, body: {} })).status).toBe(404);
	});

	it("rejects models no gateway offers and formats without a gateway", async () => {
		const r = await call("openai/v1/chat/completions", { token: c.alice.token, body: { model: "gpt-unknown" } });
		expect(r.status).toBe(400);
		expect(((await r.json()) as any).error.code).toBe("modelNotAvailable");
		await c.t.api("PUT", `/api/admin/gateways/${geminiGw}`, { token: c.root.token, body: { enabled: false } });
		const none = await call("gemini/v1beta/models/gemini-x:generateContent", { token: c.alice.token, body: {} });
		expect(none.status).toBe(404);
		expect(((await none.json()) as any).error.code).toBe("noGateway");
		await c.t.api("PUT", `/api/admin/gateways/${geminiGw}`, { token: c.root.token, body: { enabled: true } });
	});

	it("prefers an organization gateway over the platform gateway for org members", async () => {
		const orgUp = await startUpstream((_req, res) => json(res, { usage: { prompt_tokens: 2, completion_tokens: 2 } }));
		const g = await c.t.api("POST", "/api/admin/gateways", {
			token: c.root.token,
			body: { scope: "org", scopeId: c.root.orgId, name: "org-openai", format: "openai", baseUrl: orgUp.url, apiKey: "sk-org-upstream", models: ["gpt-x"] },
		});
		await resetLedger();
		const before = openai.requests.length;
		expect((await call("openai/v1/chat/completions", { token: c.alice.token, body: { model: "gpt-x" } })).status).toBe(200);
		expect(orgUp.requests).toHaveLength(1);
		expect(orgUp.requests[0]!.headers.authorization).toBe("Bearer sk-org-upstream");
		expect(orgUp.requests[0]!.url).toBe("/v1/chat/completions");
		expect(openai.requests.length).toBe(before);
		const rows = await ledger(1);
		expect(rows[0]).toMatchObject({ source: "org", gateway_id: g.data.id, org_id: c.root.orgId });
		await c.t.api("DELETE", `/api/admin/gateways/${g.data.id}`, { token: c.root.token });
		await orgUp.stop();
	});

	it("cannot be used to climb out of the gateway base path", async () => {
		const raw = (path: string) =>
			new Promise<number>((resolve, reject) => {
				const url = new URL(c.t.baseUrl);
				const req = httpRequest({ host: url.hostname, port: url.port, method: "POST", path, headers: { authorization: `Bearer ${c.alice.token}` } }, (res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				});
				req.on("error", reject);
				req.end();
			});
		const before = openai.requests.length;
		// URL parsing collapses %2e%2e before routing, so this never matches the proxy route.
		expect(await raw("/llm/openai/v1/%2e%2e/%2e%2e/admin")).toBe(404);
		// An encoded slash would survive parsing; it is refused.
		expect(await raw("/llm/openai/v1/..%2f..%2fadmin")).toBe(400);
		expect(await raw("/llm/openai/v1/a%2fb")).toBe(400);
		expect(openai.requests.length).toBe(before);
	});
});

describe("quota enforcement", () => {
	const setQuota = (subjectType: string, subjectId: string, period: string, limitTokens: number | null) =>
		c.t.api("PUT", "/api/admin/quotas", { token: c.root.token, body: { subjectType, subjectId, period, limitTokens } });
	const hit = (token = c.alice.token) => call("openai/v1/chat/completions", { token, body: { model: "gpt-x" } });
	const addUsage = (userId: string, tokens: number, orgId: string | null = c.root.orgId) =>
		c.t.hub.db.tx({ system: true }, (q) =>
			q.query("INSERT INTO usage_ledger (id, user_id, org_id, model, input_tokens, output_tokens, source, at) VALUES ($1,$2,$3,'gpt-x',$4,0,'platform',$5::timestamptz)", [
				`q${Math.random().toString(36).slice(2)}`,
				userId,
				orgId,
				tokens,
				new Date(Date.now() + c.clock.offset).toISOString(),
			]),
		);
	beforeAll(() => {
		openaiReply = (_req, res) => json(res, { usage: { prompt_tokens: 10, completion_tokens: 8 } });
	});

	it("allows requests below the limit and blocks at exactly the limit with 429 quotaExceeded", async () => {
		await resetLedger();
		await setQuota("user", c.alice.userId, "day", 100);
		await addUsage(c.alice.userId, 99);
		const ok = await hit();
		expect(ok.status).toBe(200);
		await ledger(2);
		// 99 + 18 = 117 used >= 100
		const blocked = await hit();
		expect(blocked.status).toBe(429);
		expect(((await blocked.json()) as any).error).toMatchObject({ code: "quotaExceeded" });
		expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

		await resetLedger();
		await addUsage(c.alice.userId, 100);
		expect((await hit()).status).toBe(429);
		await resetLedger();
		await addUsage(c.alice.userId, 99);
		expect((await hit()).status).toBe(200);
	});

	it("does not call the upstream when blocked, and only affects the limited user", async () => {
		await resetLedger();
		await addUsage(c.alice.userId, 500);
		const before = openai.requests.length;
		expect((await hit()).status).toBe(429);
		expect(openai.requests.length).toBe(before);
		expect((await hit(c.bob.token)).status).toBe(200);
	});

	it("resets with the natural day", async () => {
		await resetLedger();
		await addUsage(c.alice.userId, 500);
		expect((await hit()).status).toBe(429);
		c.clock.offset += 25 * 60 * 60 * 1000;
		expect((await hit()).status).toBe(200);
		c.clock.offset -= 25 * 60 * 60 * 1000;
	});

	it("applies month limits, organization limits, zero limits, and the strictest wins", async () => {
		await setQuota("user", c.alice.userId, "day", null);
		await resetLedger();
		await setQuota("user", c.alice.userId, "month", 1000);
		await addUsage(c.alice.userId, 1000);
		expect((await hit()).status).toBe(429);
		await setQuota("user", c.alice.userId, "month", null);

		// Organization quota counts everyone in the org.
		await resetLedger();
		await setQuota("org", c.root.orgId, "day", 300);
		await addUsage(c.bob.userId, 200);
		expect((await hit()).status).toBe(200);
		await ledger(2);
		await addUsage(c.bob.userId, 200);
		expect((await hit()).status).toBe(429);
		expect((await hit(c.bob.token)).status).toBe(429);
		await setQuota("org", c.root.orgId, "day", null);
		expect((await hit()).status).toBe(200);

		// Zero blocks outright; a generous org limit does not rescue a strict user limit.
		await resetLedger();
		await setQuota("org", c.root.orgId, "month", 1_000_000);
		await setQuota("user", c.bob.userId, "day", 0);
		expect((await hit(c.bob.token)).status).toBe(429);
		expect((await hit()).status).toBe(200);
		await setQuota("user", c.bob.userId, "day", null);
		await setQuota("org", c.root.orgId, "month", null);
	});

	it("does not count Hub-initiated usage against a user", async () => {
		await resetLedger();
		await setQuota("user", c.alice.userId, "day", 100);
		await addUsage("system", 1_000_000);
		expect((await hit()).status).toBe(200);
		await setQuota("user", c.alice.userId, "day", null);
	});
});

describe("failure handling", () => {
	it("passes upstream errors through untouched and records no usage", async () => {
		await resetLedger();
		openaiReply = (_req, res) => json(res, { error: { message: "rate limited upstream" } }, 429);
		const r = await call("openai/v1/chat/completions", { token: c.alice.token, body: { model: "gpt-x" } });
		expect(r.status).toBe(429);
		expect(await r.json()).toEqual({ error: { message: "rate limited upstream" } });
		await sleep(100);
		expect(await c.t.hub.db.query("SELECT 1 FROM usage_ledger")).toHaveLength(0);
	});

	it("answers 502 when the upstream is unreachable", async () => {
		await c.t.api("PUT", `/api/admin/gateways/${openaiGw}`, { token: c.root.token, body: { baseUrl: "http://127.0.0.1:9/v1" } });
		const r = await call("openai/v1/chat/completions", { token: c.alice.token, body: { model: "gpt-x" } });
		expect(r.status).toBe(502);
		expect(((await r.json()) as any).error.code).toBe("upstreamError");
		await c.t.api("PUT", `/api/admin/gateways/${openaiGw}`, { token: c.root.token, body: { baseUrl: `${openai.url}/v1` } });
	});

	it("aborts the upstream request when the client goes away", async () => {
		let upstreamClosed = false;
		let started: () => void = () => {};
		const startedP = new Promise<void>((r) => (started = r));
		openaiReply = (_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(sse([{ data: { choices: [{ delta: { content: "x" } }] } }]));
			res.on("close", () => {
				upstreamClosed = true;
			});
			started();
			// never ends
		};
		const ac = new AbortController();
		const res = await fetch(`${c.t.baseUrl}/llm/openai/v1/chat/completions`, {
			method: "POST",
			headers: { authorization: `Bearer ${c.alice.token}`, "content-type": "application/json" },
			body: JSON.stringify({ model: "gpt-x", stream: true }),
			signal: ac.signal,
		});
		await startedP;
		const reader = res.body!.getReader();
		await reader.read();
		ac.abort();
		await reader.cancel().catch(() => {});
		for (let i = 0; i < 100 && !upstreamClosed; i++) await sleep(20);
		expect(upstreamClosed).toBe(true);
	});
});
