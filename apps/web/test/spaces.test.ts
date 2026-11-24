import { describe, expect, it } from "vitest";
import { delegatedRuns, delegationTitle, effectiveSpace, groupByAge, samePath, setPersonalRoots, spaceOf } from "../src/lib/spaces.ts";

describe("spaces", () => {
	it("compares paths across slash style, case and trailing separators", () => {
		expect(samePath("C:\\Users\\Me\\home\\", "c:/users/me/home")).toBe(true);
		expect(samePath("/a/b", "/a/c")).toBe(false);
		expect(samePath(undefined, "/a")).toBe(false);
	});

	it("puts the assistant home in the personal space and everything else in work", () => {
		expect(spaceOf("/data/home", "/data/home")).toBe("personal");
		expect(spaceOf("/data/home/notes", "/data/home")).toBe("personal");
		expect(spaceOf("/data/homework", "/data/home")).toBe("work");
		expect(spaceOf("/proj", null)).toBe("work");
	});

	it("counts the companion's group folders as personal", () => {
		setPersonalRoots(["/data/pet"]);
		expect(spaceOf("/data/pet/婚礼", "/data/home")).toBe("personal");
		expect(spaceOf("/proj/婚礼", "/data/home")).toBe("work");
		setPersonalRoots([]);
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

	it("splits delegated runs into running and recent finished, by session id, ignoring others and archived ones", () => {
		const mk = (id: string, modified: string, running = false, archived = false) => ({ id, name: id, modified, running, archived });
		const r = delegatedRuns(
			[mk("a", "2026-05-01T10:00:00Z"), mk("b", "2026-05-03T10:00:00Z", true), mk("c", "2026-05-02T10:00:00Z"), mk("old", "2026-04-01T10:00:00Z", false, true), mk("plain", "2026-05-04T10:00:00Z")],
			new Set(["a", "b", "c", "old"]),
			1,
		);
		expect(r.running.map((s) => s.id)).toEqual(["b"]);
		expect(r.done.map((s) => s.id)).toEqual(["c"]);
		expect(delegationTitle("助理派活：整理表")).toBe("整理表");
	});
});
