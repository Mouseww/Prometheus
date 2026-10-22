// Bundles apps/server into dist/server-bundle for the desktop installer.
// Workspace packages ship .ts sources, which Node refuses to type-strip inside node_modules,
// so they are inlined here; third-party deps stay external and are installed next to the bundle.
// --android builds the phone flavour without the native vector DB (it has no Android binding); android-runtime.ts adds Node and packs it.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const android = process.argv.includes("--android");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = join(root, android ? "dist/server-bundle-android" : "dist/server-bundle");
const readPkg = (p: string) => JSON.parse(readFileSync(join(root, p, "package.json"), "utf8"));
// Drags in onnxruntime-node and sharp (~700 MB) with no Android binary; the plugin imports it lazily and reports it unavailable.
const NOT_ON_ANDROID = new Set(["@lancedb/lancedb"]);
// LanceDB publishes no darwin-x64 binding either, so Intel Mac builds ship without vector search too.
const noLancedb = android || (process.platform === "darwin" && process.arch === "x64");

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
	"plugins/todos",
	"plugins/git",
	"plugins/automations",
	"plugins/voice",
];
const dependencies: Record<string, string> = {};
for (const dir of sources) {
	for (const [name, version] of Object.entries<string>(readPkg(dir).dependencies ?? {})) {
		if (!version.startsWith("workspace:") && !(noLancedb && NOT_ON_ANDROID.has(name))) dependencies[name] = version;
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

// LAN and domain visitors load the UI from this server (the desktop window serves its own copy), so ship it alongside.
const webDist = join(root, "apps/web/dist");
if (!existsSync(join(webDist, "index.html"))) throw new Error("apps/web/dist is missing; build @prometheus/web before bundling the server");
cpSync(webDist, join(out, "web"), { recursive: true });

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
