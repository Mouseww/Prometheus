// The plugin inside a real PluginHost: neutral tools only, lazy start, RPC validation, stream wiring.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginHost } from "../../../packages/core/src/plugin-host.ts";
import browser from "../src/index.ts";

const hosts: PluginHost[] = [];
afterEach(async () => {
	for (const h of hosts.splice(0)) await h.dispose();
});

async function load() {
	const dataDir = await mkdtemp(join(tmpdir(), "pm-browser-plugin-"));
	const host = new PluginHost({ host: "server", dataDir, agentDir: join(dataDir, "agent"), cwd: dataDir, settings: () => ({}), gateways: () => [] });
	hosts.push(host);
	const published: unknown[] = [];
	host.publishPlugin = (_p, topic, data) => void published.push({ topic, data });
	await host.load(browser, "builtin");
	return { host, published };
}

describe("browser plugin", () => {
	it("registers eight runtime-neutral tools and nothing PI-only", async () => {
		const { host } = await load();
		expect(host.list()[0]).toMatchObject({ name: "browser", status: "loaded", toggleable: true });
		expect(host.tools.map((t) => t.tool.name)).toEqual(["browser_navigate", "browser_tabs", "browser_snapshot", "browser_act", "browser_keys", "browser_screenshot", "browser_wait", "browser_eval"]);
		expect(host.tools.filter((t) => t.tool.annotations?.readOnlyHint).map((t) => t.tool.name)).toEqual(["browser_snapshot", "browser_screenshot", "browser_wait"]);
		expect(await host.compatibility()).toEqual([]);
		// Guidelines ride on the first tool only, so they appear once.
		expect(host.tools.filter((t) => t.tool.promptGuidelines?.length)).toHaveLength(1);
	});

	it("does not start a browser on load, and validates what clients send", async () => {
		const { host } = await load();
		const state = (await host.rpcs.get("browser/state")!({})) as { state: { status: string; tabs: unknown[] }; settings: { mode: string } };
		expect(state.state.status).toBe("stopped");
		expect(state.state.tabs).toEqual([]);
		expect(state.settings.mode).toBe("headless");
		// Input for a browser that is not running is ignored, not an error.
		expect(await host.rpcs.get("browser/input")!({ tab: "t1", events: [{ k: "text", text: "x" }] })).toEqual({});
		await expect(host.rpcs.get("browser/history")!({ action: "rm -rf" })).rejects.toThrow();
		await expect(host.rpcs.get("browser/files.choose")!({ tab: "t1", paths: ["/etc/passwd"] })).rejects.toThrow("只能选择刚上传的文件");
		const saved = (await host.rpcs.get("browser/settings.set")!({ settings: { quality: 1000, proxy: "nope", idleMinutes: 5 } })) as { settings: { quality: number; proxy: string; idleMinutes: number } };
		expect(saved.settings).toMatchObject({ quality: 95, proxy: "", idleMinutes: 5 });
	});

	it("greets a new watcher with the current state", async () => {
		const { host, published } = await load();
		host.setWatchers("browser", "view", 1);
		await new Promise((r) => setTimeout(r, 20));
		expect(published).toContainEqual({ topic: "view", data: { k: "state", state: expect.objectContaining({ status: "stopped" }) } });
	});
});
