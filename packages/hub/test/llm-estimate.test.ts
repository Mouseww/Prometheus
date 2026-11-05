import { describe, expect, it } from "vitest";
import { estimateInputTokens } from "../src/llm/estimate.ts";

describe("estimateInputTokens", () => {
	it("counts text as characters / 4 across every string in the request", () => {
		const body = { model: "m", messages: [{ role: "user", content: "a".repeat(400) }, { role: "assistant", content: [{ type: "text", text: "b".repeat(396) }] }] };
		// "m" + "user" + 400 + "assistant" + "text" + 396 characters.
		expect(estimateInputTokens(body, 0)).toBe(Math.ceil((1 + 4 + 400 + 9 + 4 + 396) / 4));
	});

	it("charges inline blobs a flat amount instead of their encoded length", () => {
		const dataUrl = { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(1_000_000)}` } };
		const anthropic = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(1_000_000) } };
		const gemini = { inlineData: { mimeType: "image/png", data: "A".repeat(1_000_000) } };
		for (const part of [dataUrl, anthropic, gemini]) {
			const n = estimateInputTokens({ contents: [part] }, 0);
			expect(n).toBeGreaterThanOrEqual(1500);
			expect(n).toBeLessThan(1700);
		}
	});

	it("falls back to the raw size when the body is not JSON", () => {
		expect(estimateInputTokens(undefined, 4001)).toBe(1001);
		expect(estimateInputTokens(null, 0)).toBe(0);
	});
});
