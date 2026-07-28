import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, "..");
const repoRoot = join(clientRoot, "..", "..");
const binariesDir = join(clientRoot, "src-tauri", "binaries");
mkdirSync(binariesDir, { recursive: true });

const isWin = process.platform === "win32";
const serverName = isWin ? "prometheus-server.exe" : "prometheus-server";
const triple =
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  (process.platform === "win32"
    ? "x86_64-pc-windows-msvc"
    : process.platform === "darwin"
      ? process.arch === "arm64"
        ? "aarch64-apple-darwin"
        : "x86_64-apple-darwin"
      : "x86_64-unknown-linux-gnu");

const stagedName = isWin
  ? `prometheus-server-${triple}.exe`
  : `prometheus-server-${triple}`;

const candidates = [
  join(repoRoot, "apps", "server-rs", "target", "release", serverName),
  join(repoRoot, "apps", "server-rs", "target", "debug", serverName),
  join(repoRoot, "apps", "server-rs", "target", triple, "release", serverName),
  join(repoRoot, "apps", "server-rs", "target", triple, "debug", serverName),
];

function pick() {
  let best = null;
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    if (size < 1024 * 1024) continue;
    if (!best || size > best.size) best = { path, size };
  }
  return best;
}

let selected = pick();
if (!selected && process.argv.includes("--build")) {
  console.log("[stage-sidecar] no local server binary found; building debug server...");
  const result = spawnSync(
    "cargo",
    ["build", "--manifest-path", join(repoRoot, "apps", "server-rs", "Cargo.toml")],
    { stdio: "inherit", shell: isWin },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  selected = pick();
}

if (!selected) {
  console.warn(
    "[stage-sidecar] no usable prometheus-server binary found. Desktop local mode will not work until you build apps/server-rs.",
  );
  process.exit(0);
}

const target = join(binariesDir, stagedName);
copyFileSync(selected.path, target);
// Also provide unsuffixed name for direct resolve fallbacks.
copyFileSync(selected.path, join(binariesDir, serverName));
console.log(`[stage-sidecar] staged ${selected.path} -> ${target} (${selected.size} bytes)`);
