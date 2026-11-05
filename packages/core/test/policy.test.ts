import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { GatewayConfig } from "@prometheus/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { PrometheusHost } from "../src/host.ts";
import { PermissionGate } from "../src/permission-gate.ts";
import { PluginHost } from "../src/plugin-host.ts";
import { allowedMode, loadPolicy, mergeGateways, parsePolicy, publicPolicy } from "../src/policy.ts";

const gateway = (id: string): GatewayConfig => ({ id, name: id, format: "openai-completions", baseUrl: "https://example.com/v1", auth: { type: "bearer" }, apiKey: "sk-secret-value", models: [{ id: "m", name: "m" }] });

let dirs: string[] = [];
const tmp = async () => {
	const d = await mkdtemp(join(tmpdir(), "policy-"));
	dirs.push(d);
	return d;
};
afterEach(async () => {
	delete process.env.PROMETHEUS_POLICY;
	for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	dirs = [];
});

describe("parsePolicy", () => {
	it("accepts a full policy", () => {
		const p = parsePolicy({ serverOwner: " u1 ", forbiddenModes: ["auto", "auto"], defaultPermission: "plan", readOutsideProject: "ask", pluginAllowlist: ["git"], gateways: [gateway("g")], managedBy: "IT" });
		expect(p).toMatchObject({ serverOwner: "u1", forbiddenModes: ["auto"], defaultPermission: "plan", readOutsideProject: "ask", pluginAllowlist: ["git"], managedBy: "IT" });
		expect(p.gateways).toHaveLength(1);
	});
	it("rejects bad shapes", () => {
		expect(() => parsePolicy([])).toThrow();
		expect(() => parsePolicy({ forbiddenModes: ["nope"] })).toThrow();
		expect(() => parsePolicy({ defaultPermission: "auto", forbiddenModes: ["auto"] })).toThrow();
		expect(() => parsePolicy({ readOutsideProject: "maybe" })).toThrow();
		expect(() => parsePolicy({ pluginAllowlist: [1] })).toThrow();
		expect(() => parsePolicy({ gateways: [{ id: "" }] })).toThrow();
		expect(() => parsePolicy({ forbidenModes: [] })).toThrow();
	});
	it("hides gateway keys from clients", () => {
		const view = publicPolicy(parsePolicy({ gateways: [gateway("g")] }));
		expect(view.gateways).toEqual([{ id: "g", name: "g", format: "openai-completions", baseUrl: "https://example.com/v1" }]);
	});
});

describe("allowedMode and mergeGateways", () => {
	it("downgrades a banned mode to the policy default, then to default", () => {
		expect(allowedMode(undefined, "auto")).toBe("auto");
		expect(allowedMode({ forbiddenModes: ["auto"] }, "auto")).toBe("default");
		expect(allowedMode({ forbiddenModes: ["auto"], defaultPermission: "acceptEdits" }, "auto")).toBe("acceptEdits");
		expect(allowedMode({ forbiddenModes: ["auto", "acceptEdits"], defaultPermission: "acceptEdits" }, "auto")).toBe("default");
	});
	it("puts policy gateways first and wins on the same id", () => {
		const merged = mergeGateways([gateway("a"), gateway("b")], { gateways: [{ ...gateway("b"), name: "policy-b" }] });
		expect(merged.map((g) => g.name)).toEqual(["policy-b", "a"]);
		const local = [gateway("a")];
		expect(mergeGateways(local, undefined)).toBe(local);
	});
});

describe("loadPolicy", () => {
	it("is absent without a file", async () => {
		expect(await loadPolicy(await tmp(), {})).toBeUndefined();
	});
	it("reads policy.json and lets PROMETHEUS_POLICY win", async () => {
		const dir = await tmp();
		await writeFile(join(dir, "policy.json"), JSON.stringify({ managedBy: "file" }));
		const other = join(dir, "other.json");
		await writeFile(other, JSON.stringify({ managedBy: "env" }));
		expect((await loadPolicy(dir, {}))?.managedBy).toBe("file");
		expect((await loadPolicy(dir, { PROMETHEUS_POLICY: other }))?.managedBy).toBe("env");
	});
	it("refuses to start on a broken or missing explicit file", async () => {
		const dir = await tmp();
		await writeFile(join(dir, "policy.json"), "{broken");
		await expect(loadPolicy(dir, {})).rejects.toThrow();
		await expect(loadPolicy(dir, { PROMETHEUS_POLICY: join(dir, "nope.json") })).rejects.toThrow();
		const store = new ConfigStore(dir);
		await expect(store.load()).rejects.toThrow();
	});
});

