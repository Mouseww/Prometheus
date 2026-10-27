// Client for `opencode serve`: REST plus a Server-Sent-Events stream on /event (docs/agent-runtime.md §12.3).
// One server process per session; it listens on loopback only and is protected by a random password.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface OpenCodeServerOptions {
	env: Record<string, string | undefined>;
	cwd: string;
	/** Path of the opencode executable or its JS entry, when the user chose one. */
	executable?: string;
	/** Every event of the server's /event stream, parsed. */
	onEvent(event: { type: string; properties: any }): void;
	/** The event stream was re-established after a drop; events in between may have been missed. */
	onReconnect?(): void;
	onExit(code: number | null, output: string): void;
	onLog?(line: string): void;
}

/** How to start opencode: the npm shim on Windows is a .cmd, so prefer the native binary it wraps. */
export function resolveOpenCodeCommand(executable?: string): { command: string; args: string[]; shell: boolean } {
	if (executable) {
		if (executable.endsWith(".js") || executable.endsWith(".mjs")) return { command: process.execPath, args: [executable], shell: false };
		return { command: executable, args: [], shell: /\.(cmd|bat)$/i.test(executable) };
	}
	if (process.platform === "win32") {
		try {
			const found = execFileSync("where", ["opencode"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).find((l) => l.trim());
			if (found) {
				const dir = dirname(found.trim());
				for (const exe of [join(dir, "node_modules", "opencode-ai", "bin", "opencode.exe"), join(dir, "opencode.exe")]) {
					if (existsSync(exe)) return { command: exe, args: [], shell: false };
				}
				return { command: found.trim(), args: [], shell: /\.(cmd|bat)$/i.test(found.trim()) };
			}
		} catch {
			/* not installed or not on PATH */
		}
		return { command: "opencode", args: [], shell: true };
	}
	return { command: "opencode", args: [], shell: false };
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

export class OpenCodeServer {
	private child: ChildProcess | undefined;
	private url = "";
	private readonly secret = randomBytes(24).toString("base64url");
	private output = "";
	private closed = false;
	private stream: AbortController | undefined;
	private connectedResolve: (() => void) | undefined;
	private readonly connected = new Promise<void>((resolve) => (this.connectedResolve = resolve));
	private readonly options: OpenCodeServerOptions;

	constructor(options: OpenCodeServerOptions) {
		this.options = options;
	}

	get running(): boolean {
		return Boolean(this.child) && !this.closed;
	}

	private get authorization(): string {
		return `Basic ${Buffer.from(`opencode:${this.secret}`).toString("base64")}`;
	}

	async start(timeoutMs = 60_000): Promise<void> {
		const { command, args, shell } = resolveOpenCodeCommand(this.options.executable);
		const env = { ...this.options.env, OPENCODE_SERVER_PASSWORD: this.secret, OPENCODE_SERVER_USERNAME: "opencode" };
		const child = spawn(command, [...args, "serve", "--hostname=127.0.0.1", "--port=0"], { cwd: this.options.cwd, env: env as NodeJS.ProcessEnv, shell, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		this.child = child;
		const listening = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`opencode did not start within ${timeoutMs / 1000}s${this.output ? `: ${this.output.trim().split("\n").at(-1)}` : ""}`)), timeoutMs);
			const onData = (chunk: string) => {
				this.output = (this.output + chunk).slice(-8000);
				this.options.onLog?.(chunk.trimEnd());
				const m = /opencode server listening on\s+(https?:\/\/\S+)/.exec(this.output);
				if (m) {
					clearTimeout(timer);
					resolve(m[1]!);
				}
			};
			child.stdout!.setEncoding("utf8");
			child.stderr!.setEncoding("utf8");
			child.stdout!.on("data", onData);
			child.stderr!.on("data", onData);
			child.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			child.on("exit", (code) => {
				clearTimeout(timer);
				const wasClosed = this.closed;
				this.closed = true;
				this.stream?.abort();
				this.connectedResolve?.();
				reject(new Error(`opencode exited (${code})${this.output ? `: ${this.output.trim().split("\n").at(-1)}` : ""}`));
				if (!wasClosed) this.options.onExit(code, this.output);
			});
		});
		try {
			this.url = (await listening).replace(/\/+$/, "");
		} catch (err) {
			await this.close();
			throw err;
		}
		void this.pump();
		// The first event is `server.connected`: wait for it so nothing that follows can be missed.
		await this.connected;
	}

	/** Reads /event until the server goes away; reconnects when only the stream dropped. */
	private async pump(): Promise<void> {
		let first = true;
		while (!this.closed) {
			const abort = new AbortController();
			this.stream = abort;
			try {
				const res = await fetch(`${this.url}/event?directory=${encodeURIComponent(this.options.cwd)}`, { headers: { authorization: this.authorization, accept: "text/event-stream" }, signal: abort.signal });
				if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
				if (!first) this.options.onReconnect?.();
				first = false;
				const decoder = new TextDecoder();
				let buffer = "";
				for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
					buffer += decoder.decode(chunk, { stream: true });
					for (;;) {
						const end = buffer.search(/\r?\n\r?\n/);
						if (end < 0) break;
						const raw = buffer.slice(0, end);
						buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
						const data = raw
							.split(/\r?\n/)
							.filter((l) => l.startsWith("data:"))
							.map((l) => l.slice(5).trimStart())
							.join("\n");
						if (!data) continue;
						let event: any;
						try {
							event = JSON.parse(data);
						} catch {
							continue;
						}
						if (event?.type === "server.connected") this.connectedResolve?.();
						try {
							this.options.onEvent({ type: String(event?.type), properties: event?.properties ?? {} });
						} catch (err) {
							this.options.onLog?.(`event handler failed: ${err instanceof Error ? err.message : String(err)}`);
						}
					}
				}
			} catch (err) {
				if (this.closed) return;
				this.options.onLog?.(`event stream: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (this.closed) return;
			await new Promise((r) => setTimeout(r, 500));
		}
	}

	/** JSON request relative to the server; `undefined` for an empty body. Failures carry the server's message. */
	async request<T = any>(method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<T> {
		if (!this.running) throw new Error("opencode is not running");
		const qs = new URLSearchParams({ directory: this.options.cwd, ...query });
		const res = await fetch(`${this.url}${path}?${qs}`, {
			method,
			headers: { authorization: this.authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await res.text();
		let data: any;
		try {
			data = text ? JSON.parse(text) : undefined;
		} catch {
			data = text;
		}
		if (!res.ok) {
			const detail = typeof data === "string" ? data : (data?.data?.message ?? data?.message ?? data?.error ?? text);
			throw new Error(`${method} ${path}: ${res.status} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
		}
		return data as T;
	}

	async close(): Promise<void> {
		const child = this.child;
		this.closed = true;
		this.stream?.abort();
		this.connectedResolve?.();
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 3000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			killTree(child);
		});
	}
}
