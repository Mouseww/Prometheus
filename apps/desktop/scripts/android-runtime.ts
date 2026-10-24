// Packs Node and the Android server bundle into the generated Gradle project so the APK can run a local server.
// Run on Linux (needs ar, tar with xz) after `tauri android init` and `bundle-server.ts --android`.
//
// Android only lets an app execute files from its native-library directory, so Node ships as libnode.so and the
// server as libserver_bundle.so (a tarball that the app unpacks on first launch, see src-tauri/src/android.rs).
// Node comes from Termux: Google and nodejs.org publish no Android build, and Termux's is the maintained one.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://packages.termux.dev/apt/termux-main";
const ABI = "arm64-v8a";
// Nothing in these is needed to run the tools; ca-certificates is fetched on its own (only its cert bundle is used).
const SKIP = new Set(["ca-certificates", "resolv-conf"]);
// Termux packages to ship. Executables become lib*.so files in jniLibs, the only place Android lets an app execute from.
// proot runs the on-demand runtimes (Python, Go, Rust) from an Ubuntu rootfs the app downloads later; see src-tauri/src/runtimes.rs.
const PACKAGES = ["nodejs-lts", "npm", "git", "bash", "ripgrep", "proot"];
// Binaries from those packages exposed on PATH (see EXEC_PREFIX in src-tauri/src/android.rs).
const BINARIES = ["git", "bash", "rg", "proot"];
// Tools that run inside the PRoot rootfs: runtime id -> command names. Each becomes a shim that is only put on PATH once that runtime is installed.
const GUEST_SHIMS: Record<string, Record<string, string>> = {
	python: { python: "python3", python3: "python3", pip: "pip3", pip3: "pip3" },
	go: { go: "go", gofmt: "gofmt" },
	rust: { cargo: "cargo", rustc: "rustc", rustup: "rustup", rustdoc: "rustdoc" },
};
const GIT_HELPERS = ["git-remote-http", "git-remote-https", "git-http-fetch"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bundle = join(root, "dist/server-bundle-android");
const androidApp = join(root, "apps/desktop/src-tauri/gen/android/app");
const jniDir = join(androidApp, "src/main/jniLibs", ABI);
// Pinned package versions: Termux keeps only the newest build of each package, so a floating build breaks without warning.
const lockPath = join(dirname(fileURLToPath(import.meta.url)), "android-termux.lock.json");
const updateLock = process.argv.includes("--update-lock");
// Extra place to fetch pinned .deb files from once Termux has dropped them (a release asset mirror, optional).
const mirror = process.env.TERMUX_MIRROR?.replace(/\/$/, "");
const debCache = process.env.TERMUX_CACHE;

if (!updateLock) {
	if (!existsSync(join(bundle, "main.js"))) throw new Error("run bundle-server.ts --android first");
	if (!existsSync(androidApp)) throw new Error("run `tauri android init` first");
}

interface Pkg {
	name: string;
	depends: string[];
	filename: string;
	sha256: string;
}

type Lock = Record<string, { filename: string; sha256: string }>;

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
		pkgs.set(name, { name, depends, filename, sha256: field("SHA256") ?? "" });
	}
	return pkgs;
}

function closure(index: Map<string, Pkg>, starts: string[]): Pkg[] {
	const seen = new Map<string, Pkg>();
	const visit = (name: string) => {
		if (seen.has(name) || SKIP.has(name)) return;
		const pkg = index.get(name);
		if (!pkg) throw new Error(`Termux package not found: ${name}`);
		seen.set(name, pkg);
		pkg.depends.forEach(visit);
	};
	starts.forEach(visit);
	return [...seen.values()];
}

function isElf(file: string): boolean {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(4);
		readSync(fd, buf, 0, 4, 0);
		return buf[0] === 0x7f && buf.toString("latin1", 1, 4) === "ELF";
	} finally {
		closeSync(fd);
	}
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Downloads one pinned package, verifying its checksum; tries the cache, Termux, then the mirror. */
async function fetchDeb(pkg: Pkg): Promise<Buffer> {
	const cached = debCache ? join(debCache, `${pkg.name}-${pkg.sha256.slice(0, 12)}.deb`) : undefined;
	if (cached && existsSync(cached)) {
		const data = readFileSync(cached);
		if (!pkg.sha256 || sha256(data) === pkg.sha256) return data;
	}
	const urls = [`${REPO}/${pkg.filename}`, ...(mirror ? [`${mirror}/${pkg.filename.split("/").pop()}`] : [])];
	let lastError = "";
	for (const url of urls) {
		try {
			const data = await get(url);
			if (pkg.sha256 && sha256(data) !== pkg.sha256) throw new Error(`checksum mismatch for ${pkg.name}`);
			if (cached) {
				mkdirSync(dirname(cached), { recursive: true });
				writeFileSync(cached, data);
			}
			return data;
		} catch (e) {
			lastError = (e as Error).message;
		}
	}
	throw new Error(`${pkg.name}: ${lastError}. Termux drops old builds; refresh with \`android-runtime.ts --update-lock\` (or set TERMUX_MIRROR).`);
}

