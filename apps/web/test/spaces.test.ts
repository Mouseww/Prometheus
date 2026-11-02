import { describe, expect, it } from "vitest";
import { effectiveSpace, groupByAge, samePath, spaceOf } from "../src/lib/spaces.ts";

describe("spaces", () => {
	it("compares paths across slash style, case and trailing separators", () => {
		expect(samePath("C:\\Users\\Me\\home\\", "c:/users/me/home")).toBe(true);
		expect(samePath("/a/b", "/a/c")).toBe(false);
		expect(samePath(undefined, "/a")).toBe(false);
	});

	it("puts the assistant home in the personal space and everything else in work", () => {
		expect(spaceOf("/data/home", "/data/home")).toBe("personal");
		expect(spaceOf("/data/home/notes", "/data/home")).toBe("work");
		expect(spaceOf("/proj", null)).toBe("work");
	});

	it("has only the work space without an assistant", () => {
		expect(effectiveSpace("personal", null)).toBe("work");
		expect(effectiveSpace("personal", "/h")).toBe("personal");
	});

	it("groups by age, newest first, dropping empty groups", () => {
		const now = new Date("2026-05-14T15:00:00").getTime();
		const at = (s: string) => new Date(s).toISOString();
		const rows = [
			{ id: "old", modified: at("2026-04-01T10:00:00") },
			{ id: "week", modified: at("2026-05-10T10:00:00") },
			{ id: "t2", modified: at("2026-05-14T09:00:00") },
			{ id: "t1", modified: at("2026-05-14T12:00:00") },
		];
		const g = groupByAge(rows, now);
		expect(g.map((x) => x.key)).toEqual(["today", "week", "earlier"]);
		expect(g[0]?.items.map((x) => x.id)).toEqual(["t1", "t2"]);
		expect(groupByAge([{ modified: at("2026-05-14T09:00:00") }], now).map((x) => x.key)).toEqual(["today"]);
	});
});
