import { type ClientFrame, decodeBinaryFrame, type RpcMethod, type RpcParams, type RpcResult, type ServerFrame } from "@prometheus/protocol";
import { defineMessages, tr } from "./i18n.ts";

const M = defineMessages({
	zh: {
		closedAbruptly: "连接已断开",
		closed: "连接已关闭",
		offline: "与服务端的连接已断开，操作未执行。正在自动重连，恢复后请重试",
	},
	en: {
		closedAbruptly: "The connection was lost",
		closed: "The connection is closed",
		offline: "Not connected to the server, so nothing was done. Reconnecting automatically; try again once it is back",
	},
});

/** The request never left: the socket is down (or did not come up in time). Callers show it once, not per click. */
export class OfflineError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OfflineError";
	}
}

/** How long a request waits for a connection that is still being set up before it gives up. */
const READY_TIMEOUT_MS = 8_000;

export interface BackendTarget {
	wsUrl: string;
	httpBase: string;
	token?: string;
	label: string;
}

export type ConnState = "idle" | "connecting" | "open" | "unauthorized" | "closed";

/** What the server asked for on connect: nothing, a password (network/proxied access) or the deployment token. */
export type LoginKind = "none" | "password" | "token";

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/** WebSocket client with first-frame auth, request correlation and exponential-backoff reconnect. */
export class PrometheusClient {
	readonly target: BackendTarget;
	state: ConnState = "idle";
	/** Set from the server's hello; settings that reshape network access are only offered when true. */
	local = false;
	loginKind: LoginKind = "none";
	/** Called with the session token after a password login, so it can be saved for next time. */
	onSession: ((token: string) => void) | undefined;
	private ws: WebSocket | undefined;
	private seq = 0;
	private retry = 0;
	private stopped = false;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private watchdog: ReturnType<typeof setInterval> | undefined;
	private unbindWake: (() => void) | undefined;
	private lastSeen = 0;
	private connectingSince = 0;
	private waiters: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
	private readonly pending = new Map<string, Pending>();
	private readonly subscriptions = new Set<string>();
	/** Plugin topics being watched, as `<plugin>\0<topic>` with a reference count. */
	private readonly watches = new Map<string, number>();
	private readonly frameListeners = new Set<(frame: ServerFrame) => void>();
	private readonly stateListeners = new Set<(state: ConnState) => void>();

	constructor(target: BackendTarget) {
		this.target = target;
	}

