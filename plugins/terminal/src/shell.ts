import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Oldest output is dropped past this many characters. */
export const MAX_BUFFER = 400_000;

export interface ShellSpec {
	command: string;
	args: string[];
	/** Lines written to the shell before the user's first command. */
	init: string;
}

export function shellSpec(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ShellSpec {
	if (platform === "win32") {
		return {
			command: "powershell.exe",
			args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"],
			init: "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8\n",
		};
	}
	// Android has no /bin/bash; its system shell is /system/bin/sh. Termux builds of Node report the platform as "android".
	const fallback = platform === "android" || !existsSync("/bin/bash") ? "/system/bin/sh" : "/bin/bash";
	return { command: env.SHELL || (existsSync(fallback) ? fallback : "sh"), args: [], init: "" };
}

export interface ReadResult {
	data: string;
	/** Pass this back as `since` to continue. */
	next: number;
	alive: boolean;
	exitCode: number | null;
}

/**
 * A long-lived shell fed through pipes. There is no pseudo-terminal, so full-screen programs (vim, top) do not work,
 * but ordinary commands, `cd`, environment variables and long-running servers do.
 */
export class ShellSession {
	readonly id: string;
	readonly cwd: string;
	private proc: ChildProcess | undefined;
	private buf = "";
	/** Characters dropped from the front of `buf`; offsets handed to clients are absolute. */
	private base = 0;
	private exitCode: number | null = null;
	private closed = false;
	private readonly spec: ShellSpec;
	lastUsed = Date.now();

	constructor(id: string, cwd: string, spec: ShellSpec = shellSpec()) {
		this.id = id;
		this.cwd = cwd;
		this.spec = spec;
		this.start();
	}

	private append(text: string): void {
		this.buf += text;
		if (this.buf.length > MAX_BUFFER) {
			const drop = this.buf.length - MAX_BUFFER;
			this.buf = this.buf.slice(drop);
			this.base += drop;
		}
	}

	private start(): void {
		this.exitCode = null;
		const proc = spawn(this.spec.command, this.spec.args, {
			cwd: this.cwd,
			env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		this.proc = proc;
		proc.stdout?.setEncoding("utf8").on("data", (d: string) => this.append(d));
		proc.stderr?.setEncoding("utf8").on("data", (d: string) => this.append(d));
		proc.stdin?.on("error", () => undefined);
		proc.on("error", (e) => {
			this.append(`\n[无法启动 shell: ${e.message}]\n`);
			if (this.proc === proc) this.exitCode = -1;
		});
		proc.on("exit", (code) => {
			// A killed-and-replaced shell reports here too; only the current one counts.
			if (this.proc !== proc) return;
			this.exitCode = code ?? 0;
			if (!this.closed) this.append(`\n[shell 已退出，代码 ${code ?? 0}]\n`);
		});
		if (this.spec.init) proc.stdin?.write(this.spec.init);
	}

	get alive(): boolean {
		return this.exitCode === null;
	}

	read(since: number): ReadResult {
		this.lastUsed = Date.now();
		const from = Math.max(since, this.base);
		return { data: this.buf.slice(from - this.base), next: this.base + this.buf.length, alive: this.alive, exitCode: this.exitCode };
	}

	/** Send one command line; it is echoed into the output so history survives a reload. */
	run(line: string): void {
		this.lastUsed = Date.now();
		if (!this.alive) throw new Error("shell 已退出，请重启终端");
		this.append(`> ${line}\n`);
		this.proc?.stdin?.write(`${line}\n`);
	}

	/** Stop whatever is running by replacing the shell (pipes cannot carry Ctrl+C). Output so far is kept. */
	interrupt(): void {
		this.append("^C\n");
		this.killProc();
		this.start();
	}

	private killProc(): void {
		const proc = this.proc;
		this.proc = undefined;
		if (!proc?.pid) return;
		try {
			if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
			else process.kill(-proc.pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}

	close(): void {
		this.closed = true;
		this.killProc();
		this.exitCode ??= 0;
	}
}
