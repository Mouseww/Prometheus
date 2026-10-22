import { describe, expect, it } from "vitest";
import { matchModelDefaults, parseModelCatalog, parsePiModels } from "../src/index.ts";

const catalog = {
	anthropic: {
		models: {
			"claude-sonnet-4": {
				id: "claude-sonnet-4",
				name: "Claude Sonnet 4",
				reasoning: true,
				modalities: { input: ["text", "image"] },
				cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
				limit: { context: 200000, output: 64000 },
			},
		},
	},
	other: { models: { "gpt-x": { id: "gpt-x", reasoning: false, limit: { context: 128000 }, cost: { input: 0, output: 0 } } } },
};

describe("model catalog", () => {
	it("parses models.dev style data", () => {
		const c = parseModelCatalog(catalog);
		expect(c.count).toBe(2);
		const hit = matchModelDefaults(c, ["claude-sonnet-4"])["claude-sonnet-4"];
		expect(hit).toMatchObject({ contextWindow: 200000, maxTokens: 64000, reasoning: true, vision: true });
		expect(hit?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	});

	it("matches ignoring vendor prefix and case, omits unknown, skips zero prices", () => {
		const c = parseModelCatalog(catalog);
		const out = matchModelDefaults(c, ["anthropic/Claude-Sonnet-4", "GPT-X", "nope"]);
		expect(Object.keys(out)).toEqual(["anthropic/Claude-Sonnet-4", "GPT-X"]);
		expect(out["GPT-X"]?.cost).toBeUndefined();
	});

	it("rejects non-object input", () => {
		expect(() => parseModelCatalog([])).toThrow();
	});
});

describe("PI models.json import", () => {
	const json = {
		providers: {
			Corp: {
				baseUrl: "https://llm.example.com/v1",
				api: "openai-completions",
				apiKey: "CORP_KEY",
				authHeader: true,
				models: [{ id: "m1", reasoning: true, input: ["text", "image"], contextWindow: 64000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
			},
			Cmd: { baseUrl: "https://x.example.com", api: "anthropic-messages", apiKey: "!pass show x", models: [{ id: "a" }] },
			Weird: { baseUrl: "https://y.example.com", api: "bedrock", apiKey: "k", models: [{ id: "b" }] },
		},
	};

	it("converts supported providers and resolves env references", () => {
		const out = parsePiModels(json, { CORP_KEY: "secret-1" });
		expect(out.map((o) => o.gateway.id)).toEqual(["corp", "cmd"]);
		const corp = out[0];
		expect(corp?.missingKey).toBe(false);
		expect(corp?.gateway.apiKey).toBe("secret-1");
		expect(corp?.gateway.auth).toEqual({ type: "bearer" });
		expect(corp?.gateway.models[0]).toMatchObject({ id: "m1", vision: true, reasoning: true, contextWindow: 64000 });
	});

	it("never runs shell commands and flags the missing key", () => {
		const cmd = parsePiModels(json, {}).find((o) => o.gateway.id === "cmd");
		expect(cmd?.missingKey).toBe(true);
		expect(cmd?.gateway.apiKey).toBe("");
	});

	it("fills missing keys from auth.json api_key entries only", () => {
		const auth = { cmd: { type: "api_key", key: "from-auth" }, corp: { type: "oauth", access: "x" } };
		const out = parsePiModels(json, {}, auth);
		expect(out.find((o) => o.gateway.id === "cmd")?.gateway.apiKey).toBe("from-auth");
		expect(out.find((o) => o.gateway.id === "corp")?.missingKey).toBe(true);
	});

	it("returns nothing for malformed input", () => {
		expect(parsePiModels(null)).toEqual([]);
		expect(parsePiModels({ providers: 3 })).toEqual([]);
	});
});
