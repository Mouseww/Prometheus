import type { Readable, Writable } from "node:stream";
import type { Driver, DriverHello, DriverMethod, DriverMethods } from "../protocol.ts";

export class DriverCallError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "DriverCallError";
	}
}

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

/**
 * Line-delimited JSON-RPC 2.0 over any pair of streams: a child process's stdio, an SSH channel,
 * or a socket to the Android accessibility service.
 */
export class RpcDriver implements Driver {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private buffer = "";
	private _closed = false;
	hello!: DriverHello;

	private readonly output: Writable;
	private readonly onClose: () => void;

	constructor(input: Readable, output: Writable, onClose: () => void = () => {}) {
		this.output = output;
		this.onClose = onClose;
		input.setEncoding("utf8");
		input.on("data", (chunk: string) => this.feed(chunk));
		input.on("end", () => this.fail(new DriverCallError("internal", "驱动已退出")));
		input.on("error", (e) => this.fail(e));
		output.on("error", (e) => this.fail(e));
	}

	get closed(): boolean {
		return this._closed;
	}

	async start(timeoutMs = 60_000): Promise<this> {
		// First start on Windows compiles the driver, which takes a few seconds.
		this.hello = await this.call("hello", {}, timeoutMs);
		return this;
	}

	call<M extends DriverMethod>(method: M, params: DriverMethods[M]["params"], timeoutMs = 20_000): Promise<DriverMethods[M]["result"]> {
		if (this._closed) return Promise.reject(new DriverCallError("internal", "驱动已关闭"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new DriverCallError("timeout", `驱动调用超时：${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			this.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	close(): void {
		if (this._closed) return;
		try {
			this.output.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "shutdown" })}\n`);
			this.output.end();
		} catch {}
		this.fail(new DriverCallError("internal", "驱动已关闭"));
	}

	private feed(chunk: string): void {
		this.buffer += chunk;
		let nl: number;
		while ((nl = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (line) this.handle(line);
		}
	}

	private handle(line: string): void {
		let msg: { id?: number; result?: unknown; error?: { message?: string; data?: { code?: string } } };
		try {
			msg = JSON.parse(line);
		} catch {
			return; // stray output; the protocol owns stdout but be lenient
		}
		if (typeof msg.id !== "number") return;
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		clearTimeout(p.timer);
		if (msg.error) p.reject(new DriverCallError(msg.error.data?.code ?? "internal", msg.error.message ?? "驱动错误"));
		else p.resolve(msg.result);
	}

	private fail(err: Error): void {
		if (this._closed) return;
		this._closed = true;
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
		this.onClose();
	}
}
