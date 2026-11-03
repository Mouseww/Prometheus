import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });

describe("input history", () => {
	beforeEach(() => {
		store.clear();
		vi.resetModules();
	});

	it("returns the newest first and skips blanks", async () => {
		const { inputAt, rememberInput } = await import("../src/lib/inputHistory.ts");
		rememberInput("第一条");
		rememberInput("   ");
		rememberInput("第二条");
		expect(inputAt(0)).toBe("第二条");
		expect(inputAt(1)).toBe("第一条");
		expect(inputAt(2)).toBeUndefined();
	});

	it("moves a repeated message to the front instead of duplicating it", async () => {
		const { inputAt, rememberInput } = await import("../src/lib/inputHistory.ts");
		rememberInput("a");
		rememberInput("b");
		rememberInput("a");
		expect([inputAt(0), inputAt(1), inputAt(2)]).toEqual(["a", "b", undefined]);
	});

	it("keeps 50 entries and survives a reload", async () => {
		const first = await import("../src/lib/inputHistory.ts");
		for (let i = 0; i < 60; i++) first.rememberInput(`m${i}`);
		expect(first.inputAt(49)).toBe("m10");
		expect(first.inputAt(50)).toBeUndefined();
		vi.resetModules();
		const again = await import("../src/lib/inputHistory.ts");
		expect(again.inputAt(0)).toBe("m59");
	});
});
