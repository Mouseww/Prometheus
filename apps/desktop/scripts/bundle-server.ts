// Bundles apps/server into dist/server-bundle for the desktop installer.
// Workspace packages ship .ts sources, which Node refuses to type-strip inside node_modules,
// so they are inlined here; third-party deps stay external and are installed next to the bundle.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = join(root, "dist/server-bundle");
const readPkg = (p: string) => JSON.parse(readFileSync(join(root, p, "package.json"), "utf8"));

const sources = [
	"apps/server",
	"packages/core",
	"packages/knowledge",
	"packages/gateway",
	"packages/plugin-sdk",
	"plugins/knowledge-lancedb",
	"plugins/mcp",
	"plugins/skills",
	"plugins/memory",
	"plugins/packages",
];
const dependencies: Record<string, string> = {};
for (const dir of sources) {
	for (const [name, version] of Object.entries<string>(readPkg(dir).dependencies ?? {})) {
		if (!version.startsWith("workspace:")) dependencies[name] = version;
	}
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
	entryPoints: [join(root, "apps/server/src/main.ts")],
	outfile: join(out, "main.js"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	legalComments: "none",
	plugins: [
		{
			name: "externalize-third-party",
			setup(b) {
				b.onResolve({ filter: /^[^./]/ }, (args) =>
					args.kind === "entry-point" || isAbsolute(args.path) || args.path.startsWith("@prometheus/")
						? undefined
						: { path: args.path, external: true },
				);
			},
		},
	],
});

writeFileSync(
	join(out, "package.json"),
	JSON.stringify({ name: "prometheus-server-bundle", private: true, type: "module", dependencies }, null, 2),
);
// onnxruntime-node would otherwise fetch CUDA/TensorRT libs on Linux, which AppImage bundling cannot resolve.
execSync("npm install --omit=dev --no-audit --no-fund", {
	cwd: out,
	stdio: "inherit",
	env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: "skip" },
});
console.log(`server bundle -> ${out}`);
