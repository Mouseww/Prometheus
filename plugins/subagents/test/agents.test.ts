import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore, defFromFile, diffOverride, parseAgentFile, serializeAgent } from "../src/agents.ts";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "subagents-test-"));
	const bundled = join(dir, "npm", "node_modules", "pi-subagents", "agents");
	await mkdir(bundled, { recursive: true });
	await writeFile(
		join(bundled, "scout.md"),
		"---\nname: scout\ndescription: Fast recon\ntools: read, grep, find\nthinking: low\nsystemPromptMode: replace\ninheritProjectContext: true\n---\n\nYou scout.\n",
	);
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const settings = async () => JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));

describe("frontmatter", () => {
	it("round-trips the managed fields and keeps unknown keys", () => {
		const text = "---\nname: a\ndescription: d\nextensions: ./x.ts\ntools:\n  - read\n  - bash\n---\n\nbody\n";
		const parsed = parseAgentFile(text);
		const def = defFromFile("a", parsed);
		expect(def.tools).toEqual(["read", "bash"]);
		const out = serializeAgent({ ...def, model: "gw/m", timeoutMin: 2 }, parsed);
		expect(out).toContain("extensions: ./x.ts");
		expect(out).toContain("model: gw/m");
		expect(out).toContain("timeoutMs: 120000");
		expect(defFromFile("a", parseAgentFile(out)).tools).toEqual(["read", "bash"]);
		expect(out.trim().endsWith("body")).toBe(true);
	});

	it("collapses a multi-line description so the file stays valid", () => {
		const out = serializeAgent({ ...defFromFile("a", parseAgentFile("")), name: "a", description: "x\ny" });
		expect(out).toContain("description: x y");
	});
});

describe("AgentStore", () => {
	it("lists bundled agents and stores only the difference as an override", async () => {
		const store = new AgentStore(dir);
		expect((await store.list()).map((a) => a.name)).toEqual(["scout"]);
		const a = await store.get("scout");
		await store.save("scout", { ...a, model: "gw/fast", prompt: a.prompt });
		expect((await settings()).subagents.agentOverrides.scout).toEqual({ model: "gw/fast" });
		const after = await store.get("scout");
		expect(after.model).toBe("gw/fast");
		expect(after.modified).toBe(true);
		await store.reset("scout");
		expect((await store.get("scout")).modified).toBe(false);
		expect((await settings()).subagents).toBeUndefined();
	});

	it("keeps other settings and unmanaged override keys intact", async () => {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ theme: "x", subagents: { agentOverrides: { scout: { output: "o.md" } } } }));
		const store = new AgentStore(dir);
		const a = await store.get("scout");
		await store.save("scout", { ...a, thinking: "high" });
		const s = await settings();
		expect(s.theme).toBe("x");
		expect(s.subagents.agentOverrides.scout).toEqual({ output: "o.md", thinking: "high" });
	});

	it("disables and re-enables without touching the definition", async () => {
		const store = new AgentStore(dir);
		await store.setDisabled("scout", true);
		expect((await store.get("scout")).disabled).toBe(true);
		await store.setDisabled("scout", false);
		expect((await store.get("scout")).disabled).toBe(false);
	});

	it("creates, edits and deletes a custom agent as a markdown file", async () => {
		const store = new AgentStore(dir);
		await store.create("helper", { description: "Helps", prompt: "Be helpful", tools: ["read"], context: "fork", advertise: true });
		const file = join(dir, "agents", "helper.md");
		expect(await readFile(file, "utf8")).toContain("defaultContext: fork");
		const a = await store.get("helper");
		expect(a.source).toBe("custom");
		await store.save("helper", { ...a, mode: "append", timeoutMin: 5 });
		expect((await store.get("helper")).mode).toBe("append");
		await expect(store.create("helper", {})).rejects.toThrow();
		await store.remove("helper");
		await expect(store.get("helper")).rejects.toThrow();
	});

	it("restores the bundled agent when a shadowing file is removed", async () => {
		const store = new AgentStore(dir);
		await store.create("x", {});
		await mkdir(join(dir, "agents"), { recursive: true });
		await writeFile(join(dir, "agents", "scout.md"), "---\nname: scout\ndescription: mine\n---\n\nmine\n");
		const shadow = await store.get("scout");
		expect(shadow.shadows).toBe(true);
		await store.reset("scout");
		expect((await store.get("scout")).description).toBe("Fast recon");
	});

	it("rejects unsafe names and bad thinking levels", async () => {
		const store = new AgentStore(dir);
		await expect(store.create("../evil", {})).rejects.toThrow();
		await expect(store.create("ok", { thinking: "ludicrous" })).rejects.toThrow();
		await expect(store.remove("scout")).rejects.toThrow();
	});

	it("diffOverride is empty for an unchanged definition", () => {
		const d = defFromFile("a", parseAgentFile("---\nname: a\n---\n\nx"));
		expect(diffOverride(d, d)).toEqual({});
	});
});

describe("default model", () => {
	it("stores and clears subagents.defaultModel", async () => {
		const store = new AgentStore(dir);
		await store.setDefaultModel("agirouter/claude-sonnet-5-5");
		expect(await store.getDefaultModel()).toBe("agirouter/claude-sonnet-5-5");
		await store.setDefaultModel("");
		expect(await store.getDefaultModel()).toBe("");
		expect((await settings()).subagents).toBeUndefined();
	});
});
