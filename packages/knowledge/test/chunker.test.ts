import { describe, expect, it } from "vitest";
import { chunkText } from "../src/chunker.ts";

describe("chunkText", () => {
	it("returns nothing for blank input", () => {
		expect(chunkText("  \r\n ")).toEqual([]);
	});

	it("keeps short text as a single chunk", () => {
		expect(chunkText("hello world")).toEqual(["hello world"]);
	});

	it("respects the size limit and normalizes CRLF", () => {
		const text = Array.from({ length: 50 }, (_, i) => `段落 ${i}。这是一些测试内容。`).join("\r\n\r\n");
		const chunks = chunkText(text, { size: 100, overlap: 20 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(c.length).toBeLessThanOrEqual(120);
			expect(c).not.toContain("\r");
		}
	});

	it("hard-splits text without separators", () => {
		const chunks = chunkText("x".repeat(250), { size: 100, overlap: 0 });
		expect(chunks.join("")).toBe("x".repeat(250));
	});

	it("caps overlap at half the chunk size", () => {
		const chunks = chunkText("a ".repeat(200), { size: 40, overlap: 1000 });
		expect(chunks.length).toBeGreaterThan(1);
	});
});
