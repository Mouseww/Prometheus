// The one-click install of third-party agent CLIs: where it puts them, how they reach a runtime's PATH, and what
// the settings page is told when a runtime is missing.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AGENT_PACKAGES, agentEntry, isManaged, npmPrefixOf, agentBinDir, agentBinDirs, agentInstallPrefix, agentStatuses, compareVersions, installedCli, installedEntry, installedVersion, npmAvailable, parseVersion, withAgentBin } from "../src/agent/install.ts";

const roots: string[] = [];
function dataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "prom-agent-install-"));
	roots.push(dir);
	return dir;
}
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const cliName = (agent: string) => (process.platform === "win32" ? `${AGENT_PACKAGES[agent]!.bin}.cmd` : AGENT_PACKAGES[agent]!.bin);

describe("agent CLI installs", () => {
	it("installs into the server's own folder, beside the data, not into the user's global npm root", () => {
		const data = dataDir();
		expect(agentInstallPrefix(data)).toBe(join(data, "agents"));
		// npm's global prefix writes to `<prefix>/bin` on Unix and to the prefix itself on Windows.
		expect(agentBinDir(data)).toBe(process.platform === "win32" ? join(data, "agents") : join(data, "agents", "bin"));
	});

	it("reports the CLI it installed, and nothing for the others", () => {
		const data = dataDir();
		mkdirSync(agentBinDir(data), { recursive: true });
		writeFileSync(join(agentBinDir(data), cliName("opencode")), "x");
		expect(installedCli(data, "opencode")).toBe(join(agentBinDir(data), cliName("opencode")));
		expect(installedCli(data, "codex")).toBeUndefined();
	});

	it("searches both the prefix and its bin folder, the platform's own first", () => {
		const data = dataDir();
		const dirs = agentBinDirs(data);
		expect(dirs).toHaveLength(2);
		expect(dirs[0]).toBe(agentBinDir(data));
		expect(dirs).toContain(join(agentInstallPrefix(data), "bin"));
		if (process.platform === "win32") expect(dirs[0]).toBe(agentInstallPrefix(data));
	});

	it("puts its folders last on PATH, and only once", () => {
		const data = dataDir();
		const sep = process.platform === "win32" ? ";" : ":";
		const env = withAgentBin(data, { PATH: ["/usr/bin", "/bin"].join(sep) } as Record<string, string>);
		const parts = String(env.PATH).split(sep);
		expect(parts.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
		expect(parts.slice(2)).toEqual(agentBinDirs(data));
		const again = withAgentBin(data, env as Record<string, string>);
		expect(String(again.PATH)).toBe(String(env.PATH));
	});

	it("keeps the PATH spelling the environment already uses", () => {
		const data = dataDir();
		if (process.platform !== "win32") return;
		const env = withAgentBin(data, { Path: "C:\\bin" } as Record<string, string>);
		expect(env.Path).toBeDefined();
		expect(env.PATH).toBeUndefined();
	});

	it("tells the settings page that a missing runtime is installable when npm works", async () => {
		const data = dataDir();
		const npm = await npmAvailable();
		const status = await agentStatuses(data, "codex");
		expect(status.missing).toBe(true);
		expect(status.installable).toBe(npm.ok);
		expect(status.installed).toBeUndefined();
		// PI is built in: never missing, never installable.
		expect(await agentStatuses(data, "pi")).toEqual({});
	});

	it("knows the npm packages of the built-in and preset ACP agents, and nothing for agents without one", async () => {
		expect(AGENT_PACKAGES.gemini?.pkg).toBe("@google/gemini-cli");
		expect(AGENT_PACKAGES.qwen?.bin).toBe("qwen");
		expect(AGENT_PACKAGES.goose).toBeUndefined();
		const data = dataDir();
		expect(installedCli(data, "goose")).toBeUndefined();
		expect(await agentStatuses(data, "goose")).toEqual({ missing: true, installable: false });
		mkdirSync(agentBinDir(data), { recursive: true });
		writeFileSync(join(agentBinDir(data), cliName("gemini")), "x");
		expect(installedCli(data, "gemini")).toBe(join(agentBinDir(data), cliName("gemini")));
	});

	it("marks an installed runtime with the path it will run", async () => {
		const data = dataDir();
		mkdirSync(agentBinDir(data), { recursive: true });
		writeFileSync(join(agentBinDir(data), cliName("codex")), "x");
		const status = await agentStatuses(data, "codex");
		expect(status.installed).toBe(join(agentBinDir(data), cliName("codex")));
	});

	it("reads versions the way the CLIs print them, and orders them", () => {
		expect(parseVersion("codex-cli 0.133.0")).toBe("0.133.0");
		expect(parseVersion("2.1.310 (Claude Code)")).toBe("2.1.310");
		expect(parseVersion("v1.19.5 (latest)")).toBe("1.19.5");
		expect(parseVersion("0.3.0-nightly.20250101")).toBe("0.3.0-nightly.20250101");
		expect(parseVersion("unknown")).toBeUndefined();
		expect(compareVersions("1.19.10", "1.19.9")).toBeGreaterThan(0);
		expect(compareVersions("0.26.3", "0.26.3")).toBe(0);
		expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
		expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
	});

	it("knows the version and the runnable file of a copy it installed", () => {
		const data = dataDir();
		expect(installedVersion(data, "codex")).toBeUndefined();
		expect(installedEntry(data, "codex")).toBeUndefined();
		const pkgDir = join(agentInstallPrefix(data), "node_modules", "@openai", "codex");
		mkdirSync(join(pkgDir, "bin"), { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.140.0" }));
		writeFileSync(join(pkgDir, "bin", "codex.js"), "");
		mkdirSync(agentBinDir(data), { recursive: true });
		if (process.platform === "win32") {
			// npm's Windows shim, which the runtime unwraps to the script it starts
			writeFileSync(join(agentBinDir(data), "codex.cmd"), ["@ECHO off", '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', ""].join("\r\n"));
			expect(installedEntry(data, "codex")).toBe(join(pkgDir, "bin", "codex.js"));
		} else {
			writeFileSync(join(agentBinDir(data), "codex"), "", { mode: 0o755 });
			expect(installedEntry(data, "codex")).toBe(join(agentBinDir(data), "codex"));
		}
		expect(installedVersion(data, "codex")).toBe("0.140.0");
		// One lookup on PATH: the folder of one-click installs is last, so a CLI found earlier wins no matter who put it there.
		expect(agentEntry(data, "codex", { PATH: "" })).toBe(installedEntry(data, "codex"));
		expect(isManaged(data, installedEntry(data, "codex")!)).toBe(true);
		const other = join(data, "elsewhere");
		mkdirSync(other, { recursive: true });
		const name = process.platform === "win32" ? "codex.exe" : "codex";
		writeFileSync(join(other, name), "", { mode: 0o755 });
		expect(agentEntry(data, "codex", { PATH: other, PATHEXT: ".EXE" })).toBe(join(other, name));
		expect(isManaged(data, join(other, name))).toBe(false);
	});

	it("finds the npm prefix a CLI was installed into, and nothing for a CLI npm did not install", () => {
		const data = dataDir();
		const prefix = join(data, "user-npm");
		const lib = process.platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
		mkdirSync(join(lib, "@openai", "codex", "bin"), { recursive: true });
		const entry = join(lib, "@openai", "codex", "bin", "codex.js");
		writeFileSync(entry, "");
		expect(npmPrefixOf("codex", entry)).toBe(prefix);
		const standalone = join(data, "standalone", "codex");
		mkdirSync(join(data, "standalone"));
		writeFileSync(standalone, "");
		expect(npmPrefixOf("codex", standalone)).toBeUndefined();
		expect(npmPrefixOf("codex", join(data, "missing"))).toBeUndefined();
	});
});
