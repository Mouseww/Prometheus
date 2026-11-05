import { describe, expect, it } from "vitest";
import { defaultHomeTab, HOME_TAB_KEY_PREFIX, rememberHomeTab, resolveHomeTab, type TabStore } from "../src/team/logic/homeTab.ts";

function memStore(initial: Record<string, string> = {}): TabStore & { data: Map<string, string> } {
	const data = new Map(Object.entries(initial));
	return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const throwing: TabStore = {
	getItem: () => {
		throw new Error("blocked");
	},
	setItem: () => {
		throw new Error("blocked");
	},
};

describe("defaultHomeTab", () => {
	it("opens the daily report for team admins and the board for everyone else", () => {
		expect(defaultHomeTab("admin")).toBe("report");
		expect(defaultHomeTab("reviewer")).toBe("board");
		expect(defaultHomeTab("member")).toBe("board");
		expect(defaultHomeTab(undefined)).toBe("board");
	});
});

describe("resolveHomeTab / rememberHomeTab", () => {
	it("falls back to the role default when nothing is stored", () => {
		expect(resolveHomeTab("w1", "admin", memStore())).toBe("report");
		expect(resolveHomeTab("w1", "member", memStore())).toBe("board");
	});

	it("remembers the choice per workspace and prefers it over the default", () => {
		const store = memStore();
		expect(rememberHomeTab("w1", "board", store)).toBe(true);
		expect(store.data.get(`${HOME_TAB_KEY_PREFIX}w1`)).toBe("board");
		expect(resolveHomeTab("w1", "admin", store)).toBe("board");
		// another workspace keeps its own default
		expect(resolveHomeTab("w2", "admin", store)).toBe("report");
		rememberHomeTab("w2", "report", store);
		expect(resolveHomeTab("w2", "member", store)).toBe("report");
	});

	it("ignores stored garbage", () => {
		const store = memStore({ [`${HOME_TAB_KEY_PREFIX}w1`]: "calendar" });
		expect(resolveHomeTab("w1", "member", store)).toBe("board");
	});

	it("never throws when storage is blocked or missing", () => {
		expect(resolveHomeTab("w1", "admin", throwing)).toBe("report");
		expect(rememberHomeTab("w1", "board", throwing)).toBe(false);
		expect(rememberHomeTab("w1", "board", undefined)).toBe(false);
	});
});
