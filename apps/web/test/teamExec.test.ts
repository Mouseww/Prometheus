import { beforeEach, describe, expect, it } from "vitest";
import { handleTeamEvent, rememberTeamSession, TEAM_EVENT_TOPICS, useReadOnlyCopy, useTeamExec, watchTeamEvents } from "../src/team/execStore.ts";
import {
	activeCopyOf,
	addHand,
	applyExecChanged,
	applyExecState,
	applySnapshot,
	dismissConflict,
	gitInspectCommand,
	type HandItem,
	handsForSession,
	isReadOnly,
	linkFromStartResult,
	linkSession,
	mergeHands,
	otherSide,
	parseExecChanged,
	parseHandRequest,
	parsePendingHands,
	parseRestoreResult,
	parseSnapshotApplied,
	parseSyncConflict,
	resolveHand,
	setConflict,
	summarizeInput,
} from "../src/team/logic/exec.ts";

const hand = (callId: string, session = "h1", extra: Partial<HandItem> = {}): HandItem => ({ callId, tool: "bash", input: { command: "ls" }, session, insideProject: true, ...extra });

describe("exec events", () => {
	it("parses execChanged and rejects broken payloads", () => {
		expect(parseExecChanged({ hubSessionId: "h", sessionId: "s", activeSide: "team", activeSessionId: "t1", readOnly: true })).toEqual({ hubSessionId: "h", sessionId: "s", activeSide: "team", activeSessionId: "t1", readOnly: true });
		expect(parseExecChanged({ hubSessionId: "h", sessionId: "s", activeSide: "local", readOnly: false })).toEqual({ hubSessionId: "h", sessionId: "s", activeSide: "local", readOnly: false });
		expect(parseExecChanged({ hubSessionId: "h", sessionId: "s", activeSide: "moon", readOnly: false })).toBeUndefined();
		expect(parseExecChanged(null)).toBeUndefined();
		expect(parseExecChanged({ sessionId: "s", activeSide: "local" })).toBeUndefined();
	});

	it("marks a session read-only on the finishing side and writable on the importing side", () => {
		const finished = applyExecChanged({}, { hubSessionId: "h", sessionId: "old", activeSide: "team", activeSessionId: "new", readOnly: true });
		expect(finished.old).toEqual({ hubSessionId: "h", location: "team", readOnly: { to: "team", activeSessionId: "new" } });
		expect(isReadOnly(finished.old)).toBe(true);
		expect(activeCopyOf(finished.old)).toBe("new");
		const imported = applyExecChanged(finished, { hubSessionId: "h", sessionId: "back", activeSide: "local", readOnly: false });
		expect(imported.back).toEqual({ hubSessionId: "h", location: "local" });
		expect(isReadOnly(imported.back)).toBe(false);
		expect(imported.old).toBe(finished.old);
	});

	it("keeps the known mode when an event arrives", () => {
		const links = applyExecState(linkSession({}, "s", "h"), "s", { location: "local", mode: "team-first" });
		const next = applyExecChanged(links, { hubSessionId: "h", sessionId: "s", activeSide: "team", readOnly: false });
		expect(next.s?.mode).toBe("team-first");
		expect(next.s?.location).toBe("team");
	});

	it("applies the Hub exec state but never moves a read-only copy", () => {
		const base = linkSession({}, "s", "h");
		expect(applyExecState(base, "missing", { location: "team", mode: "local-first" })).toBe(base);
		const set = applyExecState(base, "s", { location: "team", mode: "local-first" });
		expect(set.s).toEqual({ hubSessionId: "h", location: "team", mode: "local-first" });
		expect(applyExecState(set, "s", { location: "team", mode: "local-first" })).toBe(set);
		const mirror = applyExecChanged(set, { hubSessionId: "h", sessionId: "s", activeSide: "team", activeSessionId: "t", readOnly: true });
		expect(applyExecState(mirror, "s", { location: "local", mode: "team-first" }).s).toMatchObject({ location: "team", mode: "team-first", readOnly: { to: "team" } });
	});

	it("links the ids of session.start and session.fork results", () => {
		expect(linkFromStartResult({ sessionId: "s", hubSessionId: "h", worktree: "/w", branch: "b" })).toEqual({ localSessionId: "s", hubSessionId: "h" });
		expect(linkFromStartResult({ ok: true, data: { sessionId: "s", hubSessionId: "h" } })).toEqual({ localSessionId: "s", hubSessionId: "h" });
		expect(linkFromStartResult({ sessionId: "s" })).toBeUndefined();
		expect(linkFromStartResult("s")).toBeUndefined();
		const links = linkSession({}, "s", "h");
		expect(linkSession(links, "s", "h")).toBe(links);
	});

	it("names the other side", () => {
		expect(otherSide("local")).toBe("team");
		expect(otherSide("team")).toBe("local");
	});
});

