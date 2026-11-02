// Bundles apps/server into dist/server-bundle for the desktop installer.
// Workspace packages ship .ts sources, which Node refuses to type-strip inside node_modules,
// so they are inlined here; third-party deps stay external and are installed next to the bundle.
// --android builds the phone flavour without the native vector DB (it has no Android binding); android-runtime.ts adds Node and packs it.
// The desktop installer ships neither Node nor the PI agent packages (@earendil-works/*): the app installs them on first use
// (see apps/desktop/src-tauri/runtimes.json) and `main.js` becomes a small launcher that lets the server import them from
// there. The self-contained flavours (Android, the Node 20 Electron build for old Macs, SERVER_BUNDLE_PI=1) keep them inside.
import { execSync } from "node:child_process";
import { builtinModules } from "node:module";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// SERVER_NODE_TARGET=node20 builds the legacy-macOS flavour (Node 20 is the newest line that runs on macOS 10.15); it adds the Node 22 APIs Node 20 lacks.
const nodeTarget = process.env.SERVER_NODE_TARGET ?? "node22";
const android = process.argv.includes("--android");
const withPi = android || nodeTarget !== "node22" || process.env.SERVER_BUNDLE_PI === "1";
const PI_SCOPE = "@earendil-works/";
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
	"plugins/connectors",
	"plugins/voice",
];
const dependencies: Record<string, string> = {};
/** What the on-demand PI install has to provide when the bundle does not carry it. */
const piRequirements: Record<string, string> = {};
for (const dir of sources) {
	for (const [name, version] of Object.entries<string>(readPkg(dir).dependencies ?? {})) {
		if (version.startsWith("workspace:") || (noLancedb && NOT_ON_ANDROID.has(name))) continue;
		if (name.startsWith(PI_SCOPE) && !withPi) piRequirements[name] = version;
		else dependencies[name] = version;
	}
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const built = await build({
	metafile: true,
	entryPoints: [join(root, "apps/server/src/main.ts")],
	outfile: join(out, withPi ? "main.js" : "app.js"),
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

// Every package the bundled code imports must be declared above. This used to work by accident (typebox came along with the PI
// agent's own dependencies); with the PI agent installed separately a missing declaration is a server that cannot start.
{
	const used = new Set<string>();
	for (const output of Object.values(built.metafile.outputs)) {
		for (const imp of output.imports) {
			const spec = imp.path;
			if (!imp.external || spec.startsWith("node:") || spec.startsWith("@prometheus/")) continue;
			used.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] as string));
		}
	}
	const undeclared = [...used].filter((n) => !(n in dependencies) && !(n in piRequirements) && !builtinModules.includes(n));
	if (undeclared.length) throw new Error(`the server bundle imports packages that no workspace package declares: ${undeclared.join(", ")}`);
}
if (nodeTarget !== "node22") cpSync(join(dirname(fileURLToPath(import.meta.url)), "node20-polyfills.js"), join(out, "polyfills.js"));
if (!withPi) {
	const here = join(dirname(fileURLToPath(import.meta.url)), "launcher");
	cpSync(join(here, "main.js"), join(out, "main.js"));
	cpSync(join(here, "pi-hooks.mjs"), join(out, "pi-hooks.mjs"));
	// Its presence tells the desktop shell that this bundle needs the PI agent installed first.
	writeFileSync(join(out, "pi-requirements.json"), `${JSON.stringify(piRequirements, null, 2)}\n`);
}

// LAN and domain visitors load the UI from this server (the desktop window serves its own copy), so ship it alongside.
const webDist = join(root, "apps/web/dist");
if (!existsSync(join(webDist, "index.html"))) throw new Error("apps/web/dist is missing; build @prometheus/web before bundling the server");
cpSync(webDist, join(out, "web"), { recursive: true });

writeFileSync(
	join(out, "package.json"),
	JSON.stringify(
		{
			name: "prometheus-server-bundle",
			private: true,
			type: "module",
			dependencies,
			// undici 8 needs Node 22 (webidl.util.markAsUncloneable); 7.x still runs on the Node 20 inside Electron 32.
			...(nodeTarget === "node22" ? {} : { overrides: { undici: "7" } }),
		},
		null,
		2,
	),
);
// onnxruntime-node would otherwise fetch CUDA/TensorRT libs on Linux, which AppImage bundling cannot resolve.
execSync("npm install --omit=dev --no-audit --no-fund", {
	cwd: out,
	stdio: "inherit",
	env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: "skip" },
});
// LanceDB lists @huggingface/transformers as an optional dependency for its built-in embedding functions, which pulls in
// onnxruntime-node/-web and sharp (~100 MB). Prometheus computes vectors through the gateway and hands them to LanceDB,
// and LanceDB only loads transformers lazily when one of those functions is used, so none of it is needed here.
// (Not `npm install --omit=optional`: that would also drop LanceDB's platform binding.)
// The Claude Agent SDK's per-platform Claude Code binaries (~280 MB) are optional dependencies too. Claude Code is installed
// into Prometheus' own folder on first use instead (see agent/install.ts), which also lets it update independently.
const anthropic = join(out, "node_modules", "@anthropic-ai");
if (existsSync(anthropic)) for (const name of readdirSync(anthropic)) if (name.startsWith("claude-agent-sdk-")) rmSync(join(anthropic, name), { recursive: true, force: true });
for (const dir of ["@huggingface", "onnxruntime-node", "onnxruntime-web", "onnxruntime-common", "sharp", "@img"]) rmSync(join(out, "node_modules", dir), { recursive: true, force: true });
if (nodeTarget !== "node22") {
	// Node 20 has no fs.globSync, and a missing named import fails at link time, so point those imports at the polyfill.
	const patch = (dir: string) => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, ent.name);
			if (ent.isDirectory()) patch(p);
			else if (ent.name.endsWith(".js")) {
				const src = readFileSync(p, "utf8");
				const m = /import \{([^}]*)\} from "node:fs";/.exec(src);
				if (!m || !m[1].includes("globSync")) continue;
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
if (!withPi) {
	// Nothing of the PI agent (nor its provider SDKs) may have slipped into the install.
	const leaked = ["@earendil-works", "@google", "@aws-sdk", "@smithy"].filter((n) => existsSync(join(out, "node_modules", n)));
	if (leaked.length) throw new Error(`the bundle still carries the PI agent's dependencies: ${leaked.join(", ")}`);
}
console.log(`server bundle -> ${out}${withPi ? " (with the PI agent)" : " (PI agent installed on demand)"}`);
