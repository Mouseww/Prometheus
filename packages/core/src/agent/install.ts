// One-click install of the third-party agent CLIs (Claude Code, Codex, opencode, Gemini CLI, Qwen Code, ...) for
// agents that are missing them.
// Installs go into Prometheus' own directory with an npm prefix, never into the user's global npm root, so a
// version installed here cannot break other projects and uninstalling is simply deleting the folder. The binaries
// land in `<dataDir>/agents/bin`, which every external runtime puts first on its PATH (see `agentBinDir`).
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { delimiter, dirname, join, sep as pathSep } from "node:path";
import { ACP_PRESETS, BUILTIN_AGENTS } from "@prometheus/protocol";
import { resolveExecutable } from "@prometheus/subagents";

/** The npm package that provides each agent's CLI, by agent id (built-ins and ACP presets that come from npm). */
export const AGENT_PACKAGES: Readonly<Record<string, { pkg: string; bin: string }>> = Object.fromEntries(
	[...BUILTIN_AGENTS, ...ACP_PRESETS].flatMap((a) => (a.npm ? [[a.id, a.npm] as const] : [])),
);

function packageOf(agent: string): { pkg: string; bin: string } {
	const p = AGENT_PACKAGES[agent];
	if (!p) throw new Error(`${agent} cannot be installed from here`);
	return p;
}

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

/**
 * `PATH` with the Prometheus-installed CLIs last: a CLI the user installed themselves always wins, and a one-click
 * install is still found without a restart when there is none.
 */
