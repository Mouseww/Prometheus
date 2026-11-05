import { describe, expect, it } from "vitest";
import { createUsageExtractor, usageFromObject } from "../src/llm/usage-extract.ts";
import { joinUpstreamUrl, hasDotSegment } from "../src/llm/url.ts";
import { extractJson } from "../src/llm/internal.ts";
import { sse } from "./s-helpers.ts";

const enc = new TextEncoder();

function run(format: "openai" | "anthropic" | "gemini", contentType: string, body: string, split = 7) {
	const x = createUsageExtractor(format, contentType);
	// Feed in small slices so events straddle chunk boundaries.
	const bytes = enc.encode(body);
	for (let i = 0; i < bytes.length; i += split) x.push(bytes.subarray(i, i + split));
	return x.end();
}

describe("usage extraction from JSON", () => {
	it("openai chat completions and responses", () => {
		expect(run("openai", "application/json", JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }))).toEqual({ inputTokens: 12, outputTokens: 8 });
		expect(run("openai", "application/json", JSON.stringify({ output: [], usage: { input_tokens: 30, output_tokens: 4 } }))).toEqual({ inputTokens: 30, outputTokens: 4 });
		expect(run("openai", "application/json", JSON.stringify({ choices: [] }))).toBeUndefined();
		expect(run("openai", "application/json", "not json")).toBeUndefined();
		expect(run("openai", "application/json", "")).toBeUndefined();
	});

	it("anthropic messages, counting cache tokens as input", () => {
		expect(run("anthropic", "application/json", JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }))).toEqual({ inputTokens: 10, outputTokens: 5 });
		expect(run("anthropic", "application/json", JSON.stringify({ usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 } }))).toEqual({
			inputTokens: 1110,
			outputTokens: 5,
		});
	});

	it("gemini generateContent, with thought tokens as output, and the non-SSE array stream", () => {
		expect(run("gemini", "application/json", JSON.stringify({ usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 14 } }))).toEqual({ inputTokens: 9, outputTokens: 5 });
		const arrayStream = JSON.stringify([{ usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1 } }, { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6 } }]);
		expect(run("gemini", "application/json; charset=UTF-8", arrayStream)).toEqual({ inputTokens: 9, outputTokens: 6 });
	});
});

describe("usage extraction from SSE", () => {
	it("openai chat: usage on the final chunk, [DONE] ignored, null usage on earlier chunks", () => {
		const body = sse([
			{ data: { choices: [{ delta: { content: "He" } }], usage: null } },
			{ data: { choices: [{ delta: { content: "llo" } }], usage: null } },
			{ data: { choices: [], usage: { prompt_tokens: 21, completion_tokens: 13 } } },
			{ data: "[DONE]" },
		]);
		expect(run("openai", "text/event-stream", body)).toEqual({ inputTokens: 21, outputTokens: 13 });
		expect(run("openai", "text/event-stream; charset=utf-8", body, 1)).toEqual({ inputTokens: 21, outputTokens: 13 });
	});

	it("openai responses: usage inside response.completed", () => {
		const body = sse([
			{ event: "response.created", data: { type: "response.created", response: { id: "r", usage: null } } },
			{ event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "x" } },
			{ event: "response.completed", data: { type: "response.completed", response: { id: "r", usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 } } } },
		]);
		expect(run("openai", "text/event-stream", body)).toEqual({ inputTokens: 50, outputTokens: 20 });
	});

	it("anthropic: message_start input plus cumulative message_delta output", () => {
		const body = sse([
			{ event: "message_start", data: { type: "message_start", message: { id: "m", usage: { input_tokens: 25, cache_read_input_tokens: 75, output_tokens: 1 } } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } } },
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		expect(run("anthropic", "text/event-stream", body)).toEqual({ inputTokens: 100, outputTokens: 42 });
		// A later message_delta that repeats a smaller input count does not shrink it.
		const delta = sse([
			{ event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 25, cache_read_input_tokens: 75, output_tokens: 1 } } } },
			{ event: "message_delta", data: { type: "message_delta", usage: { input_tokens: 25, output_tokens: 9 } } },
		]);
		expect(run("anthropic", "text/event-stream", delta)).toEqual({ inputTokens: 100, outputTokens: 9 });
	});

	it("gemini: the last usageMetadata wins", () => {
		const body = sse([
			{ data: { candidates: [{ content: { parts: [{ text: "a" }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1 } } },
			{ data: { candidates: [{ content: { parts: [{ text: "b" }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 } } },
		]);
		expect(run("gemini", "text/event-stream", body)).toEqual({ inputTokens: 8, outputTokens: 4 });
	});

	it("handles CRLF line endings, a missing trailing newline and garbage lines", () => {
		const body = 'data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\r\n\r\n: comment\r\ndata: {broken\r\n\r\ndata: {"usage":{"prompt_tokens":4,"completion_tokens":6}}';
		expect(run("openai", "text/event-stream", body)).toEqual({ inputTokens: 4, outputTokens: 6 });
		expect(run("openai", "text/event-stream", "")).toBeUndefined();
	});

	it("ignores malformed numbers", () => {
		expect(usageFromObject("openai", { usage: { prompt_tokens: "12", completion_tokens: -1 } })).toEqual({ input: undefined, output: undefined });
		expect(usageFromObject("gemini", null)).toEqual({});
	});
});

describe("upstream URL joining", () => {
	it("does not repeat segments shared by the base path and the request path", () => {
		expect(joinUpstreamUrl("https://api.openai.com/v1", "v1/chat/completions")).toBe("https://api.openai.com/v1/chat/completions");
		expect(joinUpstreamUrl("https://api.openai.com/v1", "chat/completions")).toBe("https://api.openai.com/v1/chat/completions");
		expect(joinUpstreamUrl("https://api.anthropic.com", "v1/messages")).toBe("https://api.anthropic.com/v1/messages");
		expect(joinUpstreamUrl("https://x.example.com/proxy/openai/v1", "v1/chat/completions")).toBe("https://x.example.com/proxy/openai/v1/chat/completions");
		expect(joinUpstreamUrl("http://h:8080", "v1beta/models/m:generateContent", new URLSearchParams("alt=sse"))).toBe("http://h:8080/v1beta/models/m:generateContent?alt=sse");
	});

	it("rejects dot segments in raw paths", () => {
		expect(hasDotSegment("v1/chat")).toBe(false);
		expect(hasDotSegment("v1/../x")).toBe(true);
		expect(hasDotSegment("v1/%2e%2e/x")).toBe(true);
		expect(hasDotSegment("v1/%2E/x")).toBe(true);
		expect(hasDotSegment("v1/a%2Fb")).toBe(true);
		expect(hasDotSegment("v1/%zz")).toBe(true);
	});
});

describe("extractJson", () => {
	it("parses plain, fenced and prose-wrapped JSON and rejects the rest", () => {
		expect(extractJson('{"a":1}')).toEqual({ a: 1 });
		expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
		expect(extractJson('Sure! {"a":3} hope that helps')).toEqual({ a: 3 });
		expect(() => extractJson("no json here")).toThrow();
	});
});
