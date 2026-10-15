import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectUsage } from "../src/usage.ts";

const usage = (input: number, output: number, cost: number) => ({ input, output, cacheRead: 5, cacheWrite: 0, totalTokens: input + output, cost: { total: cost } });
const reply = (timestamp: string, model: string, u: ReturnType<typeof usage>) =>
	JSON.stringify({ type: "message", timestamp, message: { role: "assistant", provider: "p", model, usage: u, content: [] } });

describe("collectUsage", () => {
	it("aggregates assistant usage by model and day, ignoring other lines", async () => {
		const dir = await mkdtemp(join(tmpdir(), "usage-"));
		const file = join(dir, "s.jsonl");
		await writeFile(
			file,
			[
				JSON.stringify({ type: "session", id: "s" }),
				JSON.stringify({ type: "message", timestamp: "2026-10-14T10:00:00", message: { role: "user", content: "usage" } }),
				reply("2026-10-14T10:00:01", "a", usage(100, 10, 0.5)),
				reply("2026-10-14T11:00:00", "a", usage(50, 5, 0.25)),
				reply("2026-10-15T09:00:00", "b", usage(1, 2, 0)),
				"not json \"usage\"",
			].join("\n"),
		);

		const stats = await collectUsage([file, join(dir, "missing.jsonl")], 0, new Date("2026-10-15T12:00:00"));
		expect(stats.sessions).toBe(1);
		expect(stats.totals).toMatchObject({ input: 151, output: 17, cacheRead: 15, cost: 0.75, requests: 3 });
		expect(stats.byModel.map((m) => m.model)).toEqual(["a", "b"]);
		expect(stats.byDay.map((d) => [d.date, d.requests])).toEqual([["2026-10-14", 2], ["2026-10-15", 1]]);
	});

	it("limits to the requested number of days", async () => {
		const dir = await mkdtemp(join(tmpdir(), "usage-"));
		const file = join(dir, "s.jsonl");
		await writeFile(file, [reply("2026-10-10T10:00:00", "a", usage(100, 0, 1)), reply("2026-10-15T10:00:00", "a", usage(7, 0, 0))].join("\n"));

		const stats = await collectUsage([file], 1, new Date("2026-10-15T12:00:00"));
		expect(stats.totals.input).toBe(7);
		expect(stats.byDay).toHaveLength(1);
	});
});
