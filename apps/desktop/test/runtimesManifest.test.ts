// The installer ships neither Node.js nor the PI agent; the desktop shell installs them from src-tauri/runtimes.json.
// These checks keep that manifest in step with what the server bundle is built against.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const manifest = read("apps/desktop/src-tauri/runtimes.json") as { runtimes: { id: string; version: string; desktopOnly?: boolean; requires?: string[]; targets: Record<string, { packages?: string[]; urls: string[]; sha256?: string }> }[] };

/** Every `@earendil-works/*` version any workspace package depends on. */
function workspacePiDeps(): Map<string, Set<string>> {
	const found = new Map<string, Set<string>>();
	for (const group of ["packages", "plugins", "apps"]) {
		for (const dir of readdirSync(join(root, group), { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			let pkg: { dependencies?: Record<string, string> };
			try {
				pkg = read(`${group}/${dir.name}/package.json`);
			} catch {
				continue;
			}
			for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
				if (!name.startsWith("@earendil-works/")) continue;
				found.set(name, (found.get(name) ?? new Set()).add(version));
			}
		}
	}
	return found;
}

describe("on-demand PI agent", () => {
	const pi = manifest.runtimes.find((r) => r.id === "pi-agent");

	it("is a desktop runtime that pulls in Node.js first", () => {
		expect(pi?.desktopOnly).toBe(true);
		expect(pi?.requires).toEqual(["node"]);
		expect(manifest.runtimes.some((r) => r.id === "node" && r.desktopOnly)).toBe(true);
	});

	it("installs exactly the versions the workspace builds against", () => {
		const wanted = workspacePiDeps();
		// The workspace uses one version of each package; the CLI app may depend on fewer packages than the server.
		for (const [name, versions] of wanted) expect([...versions], `${name} has several versions`).toHaveLength(1);
		const specs = new Set(pi?.targets["*"]?.packages ?? []);
		for (const [name, versions] of wanted) {
			if (name === "@earendil-works/pi-coding-agent" || name === "@earendil-works/pi-ai" || name === "@earendil-works/pi-mcp") {
				expect(specs, `runtimes.json must install ${name}`).toContain(`${name}@${[...versions][0]}`);
			}
		}
		expect(pi?.version).toBe([...(wanted.get("@earendil-works/pi-coding-agent") ?? [])][0]);
	});

	it("pins the Node.js download of every desktop platform", () => {
		const node = manifest.runtimes.find((r) => r.id === "node");
		for (const key of ["windows-x86_64", "windows-aarch64", "linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64"]) {
			const t = node?.targets[key];
			expect(t?.sha256, key).toMatch(/^[0-9a-f]{64}$/);
			expect(t?.urls[0], key).toContain(`v${node?.version}/`);
		}
	});
});
