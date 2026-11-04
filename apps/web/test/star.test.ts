// The star prompt is only acceptable because it cannot nag. These tests pin that: never before real use, never twice,
// and silence once the user has answered either way.
import { beforeEach, describe, expect, it, vi } from "vitest";

function fakeStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		clear: () => map.clear(),
	};
}

const KEY = "prometheus.star";

/** Fresh module per test: the store and the "already requested" flag are module state. */
async function load() {
	vi.resetModules();
	return import("../src/lib/star.ts");
}

describe("star prompt", () => {
	beforeEach(() => {
		vi.stubGlobal("localStorage", fakeStorage());
	});

	it("does not ask on the first day", async () => {
		const { noteUse, useStar } = await load();
		noteUse();
		expect(useStar.getState().asking).toBe(false);
	});

	it("does not ask twice on the same day, however many runs finish", async () => {
		const { noteUse, useStar } = await load();
		for (let i = 0; i < 10; i++) noteUse();
		expect(useStar.getState().asking).toBe(false);
	});

	it("asks once a second day of use has a finished run", async () => {
		const { noteUse, useStar } = await load();
		// A finished run yesterday, then one today.
		localStorage.setItem(KEY, JSON.stringify({ asked: false, done: false, days: ["2020-01-01"] }));
		noteUse();
		expect(useStar.getState().asking).toBe(true);
	});

	it("never asks again after the user answered, whichever way", async () => {
		for (const starred of [true, false]) {
			vi.stubGlobal("localStorage", fakeStorage());
			const { answerStar, noteUse, useStar } = await load();
			localStorage.setItem(KEY, JSON.stringify({ asked: false, done: false, days: ["2020-01-01"] }));
			noteUse();
			expect(useStar.getState().asking).toBe(true);
			answerStar(starred);
			expect(useStar.getState().asking).toBe(false);

			// Later days of real use must not bring it back.
			noteUse();
			expect(useStar.getState().asking).toBe(false);
			const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
			expect(saved.asked).toBe(true);
		}
	});

	it("stays silent when the storage says the user already starred", async () => {
		localStorage.setItem(KEY, JSON.stringify({ asked: true, done: true, days: ["2020-01-01"] }));
		const { noteUse, useStar } = await load();
		noteUse();
		expect(useStar.getState().asking).toBe(false);
	});

	it("keeps the day list bounded so storage cannot grow without limit", async () => {
		const { noteUse } = await load();
		for (let i = 0; i < 60; i++) noteUse();
		const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		expect(saved.days.length).toBeLessThanOrEqual(30);
	});

	it("survives corrupt storage instead of throwing", async () => {
		localStorage.setItem(KEY, "{not json");
		const { noteUse, useStar } = await load();
		expect(() => noteUse()).not.toThrow();
		expect(useStar.getState().asking).toBe(false);
	});

	it("hides the count when GitHub cannot be reached, without retrying", async () => {
		const { loadStars, useStar } = await load();
		const fetchMock = vi.fn(async () => {
			throw new Error("offline");
		});
		vi.stubGlobal("fetch", fetchMock);
		await loadStars();
		expect(useStar.getState().failed).toBe(true);
		expect(useStar.getState().stars).toBeNull();
		// Once per app run: the About page and the card share one request.
		await loadStars();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("shows the count when the request succeeds", async () => {
		const { loadStars, useStar } = await load();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ stargazers_count: 1234 }) })),
		);
		await loadStars();
		expect(useStar.getState().stars).toBe(1234);
		expect(useStar.getState().failed).toBe(false);
	});
});
