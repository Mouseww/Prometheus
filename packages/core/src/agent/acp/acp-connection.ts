// Agent Client Protocol (https://agentclientprotocol.com) transport: JSON-RPC 2.0, one message per line, over the
// stdio of the agent process. Both sides send requests: we call `initialize`, `session/*`; the agent asks us for
// permissions (`session/request_permission`) and streams `session/update` notifications.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { resolveExecutable } from "@prometheus/subagents";

export interface AcpLaunch {
	command: string;
	args: string[];
	/** Run through a shell (a `.cmd` shim whose target could not be found). */
	shell: boolean;
}

/**
 * How to start an agent. A bare name is looked up on PATH; on Windows npm's `.cmd` shims are unwrapped to the script
 * or binary they start, because a shell would mangle arguments. `.js` entries run on this Node.
 */
export function resolveAcpCommand(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): AcpLaunch {
	if (/\.(c|m)?js$/i.test(executable)) return { command: process.execPath, args: [executable, ...args], shell: false };
	const isPath = /[\\/]/.test(executable);
	if (isPath) {
		const ext = extname(executable).toLowerCase();
		if (platform === "win32" && (ext === ".cmd" || ext === ".bat" || ext === "")) {
			// Resolve the shim (or the extensionless name next to one) from its own folder.
			const found = resolveExecutable(basename(executable, ext), { ...env, PATH: dirname(executable), Path: undefined }, platform);
			if (found) return { command: found.command, args: [...found.prefix, ...args], shell: false };
			if (ext === ".cmd" || ext === ".bat") return { command: executable, args, shell: true };
		}
		return { command: executable, args, shell: false };
	}
	const found = resolveExecutable(executable, env, platform);
	if (found) return { command: found.command, args: [...found.prefix, ...args], shell: false };
	// Not found: let the platform try (and report ENOENT); Windows needs a shell for PATHEXT lookup.
	return { command: executable, args, shell: platform === "win32" };
}

/** True when the command can be found at all (cheap check for `probe`). */
export function acpCommandExists(executable: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (/[\\/]/.test(executable)) return existsSync(executable);
	return resolveExecutable(executable, env) !== undefined;
}

export class AcpError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

export interface AcpConnectionOptions {
	launch: AcpLaunch;
	cwd: string;
	env: Record<string, string | undefined>;
	/** A notification from the agent (`session/update`, ...). */
	onNotification(method: string, params: any): void;
	/** A request from the agent; the resolved value is the result, a rejection becomes a JSON-RPC error. */
	onRequest(method: string, params: any): Promise<unknown>;
	/** The process ended without `close()` being called. */
	onExit(code: number | null, stderr: string): void;
	onLog?(line: string): void;
}

interface Pending {
	resolve(value: any): void;
	reject(err: Error): void;
	timer?: ReturnType<typeof setTimeout>;
}

/** Kills a process and, on Windows, everything it started (shells, MCP servers). */
function killTree(child: ChildProcess): void {
	if (process.platform === "win32" && child.pid) {
		try {
			execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			return;
		} catch {
			/* fall through to a plain kill */
		}
	}
	child.kill();
}

export class AcpConnection {
	private child: ChildProcess | undefined;
	private readonly pending = new Map<number, Pending>();
	private seq = 0;
	private buffer = "";
	private stderr = "";
	private closed = false;
	private readonly opts: AcpConnectionOptions;

	constructor(opts: AcpConnectionOptions) {
		this.opts = opts;
	}

	get running(): boolean {
		return Boolean(this.child) && !this.closed;
	}

	/** The last lines the agent wrote to stderr (for error messages). */
	get errorTail(): string {
		return this.stderr.trim().split(/\r?\n/).slice(-3).join("\n");
	}

	start(): void {
		const { launch } = this.opts;
		const child = spawn(launch.command, launch.args, { cwd: this.opts.cwd, env: this.opts.env as NodeJS.ProcessEnv, shell: launch.shell, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		this.child = child;
		child.stdout!.setEncoding("utf8");
		child.stderr!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => this.read(chunk));
		child.stderr!.on("data", (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-8000);
			this.opts.onLog?.(chunk.trimEnd());
		});
		child.stdin!.on("error", () => {
			/* the process went away; `exit` reports it */
		});
		child.on("error", (err) => this.fail(err instanceof Error ? err : new Error(String(err))));
		child.on("exit", (code) => {
			const wasClosed = this.closed;
			this.closed = true;
			this.fail(new Error(`agent exited (${code})${this.errorTail ? `: ${this.errorTail}` : ""}`));
			if (!wasClosed) this.opts.onExit(code, this.stderr);
		});
	}

	private fail(err: Error): void {
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}

	private read(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const i = this.buffer.indexOf("\n");
			if (i < 0) break;
			const line = this.buffer.slice(0, i).trim();
			this.buffer = this.buffer.slice(i + 1);
			if (!line) continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				// Some agents print banners or logs on stdout; they are not protocol messages.
				this.opts.onLog?.(line);
				continue;
			}
			this.dispatch(msg);
		}
	}

	private dispatch(msg: any): void {
		if (msg && typeof msg.method === "string") {
			if (msg.id === undefined || msg.id === null) {
				try {
					this.opts.onNotification(msg.method, msg.params ?? {});
				} catch (err) {
					this.opts.onLog?.(`notification ${msg.method} failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}
			const id = msg.id;
			void this.opts.onRequest(msg.method, msg.params ?? {}).then(
				(result) => this.write({ jsonrpc: "2.0", id, result: result ?? null }),
				(err) => {
					const e = err instanceof AcpError ? err : new AcpError(-32603, err instanceof Error ? err.message : String(err));
					this.write({ jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } });
				},
			);
			return;
		}
		if (msg && (msg.result !== undefined || msg.error !== undefined) && typeof msg.id === "number") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new AcpError(Number(msg.error.code ?? -32603), String(msg.error.message ?? "error"), msg.error.data));
			else p.resolve(msg.result);
		}
	}

	private write(msg: unknown): void {
		if (!this.child?.stdin || this.child.stdin.destroyed) return;
		this.child.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	/** A request to the agent; no timeout unless one is given (a prompt runs as long as the turn). */
	request<T = any>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
		if (!this.running) return Promise.reject(new Error(`agent is not running${this.errorTail ? `: ${this.errorTail}` : ""}`));
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			const pending: Pending = { resolve, reject };
			if (timeoutMs) {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s${this.errorTail ? `: ${this.errorTail}` : ""}`));
				}, timeoutMs);
			}
			this.pending.set(id, pending);
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	async close(): Promise<void> {
		const child = this.child;
		this.closed = true;
		this.fail(new Error("agent closed"));
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 3000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			try {
				child.stdin?.end();
			} catch {
				/* ignore */
			}
			killTree(child);
		});
	}
}
