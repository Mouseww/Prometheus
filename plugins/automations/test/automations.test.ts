import { describe, expect, it } from "vitest";
import type { AutomationInput, AutomationSchedule } from "@prometheus/protocol";
import { AutomationEngine, type AutomationState, validateInput } from "../src/engine.ts";
import { catchUpDue, describeSchedule, nextRun, validateSchedule } from "../src/schedule.ts";

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe("nextRun", () => {
	it("interval: adds the interval", () => {
		expect(nextRun({ type: "interval", minutes: 30 }, local(2026, 1, 1, 10, 0))).toEqual(local(2026, 1, 1, 10, 30));
	});

	it("daily: today if still ahead, otherwise tomorrow", () => {
		const s: AutomationSchedule = { type: "daily", time: "09:00" };
		expect(nextRun(s, local(2026, 3, 10, 8, 0))).toEqual(local(2026, 3, 10, 9, 0));
		expect(nextRun(s, local(2026, 3, 10, 9, 0))).toEqual(local(2026, 3, 11, 9, 0));
		expect(nextRun(s, local(2026, 3, 10, 23, 59))).toEqual(local(2026, 3, 11, 9, 0));
	});

	it("daily with weekdays: skips to the next allowed day, across a month end", () => {
		// 2026-03-31 is a Tuesday; only Mondays (1) -> Monday 2026-04-06.
		const s: AutomationSchedule = { type: "daily", time: "07:30", days: [1] };
		const next = nextRun(s, local(2026, 3, 31, 12, 0))!;
		expect(next).toEqual(local(2026, 4, 6, 7, 30));
		expect(next.getDay()).toBe(1);
	});

	it("once: fires only while in the future", () => {
		const at = local(2026, 5, 1, 12, 0);
		const s: AutomationSchedule = { type: "once", at: at.toISOString() };
		expect(nextRun(s, local(2026, 5, 1, 11, 0))).toEqual(at);
		expect(nextRun(s, local(2026, 5, 1, 12, 0))).toBeUndefined();
	});

	it("never throws on a malformed time", () => {
		expect(nextRun({ type: "daily", time: "25:99" }, new Date())).toBeUndefined();
	});
});

describe("validateSchedule / catchUpDue / describeSchedule", () => {
	it("rejects out-of-range values", () => {
		expect(validateSchedule({ type: "interval", minutes: 1 })).not.toEqual([]);
		expect(validateSchedule({ type: "interval", minutes: 15.5 })).not.toEqual([]);
		expect(validateSchedule({ type: "interval", minutes: 60 })).toEqual([]);
		expect(validateSchedule({ type: "daily", time: "9:00" })).not.toEqual([]);
		expect(validateSchedule({ type: "daily", time: "09:00", days: [7] })).not.toEqual([]);
		expect(validateSchedule({ type: "daily", time: "09:00", days: [] })).not.toEqual([]);
		expect(validateSchedule({ type: "once", at: "nonsense" })).not.toEqual([]);
	});

	it("catches up a missed daily task only within a day; never an interval one", () => {
		const due = local(2026, 1, 1, 9, 0);
		expect(catchUpDue({ type: "daily", time: "09:00" }, due, local(2026, 1, 1, 20, 0))).toBe(true);
		expect(catchUpDue({ type: "daily", time: "09:00" }, due, local(2026, 1, 3, 9, 0))).toBe(false);
		expect(catchUpDue({ type: "interval", minutes: 10 }, due, local(2026, 1, 1, 9, 5))).toBe(false);
	});

	it("describes schedules for people", () => {
		expect(describeSchedule({ type: "interval", minutes: 120 })).toBe("每 2 小时");
		expect(describeSchedule({ type: "interval", minutes: 45 })).toBe("每 45 分钟");
		expect(describeSchedule({ type: "daily", time: "08:00" })).toBe("每天 08:00");
		expect(describeSchedule({ type: "daily", time: "08:00", days: [1, 3] })).toBe("每周一、三 08:00");
	});
});

