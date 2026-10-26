// Bundles apps/server into dist/server-bundle for the desktop installer.
// Workspace packages ship .ts sources, which Node refuses to type-strip inside node_modules,
// so they are inlined here; third-party deps stay external and are installed next to the bundle.
// --android builds the phone flavour without the native vector DB (it has no Android binding); android-runtime.ts adds Node and packs it.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// SERVER_NODE_TARGET=node20 builds the legacy-macOS flavour (Node 20 is the newest line that runs on macOS 10.15); it adds the Node 22 APIs Node 20 lacks.
const nodeTarget = process.env.SERVER_NODE_TARGET ?? "node22";
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
	"packages/subagents",
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
	target: nodeTarget,
	banner: nodeTarget === "node22" ? undefined : { js: 'import "./polyfills.js";' },
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

if (nodeTarget !== "node22") cpSync(join(dirname(fileURLToPath(import.meta.url)), "node20-polyfills.js"), join(out, "polyfills.js"));

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
if (nodeTarget !== "node22") {
	// Node 20 has no fs.globSync, and a missing named import fails at link time, so point those imports at the polyfill.
	const patch = (dir: string) => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, ent.name);
			if (ent.isDirectory()) patch(p);
			else if (ent.name.endsWith(".js")) {
				const src = readFileSync(p, "utf8");
				const m = /import \{([^}]*)\} from "node:fs";/.exec(src);
				if (!m || !/globSync/.test(m[1])) continue;
				const rest = m[1].split(",").map((x) => x.trim()).filter((x) => x && x !== "globSync");
				let rel = relative(dirname(p), join(out, "polyfills.js")).split(sep).join("/");
				if (!rel.startsWith(".")) rel = `./${rel}`;
				writeFileSync(p, src.replace(m[0], `import { ${rest.join(", ")} } from "node:fs";
	import { globSync } from "${rel}";`));
				console.log(`patched globSync import in ${relative(out, p)}`);
			}
		}
	};
	patch(join(out, "node_modules"));
}
console.log(`server bundle -> ${out}`);
