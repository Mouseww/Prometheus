// A small `npx` for Android, shipped as tools/npx.mjs and run by the `npx` shim.
//
// npm's own npx starts a package's command through its `.bin` link, and those scripts begin with `#!/usr/bin/env node`.
// Android has no /usr/bin/env, so the kernel refuses to run them. This installs the package into a private folder with
// npm, reads its package.json "bin", and runs the JavaScript file with this same Node instead.
//
// Supported: `npx [-y|--yes] [-q] [-p <pkg>]... <pkg[@version]|command> [args...]`. Packages are installed once and reused.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const fail = (msg) => {
	process.stderr.write(`npx: ${msg}\n`);
	process.exit(1);
};

const argv = process.argv.slice(2);
const packages = [];
let rest = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === "--") {
		rest = argv.slice(i + 1);
		break;
	}
	if (a === "-p" || a === "--package") packages.push(argv[++i] ?? fail(`${a} needs a value`));
	else if (a.startsWith("--package=")) packages.push(a.slice("--package=".length));
	else if (["-y", "--yes", "-q", "--quiet", "--no-install", "--prefer-online", "--no-yes"].includes(a)) continue;
	else if (a.startsWith("-") && rest.length === 0 && packages.length === 0 && !a.startsWith("--")) continue;
	else {
		rest = argv.slice(i);
		break;
	}
}
if (rest.length === 0 && packages.length === 0) fail("no package or command given");

// Without -p, the first argument is the package; with -p it is the command to run out of those packages.
const specs = packages.length > 0 ? packages : [rest.shift()];
const command = packages.length > 0 ? rest.shift() : undefined;

/** Package name from "name", "name@1.2", "@scope/name", "@scope/name@1.2". */
function nameOf(spec) {
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(0, at) : spec;
}

const nodePath = process.execPath;
const npmCli = process.env.PROMETHEUS_NPM_CLI;
if (!npmCli) fail("PROMETHEUS_NPM_CLI is not set");

const key = createHash("sha1").update(specs.join("\n")).digest("hex").slice(0, 16);
const prefix = join(process.env.npm_config_cache ? resolve(process.env.npm_config_cache, "..") : join(homedir(), ".cache"), "npx", key);
const modules = join(prefix, "node_modules");

if (!specs.every((s) => existsSync(join(modules, nameOf(s), "package.json")))) {
	mkdirSync(prefix, { recursive: true });
	// stdout belongs to the program being started (an MCP server speaks over it), so npm only ever writes to stderr.
	const install = spawnSync(nodePath, [npmCli, "install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", ...specs], {
		stdio: ["ignore", 2, 2],
		env: process.env,
	});
	if (install.status !== 0) fail(`installing ${specs.join(" ")} failed`);
}

/** The JavaScript file behind a package's command. */
function binFile(spec) {
	const dir = join(modules, nameOf(spec));
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	const bin = typeof pkg.bin === "string" ? { [basename(pkg.name)]: pkg.bin } : (pkg.bin ?? {});
	const names = Object.keys(bin);
	const wanted = command ?? (names.length === 1 ? names[0] : names.find((n) => n === basename(pkg.name)) ?? names[0]);
	return wanted && bin[wanted] ? realpathSync(join(dir, bin[wanted])) : undefined;
}

let entry;
for (const spec of specs) {
	entry = binFile(spec);
	if (entry) break;
}
if (!entry) fail(`${command ?? specs[0]} has no command to run`);

const child = spawn(nodePath, [entry, ...rest], { stdio: "inherit", env: { ...process.env, PATH: `${join(modules, ".bin")}:${process.env.PATH ?? ""}` } });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("error", (e) => fail(e.message));
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 1);
});
