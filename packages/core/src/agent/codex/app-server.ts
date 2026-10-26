// Client for `codex app-server`: JSON lines over stdio, JSON-RPC shaped but without the `jsonrpc` field
// (docs/agent-runtime.md §12.2).
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AppServerOptions {
	env: Record<string, string | undefined>;
	cwd?: string;
	/** Called for notifications from the server. */
	onNotification(method: string, params: any): void;
	/** Called for requests from the server (approvals, ...). The returned value is sent back as the result. */
	onRequest(method: string, params: any): Promise<unknown>;
	onExit(code: number | null, stderr: string): void;
	onLog?(line: string): void;
	/** Path of the codex executable or its JS entry, when the user chose one. */
	executable?: string;
}

interface Pending {
	resolve(value: any): void;
	reject(err: Error): void;
	method: string;
}

/** How to start Codex: on Windows the npm shim is a .cmd, so run its JS entry with node instead of a shell. */
export function resolveCodexCommand(executable?: string): { command: string; args: string[]; shell: boolean } {
	if (executable) {
		if (executable.endsWith(".js") || executable.endsWith(".mjs")) return { command: process.execPath, args: [executable, "app-server"], shell: false };
		return { command: executable, args: ["app-server"], shell: false };
	}
	if (process.platform === "win32") {
		try {
			const found = execFileSync("where", ["codex"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).find((l) => l.trim());
			if (found) {
				const entry = join(dirname(found.trim()), "node_modules", "@openai", "codex", "bin", "codex.js");
				if (existsSync(entry)) return { command: process.execPath, args: [entry, "app-server"], shell: false };
			}
		} catch {
			/* not installed or not on PATH */
		}
		return { command: "codex", args: ["app-server"], shell: true };
	}
	return { command: "codex", args: ["app-server"], shell: false };
}

export class AppServer {
	private child: ChildProcessWithoutNullStreams | undefined;
	private buffer = "";
	private seq = 0;
	private readonly pending = new Map<number, Pending>();
	private stderr = "";
	private closed = false;
	private readonly options: AppServerOptions;

	constructor(options: AppServerOptions) {
		this.options = options;
	}

	get running(): boolean {
		return Boolean(this.child) && !this.closed;
	}

	async start(): Promise<void> {
		const { command, args, shell } = resolveCodexCommand(this.options.executable);
		const child = spawn(command, args, { cwd: this.options.cwd, env: this.options.env as NodeJS.ProcessEnv, shell, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onData(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-8000);
			this.options.onLog?.(chunk.trimEnd());
		});
		child.on("error", (err) => this.fail(err));
		child.on("exit", (code) => {
			this.closed = true;
			this.rejectAll(new Error(`codex app-server exited (${code})${this.stderr ? `: ${this.stderr.trim().split("\n").at(-1)}` : ""}`));
			this.options.onExit(code, this.stderr);
		});
		await this.request("initialize", { clientInfo: { name: "prometheus", title: "Prometheus", version: "1" }, capabilities: { experimentalApi: false, requestAttestation: false } });
		this.write({ method: "initialized" });
	}

	private fail(err: Error): void {
		this.closed = true;
		this.rejectAll(err);
	}

	private rejectAll(err: Error): void {
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
	}

	private write(message: object): void {
		if (!this.child || this.closed) throw new Error("codex app-server is not running");
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	request<T = any>(method: string, params: object = {}): Promise<T> {
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, method });
			try {
				this.write({ id, method, params });
			} catch (err) {
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const nl = this.buffer.indexOf("\n");
			if (nl === -1) return;
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (!line) continue;
			let message: any;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			this.dispatch(message);
		}
	}

	private dispatch(m: any): void {
		if (m.id !== undefined && m.method === undefined) {
			const p = this.pending.get(m.id);
			if (!p) return;
			this.pending.delete(m.id);
			if (m.error) p.reject(new Error(`${p.method}: ${m.error.message ?? JSON.stringify(m.error)}`));
			else p.resolve(m.result);
			return;
		}
		if (m.method && m.id !== undefined) {
			void this.options
				.onRequest(m.method, m.params)
				.then((result) => this.write({ id: m.id, result }))
				.catch((err) => {
					try {
						this.write({ id: m.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
					} catch {
						/* process gone */
					}
				});
			return;
		}
		if (m.method) {
			try {
				this.options.onNotification(m.method, m.params);
			} catch (err) {
				this.options.onLog?.(`notification handler failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	async close(): Promise<void> {
		const child = this.child;
		if (!child || this.closed) return;
		this.closed = true;
		this.rejectAll(new Error("closed"));
		try {
			child.stdin.end();
		} catch {
			/* already closed */
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill();
				resolve();
			}, 2000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}
