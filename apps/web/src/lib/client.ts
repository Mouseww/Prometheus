import type { ClientFrame, RpcMethod, RpcParams, RpcResult, ServerFrame } from "@prometheus/protocol";

export interface BackendTarget {
	wsUrl: string;
	httpBase: string;
	token?: string;
	label: string;
}

export type ConnState = "idle" | "connecting" | "open" | "unauthorized" | "closed";

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/** WebSocket client with first-frame auth, request correlation and exponential-backoff reconnect. */
export class PrometheusClient {
	readonly target: BackendTarget;
	state: ConnState = "idle";
	private ws: WebSocket | undefined;
	private seq = 0;
	private retry = 0;
	private stopped = false;
	private waiters: (() => void)[] = [];
	private readonly pending = new Map<string, Pending>();
	private readonly subscriptions = new Set<string>();
	private readonly frameListeners = new Set<(frame: ServerFrame) => void>();
	private readonly stateListeners = new Set<(state: ConnState) => void>();

	constructor(target: BackendTarget) {
		this.target = target;
	}

	connect(): void {
		this.stopped = false;
		this.setState("connecting");
		const ws = new WebSocket(this.target.wsUrl);
		this.ws = ws;
		ws.onmessage = (ev) => {
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
			this.failPending("连接已断开");
			if (ev.code === 4001 || ev.code === 4003) {
				this.stopped = true;
				this.setState("unauthorized");
				return;
			}
			this.setState("closed");
			if (this.stopped) return;
			const delay = Math.min(500 * 2 ** this.retry++, 15_000);
			setTimeout(() => !this.stopped && this.connect(), delay);
		};
	}

	close(): void {
		this.stopped = true;
		this.ws?.close();
		this.failPending("连接已关闭");
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
			case "hello":
				if (!frame.authRequired) return this.opened();
				if (!this.target.token) {
					this.stopped = true;
					this.setState("unauthorized");
					this.ws?.close();
					return;
				}
				this.send({ type: "auth", token: this.target.token });
				return;
			case "auth_ok":
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
		this.setState("open");
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) w();
	}

	private ready(): Promise<void> {
		if (this.state === "open") return Promise.resolve();
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	private send(frame: ClientFrame): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
	}

	private failPending(message: string): void {
		for (const p of this.pending.values()) p.reject(new Error(message));
		this.pending.clear();
	}

	private setState(state: ConnState): void {
		this.state = state;
		for (const l of this.stateListeners) l(state);
	}
}
