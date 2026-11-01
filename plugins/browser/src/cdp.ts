// Chrome DevTools Protocol over --remote-debugging-pipe: messages are JSON separated by a NUL byte, written to the
// browser's fd 3 and read from its fd 4. No port is opened, so no other local process can drive the browser.
import { PassThrough, type Readable, Writable } from "node:stream";

export interface CdpEvent {
	method: string;
	// biome-ignore lint/suspicious/noExplicitAny: protocol payloads are untyped JSON
	params: any;
	sessionId?: string;
}

export class CdpError extends Error {
	readonly code: number | undefined;
	readonly method: string;
	constructor(method: string, message: string, code?: number) {
		super(`${method}: ${message}`);
		this.method = method;
		this.code = code;
	}
}

interface Pending {
	method: string;
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

const MAX_MESSAGE = 256 * 1024 * 1024;

/** Connects to a browser's `--remote-debugging-port` endpoint; the same framing as the pipe is used internally. */
export async function connectWebSocket(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
	const ws = new WebSocket(url);
	ws.binaryType = "arraybuffer";
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("connecting to the browser timed out")), timeoutMs);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
		ws.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error("could not connect to the browser"));
		}, { once: true });
	});
	const input = new PassThrough();
	const out = new Writable({
		write(chunk: Buffer, _enc, cb) {
			try {
				ws.send(chunk.toString("utf8").replace(/\0$/, ""));
				cb();
			} catch (e) {
				cb(e as Error);
			}
		},
	});
	ws.addEventListener("message", (ev) => {
		input.write(typeof ev.data === "string" ? `${ev.data}\0` : Buffer.concat([Buffer.from(ev.data as ArrayBuffer), Buffer.from([0])]));
	});
	ws.addEventListener("close", () => input.end());
	const conn = new CdpConnection(out, input);
	conn.onClose(() => {
		try {
			ws.close();
		} catch {}
	});
	return conn;
}

export class CdpConnection {
	closed = false;
	closeReason = "";
	private seq = 0;
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Set<(e: CdpEvent) => void>();
	private readonly closers = new Set<(reason: string) => void>();
	private readonly out: Writable;

	constructor(out: Writable, input: Readable) {
		this.out = out;
		let parts: Buffer[] = [];
		let size = 0;
		input.on("data", (chunk: Buffer) => {
			let start = 0;
			for (;;) {
				const end = chunk.indexOf(0, start);
				if (end < 0) break;
				parts.push(chunk.subarray(start, end));
				const text = parts.length === 1 ? parts[0]!.toString("utf8") : Buffer.concat(parts).toString("utf8");
				parts = [];
				size = 0;
				start = end + 1;
				this.dispatch(text);
			}
			if (start < chunk.length) {
				parts.push(chunk.subarray(start));
				size += chunk.length - start;
				if (size > MAX_MESSAGE) this.shutdown("message too large");
			}
		});
		input.on("close", () => this.shutdown("browser closed"));
		input.on("error", (e) => this.shutdown(e.message));
		out.on("error", (e) => this.shutdown(e.message));
	}

	send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
		if (this.closed) return Promise.reject(new CdpError(method, this.closeReason || "browser closed"));
		const id = ++this.seq;
		const msg = sessionId ? { id, method, params, sessionId } : { id, method, params };
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new CdpError(method, `timed out after ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
			this.out.write(`${JSON.stringify(msg)}\0`);
		});
	}

	on(fn: (e: CdpEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	onClose(fn: (reason: string) => void): () => void {
		if (this.closed) {
			fn(this.closeReason);
			return () => {};
		}
		this.closers.add(fn);
		return () => this.closers.delete(fn);
	}

	shutdown(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.closeReason = reason;
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new CdpError(p.method, reason));
		}
		this.pending.clear();
		for (const fn of this.closers) fn(reason);
		this.closers.clear();
		this.listeners.clear();
	}

	private dispatch(text: string): void {
		let msg: { id?: number; method?: string; params?: unknown; sessionId?: string; result?: unknown; error?: { message?: string; code?: number } };
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof msg.id === "number") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new CdpError(p.method, msg.error.message ?? "error", msg.error.code));
			else p.resolve(msg.result ?? {});
			return;
		}
		if (typeof msg.method !== "string") return;
		const event: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
		for (const fn of this.listeners) {
			try {
				fn(event);
			} catch (err) {
				console.error("[plugin:browser] CDP listener", err);
			}
		}
	}
}

/** A CDP session bound to one target (flatten mode). */
export class CdpSession {
	readonly conn: CdpConnection;
	readonly id: string;
	constructor(conn: CdpConnection, id: string) {
		this.conn = conn;
		this.id = id;
	}
	send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
		return this.conn.send<T>(method, params, this.id, timeoutMs);
	}
}