export function withAgentBin(dataDir: string, env: Record<string, string | undefined>): Record<string, string | undefined> {
	const dirs = agentBinDirs(dataDir);
	const path = env.PATH ?? env.Path ?? "";
	const sep = process.platform === "win32" ? ";" : ":";
	const parts = path ? path.split(sep) : [];
	if (dirs.every((d) => parts.includes(d))) return env;
	// Windows' PATH lookup compares names case-insensitively, but a process only ever reads one of the spellings.
	const key = process.platform === "win32" && env.Path !== undefined && env.PATH === undefined ? "Path" : "PATH";
	return { ...env, [key]: [...parts, ...dirs.filter((d) => !parts.includes(d))].filter(Boolean).join(sep) };
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
export function installedCli(dataDir: string, agent: string): string | undefined {
	const pkg = AGENT_PACKAGES[agent];
	if (!pkg) return undefined;
	const names = process.platform === "win32" ? [`${pkg.bin}.exe`, `${pkg.bin}.cmd`] : [pkg.bin];
	for (const dir of agentBinDirs(dataDir)) {
		for (const name of names) {
			const file = join(dir, name);
			if (existsSync(file)) return file;
		}
	}
	return undefined;
}

/**
 * Installs (or upgrades) one agent's CLI into `<dataDir>/agents`, or into `prefix` when given: the npm prefix an
 * existing installation lives in, so updating replaces that copy instead of adding another.
 */
export async function installAgentCli(dataDir: string, agent: string, prefix?: string): Promise<{ command: string; output: string }> {
	const pkg = packageOf(agent);
	const npm = await npmAvailable();
	if (!npm.ok) throw new Error(`找不到 npm：${npm.reason}`);
	const target = prefix ?? agentInstallPrefix(dataDir);
	await mkdir(target, { recursive: true });
	const output = await runNpm(["install", "--global", "--prefix", target, "--no-fund", "--no-audit", "--loglevel=error", `${pkg.pkg}@latest`], 15 * 60_000);
	const command = prefix ? agentEntry(dataDir, agent) : installedCli(dataDir, agent);
	if (!command) throw new Error(`安装完成，但没有找到 ${pkg.bin} 可执行文件。\n${output.trim().split(/\r?\n/).slice(-6).join("\n")}`);
	return { command, output };
}

/** Removes a runtime's CLI installed by Prometheus; the folder goes away with it. */
export async function uninstallAgentCli(dataDir: string, agent: string): Promise<void> {
	const pkg = packageOf(agent);
	await rm(join(agentInstallPrefix(dataDir), "node_modules", ...pkg.pkg.split("/")), { recursive: true, force: true });
	// npm's shims are named after the package's bin, and Windows keeps three per command.
	for (const dir of agentBinDirs(dataDir)) {
		for (const name of [`${pkg.bin}`, `${pkg.bin}.cmd`, `${pkg.bin}.ps1`, `${pkg.bin}.exe`]) {
			await rm(join(dir, name), { force: true });
		}
	}
}

/**
 * Extra health detail shown next to an agent that is not available: is a CLI installed, and can this machine install
 * one? `agent` is the agent id (built-ins: their kind); agents without an npm package are never installable.
 */
export async function agentStatuses(dataDir: string, agent: string): Promise<{ missing?: boolean; installable?: boolean; installed?: string }> {
	if (agent === "pi") return {};
	if (!AGENT_PACKAGES[agent]) return { missing: true, installable: false };
	const installed = installedCli(dataDir, agent);
	const npm = await npmAvailable();
	return { missing: true, installable: npm.ok, ...(installed ? { installed } : {}) };
}

/** Version of the copy Prometheus installed, from its package.json; undefined when there is none. */
export function installedVersion(dataDir: string, agent: string): string | undefined {
	const pkg = AGENT_PACKAGES[agent];
	if (!pkg || !installedCli(dataDir, agent)) return undefined;
	try {
		const json = JSON.parse(readFileSync(join(agentInstallPrefix(dataDir), "node_modules", ...pkg.pkg.split("/"), "package.json"), "utf8"));
		return typeof json.version === "string" ? json.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The file to run for the copy Prometheus installed: npm's shim unwrapped to the script or binary it starts (a `.js`
 * entry is returned as such; runtimes run it with this Node). Undefined when there is no such copy.
 */
export function installedEntry(dataDir: string, agent: string): string | undefined {
	const pkg = AGENT_PACKAGES[agent];
	if (!pkg || !installedCli(dataDir, agent)) return undefined;
	const found = resolveExecutable(pkg.bin, { PATH: agentBinDirs(dataDir).join(delimiter), PATHEXT: process.env.PATHEXT });
	if (!found) return undefined;
	return found.prefix.length ? found.prefix[0] : found.command;
}

/** First `x.y.z[-pre]` in a version string (`codex-cli 0.133.0`, `2.1.310 (Claude Code)`, `v1.19.5`). */
export function parseVersion(text: string | undefined): string | undefined {
	return text ? /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)?.[1] : undefined;
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. A release is newer than its pre-releases. */
export function compareVersions(a: string, b: string): number {
	const split = (v: string) => {
		const [core, pre] = v.split("-", 2) as [string, string | undefined];
		return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
	};
	const x = split(a);
	const y = split(b);
	for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
		const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
		if (d) return d;
	}
	if (x.pre === y.pre) return 0;
	if (!x.pre) return 1;
	if (!y.pre) return -1;
	return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

const LATEST_TTL = 60 * 60_000;
const latestCache = new Map<string, { at: number; value: Promise<string> }>();

/** Newest published version of an agent's npm package (`npm view`, so the user's registry or mirror applies); cached for an hour. */
export function latestVersion(agent: string, refresh = false): Promise<string> {
	const pkg = packageOf(agent);
	const hit = latestCache.get(pkg.pkg);
	if (hit && !refresh && Date.now() - hit.at < LATEST_TTL) return hit.value;
	const value = runNpm(["view", pkg.pkg, "version"], 30_000).then((out) => {
		const v = parseVersion(out.trim().split("\n").map((l) => l.trim()).filter(Boolean).at(-1));
		if (!v) throw new Error(`npm did not report a version for ${pkg.pkg}`);
		return v;
	});
	latestCache.set(pkg.pkg, { at: Date.now(), value });
	value.catch(() => {
		if (latestCache.get(pkg.pkg)?.value === value) latestCache.delete(pkg.pkg);
	});
	return value;
}

/**
 * The CLI that runs for an agent: one lookup on `PATH`, where Prometheus' own folder is last (`withAgentBin`), so it makes
 * no difference who installed it. Unwrapped like `installedEntry` (a `.js` entry is run with this Node).
 */
export function agentEntry(dataDir: string, agent: string, env: Record<string, string | undefined> = process.env): string | undefined {
	const pkg = AGENT_PACKAGES[agent];
	if (!pkg) return undefined;
	const withBin = withAgentBin(dataDir, env);
	const found = resolveExecutable(pkg.bin, { PATH: withBin.PATH ?? withBin.Path ?? "", PATHEXT: env.PATHEXT ?? process.env.PATHEXT });
	if (!found) return undefined;
	return found.prefix.length ? found.prefix[0] : found.command;
}

/**
 * The npm global prefix an installed CLI belongs to (`<prefix>/node_modules/<pkg>` on Windows, `<prefix>/lib/node_modules/<pkg>`
 * elsewhere), so an update can be installed over it. Undefined when the CLI did not come from npm (a standalone
 * installer, Homebrew, ...), which Prometheus cannot update.
 */
export function npmPrefixOf(agent: string, entry: string): string | undefined {
	const pkg = AGENT_PACKAGES[agent];
	if (!pkg) return undefined;
	let real: string;
	try {
		real = realpathSync(entry);
	} catch {
		return undefined;
	}
	const marker = `${pathSep}node_modules${pathSep}${pkg.pkg.split("/").join(pathSep)}`;
	const at = real.toLowerCase().indexOf(marker.toLowerCase());
	if (at < 0) return undefined;
	const root = real.slice(0, at);
	return process.platform !== "win32" && root.endsWith(`${pathSep}lib`) ? dirname(root) : root;
}

/** Whether a CLI file sits in the folder one-click installs go to. */
export function isManaged(dataDir: string, entry: string): boolean {
	const root = agentInstallPrefix(dataDir).toLowerCase().replace(/\\/g, "/");
	return entry.toLowerCase().replace(/\\/g, "/").startsWith(`${root}/`);
}

const versionCache = new Map<string, { stamp: number; value: Promise<string | undefined> }>();

/** Version a CLI file reports for `--version`, cached while the file does not change. */
export function cliVersion(entry: string): Promise<string | undefined> {
	let stamp = 0;
	try {
		stamp = statSync(entry).mtimeMs;
	} catch {
		return Promise.resolve(undefined);
	}
	const hit = versionCache.get(entry);
	if (hit && hit.stamp === stamp) return hit.value;
	const js = /\.(c|m)?js$/i.test(entry);
	const value = new Promise<string | undefined>((done) => {
		execFile(js ? process.execPath : entry, js ? [entry, "--version"] : ["--version"], { timeout: 15_000, windowsHide: true }, (err, stdout) => done(err ? undefined : parseVersion(String(stdout))));
	});
	versionCache.set(entry, { stamp, value });
	return value;
}