function extractDeb(deb: string, into: string, work: string, name: string): void {
	const dir = join(work, `x-${name}`);
	mkdirSync(dir);
	execFileSync("ar", ["x", deb], { cwd: dir });
	const data = readdirSync(dir).find((f) => f.startsWith("data.tar"));
	if (!data) throw new Error(`${name}: no data archive`);
	execFileSync("tar", ["-xf", join(dir, data), "-C", into]);
}

/** Copies a file as a native library: dereferenced, executable. */
function ship(src: string, name: string): void {
	const dest = join(jniDir, name);
	copyFileSync(realpathSync(src), dest);
	chmodSync(dest, 0o755);
}

const work = mkdtempSync(join(tmpdir(), "termux-"));
try {
	const index = parseIndex((await get(`${REPO}/dists/stable/main/binary-aarch64/Packages`)).toString("utf8"));
	const lock: Lock = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as Lock) : {};
	const fresh = closure(index, PACKAGES);
	const certPackage = index.get("ca-certificates");
	if (!certPackage) throw new Error("ca-certificates not in the Termux index");
	if (updateLock) {
		const next: Lock = {};
		for (const p of [...fresh, certPackage].sort((a, b) => a.name.localeCompare(b.name))) next[p.name] = { filename: p.filename, sha256: p.sha256 };
		writeFileSync(lockPath, `${JSON.stringify(next, null, "\t")}\n`);
		console.log(`pinned ${Object.keys(next).length} packages -> ${lockPath}`);
		process.exit(0);
	}
	// Use the pinned build of each package when there is one; new packages fall back to the current index (and are reported).
	const pin = (p: Pkg): Pkg => {
		const l = lock[p.name];
		if (!l) {
			console.warn(`warning: ${p.name} is not in android-termux.lock.json; using the current Termux build`);
			return p;
		}
		return { ...p, filename: l.filename, sha256: l.sha256 };
	};
	const packages = [...fresh.map(pin), pin(certPackage)];
	console.log(`termux packages: ${packages.map((p) => p.name).join(", ")}`);

	const staged = join(work, "root");
	mkdirSync(staged, { recursive: true });
	for (const pkg of packages) {
		const deb = join(work, `${pkg.name}.deb`);
		writeFileSync(deb, await fetchDeb(pkg));
		extractDeb(deb, staged, work, pkg.name);
	}

	// Termux installs under its own prefix: data/data/com.termux/files/usr.
	const prefix = join(staged, "data/data/com.termux/files/usr");
	const node = join(prefix, "bin/node");
	if (!existsSync(node)) throw new Error("node binary missing from the Termux package");

	rmSync(jniDir, { recursive: true, force: true });
	mkdirSync(jniDir, { recursive: true });
	copyFileSync(node, join(jniDir, "libnode.so"));

	// Executables on PATH: libexec_<name>.so is linked to bin/<name> at runtime.
	for (const bin of BINARIES) {
		const src = join(prefix, "bin", bin);
		if (!existsSync(src)) throw new Error(`${bin}: missing from the Termux packages`);
		ship(src, `libexec_${bin}.so`);
	}
	// git's helpers: only the HTTP transports are programs worth shipping (each is ~2 MB). Everything else in git-core is either
	// git again (builtins, which `git <cmd>` runs itself) or a shell script with a Termux-prefix shebang that cannot run here.
	const gitCore = join(prefix, "libexec/git-core");
	for (const f of GIT_HELPERS) {
		const full = join(gitCore, f);
		if (!existsSync(full) || !isElf(realpathSync(full))) throw new Error(`git helper missing or not a program: ${f}`);
		ship(full, `libgitcore_${f}.so`);
	}
	// PRoot's loader is exec'd by proot itself, so it must also live in the library directory (found through PROOT_LOADER).
	const loader = join(prefix, "libexec/proot/loader");
	if (!existsSync(loader)) throw new Error("proot loader missing from the Termux proot package");
	ship(loader, "libproot_loader.so");
	console.log(`shipped ${BINARIES.join(", ")} and ${GIT_HELPERS.join(", ")}`);

	// npm is plain JavaScript: ship its tree beside the server, and tiny shell shims as the `npm`/`npx` commands.
	// (Scripts in app storage cannot be executed, but a script in the library directory can.)
	const npmTree = join(prefix, "lib/node_modules/npm");
	if (!existsSync(join(npmTree, "bin/npm-cli.js"))) throw new Error("npm missing from the Termux packages");
	const toolsOut = join(bundle, "tools/npm");
	rmSync(join(bundle, "tools"), { recursive: true, force: true });
	mkdirSync(dirname(toolsOut), { recursive: true });
	cpSync(npmTree, toolsOut, { recursive: true, dereference: true });
	const shim = (body: string) => `#!/system/bin/sh\n${body}\n`;
	writeFileSync(join(jniDir, "libexec_npm.so"), shim('exec "$PROMETHEUS_NODE" "$PROMETHEUS_NPM_CLI" "$@"'), { mode: 0o755 });
	// npm's own npx cannot start packages here (their bins say `#!/usr/bin/env node`, and there is no /usr/bin/env), so use ours.
	copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "android/npx.mjs"), join(bundle, "tools/npx.mjs"));
	writeFileSync(join(jniDir, "libexec_npx.so"), shim('exec "$PROMETHEUS_NODE" "$PROMETHEUS_NPX_JS" "$@"'), { mode: 0o755 });

	// Shims for the on-demand runtimes. `guestrun` starts a command inside the PRoot rootfs; keep its environment in sync with
	// GUEST_PATH in src-tauri/src/android.rs. Like npm above, these are scripts in the library directory, the only place they can run from.
	const guestrun = [
		"#!/system/bin/sh",
		'if [ ! -x "$PROMETHEUS_ROOTFS/usr/bin/env" ]; then echo "runtime not installed: open Settings > Runtimes" >&2; exit 127; fi',
		'CA=""',
		'[ -n "$PROMETHEUS_CACERT" ] && CA="-b $PROMETHEUS_CACERT:/etc/ssl/certs/ca-certificates.crt"',
		'BIND=""',
		'[ "$PWD" != "/" ] && BIND="-b $PWD"',
		"exec \"$PROMETHEUS_PROOT\" --link2symlink -0 -r \"$PROMETHEUS_ROOTFS\" -b /dev -b /proc -b /sys $BIND $CA -w \"$PWD\" /usr/bin/env -i HOME=/root LANG=C.UTF-8 TERM=\"${TERM:-xterm}\" SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt PATH=/opt/python/bin:/opt/go/bin:/opt/rust/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo GOROOT=/opt/go GOPATH=/root/go GOTOOLCHAIN=local \"$@\"",
		"",
	].join("\n");
	writeFileSync(join(jniDir, "libexec_guestrun.so"), guestrun, { mode: 0o755 });
	for (const [runtime, tools] of Object.entries(GUEST_SHIMS)) {
		for (const [name, target] of Object.entries(tools)) {
			writeFileSync(join(jniDir, `libguest_${runtime}__${name}.so`), shim(`exec "$PROMETHEUS_TOOLS_BIN/guestrun" ${target} "$@"`), { mode: 0o755 });
		}
	}

	// CA bundle for git (Termux's own path does not exist on the phone).
	const cert = join(prefix, "etc/tls/cert.pem");
	if (!existsSync(cert)) throw new Error("CA bundle missing from the ca-certificates package");
	mkdirSync(join(bundle, "etc"), { recursive: true });
	copyFileSync(realpathSync(cert), join(bundle, "etc/cacert.pem"));

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
	console.log(`node, tools and server packed into ${jniDir}`);

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

	// Permissions: voice input (the WebView only prompts when the app declares it), a foreground service so Android keeps the
	// local server alive in the background, and all-files access so the workspace can live in shared storage.
	const manifestPath = join(androidApp, "src", "main", "AndroidManifest.xml");
	let manifest = readFileSync(manifestPath, "utf8");
	const perms = [
		"android.permission.RECORD_AUDIO",
		"android.permission.CAMERA",
		"android.permission.MODIFY_AUDIO_SETTINGS",
		"android.permission.FOREGROUND_SERVICE",
		"android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
		"android.permission.POST_NOTIFICATIONS",
		"android.permission.WAKE_LOCK",
		"android.permission.MANAGE_EXTERNAL_STORAGE",
	];
	for (const perm of perms) {
		if (!manifest.includes(perm)) manifest = manifest.replace(/<manifest[^>]*>/, (m) => `${m}
    <uses-permission android:name="${perm}" />`);
	}
	if (!manifest.includes("KeepAliveService")) {
		const service = `    <service android:name=".KeepAliveService" android:exported="false" android:foregroundServiceType="specialUse">
            <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="local_server" />
        </service>
    `;
		manifest = manifest.replace("</application>", `${service}</application>`);
	}
	if (!manifest.includes("RECORD_AUDIO") || !manifest.includes("KeepAliveService")) throw new Error("could not patch AndroidManifest.xml (template changed?)");
	writeFileSync(manifestPath, manifest);
	console.log("patched AndroidManifest.xml");

	// The foreground service itself, and MainActivity starting it (plus asking for notification and all-files access once).
	const pkg = /package="([^"]+)"/.exec(manifest)?.[1] ?? /namespace\s*=\s*"([^"]+)"/.exec(readFileSync(gradle, "utf8"))?.[1];
	if (!pkg) throw new Error("cannot determine the Android package name");
	const srcDir = join(androidApp, "src/main/java", ...pkg.split("."));
	mkdirSync(srcDir, { recursive: true });
	writeFileSync(join(srcDir, "KeepAliveService.kt"), keepAliveService(pkg));
	const activityPath = join(srcDir, "MainActivity.kt");
	if (!existsSync(activityPath)) throw new Error(`MainActivity.kt not found at ${activityPath}`);
	let activity = readFileSync(activityPath, "utf8");
	if (!activity.includes("startPrometheusService")) {
		const helpers = activityHelpersSource();
		if (/super\.onCreate\(savedInstanceState\)/.test(activity)) {
			activity = activity.replace(/super\.onCreate\(savedInstanceState\)/, "super.onCreate(savedInstanceState)\n    startPrometheusService()");
			activity = activity.replace(/\n\}\s*$/, () => `\n${helpers}}\n`);
		} else {
			activity = activity.replace(
				/class MainActivity\s*:\s*TauriActivity\(\)(\s*\{\s*\})?/,
				() => `class MainActivity : TauriActivity() {\n  override fun onCreate(savedInstanceState: android.os.Bundle?) {\n    super.onCreate(savedInstanceState)\n    startPrometheusService()\n  }\n${helpers}}`,
			);
		}
		if (!activity.includes("startPrometheusService()") || !activity.includes("private fun startPrometheusService")) throw new Error("could not patch MainActivity.kt (template changed?)");
		writeFileSync(activityPath, activity);
	}
	console.log("patched MainActivity.kt");
} finally {
	rmSync(work, { recursive: true, force: true });
}

