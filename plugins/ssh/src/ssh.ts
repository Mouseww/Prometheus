import { spawn } from "node:child_process";
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

function baseArgs(h: SshHost, portFlag: "-p" | "-P"): string[] {
	const args = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", portFlag, String(h.port)];
	if (h.auth === "password") args.push("-o", "BatchMode=no", "-o", "NumberOfPasswordPrompts=1", "-o", "PreferredAuthentications=password,keyboard-interactive");
	else args.push("-o", "BatchMode=yes");
	if (h.auth === "key" && h.identityFile) args.push("-i", h.identityFile, "-o", "IdentitiesOnly=yes");
	return args;
}

/** Runs `bin` with the host's auth settings. Passwords reach ssh through a throwaway SSH_ASKPASS helper, never argv. */
async function run(bin: "ssh" | "scp", h: SshHost, args: string[], timeoutMs: number): Promise<SshResult> {
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
				reject(new Error((err as NodeJS.ErrnoException).code === "ENOENT" ? `找不到 ${bin}，请先安装 OpenSSH 客户端${process.env.PROMETHEUS_ROOTFS ? "（Android：先在设置 > 运行环境安装“Linux 基础系统”，在其中执行 apt install openssh-client，然后重启应用）" : ""}` : err.message));
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
