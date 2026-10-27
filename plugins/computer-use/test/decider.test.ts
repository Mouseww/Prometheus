import type { ClassifierContext } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GatewayConfig } from "@prometheus/protocol";
import { describe, expect, it } from "vitest";
import { Decider, type DeciderConfig, framing, parseDeciderConfig } from "../src/decider.ts";

const boolQ: ClassifierContext = {
	state: { element: { role: "button", name: "Send" } },
	questions: { irreversible: { type: "bool", instructions: "Irreversible?", criteria: { true: "yes", false: "no" } } },
};

function fakeFetch(handler: (body: Record<string, unknown>, init: RequestInit) => { status?: number; json?: unknown }) {
	const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
	const f = (async (url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		calls.push({ url, body, headers: init.headers as Record<string, string> });
		const r = handler(body, init);
		return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
	}) as unknown as typeof fetch;
	return { f, calls };
}

describe("parseDeciderConfig", () => {
	it("accepts the three kinds and rejects incomplete ones", () => {
		expect(parseDeciderConfig({ kind: "registry", provider: "llama-cpp", model: "laya" })).toEqual({ kind: "registry", provider: "llama-cpp", model: "laya" });
		expect(parseDeciderConfig({ kind: "openai", baseUrl: "ftp://x", model: "m" })).toEqual({ kind: "off" });
		expect(parseDeciderConfig({ kind: "gateway", gatewayId: "g" })).toEqual({ kind: "off" });
		expect(parseDeciderConfig(undefined)).toEqual({ kind: "off" });
	});
});

describe("Decider over OpenAI-compatible chat", () => {
	const cfg: DeciderConfig = { kind: "openai", baseUrl: "http://127.0.0.1:8080/v1", model: "qwen3-0.6b", apiKey: "k" };

	it("reads bool probabilities from logprobs", async () => {
		const { f, calls } = fakeFetch(() => ({
			json: {
				choices: [
					{
						message: { content: "Yes" },
						logprobs: { content: [{ token: "Yes", logprob: Math.log(0.8), top_logprobs: [{ token: "Yes", logprob: Math.log(0.8) }, { token: "No", logprob: Math.log(0.2) }] }] },
					},
				],
			},
		}));
		const d = new Decider(() => cfg, () => [], f);
		const r = await d.ask(undefined, boolQ);
		expect(r?.via).toBe("openai:qwen3-0.6b");
		const a = r!.answers.irreversible!;
		expect(a.type === "bool" && a.probability).toBeCloseTo(0.8);
		expect(calls[0]!.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
		expect(calls[0]!.headers.authorization).toBe("Bearer k");
		expect(calls[0]!.body.temperature).toBe(0);
	});

	it("falls back to the answer text and retries without logprobs on 400", async () => {
		let n = 0;
		const { f, calls } = fakeFetch((body) => {
			n++;
			if (body.logprobs) return { status: 400 };
			return { json: { choices: [{ message: { content: " B." } }] } };
		});
		const d = new Decider(() => cfg, () => [], f);
		const r = await d.ask(undefined, {
			state: {},
			questions: { target: { type: "choice", instructions: "Which?", criteria: { e1: "button Open", e2: "button Send", e3: "link Help" } } },
		});
		expect(n).toBe(2);
		expect(calls[1]!.body.logprobs).toBeUndefined();
		const a = r!.answers.target!;
		expect(a.type === "choice" && a.choice).toBe("e2");
	});

	it("returns undefined (no opinion) on errors instead of throwing", async () => {
		const f = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const d = new Decider(() => cfg, () => [], f);
		expect(await d.ask(undefined, boolQ)).toBeUndefined();
	});

	it("uses a Prometheus gateway's URL and auth", async () => {
		const { f, calls } = fakeFetch(() => ({ json: { choices: [{ message: { content: "No" } }] } }));
		const gw: GatewayConfig = { id: "g1", name: "local", format: "openai-completions", baseUrl: "http://gw/v1/", auth: { type: "header", header: "x-api-key" }, apiKey: "secret", models: [] };
		const d = new Decider(() => ({ kind: "gateway", gatewayId: "g1", model: "tiny" }), () => [gw], f);
		const r = await d.ask(undefined, boolQ);
		expect(calls[0]!.url).toBe("http://gw/v1/chat/completions");
		expect(calls[0]!.headers["x-api-key"]).toBe("secret");
		const a = r!.answers.irreversible!;
		expect(a.type === "bool" && a.probability).toBe(0);
	});
});

describe("Decider over the PI model registry", () => {
	it("auto-picks a native decision model such as Laya", async () => {
		const seen: string[] = [];
		const registry = {
			findOfType: () => undefined,
			getAvailableOfType: async () => [
				{ provider: "llama-cpp", id: "qwen3-4b", api: "llama-cpp-classify" },
				{ provider: "llama-cpp", id: "ggml-org/Laya-GGUF", api: "typesafe-system-one" },
			],
			classify: async (model: { provider: string; id: string }) => {
				seen.push(`${model.provider}/${model.id}`);
				return { stopReason: "stop", answers: { irreversible: { type: "bool", probability: 0.9 } } };
			},
		};
		const ctx = { modelRegistry: registry } as unknown as ExtensionContext;
		const d = new Decider(() => ({ kind: "registry" }), () => []);
		const r = await d.ask(ctx, boolQ);
		expect(seen).toEqual(["llama-cpp/ggml-org/Laya-GGUF"]);
		expect(r?.via).toBe("llama-cpp/ggml-org/Laya-GGUF");
	});
});

describe("framing", () => {
	it("uses single-token labels", () => {
		expect(framing({ type: "bool", instructions: "q", criteria: { true: "a", false: "b" } }).labels).toEqual(["Yes", "No"]);
		expect(framing({ type: "score", instructions: "q", criteria: ["lo", "mid", "hi"] }).labels).toEqual(["0", "1", "2"]);
		expect(framing({ type: "choice", instructions: "q", criteria: { x: "1", y: "2" } }).labels).toEqual(["A", "B"]);
	});
});
