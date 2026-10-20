// Packs Node and the Android server bundle into the generated Gradle project so the APK can run a local server.
// Run on Linux (needs ar, tar with xz) after `tauri android init` and `bundle-server.ts --android`.
//
// Android only lets an app execute files from its native-library directory, so Node ships as libnode.so and the
// server as libserver_bundle.so (a tarball that the app unpacks on first launch, see src-tauri/src/android.rs).
// Node comes from Termux: Google and nodejs.org publish no Android build, and Termux's is the maintained one.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://packages.termux.dev/apt/termux-main";
const ABI = "arm64-v8a";
// Nothing in these is needed to run Node as a plain process, and ca-certificates would only point at Termux's prefix.
const SKIP = new Set(["ca-certificates", "resolv-conf"]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bundle = join(root, "dist/server-bundle-android");
const androidApp = join(root, "apps/desktop/src-tauri/gen/android/app");
const jniDir = join(androidApp, "src/main/jniLibs", ABI);

if (!existsSync(join(bundle, "main.js"))) throw new Error("run bundle-server.ts --android first");
if (!existsSync(androidApp)) throw new Error("run `tauri android init` first");

interface Pkg {
	name: string;
	depends: string[];
	filename: string;
}

async function get(url: string): Promise<Buffer> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url} -> ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

function parseIndex(text: string): Map<string, Pkg> {
	const pkgs = new Map<string, Pkg>();
	for (const block of text.split("\n\n")) {
		const field = (k: string) => new RegExp(`^${k}: (.+)$`, "m").exec(block)?.[1];
		const name = field("Package");
		const filename = field("Filename");
		if (!name || !filename) continue;
		// "a | b" keeps the first alternative; version constraints are dropped.
		const depends = (field("Depends") ?? "")
			.split(",")
			.map((d) => d.split("|")[0]?.replace(/\(.*\)/, "").trim() ?? "")
			.filter(Boolean);
		pkgs.set(name, { name, depends, filename });
	}
	return pkgs;
}

function closure(index: Map<string, Pkg>, start: string): Pkg[] {
	const seen = new Map<string, Pkg>();
	const visit = (name: string) => {
		if (seen.has(name) || SKIP.has(name)) return;
		const pkg = index.get(name);
		if (!pkg) throw new Error(`Termux package not found: ${name}`);
		seen.set(name, pkg);
		pkg.depends.forEach(visit);
	};
	visit(start);
	return [...seen.values()];
}

const work = mkdtempSync(join(tmpdir(), "termux-"));
try {
	const index = parseIndex((await get(`${REPO}/dists/stable/main/binary-aarch64/Packages`)).toString("utf8"));
	const packages = closure(index, "nodejs-lts");
	console.log(`termux packages: ${packages.map((p) => p.name).join(", ")}`);

	const staged = join(work, "root");
	mkdirSync(staged, { recursive: true });
	for (const pkg of packages) {
		const deb = join(work, `${pkg.name}.deb`);
		writeFileSync(deb, await get(`${REPO}/${pkg.filename}`));
		const dir = join(work, `x-${pkg.name}`);
		mkdirSync(dir);
		execFileSync("ar", ["x", deb], { cwd: dir });
		const data = readdirSync(dir).find((f) => f.startsWith("data.tar"));
		if (!data) throw new Error(`${pkg.name}: no data archive`);
		execFileSync("tar", ["-xf", join(dir, data), "-C", staged]);
	}

	// Termux installs under its own prefix: data/data/com.termux/files/usr.
	const prefix = join(staged, "data/data/com.termux/files/usr");
	const node = join(prefix, "bin/node");
	if (!existsSync(node)) throw new Error("node binary missing from the Termux package");

	mkdirSync(jniDir, { recursive: true });
	copyFileSync(node, join(jniDir, "libnode.so"));

	// Shared libraries go inside the server archive; the app points LD_LIBRARY_PATH at server/lib.
	const libOut = join(bundle, "lib");
	rmSync(libOut, { recursive: true, force: true });
	mkdirSync(libOut, { recursive: true });
	const libSrc = join(prefix, "lib");
	for (const f of readdirSync(libSrc)) {
		if (!/\.so(\.|$)/.test(f)) continue;
		// dereference: the tarball should hold real files, not links into a Termux prefix that does not exist on the phone.
		cpSync(realpathSync(join(libSrc, f)), join(libOut, f));
	}

	const tarball = join(jniDir, "libserver_bundle.so");
	execFileSync("tar", ["-czf", tarball, "-C", bundle, "."], { stdio: "inherit" });
	console.log(`node + server packed into ${jniDir}`);

	// Gradle must extract native libraries to disk (executables cannot run from inside the APK), and the
	// loopback server speaks plain http, which Android blocks unless cleartext is allowed.
	const gradle = join(androidApp, "build.gradle.kts");
	let kts = readFileSync(gradle, "utf8");
	if (!kts.includes("useLegacyPackaging")) {
		kts = kts.replace("    buildFeatures {", "    packaging {\n        jniLibs {\n            useLegacyPackaging = true\n        }\n    }\n    buildFeatures {");
	}
	kts = kts.replace('manifestPlaceholders["usesCleartextTraffic"] = "false"', 'manifestPlaceholders["usesCleartextTraffic"] = "true"');
	if (!kts.includes("useLegacyPackaging = true")) throw new Error("could not patch build.gradle.kts (template changed?)");
	writeFileSync(gradle, kts);
	console.log("patched build.gradle.kts");

	// Voice input: the WebView only prompts for the microphone when the app itself declares the permission.
	const manifestPath = join(androidApp, "src", "main", "AndroidManifest.xml");
	let manifest = readFileSync(manifestPath, "utf8");
	for (const perm of ["android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"]) {
		if (!manifest.includes(perm)) manifest = manifest.replace(/<manifest[^>]*>/, (m) => `${m}\n    <uses-permission android:name="${perm}" />`);
	}
	if (!manifest.includes("RECORD_AUDIO")) throw new Error("could not patch AndroidManifest.xml (template changed?)");
	writeFileSync(manifestPath, manifest);
	console.log("patched AndroidManifest.xml");
} finally {
	rmSync(work, { recursive: true, force: true });
}
