import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrometheusHost } from "../src/host.ts";
import { assertAgentAllowed, pluginAllowed, serverRole } from "../src/role.ts";

describe("serverRole", () => {
	it("is a normal server unless PROMETHEUS_ROLE=hub", () => {
		expect(serverRole({})).toBe("server");
		expect(serverRole({ PROMETHEUS_ROLE: "server" })).toBe("server");
		expect(serverRole({ PROMETHEUS_ROLE: "whatever" })).toBe("server");
		expect(serverRole({ PROMETHEUS_ROLE: "hub" })).toBe("hub");
		expect(serverRole({ PROMETHEUS_ROLE: " Hub " })).toBe("hub");
	});
});

describe("assertAgentAllowed", () => {
	it("refuses agent RPCs on a hub only", () => {
		for (const m of ["session.create", "chat.prompt", "message.fork", "session.switchRuntime"]) {
			expect(() => assertAgentAllowed("hub", m, {}), m).toThrowError(expect.objectContaining({ code: "agentDisabled" }));
			expect(() => assertAgentAllowed("server", m, {}), m).not.toThrow();
		}
		expect(() => assertAgentAllowed("hub", "session.list", {})).not.toThrow();
		expect(() => assertAgentAllowed("hub", "settings.get", {})).not.toThrow();
	});
	it("refuses terminal and ssh creation through plugin.call", () => {
		expect(() => assertAgentAllowed("hub", "plugin.call", { plugin: "terminal", method: "open" })).toThrowError(expect.objectContaining({ code: "agentDisabled" }));
		expect(() => assertAgentAllowed("hub", "plugin.call", { plugin: "ssh", method: "test" })).toThrowError(expect.objectContaining({ code: "agentDisabled" }));
		expect(() => assertAgentAllowed("hub", "plugin.call", { plugin: "team", method: "open" })).not.toThrow();
		expect(() => assertAgentAllowed("server", "plugin.call", { plugin: "terminal", method: "open" })).not.toThrow();
	});
});

describe("pluginAllowed", () => {
	it("a normal server loads everything unless an allowlist says otherwise", () => {
		expect(pluginAllowed("server", undefined, "terminal")).toBe(true);
		expect(pluginAllowed("server", ["git"], "terminal")).toBe(false);
		expect(pluginAllowed("server", ["git"], "git")).toBe(true);
	});
	it("a hub drops the agent plugins by default and never loads automations or flows", () => {
		for (const n of ["terminal", "ssh", "computer-use", "browser", "workbench", "folder", "automations", "flows"]) expect(pluginAllowed("hub", undefined, n), n).toBe(false);
		for (const n of ["team", "git", "memory", "knowledge"]) expect(pluginAllowed("hub", undefined, n), n).toBe(true);
	});
	it("an allowlist replaces the hub default but automations and flows stay out", () => {
		expect(pluginAllowed("hub", ["terminal", "team"], "terminal")).toBe(true);
		expect(pluginAllowed("hub", ["terminal", "team"], "git")).toBe(false);
		expect(pluginAllowed("hub", ["flows"], "flows")).toBe(false);
	});
});

describe("a hub host", () => {
	let root: string | undefined;
	let previous: { agent?: string; role?: string } = {};
	afterEach(async () => {
		if (previous.role === undefined) delete process.env.PROMETHEUS_ROLE;
		else process.env.PROMETHEUS_ROLE = previous.role;
		if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.agent;
		if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("refuses session.create with agentDisabled", async () => {
		root = await mkdtemp(join(tmpdir(), "prometheus-hub-"));
		const cwd = join(root, "work");
		await mkdir(cwd);
		previous = { agent: process.env.PI_CODING_AGENT_DIR, role: process.env.PROMETHEUS_ROLE };
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		process.env.PROMETHEUS_ROLE = "hub";
		const host = await PrometheusHost.create({
			dataDir: join(root, "data"),
			cwd,
			listener: { event: () => {}, uiRequest: () => {}, uiResolved: () => {}, sessionsChanged: () => {}, gatewaysChanged: () => {}, pluginsChanged: () => {}, pluginNotify: () => {} },
		});
		try {
			await expect(host.call("session.create", { cwd })).rejects.toMatchObject({ code: "agentDisabled" });
			await expect(host.call("chat.prompt", { sessionId: "x", text: "hi" })).rejects.toMatchObject({ code: "agentDisabled" });
			await expect(host.call("settings.get", {})).resolves.toBeDefined();
		} finally {
			await host.dispose();
		}
	}, 60_000);
});