describe("ConfigStore under a policy", () => {
	async function store(policy?: object) {
		const dir = await tmp();
		if (policy) await writeFile(join(dir, "policy.json"), JSON.stringify(policy));
		const s = new ConfigStore(dir);
		await s.load();
		return s;
	}
	it("without a policy nothing changes", async () => {
		const s = await store();
		expect(s.policy()).toBeUndefined();
		await s.setDefaultPermission("auto");
		expect(s.get().defaultPermission).toBe("auto");
		await s.saveGateway(gateway("g"));
		expect(s.gateways().map((g) => g.id)).toEqual(["g"]);
	});
	it("forces the default permission and refuses changes", async () => {
		const s = await store({ defaultPermission: "plan" });
		expect(s.get().defaultPermission).toBe("plan");
		await expect(s.setDefaultPermission("auto")).rejects.toMatchObject({ code: "policyLocked", params: { field: "defaultPermission" } });
	});
	it("refuses a banned default and degrades a stored banned one", async () => {
		const dir = await tmp();
		await writeFile(join(dir, "config.json"), JSON.stringify({ defaultPermission: "bypassPermissions" }));
		await writeFile(join(dir, "policy.json"), JSON.stringify({ forbiddenModes: ["bypassPermissions"] }));
		const s = new ConfigStore(dir);
		await s.load();
		expect(s.get().defaultPermission).toBe("");
		await expect(s.setDefaultPermission("bypassPermissions")).rejects.toMatchObject({ code: "policyLocked" });
		await s.setDefaultPermission("acceptEdits");
		expect(s.get().defaultPermission).toBe("acceptEdits");
	});
	it("locks gateways and merges the administrator's", async () => {
		const s = await store({ gateways: [gateway("corp")] });
		expect(s.gateways().map((g) => g.id)).toEqual(["corp"]);
		await expect(s.saveGateway(gateway("mine"))).rejects.toMatchObject({ code: "policyLocked", params: { field: "gateways" } });
		await expect(s.deleteGateway("corp")).rejects.toMatchObject({ code: "policyLocked" });
	});
});

describe("PermissionGate under a policy", () => {
	it("refuses a banned mode", () => {
		const gate = new PermissionGate();
		gate.policy = { forbiddenModes: ["auto"] };
		expect(() => gate.setMode("auto")).toThrowError(expect.objectContaining({ code: "policyLocked" }));
		gate.setMode("acceptEdits");
		expect(gate.mode).toBe("acceptEdits");
	});
	it("an unattended run whose access maps to a banned mode falls back to default and says so", async () => {
		const gate = new PermissionGate();
		gate.unattended = "full";
		gate.policy = { forbiddenModes: ["bypassPermissions"] };
		const bash = await gate.evaluate({ toolName: "bash", input: { command: "rm -rf x" }, readOnly: false, cwd: "/w" });
		expect(bash).toMatchObject({ block: true });
		expect(gate.takeBlocked().some((b) => b.tool === "policy")).toBe(true);
		const open = new PermissionGate();
		open.unattended = "full";
		expect(await open.evaluate({ toolName: "bash", input: { command: "rm -rf x" }, readOnly: false, cwd: "/w" })).toBeUndefined();
	});
});

