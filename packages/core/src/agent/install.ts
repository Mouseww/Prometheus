// One-click install of the third-party agent CLIs (Claude Code, Codex, opencode) for runtimes that are missing them.
// Installs go into Prometheus' own directory with an npm prefix, never into the user's global npm root, so a
// version installed here cannot break other projects and uninstalling is simply deleting the folder. The binaries
// land in `<dataDir>/agents/bin`, which every external runtime puts first on its PATH (see `agentBinDir`).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeKind } from "@prometheus/protocol";

/** The npm package that provides each CLI, for the runtimes that are installed rather than built in. */
export const AGENT_PACKAGES: Record<Exclude<RuntimeKind, "pi">, { pkg: string; bin: string }> = {
	"claude-code": { pkg: "@anthropic-ai/claude-code", bin: "claude" },
	codex: { pkg: "@openai/codex", bin: "codex" },
	opencode: { pkg: "opencode-ai", bin: "opencode" },
};

/** Where the CLIs installed from Prometheus live: `<prefix>/bin` on Unix, the prefix itself on Windows (npm's doing). */
export function agentInstallPrefix(dataDir: string): string {
	return join(dataDir, "agents");
}
/**
 * Folders an installed CLI may sit in, canonical one first. npm's global prefix puts them in `<prefix>/bin` on Unix
 * but directly in the prefix on Windows, so both are searched and every caller uses this list.
 */
export function agentBinDirs(dataDir: string): string[] {
	const prefix = agentInstallPrefix(dataDir);
	return process.platform === "win32" ? [prefix, join(prefix, "bin")] : [join(prefix, "bin"), prefix];
}
export function agentBinDir(dataDir: string): string {
	return agentBinDirs(dataDir)[0]!;
}

/** `PATH` with the Prometheus-installed CLIs first, so a one-click install is picked up without a restart. */
export function withAgentBin(dataDir: string, env: Record<string, string | undefined>): Record<string, string | undefined> {
	const dirs = agentBinDirs(dataDir);
	const path = env.PATH ?? env.Path ?? "";
	const sep = process.platform === "win32" ? ";" : ":";
	const parts = path ? path.split(sep) : [];
	if (dirs.every((d) => parts.includes(d))) return env;
	// Windows' PATH lookup compares names case-insensitively, but a process only ever reads one of the spellings.
	const key = process.platform === "win32" && env.Path !== undefined && env.PATH === undefined ? "Path" : "PATH";
	return { ...env, [key]: [...dirs, ...parts].filter(Boolean).join(sep) };
}

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function runNpm(args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(NPM, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, shell: process.platform === "win32" }, (err, stdout, stderr) => {
			if (err) {
				const tail = `${stderr || stdout || ""}`.trim().split(/\r?\n/).slice(-6).join("\n");
				reject(new Error(tail || (err instanceof Error ? err.message : String(err))));
				return;
			}
			resolve(String(stdout));
		});
	});
}

/** Node and npm must exist for any of this; the desktop and the server both ship or require Node. */
export async function npmAvailable(): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
	try {
		const version = (await runNpm(["--version"], 20_000)).trim();
		return { ok: true, version };
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

/** The CLI a runtime would run right now, inside a directory installed by Prometheus. */
export function installedCli(dataDir: string, kind: Exclude<RuntimeKind, "pi">): string | undefined {
	const names = process.platform === "win32" ? [`${AGENT_PACKAGES[kind].bin}.exe`, `${AGENT_PACKAGES[kind].bin}.cmd`] : [AGENT_PACKAGES[kind].bin];
	for (const dir of agentBinDirs(dataDir)) {
		for (const name of names) {
			const file = join(dir, name);
			if (existsSync(file)) return file;
		}
	}
	return undefined;
}

/** Installs (or upgrades) one runtime's CLI into `<dataDir>/agents`. */
export async function installAgentCli(dataDir: string, kind: Exclude<RuntimeKind, "pi">): Promise<{ command: string; output: string }> {
	const npm = await npmAvailable();
	if (!npm.ok) throw new Error(`找不到 npm：${npm.reason}`);
	const prefix = agentInstallPrefix(dataDir);
	await mkdir(prefix, { recursive: true });
	const output = await runNpm(["install", "--global", "--prefix", prefix, "--no-fund", "--no-audit", "--loglevel=error", `${AGENT_PACKAGES[kind].pkg}@latest`], 15 * 60_000);
	const command = installedCli(dataDir, kind);
	if (!command) throw new Error(`安装完成，但没有找到 ${AGENT_PACKAGES[kind].bin} 可执行文件。\n${output.trim().split(/\r?\n/).slice(-6).join("\n")}`);
	return { command, output };
}

/** Removes a runtime's CLI installed by Prometheus; the folder goes away with it. */
export async function uninstallAgentCli(dataDir: string, kind: Exclude<RuntimeKind, "pi">): Promise<void> {
	await rm(join(agentInstallPrefix(dataDir), "node_modules", ...AGENT_PACKAGES[kind].pkg.split("/")), { recursive: true, force: true });
	// npm's shims are named after the package's bin, and Windows keeps three per command.
	for (const dir of agentBinDirs(dataDir)) {
		for (const name of [`${AGENT_PACKAGES[kind].bin}`, `${AGENT_PACKAGES[kind].bin}.cmd`, `${AGENT_PACKAGES[kind].bin}.ps1`, `${AGENT_PACKAGES[kind].bin}.exe`]) {
			await rm(join(dir, name), { force: true });
		}
	}}

/** Extra health detail shown next to a runtime that is not available: is a CLI installed, and can this machine install one? */
export async function agentStatuses(dataDir: string, kind: RuntimeKind): Promise<{ missing?: boolean; installable?: boolean; installed?: string }> {
	if (kind === "pi") return {};
	const installed = installedCli(dataDir, kind as Exclude<RuntimeKind, "pi">);
	const npm = await npmAvailable();
	return { missing: true, installable: npm.ok, ...(installed ? { installed } : {}) };
}
