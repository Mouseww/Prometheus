import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "@prometheus/protocol";
import { embed, escapePiValue, maskSecret, mergeGatewayUpdate, normalizeProviderBaseUrl, redactGateway, requiresAdaptiveThinking, toProviderConfig, transcribe, validateGateway } from "../src/index.ts";

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
	it("marks Claude 5.5 Anthropic models as adaptive-thinking", () => {
		const cfg = toProviderConfig(
			gw({
				format: "anthropic-messages",
				models: [
					{ id: "claude-sonnet-5-5", reasoning: true },
					{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", reasoning: true },
					{ id: "claude-opus-4-6", reasoning: true },
					{ id: "claude-sonnet-4-5", reasoning: true },
					{ id: "claude-3-5-sonnet", reasoning: true },
				],
			}),
		);
		expect(cfg.models[0]?.compat?.forceAdaptiveThinking).toBe(true);
		expect(cfg.models[0]?.thinkingLevelMap?.off).toBeNull();
		expect(cfg.models[1]?.compat?.forceAdaptiveThinking).toBe(true);
		expect(cfg.models[2]?.compat?.forceAdaptiveThinking).toBe(true);
		expect(cfg.models[3]?.compat).toBeUndefined();
		expect(cfg.models[3]?.thinkingLevelMap?.off).toBeUndefined();
		expect(cfg.models[3]?.thinkingLevelMap).toBeUndefined();
		expect(cfg.models[4]?.compat).toBeUndefined();
	});
	it("maps xhigh/max only when opted in on a reasoning model", () => {
		const cfg = toProviderConfig(
			gw({ models: [{ id: "a", reasoning: true, xhigh: true }, { id: "b", reasoning: true, xhigh: true, max: true }, { id: "c", xhigh: true }, { id: "d", reasoning: true }] }),
		);
		expect(cfg.models[0]?.thinkingLevelMap).toEqual({ xhigh: "xhigh" });
		expect(cfg.models[1]?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
		expect(cfg.models[2]?.thinkingLevelMap).toBeUndefined();
		expect(cfg.models[3]?.thinkingLevelMap).toBeUndefined();
	});
	it("does not force adaptive thinking on OpenAI-format Claude proxies", () => {
		const cfg = toProviderConfig(gw({ models: [{ id: "claude-sonnet-5-5", reasoning: true }] }));
		expect(cfg.models[0]?.compat).toBeUndefined();
	});
	it("strips a trailing /v1 from Anthropic base URLs", () => {
		const withV1 = toProviderConfig(gw({ format: "anthropic-messages", baseUrl: "https://agirouter.example.com/v1/" }));
		expect(withV1.baseUrl).toBe("https://agirouter.example.com");
		const hostOnly = toProviderConfig(gw({ format: "anthropic-messages", baseUrl: "https://agirouter.example.com" }));
		expect(hostOnly.baseUrl).toBe("https://agirouter.example.com");
	});
});

describe("normalizeProviderBaseUrl", () => {
	it("keeps OpenAI /v1 and strips it only for Anthropic", () => {
		expect(normalizeProviderBaseUrl("openai-completions", "https://llm.example.com/v1/")).toBe("https://llm.example.com/v1");
		expect(normalizeProviderBaseUrl("anthropic-messages", "https://llm.example.com/v1")).toBe("https://llm.example.com");
	});
});

describe("requiresAdaptiveThinking", () => {
	it("matches current Claude families that reject thinking.type=enabled", () => {
		expect(requiresAdaptiveThinking("claude-sonnet-5-5")).toBe(true);
		expect(requiresAdaptiveThinking("claude-haiku-5-5")).toBe(true);
		expect(requiresAdaptiveThinking("claude-opus-5")).toBe(true);
		expect(requiresAdaptiveThinking("claude-sonnet-4-5")).toBe(false);
		expect(requiresAdaptiveThinking("gpt-4.1")).toBe(false);
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

describe("transcribe", () => {
	const audio = new Uint8Array([1, 2, 3]);

	it("posts multipart audio to /audio/transcriptions without a forced content-type", async () => {
		let captured: { url: string; init: RequestInit } | undefined;
		const fetchImpl = (async (url: string, init: RequestInit) => {
			captured = { url, init };
			return new Response(JSON.stringify({ text: "  \u4f60\u597d\u4e16\u754c  " }));
		}) as unknown as typeof fetch;
		const text = await transcribe(gw(), "whisper-1", audio, "audio/webm;codecs=opus", { fetchImpl, language: "zh" });
		expect(text).toBe("\u4f60\u597d\u4e16\u754c");
		expect(captured?.url).toBe("https://llm.example.com/v1/audio/transcriptions");
		const headers = captured?.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
		expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("content-type");
		const form = captured?.init.body as FormData;
		expect(form.get("model")).toBe("whisper-1");
		expect(form.get("language")).toBe("zh");
		const file = form.get("file") as File;
		expect(file.name).toBe("speech.webm");
		expect(file.type).toBe("audio/webm");
	});

	it("sends Gemini audio inline through generateContent", async () => {
		let body: { contents: { parts: Record<string, unknown>[] }[] } | undefined;
		let url = "";
		const fetchImpl = (async (u: string, init: RequestInit) => {
			url = u;
			body = JSON.parse(String(init.body));
			return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello " }, { text: "there" }] } }] }));
		}) as unknown as typeof fetch;
		const text = await transcribe(gw({ format: "google-generative-ai", baseUrl: "https://g.example.com/v1beta" }), "gemini-2.0-flash", audio, "audio/webm", { fetchImpl });
		expect(text).toBe("hello there");
		expect(url).toBe("https://g.example.com/v1beta/models/gemini-2.0-flash:generateContent");
		expect(body?.contents[0]?.parts[1]).toEqual({ inlineData: { mimeType: "audio/webm", data: "AQID" } });
	});

	it("surfaces HTTP errors and rejects anthropic", async () => {
		const fetchImpl = (async () => new Response("no such model", { status: 404 })) as unknown as typeof fetch;
		await expect(transcribe(gw(), "x", audio, "audio/webm", { fetchImpl })).rejects.toThrow(/404 no such model/);
		await expect(transcribe(gw({ format: "anthropic-messages" }), "x", audio, "audio/webm")).rejects.toThrow(/Anthropic/);
	});
});