describe("PermissionGate reading outside the project", () => {
	it("asks every time and asks every time for an outside read", async () => {
		const gate = new PermissionGate();
		gate.policy = { readOutsideProject: "ask" };
		const prompts: string[] = [];
		gate.ask = async (p) => {
			prompts.push(p.kind === "tool" ? p.toolName : p.kind);
			return "allow";
		};
		const read = { toolName: "read", input: { path: "/elsewhere/file" }, readOnly: false, cwd: "/w/app" };
		expect(await gate.evaluate(read)).toBeUndefined();
		expect(await gate.evaluate(read)).toBeUndefined();
		expect(prompts).toEqual(["read", "read"]);
		expect(await gate.evaluate({ ...read, input: { path: "src/a.ts" } })).toBeUndefined();
		expect(prompts).toHaveLength(2);
	});
	it("an unattended run that would read outside is refused", async () => {
		const gate = new PermissionGate();
		gate.unattended = "readonly";
		gate.policy = { readOutsideProject: "ask" };
		expect(await gate.evaluate({ toolName: "read", input: { path: "/elsewhere" }, readOnly: false, cwd: "/w/app" })).toMatchObject({ block: true });
	});
});

describe("plugin allowlist", () => {
	it("skips plugins off the list and refuses to install or enable them", async () => {
		const dataDir = await tmp();
		const host = new PluginHost({
			host: "server",
			dataDir,
			agentDir: join(dataDir, "agent"),
			cwd: dataDir,
			settings: () => ({}),
			gateways: () => [],
			allowPlugin: (n) => n === "ok" || n === "ok2",
		});
		await host.load({ name: "ok2", setup: () => {} }, "builtin");
		await host.load({ name: "other", setup: () => {} }, "builtin");
		expect(host.list().map((p) => p.name)).toEqual(["ok2"]);
		const files = (name: string) => [{ path: "index.js", content: `export default { name: ${JSON.stringify(name)}, setup() {} };` }];
		await expect(host.install({ name: "other", files: files("other") })).rejects.toMatchObject({ code: "policyLocked" });
		await expect(host.install({ name: "ok", files: files("ok") })).resolves.toMatchObject({ plugin: { name: "ok" } });
		const plugins = join(dataDir, "plugins", "sneaky");
		await mkdir(plugins, { recursive: true });
		await writeFile(join(plugins, "package.json"), JSON.stringify({ name: "sneaky", main: "index.js", type: "module" }));
		await writeFile(join(plugins, "index.js"), 'export default { name: "sneaky", setup() {} };');
		await host.scan();
		expect(host.list().map((p) => p.name)).not.toContain("sneaky");
	});
});

describe("host under a policy", () => {
	it("shows policy to clients without keys, and restores a banned mode as a lower one", async () => {
		const root = await tmp();
		const cwd = join(root, "work");
		await mkdir(cwd);
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		const sm = SessionManager.create(cwd);
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
		const id = sm.getSessionId();
		const dataDir = join(root, "data");
		await mkdir(join(dataDir, "sessions"), { recursive: true });
		await writeFile(join(dataDir, "sessions", "permissions.json"), JSON.stringify({ [id]: "bypassPermissions" }));
		await writeFile(join(dataDir, "policy.json"), JSON.stringify({ forbiddenModes: ["bypassPermissions"], gateways: [gateway("corp")], managedBy: "IT" }));
		const host = await PrometheusHost.create({
			dataDir,
			cwd,
			listener: { event: () => {}, uiRequest: () => {}, uiResolved: () => {}, sessionsChanged: () => {}, gatewaysChanged: () => {}, pluginsChanged: () => {}, pluginNotify: () => {} },
		});
		try {
			const settings = await host.call("settings.get", {});
			expect(settings.policy?.managedBy).toBe("IT");
			expect(JSON.stringify(settings.policy)).not.toContain("sk-secret-value");
			expect((await host.call("session.open", { sessionId: id })).permissionMode).toBe("default");
			await expect(host.call("permission.set", { sessionId: id, mode: "bypassPermissions" })).rejects.toMatchObject({ code: "policyLocked" });
			await expect(host.call("gateway.save", { gateway: gateway("mine") })).rejects.toMatchObject({ code: "policyLocked" });
			expect((await host.call("gateway.list", {})).map((g) => g.id)).toEqual(["corp"]);
		} finally {
			await host.dispose();
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	}, 60_000);
});
