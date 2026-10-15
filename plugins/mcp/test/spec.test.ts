import { describe, expect, it } from "vitest";
import { MASK, mergeSpec, parseSpec, redactSpec, toPiConfig } from "../src/spec.ts";

describe("mcp spec", () => {
	it("parses stdio and http servers", () => {
		expect(parseSpec({ type: "stdio", command: " npx ", args: ["-y", "srv"] })).toMatchObject({ type: "stdio", command: "npx", enabled: true });
		expect(parseSpec({ type: "http", url: "https://x.example/mcp" }).url).toBe("https://x.example/mcp");
	});

	it("rejects invalid input", () => {
		expect(() => parseSpec({ type: "ws" })).toThrow();
		expect(() => parseSpec({ type: "stdio" })).toThrow();
		expect(() => parseSpec({ type: "http", url: "file:///etc/passwd" })).toThrow();
		expect(() => parseSpec({ type: "http", url: "https://x", headers: { "bad header": "v" } })).toThrow();
		expect(() => parseSpec({ type: "stdio", command: "x", exposure: "everything" })).toThrow();
	});

	it("masks secrets but keeps env references visible, and restores masked values on save", () => {
		const stored = parseSpec({ type: "http", url: "https://x", headers: { Authorization: "Bearer s3cret", "X-Env": "${TOKEN}" } });
		const shown = redactSpec(stored);
		expect(shown.headers).toEqual({ Authorization: MASK, "X-Env": "${TOKEN}" });
		const merged = mergeSpec(parseSpec(shown), stored);
		expect(merged.headers?.Authorization).toBe("Bearer s3cret");
	});

	it("maps to PI's config shape", () => {
		expect(toPiConfig(parseSpec({ type: "stdio", command: "srv", exposure: "direct" }))).toMatchObject({ type: "stdio", command: "srv", exposure: "direct" });
	});
});