// ---------- engine ----------

function harness(initial: AutomationState = { tasks: [], runs: [] }, workspaces = [{ id: "w1", path: "/proj", name: "proj" }]) {
	let now = local(2026, 1, 1, 9, 0);
	let saved: AutomationState = structuredClone(initial);
	const calls: { cwd: string; access: string; prompt: string }[] = [];
	let outcome: () => Promise<{ sessionId: string; status: "success" | "error" | "aborted"; text: string; error?: string }> = async () => ({ sessionId: "s1", status: "success", text: "all done" });
	let changes = 0;
	const engine = new AutomationEngine({
		load: async () => structuredClone(saved),
		save: async (s) => void (saved = structuredClone(s)),
		workspaces: async () => workspaces,
		runAgent: async (o) => {
			calls.push({ cwd: o.cwd, access: o.access, prompt: o.prompt });
			return outcome();
		},
		now: () => now,
		changed: () => void changes++,
		log: () => {},
	});
	return { engine, calls, saved: () => saved, setNow: (d: Date) => (now = d), setOutcome: (f: typeof outcome) => (outcome = f), changes: () => changes };
}

const input = (over: Partial<AutomationInput> = {}): AutomationInput => ({
	name: "nightly",
	prompt: "summarise changes",
	workspaceId: "w1",
	schedule: { type: "interval", minutes: 60 },
	access: "readonly",
	enabled: true,
	...over,
});

