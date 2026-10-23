import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentRun } from "@prometheus/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../src/agents.ts";
import { SubagentRuntime } from "../src/runtime.ts";
import type { Runner } from "../src/types.ts";

type Exec = (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: { runs: { run: SubagentRun }[] }; isError?: boolean }>;

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "subagents-rt-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function setup(runner: Runner, max = 4) {
	const emitted: SubagentRun[][] = [];
	const sent: { content: string }[] = [];
	const rt = new SubagentRuntime({ store: new AgentStore(dir), cwd: () => dir, emit: (r) => emitted.push(r), maxParallel: max, runners: { pi: runner, "claude-code": runner, codex: runner } });
	let exec!: Exec;
	(rt.extension() as unknown as { factory: (pi: never) => void }).factory({
		registerTool: (t: { execute: Exec }) => (exec = t.execute),
		on: () => {},
		sendMessage: (m: { content: string }) => sent.push(m),
	} as never);
	return { rt, exec, emitted, sent };
}

const gate = () => {
	let open!: () => void;
	const p = new Promise<void>((r) => (open = r));
	return { p, open };
};

describe("subagent tool", () => {
	it("runs one agent in the foreground and returns its output", async () => {
		const { exec, rt } = setup(async (job) => `done: ${job.task}`);
		const res = await exec("c1", { agent: "scout", task: "look" });
		expect(res.content[0]?.text).toContain("done: look");
		expect(rt.list()).toHaveLength(1);
		expect(rt.list()[0]).toMatchObject({ agent: "scout", state: "completed", background: false });
	});

	it("runs a tasks array in parallel", async () => {
		const g = gate();
		let running = 0;
		let peak = 0;
		const { exec } = setup(async (job) => {
			peak = Math.max(peak, ++running);
			await g.p;
			running--;
			return job.task;
		});
		const done = exec("c", { tasks: [{ agent: "scout", task: "a" }, { agent: "reviewer", task: "b" }] });
		await new Promise((r) => setTimeout(r, 30));
		expect(peak).toBe(2);
		g.open();
		const res = await done;
		expect(res.content[0]?.text).toContain("## scout");
		expect(res.content[0]?.text).toContain("## reviewer");
	});

	it("queues runs beyond the parallel limit", async () => {
		const g = gate();
		const { exec, rt } = setup(async () => {
			await g.p;
			return "ok";
		}, 1);
		const done = exec("c", { tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }] });
		await new Promise((r) => setTimeout(r, 30));
		expect(rt.list().map((r) => r.state).sort()).toEqual(["queued", "running"]);
		g.open();
		await done;
		expect(rt.list().every((r) => r.state === "completed")).toBe(true);
	});

	it("returns at once for background runs and reports back when they finish", async () => {
		const g = gate();
		const { exec, rt, sent } = setup(async () => {
			await g.p;
			return "late result";
		});
		const res = await exec("c", { agent: "worker", task: "t", background: true });
		expect(res.content[0]?.text).toContain("后台");
		expect(rt.list()[0]).toMatchObject({ background: true, state: "running" });
		expect(sent).toHaveLength(0);
		g.open();
		await new Promise((r) => setTimeout(r, 50));
		expect(sent[0]?.content).toContain("late result");
		expect(rt.list()[0]?.state).toBe("completed");
	});

	it("marks a failing runner as failed with its message", async () => {
		const { exec, rt } = setup(async () => {
			throw new Error("503: No ready deployment");
		});
		const res = await exec("c", { agent: "scout", task: "t" });
		expect(res.isError).toBe(true);
		expect(rt.list()[0]).toMatchObject({ state: "failed", error: "503: No ready deployment" });
	});

	it("stops a running agent", async () => {
		const { exec, rt } = setup((_job, _h, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("已停止")))));
		const done = exec("c", { agent: "scout", task: "t", background: true });
		await done;
		rt.stop(rt.list()[0]?.id as string);
		await new Promise((r) => setTimeout(r, 30));
		expect(rt.list()[0]?.state).toBe("stopped");
	});

	it("rejects an unknown or disabled agent and lists what exists", async () => {
		const { exec } = setup(async () => "x");
		const res = await exec("c", { agent: "nope", task: "t" });
		expect(res.isError).toBe(true);
		expect(res.content[0]?.text).toContain("scout");
		const store = new AgentStore(dir);
		await store.setDisabled("scout", true);
		expect((await exec("c2", { agent: "scout", task: "t" })).isError).toBe(true);
	});

	it("lists agents with their runner", async () => {
		const { exec } = setup(async () => "x");
		const text = (await exec("c", { action: "list" })).content[0]?.text ?? "";
		expect(text).toContain("- scout [PI");
		expect(text).toContain("Claude Code");
		expect(text).toContain("Codex");
	});

	it("restores finished runs from saved tool results", async () => {
		const first = setup(async () => "kept");
		const res = await first.exec("c", { agent: "scout", task: "t" });
		const next = setup(async () => "x");
		next.rt.restore([{ role: "toolResult", toolName: "subagent", details: res.details }]);
		expect(next.rt.list()[0]).toMatchObject({ agent: "scout", state: "completed" });
		expect(next.rt.detail(next.rt.list()[0]?.id as string).output).toBe("kept");
	});
});
