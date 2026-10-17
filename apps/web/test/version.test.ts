import { describe, expect, it } from "vitest";
import { isNewer } from "../src/lib/version.ts";

describe("isNewer", () => {
	it("compares numerically, not as text", () => {
		expect(isNewer("0.4.10", "0.4.9")).toBe(true);
		expect(isNewer("0.5.0", "0.4.99")).toBe(true);
		expect(isNewer("1.0.0", "0.9.9")).toBe(true);
	});

	it("is false for equal and older versions", () => {
		expect(isNewer("0.4.5", "0.4.5")).toBe(false);
		expect(isNewer("0.4.4", "0.4.5")).toBe(false);
	});

	it("accepts a v prefix and uneven lengths", () => {
		expect(isNewer("v0.4.5", "0.4.4")).toBe(true);
		expect(isNewer("0.5", "0.4.9")).toBe(true);
		expect(isNewer("0.4", "0.4.0")).toBe(false);
	});
});