describe("AutomationEngine", () => {
	it("validates input and workspace", async () => {
		expect(validateInput(input({ name: " ", prompt: "" }))).toHaveLength(2);
		const h = harness();
		await h.engine.start();
		await expect(h.engine.create(input({ workspaceId: "nope" }))).rejects.toThrow(/工作区不存在/);
		await expect(h.engine.create(input({ access: "root" as never }))).rejects.toThrow(/权限/);
		await h.engine.stop();
	});

	it("creates a task with a next run time and runs it when due, once", async () => {
		const h = harness();
		await h.engine.start();
		const task = await h.engine.create(input());
		expect(task.nextRunAt).toBe(local(2026, 1, 1, 10, 0).toISOString());

		await h.engine.tick();
		expect(h.calls).toHaveLength(0);

		h.setNow(local(2026, 1, 1, 10, 0));
		await h.engine.tick();
		await h.engine.tick();
		expect(h.calls).toEqual([{ cwd: "/proj", access: "readonly", prompt: "summarise changes" }]);

		const snap = h.engine.snapshot();
		expect(snap.runs[0]).toMatchObject({ status: "success", sessionId: "s1", summary: "all done", taskName: "nightly" });
		expect(snap.tasks[0]?.nextRunAt).toBe(local(2026, 1, 1, 11, 0).toISOString());
		await h.engine.stop();
	});

	it("records failures and keeps the schedule", async () => {
		const h = harness();
		await h.engine.start();
		const task = await h.engine.create(input());
		h.setOutcome(async () => ({ sessionId: "s2", status: "error", text: "partial", error: "model refused" }));
		await h.engine.runNow(task.id);
		const run = h.engine.snapshot().runs[0];
		expect(run).toMatchObject({ status: "error", error: "model refused", summary: "partial" });
		h.setOutcome(async () => {
			throw new Error("no model configured");
		});
		await h.engine.runNow(task.id);
		expect(h.engine.snapshot().runs[0]).toMatchObject({ status: "error", error: "no model configured" });
		expect(h.engine.snapshot().tasks[0]?.enabled).toBe(true);
		await h.engine.stop();
	});

	it("disables a one-off task after it fires", async () => {
		const h = harness();
		await h.engine.start();
		const task = await h.engine.create(input({ schedule: { type: "once", at: local(2026, 1, 1, 9, 30).toISOString() } }));
		h.setNow(local(2026, 1, 1, 9, 30));
		await h.engine.tick();
		expect(h.calls).toHaveLength(1);
		expect(h.engine.snapshot().tasks.find((t) => t.id === task.id)).toMatchObject({ enabled: false, nextRunAt: undefined });
		await h.engine.stop();
	});

	it("does not run a disabled task and resumes when re-enabled", async () => {
		const h = harness();
		await h.engine.start();
		const task = await h.engine.create(input({ enabled: false }));
		expect(task.nextRunAt).toBeUndefined();
		h.setNow(local(2026, 1, 2, 9, 0));
		await h.engine.tick();
		expect(h.calls).toHaveLength(0);
		const on = await h.engine.setEnabled(task.id, true);
		expect(on.nextRunAt).toBe(local(2026, 1, 2, 10, 0).toISOString());
		await h.engine.stop();
	});

	it("refuses to start a task twice at once, and can cancel it", async () => {
		const h = harness();
		await h.engine.start();
		const task = await h.engine.create(input());
		let release!: () => void;
		h.setOutcome(() => new Promise((r) => (release = () => r({ sessionId: "s", status: "aborted", text: "", error: "已取消" }))));
		const first = h.engine.runNow(task.id);
		await new Promise((r) => setTimeout(r, 0));
		await expect(h.engine.runNow(task.id)).rejects.toThrow(/正在运行/);
		expect(h.engine.cancel(task.id)).toBe(true);
		release();
		await first;
		expect(h.engine.snapshot().runs[0]?.status).toBe("error");
		await h.engine.stop();
	});

	it("skips a task whose workspace was removed instead of running somewhere else", async () => {
		const ws = [{ id: "w1", path: "/proj", name: "proj" }];
		const h = harness(undefined, ws);
		await h.engine.start();
		const task = await h.engine.create(input());
		ws.length = 0;
		await h.engine.runNow(task.id);
		expect(h.calls).toHaveLength(0);
		expect(h.engine.snapshot().runs[0]).toMatchObject({ status: "skipped", error: "工作区已被移除" });
		await h.engine.stop();
	});

	it("on restart: fails stranded runs, catches up a recent daily task, skips a stale interval one", async () => {
		const state: AutomationState = {
			tasks: [
				{ id: "d", name: "daily", prompt: "p", workspaceId: "w1", schedule: { type: "daily", time: "08:00" }, access: "readonly", enabled: true, createdAt: "x", nextRunAt: local(2026, 1, 1, 8, 0).toISOString() },
				{ id: "i", name: "interval", prompt: "p", workspaceId: "w1", schedule: { type: "interval", minutes: 30 }, access: "readonly", enabled: true, createdAt: "x", nextRunAt: local(2026, 1, 1, 6, 0).toISOString() },
			],
			runs: [{ id: "r", taskId: "d", taskName: "daily", startedAt: "x", status: "running" }],
		};
		const h = harness(state);
		await h.engine.start();
		await new Promise((r) => setTimeout(r, 10));
		expect(h.calls).toHaveLength(1);
		const snap = h.engine.snapshot();
		expect(snap.runs.find((r) => r.id === "r")).toMatchObject({ status: "error", error: "应用关闭时中断" });
		expect(snap.tasks.find((t) => t.id === "i")?.nextRunAt).toBe(local(2026, 1, 1, 9, 30).toISOString());
		await h.engine.stop();
	});

	it("persists tasks and notifies listeners", async () => {
		const h = harness();
		await h.engine.start();
		await h.engine.create(input());
		expect(h.saved().tasks).toHaveLength(1);
		expect(h.changes()).toBeGreaterThan(0);
		const id = h.saved().tasks[0]!.id;
		await h.engine.remove(id);
		expect(h.saved().tasks).toEqual([]);
		await expect(h.engine.setEnabled(id, true)).rejects.toThrow(/不存在/);
		await h.engine.stop();
	});
});