describe("hand queue", () => {
	it("parses requests and the pending list defensively", () => {
		expect(parseHandRequest({ callId: "c", tool: "bash", input: { command: "ls" }, session: "h", insideProject: false })).toEqual({ callId: "c", tool: "bash", input: { command: "ls" }, session: "h", insideProject: false });
		expect(parseHandRequest({ callId: "c", tool: "bash" })).toBeUndefined();
		expect(parsePendingHands({ items: [hand("a"), { junk: true }, hand("b")] }).map((h) => h.callId)).toEqual(["a", "b"]);
		expect(parsePendingHands(undefined)).toEqual([]);
	});

	it("replaces a repeated callId and merges recovered items without duplicates", () => {
		const a = hand("a");
		expect(addHand([a, hand("b")], hand("a", "h2")).map((h) => `${h.callId}:${h.session}`)).toEqual(["b:h1", "a:h2"]);
		expect(mergeHands([a], [hand("a"), hand("c")]).map((h) => h.callId)).toEqual(["a", "c"]);
	});

	it("removes an answered request and reports a timed out one", () => {
		const list = [hand("a"), hand("b")];
		expect(resolveHand(list, { callId: "a", decision: "once" })).toEqual({ hands: [list[1]] });
		const t = resolveHand(list, { callId: "b", decision: "timeout" });
		expect(t.hands).toEqual([list[0]]);
		expect(t.timedOut?.callId).toBe("b");
		expect(resolveHand(list, { callId: "zzz", decision: "timeout" })).toEqual({ hands: list });
	});

	it("shows a request in its own session, and orphans anywhere", () => {
		const links = { local1: { hubSessionId: "h1" }, local2: { hubSessionId: "h2" } };
		const hands = [hand("a", "h1"), hand("b", "h2"), hand("c", "unknown")];
		expect(handsForSession(hands, links, "local1").map((h) => h.callId)).toEqual(["a", "c"]);
		expect(handsForSession(hands, links, "local2").map((h) => h.callId)).toEqual(["b", "c"]);
		expect(handsForSession(hands, links, undefined).map((h) => h.callId)).toEqual(["c"]);
	});
});

