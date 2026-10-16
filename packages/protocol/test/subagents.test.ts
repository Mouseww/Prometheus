import { describe, expect, it } from "vitest";
import { sortSubagents, type SubagentRun } from "../src/index.ts";

const run = (id: string, state: SubagentRun["state"], startedAt: number, endedAt?: number): SubagentRun => ({
	id,
	callId: id,
	agent: id,
	task: "",
	state,
	background: false,
	startedAt,
	...(endedAt !== undefined ? { endedAt } : {}),
	stoppable: state === "running",
});

const runs = [run("done-old", "completed", 1, 10), run("run-old", "running", 2), run("failed", "failed", 5, 20), run("done-new", "completed", 8, 30), run("queued", "queued", 9), run("run-new", "running", 7), run("stopped", "stopped", 4, 15)];
const ids = (by: Parameters<typeof sortSubagents>[1]) => sortSubagents(runs, by).map((r) => r.id);

describe("sortSubagents", () => {
	it("by status: live first, then failed, stopped, completed; newest launch first within a group", () => {
		expect(ids("status")).toEqual(["run-new", "run-old", "queued", "failed", "stopped", "done-new", "done-old"]);
	});

	it("by start time: newest launch first", () => {
		expect(ids("started")).toEqual(["queued", "done-new", "run-new", "failed", "stopped", "run-old", "done-old"]);
	});

	it("by finish time: live agents on top, then the most recently finished", () => {
		expect(ids("ended")).toEqual(["queued", "run-new", "run-old", "done-new", "failed", "stopped", "done-old"]);
	});

	it("does not mutate its input and is stable for equal keys", () => {
		const input = [run("b", "running", 1), run("a", "running", 1)];
		const out = sortSubagents(input, "status");
		expect(input.map((r) => r.id)).toEqual(["b", "a"]);
		expect(out.map((r) => r.id)).toEqual(["a", "b"]);
	});
});
