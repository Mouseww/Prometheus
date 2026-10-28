// Which command line a Windows install of opencode resolves to: npm ships an extensionless sh script and a `.cmd`,
// neither is spawnable directly, so the native binary the shim wraps must be found instead.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveOpenCodeCommand } from "../src/agent/opencode/opencode-server.ts";

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});
/** A fake npm global folder holding the given files (directories are created as needed). */
function npmDir(files: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "prom-oc-resolve-"));
	roots.push(dir);
	for (const f of files) {
		const file = join(dir, f);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, "x");
	}
	return dir;
}
const win = (dir: string) => ({ platform: "win32" as const, arch: "x64", env: { PATH: dir } });

describe("resolveOpenCodeCommand", () => {
	it("takes an explicit executable as it is, and runs a .cmd through a shell", () => {
		expect(resolveOpenCodeCommand("C:\\tools\\opencode.exe")).toEqual({ command: "C:\\tools\\opencode.exe", args: [], shell: false });
		expect(resolveOpenCodeCommand("C:\\tools\\opencode.cmd")).toMatchObject({ shell: true });
		expect(resolveOpenCodeCommand("C:\\tools\\opencode.mjs")).toMatchObject({ command: process.execPath });
	});

	it("uses the bare name off Windows", () => {
		expect(resolveOpenCodeCommand(undefined, { platform: "linux", arch: "x64", env: {} })).toEqual({ command: "opencode", args: [], shell: false });
	});

	it("finds the native binary npm installed beside its shim", () => {
		const dir = npmDir(["opencode", "opencode.cmd", "node_modules/opencode-windows-x64/bin/opencode.exe", "node_modules/opencode-windows-arm64/bin/opencode.exe"]);
		expect(resolveOpenCodeCommand(undefined, win(dir))).toEqual({ command: join(dir, "node_modules", "opencode-windows-x64", "bin", "opencode.exe"), args: [], shell: false });
		expect(resolveOpenCodeCommand(undefined, { ...win(dir), arch: "arm64" }).command).toContain("arm64");
	});

	it("prefers the build for this CPU, and skips the baseline variant", () => {
		const dir = npmDir(["opencode.cmd", "node_modules/opencode-windows-x64-baseline/bin/opencode.exe", "node_modules/opencode-windows-x64/bin/opencode.exe"]);
		expect(resolveOpenCodeCommand(undefined, win(dir)).command).not.toContain("baseline");
		const only = npmDir(["opencode.cmd", "node_modules/opencode-windows-x64-baseline/bin/opencode.exe"]);
		expect(resolveOpenCodeCommand(undefined, win(only)).command).toContain("baseline");
	});

	it("finds a binary nested inside opencode-ai", () => {
		const dir = npmDir(["opencode.cmd", "node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe"]);
		expect(resolveOpenCodeCommand(undefined, win(dir)).command).toContain("opencode-windows-x64");
	});

	it("falls back to the .cmd through a shell when no native binary exists", () => {
		const dir = npmDir(["opencode", "opencode.cmd"]);
		const r = resolveOpenCodeCommand(undefined, win(dir));
		expect(r.shell).toBe(true);
		expect(r.command.toLowerCase()).toBe(join(dir, "opencode.cmd").toLowerCase());
	});

	it("never returns npm's extensionless sh script, which cannot be spawned", () => {
		const dir = npmDir(["opencode"]);
		expect(resolveOpenCodeCommand(undefined, win(dir)).command).not.toBe(join(dir, "opencode"));
	});

	it("reads the PATH in either case spelling, as Windows does", () => {
		const dir = npmDir(["opencode.cmd", "node_modules/opencode-windows-x64/bin/opencode.exe"]);
		const r = resolveOpenCodeCommand(undefined, { platform: "win32", arch: "x64", env: { Path: dir } });
		expect(r.command).toContain("opencode-windows-x64");
	});
});
