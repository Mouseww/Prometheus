// Downloads the official Node.js runtime for the build host into dist/node-runtime, which the desktop installer
// ships as the `node/` resource (node + npm + npx) so the app never depends on a Node install (or PATH) on the user's machine.
// NODE_MAJOR picks the release line (default 22, newest patch); NODE_BUNDLE_ARCH overrides the target arch (x64 | arm64).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = join(root, "dist/node-runtime");
const major = process.env.NODE_MAJOR ?? "22";
const arch = process.env.NODE_BUNDLE_ARCH ?? process.arch;
const platform = { win32: "win", darwin: "darwin", linux: "linux" }[process.platform as string];
if (!platform) throw new Error(`unsupported platform ${process.platform}`);
const ext = platform === "win" ? "zip" : platform === "linux" ? "tar.xz" : "tar.gz";

const base = `https://nodejs.org/dist/latest-v${major}.x`;
const get = async (url: string) => {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
};

const sums = (await get(`${base}/SHASUMS256.txt`)).toString("utf8");
const suffix = `-${platform}-${arch}.${ext}`;
const line = sums.split("\n").find((l) => l.trim().endsWith(suffix) && l.includes(" node-v"));
if (!line) throw new Error(`no Node ${major}.x build for ${platform}-${arch}`);
const [sha, file] = line.trim().split(/\s+/);
const version = file.slice("node-".length, -suffix.length);

console.log(`downloading ${file}`);
const archive = await get(`${base}/${file}`);
const actual = createHash("sha256").update(archive).digest("hex");
if (actual !== sha) throw new Error(`SHA256 mismatch for ${file}: expected ${sha}, got ${actual}`);

const work = mkdtempSync(join(tmpdir(), "prometheus-node-"));
try {
	const archivePath = join(work, file);
	writeFileSync(archivePath, archive);
	// Windows' own bsdtar reads zip; a GNU tar earlier on PATH (Git for Windows) would not.
	const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
	execFileSync(tar, ["-xf", archivePath, "-C", work], { stdio: "inherit" });
	const dir = join(work, file.slice(0, -(ext.length + 1)));
	rmSync(out, { recursive: true, force: true });
	if (platform === "win") {
		// Windows layout: node.exe, npm.cmd and npx.cmd sit beside node_modules/npm, which is where the .cmd files look.
		for (const name of ["node.exe", "npm.cmd", "npx.cmd", "node_modules"]) {
			if (!existsSync(join(dir, name))) throw new Error(`${name} missing in ${file}`);
			cpSync(join(dir, name), join(out, name), { recursive: true });
		}
	} else {
		// Unix layout: bin/node plus lib/node_modules/npm. The archive's bin/npm and bin/npx are symlinks, which
		// installer resource copying may flatten into regular files (breaking their relative requires), so use wrappers.
		if (!existsSync(join(dir, "bin", "node"))) throw new Error(`bin/node missing in ${file} (found: ${readdirSync(dir).join(", ")})`);
		mkdirSync(join(out, "bin"), { recursive: true });
		cpSync(join(dir, "bin", "node"), join(out, "bin", "node"));
		cpSync(join(dir, "lib", "node_modules", "npm"), join(out, "lib", "node_modules", "npm"), { recursive: true });
		for (const [name, cli] of [["npm", "npm-cli.js"], ["npx", "npx-cli.js"]]) {
			const wrapper = join(out, "bin", name);
			writeFileSync(
				wrapper,
				`#!/bin/sh
d=$(cd "$(dirname "$0")" && pwd -P)
exec "$d/node" "$d/../lib/node_modules/npm/bin/${cli}" "$@"
`,
			);
			chmodSync(wrapper, 0o755);
		}
		chmodSync(join(out, "bin", "node"), 0o755);
	}
	for (const name of ["LICENSE"]) if (existsSync(join(dir, name))) cpSync(join(dir, name), join(out, `NODE-${name}`));
	writeFileSync(join(out, "VERSION"), `${version}\n`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
console.log(`node ${version} (${platform}-${arch}) -> ${out}`);
