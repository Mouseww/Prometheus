import { beforeEach, describe, expect, it } from "vitest";
import { loadConflicts, loadSessionLink, resetLinkLookups, useTeamExec } from "../src/team/execStore.ts";
import { applySessionLink, linkSession, parseConflictList, parseSessionLink, seedConflict, type SyncConflict } from "../src/team/logic/exec.ts";

const conflict = (ref: string, extra: Partial<SyncConflict> = {}): SyncConflict => ({ hubSessionId: "h", conflictRef: ref, conflictCommit: "c", worktree: "/w", message: "", ...extra });

describe("session.link answers", () => {
	it("parses a link, null and junk", () => {
		expect(parseSessionLink({ hubSessionId: "h", workspaceId: "w", readOnly: true, activeSide: "team", activeSessionId: "t1", execMode: "team-first" })).toEqual({
			hubSessionId: "h",
			workspaceId: "w",
			readOnly: true,
			activeSide: "team",
			activeSessionId: "t1",
			execMode: "team-first",
		});
		expect(parseSessionLink({ hubSessionId: "h", workspaceId: "w", readOnly: false, activeSide: "local" })).toEqual({ hubSessionId: "h", workspaceId: "w", readOnly: false, activeSide: "local" });
		expect(parseSessionLink(null)).toBeNull();
		expect(parseSessionLink({ hubSessionId: "h", activeSide: "moon" })).toBeUndefined();
		expect(parseSessionLink("x")).toBeUndefined();
	});

	it("sets side, read-only state and mode on the link, keeping a known mode the answer lacks", () => {
		const known = { s: { hubSessionId: "h", location: "local" as const, mode: "team-first" as const } };
		const next = applySessionLink(known, "s", { hubSessionId: "h", workspaceId: "w", readOnly: true, activeSide: "team", activeSessionId: "t" });
		expect(next.s).toEqual({ hubSessionId: "h", location: "team", mode: "team-first", readOnly: { to: "team", activeSessionId: "t" } });
		expect(applySessionLink(next, "s", { hubSessionId: "h", workspaceId: "w", readOnly: true, activeSide: "team", activeSessionId: "t" })).toBe(next);
		expect(applySessionLink({}, "n", { hubSessionId: "h2", workspaceId: "w", readOnly: false, activeSide: "local", execMode: "local-first" }).n).toEqual({ hubSessionId: "h2", location: "local", mode: "local-first" });
		// A link to another Hub session does not inherit the old mode.
		expect(applySessionLink(linkSession({}, "s", "old"), "s", { hubSessionId: "h", workspaceId: "w", readOnly: false, activeSide: "local" }).s).toEqual({ hubSessionId: "h", location: "local" });
	});
});

describe("saved conflicts after a reload", () => {
	it("parses sync.conflicts entries with the worktree and drops incomplete ones", () => {
		const list = parseConflictList({ conflicts: [{ conflictRef: "r2", commit: "c2", savedAt: 2, files: ["a"], worktree: "/w" }, { conflictRef: "r1" }, "junk"] }, "h");
		expect(list).toEqual([{ hubSessionId: "h", conflictRef: "r2", conflictCommit: "c2", worktree: "/w", message: "" }]);
		expect(parseConflictList(undefined, "h")).toEqual([]);
	});

	it("shows the newest saved conflict unless a live one or the dismissed one exists", () => {
		const loaded = [conflict("new"), conflict("old")];
		expect(seedConflict({}, {}, loaded).h?.conflictRef).toBe("new");
		const live = { h: conflict("live") };
		expect(seedConflict(live, {}, loaded)).toBe(live);
		expect(seedConflict({}, { h: "new" }, loaded)).toEqual({});
		expect(seedConflict({}, { h: "older" }, loaded).h?.conflictRef).toBe("new");
		expect(seedConflict({}, {}, [])).toEqual({});
	});
});

describe("loading into the store", () => {
	beforeEach(() => {
		useTeamExec.setState({ links: {}, hands: [], timedOut: [], sync: {}, conflicts: {}, dismissed: {} });
		resetLinkLookups();
	});

	it("seeds the link of an unknown session once and remembers a negative answer", async () => {
		const calls: unknown[] = [];
		const answers: unknown[] = [{ hubSessionId: "h", workspaceId: "w", readOnly: false, activeSide: "local", execMode: "local-first" }];
		const call = async (method: string, params: Record<string, unknown>) => (calls.push({ method, params }), answers.shift() ?? null);
		await loadSessionLink(call, "s1");
		expect(calls).toEqual([{ method: "session.link", params: { sessionId: "s1" } }]);
		expect(useTeamExec.getState().links.s1).toEqual({ hubSessionId: "h", location: "local", mode: "local-first" });
		await loadSessionLink(call, "s1");
		expect(calls).toHaveLength(1);
		await loadSessionLink(call, "plain");
		await loadSessionLink(call, "plain");
		expect(calls).toHaveLength(2);
		expect(useTeamExec.getState().links.plain).toBeUndefined();
	});

	it("survives a missing plugin or a malformed answer without seeding anything", async () => {
		await loadSessionLink(async () => Promise.reject(new Error("no plugin")), "s");
		await loadSessionLink(async () => "garbage", "s");
		expect(useTeamExec.getState().links).toEqual({});
	});

	it("loads conflicts, keeps a live one, and does not bring back a dismissed one", async () => {
		const call = async () => ({ conflicts: [{ conflictRef: "r2", commit: "c", savedAt: 2, files: [], worktree: "/w" }] });
		await loadConflicts(call, "h");
		expect(useTeamExec.getState().conflicts.h).toMatchObject({ conflictRef: "r2", worktree: "/w" });
		useTeamExec.getState().dismissConflict("h");
		expect(useTeamExec.getState().conflicts).toEqual({});
		await loadConflicts(call, "h");
		expect(useTeamExec.getState().conflicts).toEqual({});
		useTeamExec.setState({ conflicts: { h: conflict("live") }, dismissed: {} });
		await loadConflicts(call, "h");
		expect(useTeamExec.getState().conflicts.h?.conflictRef).toBe("live");
		await loadConflicts(async () => Promise.reject(new Error("404")), "other");
		expect(useTeamExec.getState().conflicts.other).toBeUndefined();
	});
});
