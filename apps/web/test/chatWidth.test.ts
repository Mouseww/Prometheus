import { describe, expect, it } from "vitest";
import { preferenceFromDrag, resolveChatWidth } from "../src/lib/chatWidth.ts";

describe("resolveChatWidth", () => {
	it("adapts to the window when there is no preference", () => {
		expect(resolveChatWidth(3000, null)).toBe(1040);
		expect(resolveChatWidth(1000, null)).toBe(768);
		expect(resolveChatWidth(1400, null)).toBeCloseTo(1008);
	});
	it("clamps a preference to the window without losing it", () => {
		expect(resolveChatWidth(3000, 1400)).toBe(1400);
		expect(resolveChatWidth(900, 1400)).toBe(804);
		expect(resolveChatWidth(3000, 100)).toBe(640);
	});
});

describe("preferenceFromDrag", () => {
	it("follows the drag when not clamped", () => {
		expect(preferenceFromDrag(3000, 1200, 1200, 1300)).toBe(1300);
	});
	it("a nudge outward in a small window keeps the wider saved width", () => {
		const display = resolveChatWidth(900, 1400);
		expect(preferenceFromDrag(900, 1400, display, display + 10)).toBe(1400);
	});
});
