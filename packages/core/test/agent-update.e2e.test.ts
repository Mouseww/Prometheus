// Agent CLI updates through the host, against the real npm registry: an older OpenCode installed by Prometheus is
// reported as outdated, `agent.install` upgrades it, and the runtime then runs the new copy.
// Downloads packages, so it only runs with PROMETHEUS_TEST_UPDATES=1.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentInstallPrefix } from "../src/agent/install.ts";
import { PrometheusHost } from "../src/host.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const enabled = process.env.PROMETHEUS_TEST_UPDATES === "1";
let root: string;
let host: PrometheusHost;
let previous: string | undefined;

beforeAll(async () => {
	if (!enabled) return;
	root = await mkdtemp(join(tmpdir(), "prometheus-update-"));
	await mkdir(join(root, "work"));
	previous = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = join(root, "agent");
	const data = join(root, "data");
	// An outdated copy, as an earlier one-click install would have left it.
	const versions: string[] = JSON.parse(execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["view", "opencode-ai", "versions", "--json"], { encoding: "utf8", shell: process.platform === "win32" }));
	const older = versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v)).at(-2)!;
	execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--global", "--prefix", agentInstallPrefix(data), "--no-fund", "--no-audit", "--loglevel=error", `opencode-ai@${older}`], { stdio: "ignore", shell: process.platform === "win32" });
	host = await PrometheusHost.create({
		dataDir: data,
		cwd: join(root, "work"),
		listener: { event: () => {}, uiRequest: () => {}, uiResolved: () => {}, sessionsChanged: () => {}, gatewaysChanged: () => {}, pluginsChanged: () => {}, pluginNotify: () => {} },
	});
}, 600_000);

afterAll(async () => {
	await host?.dispose();
	if (previous === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = previous;
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

describe.skipIf(!enabled)("agent CLI updates", { timeout: 600_000 }, () => {
	it("reports an outdated copy, upgrades it, and runs the new one", async () => {
		const [before] = await host.call("agent.checkUpdates", { id: "opencode", refresh: true });
		expect(before).toMatchObject({ id: "opencode", source: "prometheus", updateAvailable: true });
		expect(before!.latest).toBeDefined();
		const running = (await host.call("runtime.list", {})).find((r) => r.id === "opencode")!;
		expect(running.health.version).toContain(before!.current!);

		await host.call("agent.install", { agent: "opencode" });
		const [after] = await host.call("agent.checkUpdates", { id: "opencode" });
		expect(after).toMatchObject({ source: "prometheus", current: before!.latest, updateAvailable: false });
		const now = (await host.call("runtime.list", {})).find((r) => r.id === "opencode")!;
		expect(now.health.version).toContain(before!.latest!);
	});

	it("explains agents it cannot update, and knows Claude Code's bundled version", async () => {
		await host.call("agent.save", { agent: { id: "oc-remote", name: "remote", kind: "opencode", server: { url: "http://127.0.0.1:1" } } });
		await host.call("agent.save", { agent: { id: "goose", name: "Goose", kind: "acp", executable: "goose", args: ["acp"] } });
		const list = await host.call("agent.checkUpdates", {});
		expect(list.find((u) => u.id === "oc-remote")).toMatchObject({ source: "server", reason: "server", updateAvailable: false });
		expect(list.find((u) => u.id === "goose")).toMatchObject({ source: "custom", updateAvailable: false });
		const cc = list.find((u) => u.id === "claude-code")!;
		expect(cc.source).toBe("bundled");
		expect(cc.current).toMatch(/^\d+\.\d+\.\d+/);
	});
});
