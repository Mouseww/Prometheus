import { expect, test } from "vitest";
import { SettingsManager, shouldCompact } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACT_PERCENT, MAX_COMPACT_PERCENT, MIN_COMPACT_PERCENT } from "@prometheus/protocol";
import { applyCompactPercent, reserveForPercent } from "../src/agent/pi/compaction.ts";

const MODEL = { provider: "test", id: "m" } as never;
const WINDOW = 200_000;

test("percent turns into the headroom PI compares against", () => {
	expect(reserveForPercent(80, WINDOW)).toBe(40_000);
	expect(reserveForPercent(50, WINDOW)).toBe(100_000);
	expect(reserveForPercent(95, WINDOW)).toBe(10_000);
});

test("out-of-range percentages are clamped, not honoured", () => {
	expect(reserveForPercent(0, WINDOW)).toBe(Math.round(WINDOW * (1 - MIN_COMPACT_PERCENT / 100)));
	expect(reserveForPercent(100, WINDOW)).toBe(Math.round(WINDOW * (1 - MAX_COMPACT_PERCENT / 100)));
	// A number that is not a number falls back to the default, not to the low bound.
	expect(reserveForPercent(Number.NaN, WINDOW)).toBe(reserveForPercent(DEFAULT_COMPACT_PERCENT, WINDOW));
});

test("a model with no known window is left alone", () => {
	const sm = SettingsManager.inMemory({});
	const before = sm.getCompactionSettings(MODEL).reserveTokens;
	applyCompactPercent(sm, 60, 0);
	expect(sm.getCompactionSettings(MODEL).reserveTokens).toBe(before);
});

test("the threshold really moves when PI decides to compact", () => {
	const at = (percent: number) => {
		const sm = SettingsManager.inMemory({});
		applyCompactPercent(sm, percent, WINDOW);
		return sm.getCompactionSettings(MODEL);
	};
	const early = at(60);
	const late = at(90);

	// 150k tokens of a 200k window: full enough for 60%, roomy enough for 90%.
	const tokens = 150_000;
	expect(shouldCompact(tokens, WINDOW, early)).toBe(true);
	expect(shouldCompact(tokens, WINDOW, late)).toBe(false);

	// Somewhere between the two thresholds the answers must differ, which is what the slider buys.
	expect(early.reserveTokens).toBeGreaterThan(late.reserveTokens);
});

test("the default keeps PI's own behaviour available", () => {
	expect(DEFAULT_COMPACT_PERCENT).toBeGreaterThanOrEqual(MIN_COMPACT_PERCENT);
	expect(DEFAULT_COMPACT_PERCENT).toBeLessThanOrEqual(MAX_COMPACT_PERCENT);
});
