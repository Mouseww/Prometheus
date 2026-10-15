import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginHost, validateFiles } from "../src/plugin-host.ts";

async function makeHost() {
	const dataDir = await mkdtemp(join(tmpdir(), "plughost-"));
	const disabled = new Set<string>();
	let applied = 0;
	const host = new PluginHost({
		host: "server",
		dataDir,
		agentDir: join(dataDir, "agent"),
		cwd: dataDir,
		settings: () => ({}),
		gateways: () => [],
		isDisabled: (id) => disabled.has(id),
		setDisabled: async (id, d) => void (d ? disabled.add(id) : disabled.delete(id)),
	});
	host.reloadSessions = async () => void applied++;
	return { host, dataDir, disabled, applied: () => applied };
}

const plugin = (name: string, body = "", version = "1.0.0") => ({
	path: "index.js",
	content: `export default { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, setup(ctx) { ctx.rpc("hi", () => ${JSON.stringify(version)}); ${body} } };`,
});

describe("PluginHost hot management", () => {
	it("installs a folder plugin live and exposes its rpc, with no restart notes", async () => {
		const { host, applied } = await makeHost();
		const res = await host.install({ name: "alpha", files: [plugin("alpha")] });
		expect(res.hot).toBe(true);
		expect(res.updated).toBe(false);
		expect(res.restartReasons).toEqual([]);
		expect(res.plugin).toMatchObject({ id: "directory:alpha", name: "alpha", status: "loaded", removable: true, toggleable: true });
		expect(await host.rpcs.get("alpha/hi")?.({})).toBe("1.0.0");
		expect(applied()).toBe(1);
	});

	it("updates in place and picks up the new code despite the module cache", async () => {
		const { host } = await makeHost();
		await host.install({ name: "alpha", files: [plugin("alpha", "", "1.0.0")] });
		const res = await host.install({ name: "alpha", files: [plugin("alpha", "", "2.0.0")] });
		expect(res.updated).toBe(true);
		expect(await host.rpcs.get("alpha/hi")?.({})).toBe("2.0.0");
		expect(host.list().filter((p) => p.name === "alpha")).toHaveLength(1);
	});

	it("keeps the working version when an update fails to load", async () => {
		const { host, dataDir } = await makeHost();
		await host.install({ name: "alpha", files: [plugin("alpha", "", "1.0.0")] });
		await expect(host.install({ name: "alpha", files: [plugin("alpha", "throw new Error('boom');", "2.0.0")] })).rejects.toThrow(/已保持原状.*boom/);
		expect(await host.rpcs.get("alpha/hi")?.({})).toBe("1.0.0");
		expect(host.list().find((p) => p.name === "alpha")?.status).toBe("loaded");
		expect(await readFile(join(dataDir, "plugins", "alpha", "index.js"), "utf8")).toContain("1.0.0");
		expect((await readdir(join(dataDir, "plugins"))).filter((n) => n.includes(".bak-"))).toEqual([]);
	});

	it("leaves nothing behind when a first install fails", async () => {
		const { host, dataDir } = await makeHost();
		await expect(host.install({ name: "bad", files: [{ path: "index.js", content: "export default 42" }] })).rejects.toThrow(/已保持原状/);
		expect(host.list()).toEqual([]);
		expect(await stat(join(dataDir, "plugins", "bad")).catch(() => null)).toBeNull();
	});

	it("rejects an entry whose declared name differs from the install name", async () => {
		const { host } = await makeHost();
		await expect(host.install({ name: "alpha", files: [plugin("other")] })).rejects.toThrow(/必须与安装名/);
		expect(host.rpcs.has("other/hi")).toBe(false);
	});

	it("disabling removes rpcs, routes and panels; enabling restores them", async () => {
		const { host, disabled } = await makeHost();
		await host.install({
			name: "alpha",
			files: [plugin("alpha", `ctx.route("GET", "/x", () => {}); ctx.panel({ id: "p", title: "P", path: "/x" });`)],
		});
		expect(host.routes.map((r) => r.path)).toEqual(["/plugins/alpha/x"]);
		expect(host.panels()).toHaveLength(1);

		const off = await host.setEnabled("directory:alpha", false);
		expect(off.status).toBe("disabled");
		expect(disabled.has("directory:alpha")).toBe(true);
		expect(host.rpcs.has("alpha/hi")).toBe(false);
		expect(host.routes).toEqual([]);
		expect(host.panels()).toEqual([]);

		const on = await host.setEnabled("directory:alpha", true);
		expect(on.status).toBe("loaded");
		expect(host.rpcs.has("alpha/hi")).toBe(true);
		expect(host.routes).toHaveLength(1);
	});

	it("runs onDispose cleanup when a plugin is disabled", async () => {
		const { host } = await makeHost();
		await host.install({ name: "alpha", files: [plugin("alpha", `ctx.onDispose(() => { globalThis.__alphaCleaned = (globalThis.__alphaCleaned ?? 0) + 1; });`)] });
		await host.setEnabled("directory:alpha", false);
		expect((globalThis as { __alphaCleaned?: number }).__alphaCleaned).toBe(1);
	});

	it("removes the folder and the entry", async () => {
		const { host, dataDir } = await makeHost();
		await host.install({ name: "alpha", files: [plugin("alpha")] });
		await host.remove("directory:alpha");
		expect(host.list()).toEqual([]);
		expect(host.rpcs.has("alpha/hi")).toBe(false);
		expect(await stat(join(dataDir, "plugins", "alpha")).catch(() => null)).toBeNull();
	});

	it("refuses to disable or remove built-ins", async () => {
		const { host } = await makeHost();
		await host.load({ name: "core-thing", setup() {} }, "builtin");
		await expect(host.setEnabled("builtin:core-thing", false)).rejects.toThrow(/不能停用/);
		await expect(host.remove("builtin:core-thing")).rejects.toThrow(/只能删除/);
	});

	it("lets a built-in marked optional be switched off", async () => {
		const { host } = await makeHost();
		await host.load({ name: "extra", optional: true, setup: (ctx) => ctx.rpc("ping", () => 1) }, "builtin");
		expect(host.list()[0]?.toggleable).toBe(true);
		await host.setEnabled("builtin:extra", false);
		expect(host.rpcs.has("extra/ping")).toBe(false);
	});

	it("starts a plugin that was disabled earlier as disabled", async () => {
		const { host, disabled, dataDir } = await makeHost();
		await host.install({ name: "alpha", files: [plugin("alpha")] });
		await host.dispose();
		const fresh = new PluginHost({ host: "server", dataDir, agentDir: dataDir, cwd: dataDir, settings: () => ({}), gateways: () => [], isDisabled: () => true, setDisabled: async () => {} });
		disabled.add("directory:alpha");
		await fresh.loadDirectory();
		expect(fresh.list()[0]).toMatchObject({ id: "directory:alpha", status: "disabled" });
		expect(fresh.rpcs.has("alpha/hi")).toBe(false);
	});

	it("scan picks up a folder dropped in by hand, once", async () => {
		const { host, dataDir, applied } = await makeHost();
		const { mkdir, writeFile } = await import("node:fs/promises");
		const dir = join(dataDir, "plugins", "manual");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: "manual", main: "index.js" }));
		await writeFile(join(dir, "index.js"), plugin("manual").content);
		expect((await host.scan()).map((p) => p.name)).toEqual(["manual"]);
		expect(applied()).toBe(1);
		await host.scan();
		expect(applied()).toBe(1);
	});

	it("replays active plugin extensions into a session, and stops after disable", async () => {
		const { host } = await makeHost();
		await host.install({ name: "alpha", files: [plugin("alpha", `ctx.extension((pi) => { pi.__seen = (pi.__seen ?? []).concat("alpha"); });`)] });
		const pi = {} as { __seen?: string[] };
		await (host.dynamicExtension() as { factory: (pi: unknown) => Promise<void> }).factory(pi);
		expect(pi.__seen).toEqual(["alpha"]);
		await host.setEnabled("directory:alpha", false);
		const pi2 = {} as { __seen?: string[] };
		await (host.dynamicExtension() as { factory: (pi: unknown) => Promise<void> }).factory(pi2);
		expect(pi2.__seen).toBeUndefined();
	});

	it("rejects names Windows would fold into another folder or refuse", async () => {
		const { host } = await makeHost();
		await host.install({ name: "alpha", files: [plugin("alpha")] });
		for (const name of ["alpha..", "con", "nul.txt", "com1", "UPPER", "../x", "a b", ""]) {
			await expect(host.install({ name, files: [plugin(name)] }), name).rejects.toThrow();
		}
		expect(host.list().map((p) => p.name)).toEqual(["alpha"]);
		expect(await host.rpcs.get("alpha/hi")?.({})).toBe("1.0.0");
	});

	it("flags tui installs and multi-file updates as needing a restart", async () => {
		const { host } = await makeHost();
		const tui = new PluginHost({ host: "tui", dataDir: await mkdtemp(join(tmpdir(), "plugtui-")), agentDir: "x", cwd: "x", settings: () => ({}), gateways: () => [] });
		const r1 = await tui.install({ name: "alpha", files: [plugin("alpha")] });
		expect(r1.hot).toBe(false);
		expect(r1.restartReasons[0]).toMatch(/TUI/);

		await host.install({ name: "beta", files: [plugin("beta"), { path: "lib/util.js", content: "export const x = 1;" }] });
		const r2 = await host.install({ name: "beta", files: [plugin("beta"), { path: "lib/util.js", content: "export const x = 2;" }] });
		expect(r2.restartReasons.join()).toMatch(/重启/);
		expect(host.list().find((p) => p.name === "beta")?.notes.length).toBe(1);
	});
});

describe("validateFiles", () => {
	const ok = { path: "index.js", content: "x" };
	it("accepts a normal layout", () => {
		expect(validateFiles([ok, { path: "lib/a.js", content: "y" }]).map((f) => f.path)).toEqual(["index.js", "lib/a.js"]);
	});
	it("rejects traversal, absolute, backslash and reserved paths", () => {
		for (const path of ["../evil.js", "a/../../evil.js", "/abs.js", "C:/x.js", "a\\b.js", "node_modules/x.js", ".git/config", "package.json"]) {
			expect(() => validateFiles([ok, { path, content: "" }]), path).toThrow();
		}
	});
	it("requires an index.js entry and rejects duplicates, oversize and empty input", () => {
		expect(() => validateFiles([{ path: "main.js", content: "" }])).toThrow(/index\.js/);
		expect(() => validateFiles([ok, { path: "./index.js", content: "" }])).toThrow(/重复/);
		expect(() => validateFiles([{ path: "index.js", content: "x".repeat(500_000) }])).toThrow(/过大/);
		expect(() => validateFiles([])).toThrow();
	});
});
