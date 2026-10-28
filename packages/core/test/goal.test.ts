import { type GoalState, goalDirective, goalTitle, parseGoalCommand, parseGoalDirective, readGoalStatus, stripGoalStatus } from "@prometheus/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalTracker, type GoalView } from "../src/goal.ts";

/** A fake session: each prompt starts a run; the test settles it with the reply it wants. */
function harness() {
	const prompts: string[] = [];
	const emitted: (GoalState | null)[] = [];
	let view: GoalView = { isStreaming: false, queued: false, lastReply: "" };
	const tracker = new GoalTracker({
		prompt: async (_id, text) => {
			prompts.push(text);
			view = { ...view, isStreaming: true };
		},
		view: () => view,
		emit: (_id, goal) => void emitted.push(goal),
		delayMs: 10,
	});
	/** The run ends with `reply`; the tracker decides after its delay. */
	const settle = async (reply: string, extra: Partial<GoalView> = {}, aborted = false) => {
		view = { isStreaming: false, queued: false, lastReply: reply, ...extra };
		tracker.settled("s", aborted);
		await vi.advanceTimersByTimeAsync(20);
	};
	return { tracker, prompts, emitted, settle, setView: (v: Partial<GoalView>) => (view = { ...view, ...v }) };
}

describe("GoalTracker", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("keeps sending turns until the agent reports the objective complete", async () => {
		const h = harness();
		await h.tracker.set("s", "make the tests pass");
		expect(h.prompts).toHaveLength(1);
		expect(parseGoalDirective(h.prompts[0]!)).toEqual({ turn: 1, maxTurns: 30, objective: "make the tests pass" });

		await h.settle("Fixed two of five failures.");
		await h.settle("Fixed the rest, running again.");
		expect(h.prompts).toHaveLength(3);
		expect(parseGoalDirective(h.prompts[2]!)?.turn).toBe(3);

		await h.settle("All 120 tests pass.\n\n<goal_status>complete</goal_status>");
		expect(h.prompts).toHaveLength(3);
		expect(h.tracker.get("s")).toMatchObject({ status: "complete", turns: 3, note: "All 120 tests pass." });
	});

	it("stops when the agent is blocked, and resuming does not re-read the blocking reply", async () => {
		const h = harness();
		await h.tracker.set("s", "deploy");
		await h.settle("I need the server password. <goal_status>blocked: no credentials</goal_status>");
		expect(h.tracker.get("s")).toMatchObject({ status: "blocked", note: "no credentials" });

		await h.tracker.resume("s");
		expect(h.prompts).toHaveLength(2);
		expect(h.tracker.get("s")?.status).toBe("active");
		expect(h.tracker.get("s")?.note).toBeUndefined();
	});

	it("pauses when the user stops a run or a turn fails", async () => {
		const h = harness();
		await h.tracker.set("s", "x");
		await h.settle("partial", {}, true);
		expect(h.tracker.get("s")?.status).toBe("paused");

		await h.tracker.resume("s");
		await h.settle("", { error: "rate limited" });
		expect(h.tracker.get("s")).toMatchObject({ status: "paused", note: "rate limited" });
		expect(h.prompts).toHaveLength(2);
	});

	it("stops at the turn limit; resuming grants another budget", async () => {
		const h = harness();
		await h.tracker.set("s", "x", 2);
		await h.settle("step 1");
		await h.settle("step 2");
		expect(h.tracker.get("s")).toMatchObject({ status: "limit", turns: 2 });
		expect(h.prompts).toHaveLength(2);

		await h.tracker.resume("s");
		expect(h.tracker.get("s")).toMatchObject({ status: "active", turns: 3, maxTurns: 4 });
	});

	it("waits for a run already in progress, and for messages the user queued", async () => {
		const h = harness();
		h.setView({ isStreaming: true });
		await h.tracker.set("s", "x");
		expect(h.prompts).toHaveLength(0);

		await h.settle("the earlier answer", { queued: true });
		expect(h.prompts).toHaveLength(0);
		await h.settle("answer to the queued message");
		expect(h.prompts).toHaveLength(1);
	});

	it("clearing stops the loop and announces that there is no goal", async () => {
		const h = harness();
		await h.tracker.set("s", "x");
		h.tracker.settled("s", false);
		h.tracker.clear("s");
		await vi.advanceTimersByTimeAsync(50);
		expect(h.prompts).toHaveLength(1);
		expect(h.tracker.get("s")).toBeUndefined();
		expect(h.emitted.at(-1)).toBeNull();
	});

	it("moves with the conversation to another session id", async () => {
		const h = harness();
		await h.tracker.set("s", "x");
		h.setView({ isStreaming: false, lastReply: "progress" });
		h.tracker.move("s", "t");
		expect(h.tracker.get("s")).toBeUndefined();
		await vi.advanceTimersByTimeAsync(20);
		expect(h.tracker.get("t")?.turns).toBe(2);
	});
});

describe("goal text conventions", () => {
	it("parses /goal commands", () => {
		expect(parseGoalCommand("hello")).toBeNull();
		expect(parseGoalCommand("/goals")).toBeNull();
		expect(parseGoalCommand("/goal")).toEqual({ action: "show" });
		expect(parseGoalCommand("/goal pause")).toEqual({ action: "pause" });
		expect(parseGoalCommand("/goal resume")).toEqual({ action: "resume" });
		expect(parseGoalCommand("/goal stop")).toEqual({ action: "clear" });
		expect(parseGoalCommand("/goal  ship v2\nwith docs")).toEqual({ action: "set", objective: "ship v2\nwith docs" });
		expect(parseGoalCommand("/goal --max 5 fix it")).toEqual({ action: "set", objective: "fix it", maxTurns: 5 });
		expect(parseGoalCommand("/goal --max=9999 fix it")).toEqual({ action: "set", objective: "fix it", maxTurns: 200 });
	});

	it("reads the last status tag and strips them for display", () => {
		expect(readGoalStatus("working")).toBeNull();
		expect(readGoalStatus("done <goal_status>COMPLETE</goal_status>")).toEqual({ status: "complete" });
		expect(readGoalStatus("<goal_status>complete</goal_status> then <goal_status>blocked: need key</goal_status>")).toEqual({ status: "blocked", reason: "need key" });
		expect(stripGoalStatus("Done.\n\n<goal_status>complete</goal_status>\n")).toBe("Done.");
	});

	it("titles a goal conversation by its objective, even when cut short", () => {
		const text = goalDirective("Port the CLI to Rust", 1, 30);
		expect(goalTitle(text)).toBe("Port the CLI to Rust");
		expect(goalTitle(text.slice(0, text.indexOf("Rules:") + 3))).toBe("Port the CLI to Rust");
		expect(goalTitle("plain message")).toBeNull();
	});
});