describe("summarizeInput", () => {
	it("prefers the field that says what happens", () => {
		expect(summarizeInput({ command: "rm -rf build", cwd: "/x" })).toBe("rm -rf build");
		expect(summarizeInput({ path: "src/a.ts", content: "..." })).toBe("src/a.ts");
		expect(summarizeInput({ file_path: "/tmp/x" })).toBe("/tmp/x");
	});

	it("falls back to compact JSON and handles odd inputs", () => {
		expect(summarizeInput({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
		expect(summarizeInput("  hello\n world ")).toBe("hello world");
		expect(summarizeInput(undefined)).toBe("");
		expect(summarizeInput(null)).toBe("");
		expect(summarizeInput(42)).toBe("42");
	});

	it("cuts long text to the limit with an ellipsis", () => {
		const s = summarizeInput({ command: "x".repeat(300) }, 20);
		expect(s).toHaveLength(20);
		expect(s.endsWith("\u2026")).toBe(true);
	});
});

describe("sync status", () => {
	it("parses snapshot and conflict events", () => {
		expect(parseSnapshotApplied({ hubSessionId: "h", commit: "abcdef0123", status: "applied" })).toEqual({ hubSessionId: "h", commit: "abcdef0123", status: "applied" });
		expect(parseSnapshotApplied({ hubSessionId: "h" })).toBeUndefined();
		const c = parseSyncConflict({ hubSessionId: "h", conflictRef: "refs/prometheus/snapshots/u/s/conflict-1", conflictCommit: "c0ffee", worktree: "/w/a b", message: "saved" });
		expect(c).toEqual({ hubSessionId: "h", conflictRef: "refs/prometheus/snapshots/u/s/conflict-1", conflictCommit: "c0ffee", worktree: "/w/a b", message: "saved" });
		expect(parseSyncConflict({ hubSessionId: "h", conflictRef: "r" })).toBeUndefined();
	});

	it("keeps the newest status and conflict per session", () => {
		const s1 = applySnapshot({}, { hubSessionId: "h", commit: "a", status: "applied" }, 10);
		const s2 = applySnapshot(s1, { hubSessionId: "h", commit: "b", status: "unchanged" }, 20);
		expect(s2.h).toEqual({ commit: "b", status: "unchanged", at: 20 });
		const conflict = { hubSessionId: "h", conflictRef: "r", conflictCommit: "c", worktree: "/w", message: "m" };
		const withConflict = setConflict({}, conflict);
		expect(withConflict.h).toEqual(conflict);
		expect(dismissConflict(withConflict, "h")).toEqual({});
		expect(dismissConflict(withConflict, "other")).toEqual({ h: conflict });
	});

	it("reads the answer of sync.restoreConflict defensively", () => {
		expect(parseRestoreResult({ mode: "branch", conflictRef: "r", worktree: "/w2", branch: "b2", files: ["a", 3, "b"] })).toEqual({ mode: "branch", conflictRef: "r", worktree: "/w2", branch: "b2", files: ["a", "b"] });
		expect(parseRestoreResult({ mode: "apply", conflictRef: "r", worktree: "/w" })).toEqual({ mode: "apply", conflictRef: "r", worktree: "/w", files: [] });
		expect(parseRestoreResult({ mode: "other", conflictRef: "r", worktree: "/w" })).toBeUndefined();
		expect(parseRestoreResult(undefined)).toBeUndefined();
	});

	it("builds a copyable git command and quotes awkward paths", () => {
		expect(gitInspectCommand({ worktree: "/w/a", conflictRef: "refs/x/y", conflictCommit: "c" })).toBe("git -C /w/a diff --stat HEAD refs/x/y");
		expect(gitInspectCommand({ worktree: "C:\\Users\\me\\My Repo", conflictRef: "", conflictCommit: "abc123" })).toBe('git -C "C:\\Users\\me\\My Repo" diff --stat HEAD abc123');
	});
});

describe("team exec store wiring", () => {
	beforeEach(() => {
		useTeamExec.setState({ links: {}, hands: [], timedOut: [], sync: {}, conflicts: {} });
	});

	it("queues a request, then drops it on handResolved and keeps a timeout note", () => {
		handleTeamEvent("handRequest", { callId: "c1", tool: "bash", input: { command: "ls" }, session: "h", insideProject: true });
		handleTeamEvent("handRequest", { callId: "c2", tool: "write", input: { path: "a" }, session: "h", insideProject: false });
		expect(useTeamExec.getState().hands.map((h) => h.callId)).toEqual(["c1", "c2"]);
		handleTeamEvent("handResolved", { callId: "c1", decision: "once" });
		expect(useTeamExec.getState().hands.map((h) => h.callId)).toEqual(["c2"]);
		expect(useTeamExec.getState().timedOut).toEqual([]);
		handleTeamEvent("handResolved", { callId: "c2", decision: "timeout" });
		expect(useTeamExec.getState().hands).toEqual([]);
		expect(useTeamExec.getState().timedOut.map((h) => h.callId)).toEqual(["c2"]);
		useTeamExec.getState().dropTimedOut("c2");
		expect(useTeamExec.getState().timedOut).toEqual([]);
	});

	it("tracks execChanged, sync status and conflicts; ignores junk", () => {
		handleTeamEvent("execChanged", { hubSessionId: "h", sessionId: "s", activeSide: "team", activeSessionId: "t", readOnly: true });
		expect(useTeamExec.getState().links.s?.readOnly).toEqual({ to: "team", activeSessionId: "t" });
		handleTeamEvent("snapshotApplied", { hubSessionId: "h", commit: "abc", status: "applied" }, 99);
		expect(useTeamExec.getState().sync.h).toEqual({ commit: "abc", status: "applied", at: 99 });
		handleTeamEvent("syncConflict", { hubSessionId: "h", conflictRef: "r", conflictCommit: "c", worktree: "/w", message: "m" });
		expect(useTeamExec.getState().conflicts.h?.conflictRef).toBe("r");
		useTeamExec.getState().dismissConflict("h");
		expect(useTeamExec.getState().conflicts).toEqual({});
		handleTeamEvent("handRequest", { nope: true });
		handleTeamEvent("whatever", {});
		expect(useTeamExec.getState().hands).toEqual([]);
	});

	it("remembers the link of a started session", () => {
		rememberTeamSession({ sessionId: "s9", hubSessionId: "h9", worktree: "/w", branch: "b" });
		expect(useTeamExec.getState().links.s9).toEqual({ hubSessionId: "h9" });
		rememberTeamSession("garbage");
		expect(Object.keys(useTeamExec.getState().links)).toEqual(["s9"]);
		expect(typeof useReadOnlyCopy).toBe("function");
	});
});

describe("watchTeamEvents", () => {
	interface Frame {
		type: string;
		plugin?: string;
		topic?: string;
		data?: unknown;
	}

	function fakeClient(pending: unknown, state = "open") {
		const frameListeners = new Set<(f: Frame) => void>();
		const stateListeners = new Set<(s: string) => void>();
		const watched: string[] = [];
		const unwatched: string[] = [];
		const calls: unknown[] = [];
		const client = {
			state,
			watch: (plugin: string, topic: string) => {
				watched.push(`${plugin}:${topic}`);
				return () => void unwatched.push(`${plugin}:${topic}`);
			},
			onFrame: (cb: (f: Frame) => void) => {
				frameListeners.add(cb);
				return () => void frameListeners.delete(cb);
			},
			onState: (cb: (s: string) => void) => {
				stateListeners.add(cb);
				return () => void stateListeners.delete(cb);
			},
			rpc: async (method: string, params: unknown) => {
				calls.push({ method, params });
				if (pending instanceof Error) throw pending;
				return pending;
			},
		};
		return { client, frameListeners, stateListeners, watched, unwatched, calls };
	}

	beforeEach(() => {
		useTeamExec.setState({ links: {}, hands: [], timedOut: [], sync: {}, conflicts: {} });
	});

	it("watches every topic, routes frames of the team plugin only, and cleans up", async () => {
		const f = fakeClient({ items: [hand("old")] });
		// biome-ignore lint/suspicious/noExplicitAny: a structural fake of the client
		const off = watchTeamEvents(f.client as any);
		expect(f.watched).toEqual(TEAM_EVENT_TOPICS.map((t) => `team:${t}`));
		await Promise.resolve();
		await Promise.resolve();
		expect(f.calls).toEqual([{ method: "plugin.call", params: { plugin: "team", method: "hand.pending", params: {} } }]);
		expect(useTeamExec.getState().hands.map((h) => h.callId)).toEqual(["old"]);

		for (const cb of f.frameListeners) {
			cb({ type: "plugin.event", plugin: "team", topic: "handRequest", data: hand("live") });
			cb({ type: "plugin.event", plugin: "other", topic: "handRequest", data: hand("alien") });
			cb({ type: "plugin.event", plugin: "team", topic: "hub:user", data: hand("hub") });
		}
		expect(useTeamExec.getState().hands.map((h) => h.callId)).toEqual(["old", "live"]);

		off();
		expect(f.unwatched).toHaveLength(TEAM_EVENT_TOPICS.length);
		expect(f.frameListeners.size).toBe(0);
		expect(f.stateListeners.size).toBe(0);
	});

	it("recovers again after a reconnect and survives a missing plugin", async () => {
		const f = fakeClient(new Error("plugin not found"), "connecting");
		// biome-ignore lint/suspicious/noExplicitAny: a structural fake of the client
		const off = watchTeamEvents(f.client as any);
		expect(f.calls).toHaveLength(0);
		for (const cb of f.stateListeners) cb("open");
		await Promise.resolve();
		await Promise.resolve();
		expect(f.calls).toHaveLength(1);
		expect(useTeamExec.getState().hands).toEqual([]);
		off();
	});
});
