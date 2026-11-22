import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanSyncSettings, SyncLedger } from "../src/sync.ts";

describe("cleanSyncSettings", () => {
	it("keeps known well-typed fields only", () => {
		expect(cleanSyncSettings({ goalTurns: 12, worktreeMode: "on", autoCompaction: true, workspaceRoot: "/x", recycleDays: "9", evil: 1 })).toEqual({ goalTurns: 12, worktreeMode: "on", autoCompaction: true });
	});
	it("tolerates garbage", () => {
		expect(cleanSyncSettings(null)).toEqual({});
		expect(cleanSyncSettings("x")).toEqual({});
	});
});

describe("SyncLedger", () => {
	it("remembers origin ids across instances", async () => {
		const file = join(await mkdtemp(join(tmpdir(), "sync-")), "ledger.json");
		await new SyncLedger(file).set("a", "local-1");
		expect(await new SyncLedger(file).get("a")).toBe("local-1");
		expect(await new SyncLedger(file).get("b")).toBeUndefined();
	});
});
