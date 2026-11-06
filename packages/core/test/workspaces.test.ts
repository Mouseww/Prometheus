import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "../src/workspaces.ts";

describe("WorkspaceStore extra folders", () => {
	it("keeps additional folders, drops the primary and duplicates, and rejects missing ones", async () => {
		const root = mkdtempSync(join(tmpdir(), "ws-"));
		const [a, b, c] = ["a", "b", "c"].map((n) => join(root, n));
		for (const d of [a!, b!, c!]) mkdirSync(d);
		const store = new WorkspaceStore(join(root, "workspaces.json"));
		const w = await store.add(a!, undefined, [b!, a!, b!]);
		expect(w.extraPaths).toHaveLength(1);
		expect((await store.setFolders(w.id, [b!, c!])).extraPaths).toHaveLength(2);
		expect((await store.setFolders(w.id, [])).extraPaths).toBeUndefined();
		await expect(store.setFolders(w.id, [join(root, "nope")])).rejects.toThrow();
	});
});
