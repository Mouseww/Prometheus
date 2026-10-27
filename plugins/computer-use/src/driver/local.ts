import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DRIVERS } from "./embedded.generated.ts";
import { DriverCallError, RpcDriver } from "./rpc.ts";

/** Writes the embedded driver sources for `platform` under `dir/<platform>/<hash>/` once. */
async function materialise(platform: string, dir: string): Promise<string> {
	const bundle = DRIVERS[platform];
	if (!bundle) throw new DriverCallError("unsupported", `没有 ${platform} 平台的驱动`);
	const target = join(dir, platform, bundle.hash);
	for (const [name, text] of Object.entries(bundle.files)) {
		const path = join(target, name);
		if (existsSync(path)) continue;
		await mkdir(target, { recursive: true });
		await writeFile(path, text, "utf8");
	}
	return target;
}

/**
 * Starts the driver for the machine the host runs on: Windows (UI Automation) and macOS (AX).
 * Linux (AT-SPI) and Android follow behind the same protocol.
 */
export async function startLocalDriver(dataDir: string, log: (m: string) => void): Promise<RpcDriver> {
	const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : undefined;
	if (!platform || !DRIVERS[platform]) {
		throw new DriverCallError("unsupported", `本机 Computer Use 驱动暂不支持 ${process.platform}。`);
	}
	const dir = await materialise(platform, join(dataDir, "drivers"));
	const bin = join(dataDir, "drivers", platform, "bin");
	const [cmd, args] = launchCommand(platform, dir, bin);
	const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (d: string) => {
		stderr = (stderr + d).slice(-4000);
	});
	const driver = new RpcDriver(child.stdout, child.stdin, () => {
		if (!child.killed) child.kill();
	});
	child.on("exit", (code) => {
		if (code && stderr.trim()) log(`computer-use driver exited (${code}): ${stderr.trim().slice(-800)}`);
	});
	try {
		// First start compiles the driver, which takes a while on every platform.
		const started = await driver.start(180_000);
		const perm = started.hello.permissions.accessibility;
		if (perm === "denied") {
			log("computer-use: accessibility permission is not granted yet");
		}
		return started;
	} catch (e) {
		child.kill();
		const detail = stderr.trim() ? `\n${stderr.trim().slice(-800)}` : "";
		throw new DriverCallError("internal", `无法启动 ${platform} 驱动：${(e as Error).message}${detail}`);
	}
}

function launchCommand(platform: string, dir: string, bin: string): [string, string[]] {
	switch (platform) {
		case "windows":
			return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(dir, "cu-driver.ps1"), "-Source", join(dir, "driver.cs"), "-CacheDir", bin]];
		case "macos":
			return ["/bin/sh", [join(dir, "cu-driver.sh"), join(dir, "driver.swift"), bin]];
		default:
			return ["python3", [join(dir, "driver.py")]];
	}
}
