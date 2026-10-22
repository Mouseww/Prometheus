import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";

const store = async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "config-"));
	const config = new ConfigStore(dataDir);
	await config.load();
	return { dataDir, config };
};

describe("workspaceRoot", () => {
	it("defaults to empty, so the folder picker falls back to home", async () => {
		const { dataDir, config } = await store();
		expect(config.get().workspaceRoot).toBe("");
		await rm(dataDir, { recursive: true, force: true });
	});

	it("survives a reload", async () => {
		const { dataDir, config } = await store();
		const root = join(dataDir, "projects");
		await mkdir(root);
		await config.setWorkspaceRoot(`  ${root}  `);

		const reopened = new ConfigStore(dataDir);
		await reopened.load();
		expect(reopened.get().workspaceRoot).toBe(root);

		await reopened.setWorkspaceRoot("");
		expect(reopened.get().workspaceRoot).toBe("");
		await rm(dataDir, { recursive: true, force: true });
	});
});
