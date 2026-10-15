import { randomUUID } from "node:crypto";
import type { PackageJob } from "@prometheus/protocol";

const MAX_LOG_LINES = 200;
const MAX_LINE = 400;
const MAX_FINISHED = 20;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Runs package operations one at a time in the background and keeps their outcome and captured output,
 * so clients can poll for progress instead of holding a request open.
 */
export class JobTracker {
	private jobs: PackageJob[] = [];
	private tail: Promise<void> = Promise.resolve();
	private running: PackageJob | undefined;
	private partial = "";
	private readonly explain: (err: unknown, log: string[]) => string;

	constructor(explain: (err: unknown, log: string[]) => string) {
		this.explain = explain;
	}

	run(action: PackageJob["action"], source: string, label: string, task: () => Promise<void>): PackageJob {
		const existing = this.jobs.find((j) => (j.status === "queued" || j.status === "running") && j.action === action && j.source === source);
		if (existing) return structuredClone(existing);

		const job: PackageJob = { id: randomUUID(), action, source, label, status: "queued", startedAt: Date.now(), log: [] };
		this.jobs.push(job);
		const exec = async (): Promise<void> => {
			job.status = "running";
			this.running = job;
			this.partial = "";
			try {
				await task();
				this.flush();
				job.status = "success";
			} catch (err) {
				this.flush();
				job.status = "error";
				job.error = this.explain(err, job.log);
			} finally {
				this.running = undefined;
				job.finishedAt = Date.now();
				this.prune();
			}
		};
		this.tail = this.tail.then(exec);
		return structuredClone(job);
	}

	/** Feed raw process output to the job that is currently running. */
	append(chunk: string): void {
		const job = this.running;
		if (!job) return;
		const lines = (this.partial + chunk.replace(ANSI, "").replace(/\r\n?/g, "\n")).split("\n");
		this.partial = lines.pop() ?? "";
		for (const line of lines) this.push(job, line);
	}

	list(): PackageJob[] {
		return this.jobs.map((j) => structuredClone(j)).reverse();
	}

	dismiss(id: string): void {
		this.jobs = this.jobs.filter((j) => j.id !== id || j.status === "queued" || j.status === "running");
	}

	private flush(): void {
		if (this.running && this.partial.trim()) this.push(this.running, this.partial);
		this.partial = "";
	}

	private push(job: PackageJob, line: string): void {
		const text = line.trimEnd().slice(0, MAX_LINE);
		if (!text.trim()) return;
		job.log.push(text);
		if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
	}

	private prune(): void {
		const finished = this.jobs.filter((j) => j.status === "success" || j.status === "error");
		const drop = new Set(finished.slice(0, Math.max(0, finished.length - MAX_FINISHED)));
		if (drop.size) this.jobs = this.jobs.filter((j) => !drop.has(j));
	}
}
