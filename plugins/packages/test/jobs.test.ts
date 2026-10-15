import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { captureCommandOutput } from "../src/capture.ts";
import { explainFailure } from "../src/explain.ts";
import { JobTracker } from "../src/jobs.ts";

const gate = () => {
	let open!: () => void;
	const wait = new Promise<void>((r) => (open = r));
	return { open, wait };
};

describe("JobTracker", () => {
	it("runs jobs one at a time and records success", async () => {
		const jobs = new JobTracker(() => "x");
		const order: string[] = [];
		const g = gate();
		const a = jobs.run("install", "npm:a", "a", async () => {
			order.push("a:start");
			await g.wait;
			order.push("a:end");
		});
		const b = jobs.run("install", "npm:b", "b", async () => void order.push("b"));
		await new Promise((r) => setTimeout(r, 5));
		expect(jobs.list().find((j) => j.id === a.id)?.status).toBe("running");
		expect(jobs.list().find((j) => j.id === b.id)?.status).toBe("queued");

		g.open();
		await new Promise((r) => setTimeout(r, 10));
		expect(order).toEqual(["a:start", "a:end", "b"]);
		expect(jobs.list().map((j) => j.status)).toEqual(["success", "success"]);
	});

	it("keeps captured output and a reason when a job fails", async () => {
		const jobs = new JobTracker((err, log) => `${(err as Error).message} | ${log.at(-1)}`);
		jobs.run("install", "npm:a", "a", async () => {
			jobs.append("\u001b[31mnpm error code E404\u001b[0m\npartial");
			throw new Error("boom");
		});
		await new Promise((r) => setTimeout(r, 5));
		const [job] = jobs.list();
		expect(job?.status).toBe("error");
		expect(job?.log).toEqual(["npm error code E404", "partial"]);
		expect(job?.error).toBe("boom | partial");
	});

	it("does not queue the same operation twice while it is pending", async () => {
		const jobs = new JobTracker(() => "x");
		const g = gate();
		const first = jobs.run("install", "npm:a", "a", () => g.wait);
		const second = jobs.run("install", "npm:a", "a", async () => {});
		expect(second.id).toBe(first.id);
		expect(jobs.list()).toHaveLength(1);
		g.open();
	});

	it("only dismisses finished jobs", async () => {
		const jobs = new JobTracker(() => "x");
		const g = gate();
		const running = jobs.run("install", "npm:a", "a", () => g.wait);
		await new Promise((r) => setTimeout(r, 5));
		jobs.dismiss(running.id);
		expect(jobs.list()).toHaveLength(1);
		g.open();
		await new Promise((r) => setTimeout(r, 5));
		jobs.dismiss(running.id);
		expect(jobs.list()).toHaveLength(0);
	});
});

describe("explainFailure", () => {
	it("recognises a missing package and quotes the npm error", () => {
		const log = ["$ npm install npm:nope", "npm error code E404", "npm error 404 Not Found - GET https://registry.npmjs.org/nope", "npm error A complete log of this run can be found in: x"];
		const out = explainFailure(new Error("npm install failed with code 1"), log);
		expect(out).toContain("找不到该包");
		expect(out).toContain("404 Not Found");
		expect(out).not.toContain("complete log");
	});

	it("explains a missing npm executable", () => {
		expect(explainFailure(new Error("spawn npm ENOENT"), [])).toContain("PATH");
	});

	it("explains network failures", () => {
		expect(explainFailure(new Error("x"), ["npm error code ENOTFOUND", "npm error network request failed"])).toContain("网络");
	});

	it("falls back to the last npm error line", () => {
		expect(explainFailure(new Error("failed with code 1"), ["npm error something odd"])).toBe("something odd");
	});

	it("truncates very long messages", () => {
		expect(explainFailure(new Error("e".repeat(1000)), []).length).toBeLessThanOrEqual(301);
	});
});

describe("captureCommandOutput", () => {
	const fakeChild = (code: number, out: string, err: string) => {
		const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => {};
		setTimeout(() => {
			child.stdout.write(out);
			child.stderr.write(err);
			child.emit("close", code);
		}, 1);
		return child;
	};

	it("returns false when PI no longer exposes the spawn hook", () => {
		expect(captureCommandOutput({}, () => {})).toBe(false);
	});

	it("pipes output to the sink and resolves on exit 0", async () => {
		const manager = { spawnCaptureCommand: () => fakeChild(0, "added 1 package\n", "") } as Record<string, unknown>;
		const chunks: string[] = [];
		expect(captureCommandOutput(manager, (c) => chunks.push(c))).toBe(true);
		await (manager.runCommand as (c: string, a: string[]) => Promise<void>)("npm", ["install", "x"]);
		expect(chunks.join("")).toContain("$ npm install x");
		expect(chunks.join("")).toContain("added 1 package");
	});

	it("rejects with the exit code and keeps stderr", async () => {
		const manager = { spawnCaptureCommand: () => fakeChild(1, "", "npm error code E404\n") } as Record<string, unknown>;
		const chunks: string[] = [];
		captureCommandOutput(manager, (c) => chunks.push(c));
		await expect((manager.runCommand as (c: string, a: string[]) => Promise<void>)("npm", ["install"])).rejects.toThrow("退出码 1");
		expect(chunks.join("")).toContain("E404");
	});

	it("times out hung commands", async () => {
		const hang = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
		hang.stdout = new PassThrough();
		hang.stderr = new PassThrough();
		let killed = false;
		hang.kill = () => void (killed = true);
		const manager = { spawnCaptureCommand: () => hang } as Record<string, unknown>;
		captureCommandOutput(manager, () => {}, 20);
		await expect((manager.runCommand as (c: string, a: string[]) => Promise<void>)("npm", [])).rejects.toThrow("超时");
		expect(killed).toBe(true);
	});
});
