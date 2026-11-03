// Big npm packages the desktop installer leaves out and the server installs on first use into `<dataDir>/packages/<id>`:
// the LanceDB vector store (about 320 MB with its native binding) and the Claude Agent SDK. They are plain npm installs
// next to nothing else, so removing one is deleting its folder. The desktop launcher's resolve hook (apps/desktop/scripts/
// launcher) lets `import("@lancedb/lancedb")` find them there, so installing needs no restart. Builds that carry the
// packages themselves (development, Docker, Android, the old-Mac build) just resolve them normally and never install.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { npmAvailable, runNpmWithFallback } from "./agent/install.ts";

export type OptionalPackageId = "lancedb" | "claude-agent-sdk";

interface Def {
	name: string;
	/** The package the code imports. */
	pkg: string;
	/** Exact version; must equal the workspace dependency (checked by a test). */
	version: string;
	sizeMb: number;
	/** Extra packages to install with it (platform bindings that npm would otherwise treat as optional). */
	extra?: () => string[];
}

/** LanceDB's native binding is an optional dependency of the package, and so are heavy embedding libraries we do not use. */
function lancedbBinding(): string[] {
	const { platform, arch } = process;
	const table: Record<string, string> = {
		"win32-x64": "win32-x64-msvc",
		"win32-arm64": "win32-arm64-msvc",
		"linux-x64": existsSync("/etc/alpine-release") ? "linux-x64-musl" : "linux-x64-gnu",
		"linux-arm64": existsSync("/etc/alpine-release") ? "linux-arm64-musl" : "linux-arm64-gnu",
		"darwin-arm64": "darwin-arm64",
	};
	const suffix = table[`${platform}-${arch}`];
	if (!suffix) throw new Error(`LanceDB 没有适用于 ${platform}-${arch} 的原生库`);
	return [`@lancedb/lancedb-${suffix}@${OPTIONAL_PACKAGES.lancedb.version}`];
}

export const OPTIONAL_PACKAGES: Record<OptionalPackageId, Def> = {
	lancedb: { name: "LanceDB", pkg: "@lancedb/lancedb", version: "0.40.0", sizeMb: 320, extra: lancedbBinding },
	"claude-agent-sdk": { name: "Claude Agent SDK", pkg: "@anthropic-ai/claude-agent-sdk", version: "0.3.310", sizeMb: 30 },
};

export function isOptionalPackage(id: string): id is OptionalPackageId {
	return id in OPTIONAL_PACKAGES;
}

export const optionalPackagesDir = (dataDir: string): string => join(dataDir, "packages");
const dirOf = (dataDir: string, id: OptionalPackageId): string => join(optionalPackagesDir(dataDir), id);
const entryOf = (dir: string, pkg: string): string => join(dir, "node_modules", ...pkg.split("/"), "package.json");

export interface OptionalPackageStatus {
	id: OptionalPackageId;
	name: string;
	version: string;
	sizeMb: number;
	/** Usable now: installed by Prometheus, or shipped with this build. */
	installed: boolean;
	/** Installed by Prometheus (and so removable). */
	managed: boolean;
	/** Whether this machine can install it (npm is available, and a native binding exists for it). */
	installable: boolean;
}

/** Whether the build itself carries the package (development, Docker, Android, the old-Mac build). */
function shipped(pkg: string): boolean {
	try {
		createRequire(import.meta.url).resolve(`${pkg}/package.json`);
		return true;
	} catch {
		return false;
	}
}

export async function optionalPackageStatus(dataDir: string, id: OptionalPackageId): Promise<OptionalPackageStatus> {
	const def = OPTIONAL_PACKAGES[id];
	const managed = existsSync(entryOf(dirOf(dataDir, id), def.pkg));
	let installable = (await npmAvailable()).ok;
	try {
		def.extra?.();
	} catch {
		installable = false;
	}
	return { id, name: def.name, version: def.version, sizeMb: def.sizeMb, installed: managed || shipped(def.pkg), managed, installable };
}

const running = new Map<OptionalPackageId, Promise<void>>();

/** `--omit=optional` keeps npm from pulling per-platform binaries and embedding libraries we never load. */
function npmArgs(dir: string, specs: string[]): string[] {
	return ["install", "--prefix", dir, "--omit=optional", "--no-fund", "--no-audit", "--loglevel=error", ...specs];
}

/** Installs the package; a second call while one runs joins it. A failing default registry falls back to a mirror. */
export function installOptionalPackage(dataDir: string, id: OptionalPackageId): Promise<void> {
	const current = running.get(id);
	if (current) return current;
	const def = OPTIONAL_PACKAGES[id];
	const job = (async () => {
		const npm = await npmAvailable();
		if (!npm.ok) throw new Error(`找不到 npm：${npm.reason}`);
		const dir = dirOf(dataDir, id);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: `prometheus-${id}`, private: true }));
		const specs = [`${def.pkg}@${def.version}`, ...(def.extra?.() ?? [])];
		await runNpmWithFallback(npmArgs(dir, specs), 20 * 60_000);
		if (!existsSync(entryOf(dir, def.pkg))) throw new Error(`安装完成，但没有找到 ${def.pkg}`);
	})().finally(() => running.delete(id));
	running.set(id, job);
	return job;
}

export async function uninstallOptionalPackage(dataDir: string, id: OptionalPackageId): Promise<void> {
	await rm(dirOf(dataDir, id), { recursive: true, force: true });
}
