import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SshHost {
	id: string;
	name: string;
	host: string;
	port: number;
	user: string;
	/** key: identity file or default keys; agent: ssh-agent; password: via SSH_ASKPASS. */
	auth: "key" | "agent" | "password";
	identityFile?: string;
	secret?: string;
	note?: string;
}

export interface SshResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
}

const MAX_OUTPUT = 100_000;
export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._:%-]*$/;
export const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function validateHost(h: Pick<SshHost, "host" | "user" | "port">): void {
	if (!HOST_RE.test(h.host)) throw new Error("主机地址不合法");
	if (!USER_RE.test(h.user)) throw new Error("用户名不合法");
	if (!Number.isInteger(h.port) || h.port < 1 || h.port > 65535) throw new Error("端口不合法");
}

/** Android: tools run inside the PRoot Ubuntu rootfs (set by the app), so ssh may need installing there first. */
const guestRoot = () => process.env.PROMETHEUS_ROOTFS;

function baseArgs(h: SshHost, portFlag: "-p" | "-P"): string[] {
	const args = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", portFlag, String(h.port)];
	// Under PRoot on a phone: no TOS marking (some Android/WiFi stacks refuse the socket option), and IPv4 only for names
	// (a LAN host usually has no working IPv6 route; ssh would otherwise stall on the AAAA record first).
	if (guestRoot()) {
		args.push("-o", "IPQoS=none");
		if (!h.host.includes(":")) args.push("-o", "AddressFamily=inet");
	}
	if (h.auth === "password") args.push("-o", "BatchMode=no", "-o", "NumberOfPasswordPrompts=1", "-o", "PreferredAuthentications=password,keyboard-interactive");
	else args.push("-o", "BatchMode=yes");
	if (h.auth === "key" && h.identityFile) args.push("-i", h.identityFile, "-o", "IdentitiesOnly=yes");
	return args;
}

let installing: Promise<void> | undefined;

/** Runs a command inside the rootfs through the app's `guestrun` shim and fails with its tail output. */
function guestSh(args: string[], timeoutMs: number): Promise<void> {
	const tools = process.env.PROMETHEUS_TOOLS_BIN ?? "";
	return new Promise((resolve, reject) => {
		const child = spawn(join(tools, "guestrun"), args, { stdio: ["ignore", "pipe", "pipe"] });
		let tail = "";
		const keep = (d: Buffer) => (tail = (tail + d.toString("utf8")).slice(-1500));
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			code === 0 ? resolve() : reject(new Error(tail.trim() || `exit ${code}`));
		});
	});
}

/** Installs openssh-client into the PRoot rootfs with apt (once at a time) and exposes ssh/scp on PATH. */
function installGuestSsh(): Promise<void> {
	installing ??= (async () => {
		const root = guestRoot();
		const tools = process.env.PROMETHEUS_TOOLS_BIN;
		if (!root || !tools) throw new Error("找不到 PRoot 环境");
		if (!existsSync(join(root, "usr/bin/env"))) {
			throw new Error("Android 上还没有 Linux 基础系统，无法自动安装 OpenSSH 客户端。请在 设置 > 运行环境 的“工具商店”里安装 openssh-client（会自动准备基础系统），然后重试。");
		}
		const env = ["env", "DEBIAN_FRONTEND=noninteractive"];
		await guestSh([...env, "apt-get", "update"], 300_000);
		await guestSh([...env, "apt-get", "install", "-y", "--no-install-recommends", "openssh-client"], 600_000);
		// Link the new commands (ssh, scp, ...) into the PATH directory the server was started with.
		await new Promise<void>((resolve) => {
			const c = spawn(join(tools, "guestsync"), [], { stdio: "ignore" });
			c.on("error", () => resolve());
			c.on("close", () => resolve());
		});
	})().finally(() => {
		installing = undefined;
	});
	return installing;
}

/** Runs `bin` with the host's auth settings. If ssh is missing on Android it is installed into PRoot first, then the call is retried once. */
async function run(bin: "ssh" | "scp", h: SshHost, args: string[], timeoutMs: number): Promise<SshResult> {
	try {
		return await runOnce(bin, h, args, timeoutMs);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !guestRoot()) throw err;
	}
	try {
		await installGuestSsh();
	} catch (err) {
		throw new Error(`找不到 ${bin}，自动安装 OpenSSH 客户端失败：${(err as Error).message}`);
	}
	return runOnce(bin, h, args, timeoutMs);
}

/** Passwords reach ssh through a throwaway SSH_ASKPASS helper, never argv. */
async function runOnce(bin: "ssh" | "scp", h: SshHost, args: string[], timeoutMs: number): Promise<SshResult> {
	let dir: string | undefined;
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (h.auth === "password") {
		if (!h.secret) throw new Error("未保存密码");
		dir = await mkdtemp(join(tmpdir(), "prom-ssh-"));
		const win = process.platform === "win32";
		const script = join(dir, win ? "askpass.cmd" : "askpass.sh");
		await writeFile(script, win ? "@echo off\r\necho %PROMETHEUS_SSH_SECRET%\r\n" : '#!/bin/sh\nprintf "%s\\n" "$PROMETHEUS_SSH_SECRET"\n');
		if (!win) await chmod(script, 0o700);
		env.SSH_ASKPASS = script;
		env.SSH_ASKPASS_REQUIRE = "force";
		env.DISPLAY ??= "prometheus:0";
		env.PROMETHEUS_SSH_SECRET = h.secret;
	}
	try {
		return await new Promise<SshResult>((resolve, reject) => {
			const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
			let stdout = "";
			let stderr = "";
			let truncated = false;
			let timedOut = false;
			const take = (cur: string, d: Buffer) => {
				if (cur.length >= MAX_OUTPUT) {
					truncated = true;
					return cur;
				}
				return cur + d.toString("utf8");
			};
			child.stdout.on("data", (d: Buffer) => (stdout = take(stdout, d)));
			child.stderr.on("data", (d: Buffer) => (stderr = take(stderr, d)));
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, timeoutMs);
			child.on("error", (err) => {
				clearTimeout(timer);
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					// run() installs ssh on Android and retries; elsewhere the user has to install it.
					reject(Object.assign(new Error(`找不到 ${bin}，请先安装 OpenSSH 客户端`), { code: "ENOENT" }));
				} else {
					reject(err);
				}
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ code, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), timedOut, truncated });
			});
		});
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

export function sshExec(h: SshHost, command: string, timeoutMs = 60_000): Promise<SshResult> {
	validateHost(h);
	return run("ssh", h, [...baseArgs(h, "-p"), "--", `${h.user}@${h.host}`, command], timeoutMs);
}

export function scpTransfer(h: SshHost, dir: "up" | "down", local: string, remote: string, timeoutMs = 300_000): Promise<SshResult> {
	validateHost(h);
	const target = `${h.user}@${h.host}:${remote}`;
	const args = [...baseArgs(h, "-P"), "-r", "--", ...(dir === "up" ? [local, target] : [target, local])];
	return run("scp", h, args, timeoutMs);
}

export function formatResult(r: SshResult): string {
	const parts: string[] = [];
	if (r.stdout) parts.push(r.stdout.trimEnd());
	if (r.stderr) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
	if (r.truncated) parts.push("[输出已截断]");
	if (r.timedOut) parts.push("[命令超时已终止]");
	parts.push(`[exit ${r.code ?? "none"}]`);
	return parts.join("\n");
}
