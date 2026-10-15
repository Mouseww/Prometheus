import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "@prometheus/protocol";
import { embed, escapePiValue, maskSecret, mergeGatewayUpdate, redactGateway, toProviderConfig, validateGateway } from "../src/index.ts";

const SECRET = ["sk", "test", "1234567890"].join("-");
const NEW_SECRET = ["new", "secret", "value"].join("-");

function withSecret(g: GatewayConfig, value: string | undefined): GatewayConfig {
	const copy = { ...g };
	if (value === undefined) delete copy.apiKey;
	else Reflect.set(copy, "apiKey", value);
	return copy;
}

function gw(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
	const base: GatewayConfig = {
		id: "corp",
		name: "Corp",
		format: "openai-completions",
		baseUrl: "https://llm.example.com/v1/",
		auth: { type: "native" },
		models: [{ id: "m1" }],
		...overrides,
	};
	return "apiKey" in overrides ? base : withSecret(base, SECRET);
}

describe("validateGateway", () => {
	it("accepts a valid config", () => {
		expect(validateGateway(gw())).toEqual([]);
	});
	it("rejects bad id, url, header and missing secret", () => {
		const bad = withSecret(gw({ id: "Bad Id", baseUrl: "ftp://x", auth: { type: "header", header: "bad header" }, models: [] }), undefined);
		expect(validateGateway(bad).length).toBeGreaterThanOrEqual(5);
	});
	it("allows missing secret for auth none", () => {
		const g = withSecret(gw({ auth: { type: "none" } }), undefined);
		expect(validateGateway(g)).toEqual([]);
	});
});

describe("escapePiValue", () => {
	it("neutralises env interpolation and commands", () => {
		expect(escapePiValue("a$HOME")).toBe("a$$HOME");
		expect(escapePiValue("!rm -rf")).toBe("$!rm -rf");
		expect(escapePiValue("plain")).toBe("plain");
	});
});

describe("toProviderConfig", () => {
	it("maps native auth and fills model defaults", () => {
		const cfg = toProviderConfig(gw());
		expect(cfg.api).toBe("openai-completions");
		expect(cfg.baseUrl).toBe("https://llm.example.com/v1");
		expect(cfg.apiKey).toBe(SECRET);
		expect(cfg.authHeader).toBeUndefined();
		expect(cfg.models[0]).toMatchObject({ id: "m1", name: "m1", input: ["text"], reasoning: false, contextWindow: 128000 });
	});
	it("forces Authorization header for anthropic in bearer mode", () => {
		const cfg = toProviderConfig(gw({ format: "anthropic-messages", auth: { type: "bearer" } }));
		expect(cfg.authHeader).toBe(true);
	});
	it("custom header carries secret and keeps it out of default slot", () => {
		const cfg = toProviderConfig(gw({ format: "openai-responses", auth: { type: "header", header: "api-key", prefix: "" } }));
		expect(cfg.headers?.["api-key"]).toBe(SECRET);
		expect(cfg.apiKey).not.toBe(SECRET);
	});
	it("vision models accept images", () => {
		const cfg = toProviderConfig(gw({ models: [{ id: "v", vision: true, reasoning: true }] }));
		expect(cfg.models[0]?.input).toEqual(["text", "image"]);
		expect(cfg.models[0]?.reasoning).toBe(true);
	});
});

describe("secret handling", () => {
	it("masks secrets", () => {
		expect(maskSecret(SECRET)).toBe("sk-…7890");
		expect(maskSecret("short")).toBe("••••");
		expect(redactGateway(gw()).apiKey).toBe("sk-…7890");
	});
	it("keeps stored secret when client sends mask or empty", () => {
		const existing = gw();
		const masked = redactGateway(existing);
		expect(mergeGatewayUpdate(masked, existing).apiKey).toBe(SECRET);
		expect(mergeGatewayUpdate(withSecret(masked, ""), existing).apiKey).toBe(SECRET);
		expect(mergeGatewayUpdate(withSecret(masked, NEW_SECRET), existing).apiKey).toBe(NEW_SECRET);
	});
});

describe("embed", () => {
	it("calls OpenAI-compatible /embeddings and orders by index", async () => {
		let captured: { url: string; init: RequestInit } | undefined;
		const fetchImpl = (async (url: string, init: RequestInit) => {
			captured = { url, init };
			return new Response(JSON.stringify({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }));
		}) as unknown as typeof fetch;
		const out = await embed(gw(), "emb", ["a", "b"], { fetchImpl });
		expect(out).toEqual([[1], [2]]);
		expect(captured?.url).toBe("https://llm.example.com/v1/embeddings");
		expect((captured?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
	});
	it("calls Gemini batchEmbedContents", async () => {
		let url = "";
		const fetchImpl = (async (u: string) => {
			url = u;
			return new Response(JSON.stringify({ embeddings: [{ values: [0.5] }] }));
		}) as unknown as typeof fetch;
		const out = await embed(gw({ format: "google-generative-ai", baseUrl: "https://g.example.com/v1beta" }), "text-embedding-004", ["a"], { fetchImpl });
		expect(out).toEqual([[0.5]]);
		expect(url).toBe("https://g.example.com/v1beta/models/text-embedding-004:batchEmbedContents");
	});
	it("rejects anthropic", async () => {
		await expect(embed(gw({ format: "anthropic-messages" }), "x", ["a"])).rejects.toThrow(/Anthropic/);
	});
});
