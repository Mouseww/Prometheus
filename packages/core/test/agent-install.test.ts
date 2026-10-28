// The one-click install of third-party agent CLIs: where it puts them, how they reach a runtime's PATH, and what
// the settings page is told when a runtime is missing.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AGENT_PACKAGES, agentBinDir, agentBinDirs, agentInstallPrefix, agentStatuses, installedCli, npmAvailable, withAgentBin } from "../src/agent/install.ts";

const roots: string[] = [];
function dataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "prom-agent-install-"));
	roots.push(dir);
	return dir;
}
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const cliName = (kind: "claude-code" | "codex" | "opencode") => (process.platform === "win32" ? `${AGENT_PACKAGES[kind].bin}.cmd` : AGENT_PACKAGES[kind].bin);

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

	it("puts its folders first on PATH, and only once", () => {
		const data = dataDir();
		const sep = process.platform === "win32" ? ";" : ":";
		const env = withAgentBin(data, { PATH: ["/usr/bin", "/bin"].join(sep) } as Record<string, string>);
		const parts = String(env.PATH).split(sep);
		expect(parts.slice(0, 2)).toEqual(agentBinDirs(data));
		expect(parts.slice(2)).toEqual(["/usr/bin", "/bin"]);
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

	it("marks an installed runtime with the path it will run", async () => {
		const data = dataDir();
		mkdirSync(agentBinDir(data), { recursive: true });
		writeFileSync(join(agentBinDir(data), cliName("codex")), "x");
		const status = await agentStatuses(data, "codex");
		expect(status.installed).toBe(join(agentBinDir(data), cliName("codex")));
	});
});