function keepAliveService(pkg: string): string {
	return `package ${pkg}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

// Keeps the process (and the local Node server it spawned) alive while the app is in the background.
class KeepAliveService : Service() {
  private var lock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val channel = "prometheus_local"
    getSystemService(NotificationManager::class.java)
      .createNotificationChannel(NotificationChannel(channel, "Local server", NotificationManager.IMPORTANCE_LOW))
    val notification: Notification = Notification.Builder(this, channel)
      .setContentTitle("Prometheus")
      .setContentText("Local server is running")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(1, notification)
    }
    if (lock == null) {
      lock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "prometheus:server").apply { acquire() }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    lock?.release()
    super.onDestroy()
  }
}
`;
}

function activityHelpersSource(): string {
	return `
  private fun startPrometheusService() {
    try {
      startForegroundService(android.content.Intent(this, KeepAliveService::class.java))
    } catch (_: Exception) {
    }
    if (android.os.Build.VERSION.SDK_INT >= 33 &&
      checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    // All-files access cannot be requested in a dialog; send the user to the settings page once.
    val prefs = getSharedPreferences("prometheus", MODE_PRIVATE)
    if (android.os.Build.VERSION.SDK_INT >= 30 && !android.os.Environment.isExternalStorageManager() && !prefs.getBoolean("asked_storage", false)) {
      prefs.edit().putBoolean("asked_storage", true).apply()
      try {
        startActivity(
          android.content.Intent(
            android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            android.net.Uri.parse("package:" + packageName),
          ),
        )
      } catch (_: Exception) {
      }
    }
  }
`;
}
