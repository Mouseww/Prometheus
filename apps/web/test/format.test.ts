import { describe, expect, it } from "vitest";
import { cacheRate, fmtTokens } from "../src/lib/format.ts";

describe("fmtTokens", () => {
	it("switches units instead of showing 1000k", () => {
		expect(fmtTokens(999)).toBe("999");
		expect(fmtTokens(1500)).toBe("1.5k");
		expect(fmtTokens(999_949)).toBe("999.9k");
		expect(fmtTokens(999_950)).toBe("1m");
		expect(fmtTokens(1_000_000)).toBe("1m");
		expect(fmtTokens(2_340_000)).toBe("2.3m");
	});
});

describe("cacheRate", () => {
	it("is cacheRead share of prompt tokens", () => {
		expect(cacheRate({ input: 100, cacheRead: 300, cacheWrite: 100 })).toBe(60);
		expect(cacheRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
	});
});
