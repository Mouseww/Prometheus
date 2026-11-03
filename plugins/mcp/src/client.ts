// A small MCP client, enough to connect, initialize and list tools. It exists so the "test connection" button works without
// the PI agent installed (the MCP client of the PI packages is optional now). Transports: stdio (newline-delimited JSON-RPC)
// and Streamable HTTP (a POST whose answer is JSON or an SSE stream).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const PROTOCOL = "2025-06-18";

export interface McpToolInfo {
	name: string;
	description?: string;
}

export interface McpInit {
	serverInfo: { name: string; version: string };
	hasTools: boolean;
}

interface Rpc {
	id?: number;
	result?: any;
	error?: { message?: string };
}

export interface Transport {
	/** Sends a request and resolves with its result. */
	request(method: string, params: unknown, signal: AbortSignal): Promise<any>;
	notify(method: string, params?: unknown): Promise<void>;
	close(): Promise<void>;
}

const fail = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

export class StdioTransport implements Transport {
	private readonly child: ChildProcessWithoutNullStreams;
	private next = 1;
	private buffer = "";
	private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private stderr = "";
	private dead: Error | undefined;

	constructor(opts: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }) {
		// Windows runs .cmd/.bat shims (npx, uvx wrappers) only through a shell.
		const shell = process.platform === "win32";
		const quote = (v: string) => (shell && /[\s&()^|<>]/.test(v) && !v.startsWith('"') ? `"${v}"` : v);
		this.child = spawn(quote(opts.command), (opts.args ?? []).map(quote), {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			windowsHide: true,
			shell,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-1500);
		});
		const die = (e: Error) => {
			this.dead ??= e;
			for (const p of this.pending.values()) p.reject(e);
			this.pending.clear();
		};
		this.child.on("error", (e) => die(new Error(`无法启动 ${opts.command}：${e.message}`)));
		this.child.on("exit", (code) => die(new Error(`服务器已退出（${code}）${this.stderr.trim() ? `：${this.stderr.trim().split(/\r?\n/).slice(-8).join(" | ")}` : ""}`)));
		this.child.stdin.on("error", () => undefined);
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let at: number;
		while ((at = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, at).trim();
			this.buffer = this.buffer.slice(at + 1);
			if (!line) continue;
			let msg: Rpc;
			try {
				msg = JSON.parse(line) as Rpc;
			} catch {
				continue;
			}
			if (msg.id === undefined) continue;
			const p = this.pending.get(msg.id);
			if (!p) continue;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
			else p.resolve(msg.result);
		}
	}

	request(method: string, params: unknown, signal: AbortSignal): Promise<any> {
		if (this.dead) return Promise.reject(this.dead);
		const id = this.next++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			signal.addEventListener("abort", () => {
				this.pending.delete(id);
				reject(new Error("连接超时"));
			});
			this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	async notify(method: string, params?: unknown): Promise<void> {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	async close(): Promise<void> {
		this.child.stdin.end();
		this.child.kill();
	}
}

export class HttpTransport implements Transport {
	private next = 1;
	private session: string | undefined;

	private readonly opts: { url: string; headers?: Record<string, string> };

	constructor(opts: { url: string; headers?: Record<string, string> }) {
		this.opts = opts;
	}

	private async post(body: unknown, signal: AbortSignal): Promise<Response> {
		return fetch(this.opts.url, {
			method: "POST",
			signal,
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": PROTOCOL,
				...(this.session ? { "mcp-session-id": this.session } : {}),
				...this.opts.headers,
			},
			body: JSON.stringify(body),
		});
	}

	async request(method: string, params: unknown, signal: AbortSignal): Promise<any> {
		const id = this.next++;
		const res = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
		this.session ??= res.headers.get("mcp-session-id") ?? undefined;
		if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? "（需要认证：请在请求头里填写令牌）" : ""}`);
		const text = await res.text();
		const kind = res.headers.get("content-type") ?? "";
		// An SSE answer carries the response as one of its `data:` events; others may be notifications.
		const messages: Rpc[] = kind.includes("text/event-stream")
			? text.split(/\r?\n\r?\n/).flatMap((ev) => {
					const data = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
					try {
						return data ? [JSON.parse(data) as Rpc] : [];
					} catch {
						return [];
					}
				})
			: [JSON.parse(text) as Rpc];
		const mine = messages.find((m) => m.id === id);
		if (!mine) throw new Error("服务器没有返回结果");
		if (mine.error) throw new Error(mine.error.message ?? "MCP error");
		return mine.result;
	}

	async notify(method: string, params?: unknown): Promise<void> {
		await this.post({ jsonrpc: "2.0", method, params }, AbortSignal.timeout(10_000)).catch(() => undefined);
	}

	async close(): Promise<void> {
		if (!this.session) return;
		await fetch(this.opts.url, { method: "DELETE", headers: { "mcp-session-id": this.session, ...this.opts.headers }, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
	}
}

export class McpClient {
	private readonly transport: Transport;

	constructor(transport: Transport) {
		this.transport = transport;
	}

	async connect(signal: AbortSignal): Promise<McpInit> {
		const result = await this.transport.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "prometheus", version: "0.1.0" } }, signal).catch((e) => {
			throw fail(e);
		});
		await this.transport.notify("notifications/initialized");
		return {
			serverInfo: { name: String(result?.serverInfo?.name ?? "?"), version: String(result?.serverInfo?.version ?? "") },
			hasTools: Boolean(result?.capabilities?.tools),
		};
	}

	async listTools(signal: AbortSignal): Promise<McpToolInfo[]> {
		const out: McpToolInfo[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.transport.request("tools/list", cursor ? { cursor } : {}, signal);
			for (const t of Array.isArray(page?.tools) ? page.tools : []) out.push({ name: String(t.name), description: typeof t.description === "string" ? t.description : undefined });
			cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
		} while (cursor && out.length < 500);
		return out;
	}

	close(): Promise<void> {
		return this.transport.close();
	}
}