	connect(): void {
		this.stopped = false;
		clearTimeout(this.retryTimer);
		// Never leave an older socket behind: it would stay registered on the server as a second client.
		const old = this.ws;
		this.ws = undefined;
		if (old) {
			old.onclose = null;
			old.onmessage = null;
			try {
				old.close();
			} catch {}
		}
		this.setState("connecting");
		this.connectingSince = Date.now();
		this.lastSeen = Date.now();
		this.startWatchdog();
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.target.wsUrl);
		} catch {
			this.scheduleRetry();
			return;
		}
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.onmessage = (ev) => {
			this.lastSeen = Date.now();
			if (ev.data instanceof ArrayBuffer) {
				const decoded = decodeBinaryFrame(new Uint8Array(ev.data));
				if (decoded?.header.type === "plugin.event") this.handle({ ...(decoded.header as Extract<ServerFrame, { type: "plugin.event" }>), binary: decoded.payload });
				return;
			}
			let frame: ServerFrame;
			try {
				frame = JSON.parse(String(ev.data)) as ServerFrame;
			} catch {
				return;
			}
			this.handle(frame);
		};
		ws.onclose = (ev) => {
			if (this.ws !== ws) return;
			this.failPending(tr(M, "closedAbruptly"));
			// Closing the idle socket to ask for credentials must not replace the sign-in prompt with "closed".
			if (this.state === "unauthorized") return;
			// 4001 is only the server's sign-in timeout (slow link, busy server): try again instead of asking for credentials.
			if (ev.code === 4003) {
				this.stopped = true;
				this.setState("unauthorized");
				return;
			}
			this.setState("closed");
			this.scheduleRetry();
		};
	}

	private scheduleRetry(): void {
		if (this.stopped) return;
		clearTimeout(this.retryTimer);
		const delay = Math.min(500 * 2 ** this.retry++, 10_000) + Math.random() * 300;
		this.retryTimer = setTimeout(() => !this.stopped && this.connect(), delay);
	}

	/** Detects connections that died without a close (sleep, proxy timeout, dropped Wi-Fi) and forces a reconnect. */
	private startWatchdog(): void {
		if (this.watchdog) return;
		const check = () => {
			if (this.stopped || !this.ws) return;
			const now = Date.now();
			if (this.state === "connecting" && now - this.connectingSince > 12_000) return this.drop();
			if (this.state === "open") {
				if (now - this.lastSeen > 35_000) return this.drop();
				this.send({ type: "ping" });
			}
		};
		this.watchdog = setInterval(check, 15_000);
		if (typeof window !== "undefined") {
			const wake = () => {
				if (this.stopped) return;
				if (this.state === "closed") {
					this.retry = 0;
					this.connect();
				} else if (this.state === "open") this.send({ type: "ping" });
			};
			const onVisible = () => document.visibilityState === "visible" && wake();
			window.addEventListener("online", wake);
			document.addEventListener("visibilitychange", onVisible);
			this.unbindWake = () => {
				window.removeEventListener("online", wake);
				document.removeEventListener("visibilitychange", onVisible);
			};
		}
	}

	/** Gives up on the current socket and reconnects right away. */
	private drop(): void {
		const ws = this.ws;
		this.ws = undefined;
		if (ws) {
			ws.onclose = null;
			ws.onmessage = null;
			try {
				ws.close();
			} catch {}
		}
		this.failPending(tr(M, "closedAbruptly"));
		this.setState("closed");
		this.scheduleRetry();
	}

	close(): void {
		this.stopped = true;
		clearTimeout(this.retryTimer);
		clearInterval(this.watchdog);
		this.watchdog = undefined;
		this.unbindWake?.();
		this.unbindWake = undefined;
		this.ws?.close();
		this.failPending(tr(M, "closed"));
	}

	async rpc<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
		await this.ready();
		const id = `r${++this.seq}`;
		return new Promise<RpcResult<M>>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.send({ type: "rpc", id, method, params } as ClientFrame);
		});
	}

	subscribe(sessionId: string): void {
		this.subscriptions.add(sessionId);
		if (this.state === "open") this.send({ type: "subscribe", sessionId });
	}

	unsubscribe(sessionId: string): void {
		this.subscriptions.delete(sessionId);
		if (this.state === "open") this.send({ type: "unsubscribe", sessionId });
	}

	/** Receive `plugin.event` frames for a plugin topic (through onFrame) until the returned function is called. */
	watch(plugin: string, topic: string): () => void {
		const key = `${plugin}\0${topic}`;
		const n = this.watches.get(key) ?? 0;
		this.watches.set(key, n + 1);
		if (n === 0 && this.state === "open") this.send({ type: "plugin.watch", plugin, topic });
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const left = (this.watches.get(key) ?? 1) - 1;
			if (left > 0) return void this.watches.set(key, left);
			this.watches.delete(key);
			if (this.state === "open") this.send({ type: "plugin.unwatch", plugin, topic });
		};
	}

	onFrame(listener: (frame: ServerFrame) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	onState(listener: (state: ConnState) => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	private handle(frame: ServerFrame): void {
		switch (frame.type) {
			case "pong":
				return;
			case "hello":
				this.local = frame.local === true;
				this.loginKind = !frame.authRequired ? "none" : (frame.login ?? "token");
				if (!frame.authRequired) return this.opened();
				if (!this.target.token) {
					// Nothing to present: the sign-in screen asks for it and connects again.
					this.stopped = true;
					this.setState("unauthorized");
					this.ws?.close();
					return;
				}
				this.send({ type: "auth", token: this.target.token });
				return;
			case "auth_ok":
				if (frame.token) this.onSession?.(frame.token);
				return this.opened();
			case "response": {
				const p = this.pending.get(frame.id);
				if (!p) return;
				this.pending.delete(frame.id);
				if (frame.ok) p.resolve(frame.data);
				else p.reject(new Error(frame.error));
				return;
			}
			default:
				for (const l of this.frameListeners) l(frame);
		}
	}

	private opened(): void {
		this.retry = 0;
		for (const sessionId of this.subscriptions) this.send({ type: "subscribe", sessionId });
		for (const key of this.watches.keys()) {
			const [plugin = "", topic = ""] = key.split("\0");
			this.send({ type: "plugin.watch", plugin, topic });
		}
		this.setState("open");
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) {
			clearTimeout(w.timer);
			w.resolve();
		}
	}

	/**
	 * Resolves once the socket is open. A request made while the link is down used to queue silently and then fire all at once on
	 * reconnect (the user saw nothing, clicked again, and got every error together); now it fails right away, and a connection that
	 * is still being set up gets a bounded wait.
	 */
	private ready(): Promise<void> {
		if (this.state === "open") return Promise.resolve();
		if (this.state !== "connecting" && this.state !== "idle") return Promise.reject(new OfflineError(tr(M, "offline")));
		return new Promise((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				timer: setTimeout(() => {
					this.waiters = this.waiters.filter((w) => w !== waiter);
					reject(new OfflineError(tr(M, "offline")));
				}, READY_TIMEOUT_MS),
			};
			this.waiters.push(waiter);
		});
	}

	/** Reconnect now instead of waiting out the backoff (the banner's retry button). */
	retryNow(): void {
		if (this.state === "open" || this.state === "unauthorized") return;
		this.retry = 0;
		this.connect();
	}

	private send(frame: ClientFrame): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
	}

	private failPending(message: string): void {
		for (const p of this.pending.values()) p.reject(new OfflineError(message));
		this.pending.clear();
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) {
			clearTimeout(w.timer);
			w.reject(new OfflineError(tr(M, "offline")));
		}
	}

	private setState(state: ConnState): void {
		this.state = state;
		for (const l of this.stateListeners) l(state);
	}
}
