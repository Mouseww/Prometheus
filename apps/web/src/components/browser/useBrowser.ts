// The browser view's link to the server-side browser plugin: live state and frames over a plugin stream, commands
// over plugin RPC. Frames never pass through React state; they go straight to whoever draws them.
import type { ServerFrame } from "@prometheus/protocol";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../lib/store.ts";
import type { BrowserSettings, BrowserState, InputEvent, ViewMessage } from "./types.ts";

export const PLUGIN = "browser";
const TOPIC = "view";

/** RPC without the global error toast; the caller decides what to show. */
export function browserCall<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
	const client = useStore.getState().client;
	if (!client) return Promise.reject(new Error("offline"));
	return client.rpc("plugin.call", { plugin: PLUGIN, method, params }) as Promise<T>;
}

export type FrameSink = (jpeg: Uint8Array, width: number, height: number, tab: string) => void;
export type EventSink = (msg: Exclude<ViewMessage, { k: "state" } | { k: "frame" }>) => void;

export function useBrowser(onFrame: FrameSink, onEvent: EventSink) {
	const client = useStore((s) => s.client);
	const conn = useStore((s) => s.conn);
	const [state, setState] = useState<BrowserState | null>(null);
	const [settings, setSettings] = useState<BrowserSettings | null>(null);
	const [startError, setStartError] = useState<string | null>(null);
	const frameRef = useRef(onFrame);
	const eventRef = useRef(onEvent);
	frameRef.current = onFrame;
	eventRef.current = onEvent;

	useEffect(() => {
		if (!client || conn !== "open") return;
		const off = client.onFrame((f: ServerFrame) => {
			if (f.type !== "plugin.event" || f.plugin !== PLUGIN || f.topic !== TOPIC) return;
			const msg = f.data as ViewMessage;
			if (msg.k === "state") setState(msg.state);
			else if (msg.k === "frame") {
				if (f.binary) frameRef.current(f.binary, msg.width, msg.height, msg.tab);
			} else eventRef.current(msg);
		});
		const unwatch = client.watch(PLUGIN, TOPIC);
		let dead = false;
		void browserCall<{ state: BrowserState; settings: BrowserSettings }>("state")
			.then((r) => {
				if (dead) return;
				setState(r.state);
				setSettings(r.settings);
				if (r.state.status === "stopped" || r.state.status === "error") {
					if (!r.state.missing && !r.state.unsupported) void start();
				}
			})
			.catch((e: unknown) => !dead && setStartError(e instanceof Error ? e.message : String(e)));
		const start = () =>
			browserCall<BrowserState>("start").then(
				() => !dead && setStartError(null),
				(e: unknown) => !dead && setStartError(e instanceof Error ? e.message : String(e)),
			);
		return () => {
			dead = true;
			off();
			unwatch();
		};
	}, [client, conn]);

	// Self-heal: a running browser always has a tab on screen. If this view's copy says otherwise (it missed an
	// update), fetch the whole state again.
	const orphan = !!state && state.status === "running" && state.tabs.length > 0 && !state.tabs.some((t) => t.id === state.active);
	useEffect(() => {
		if (!orphan) return;
		const timer = setTimeout(() => void browserCall<{ state: BrowserState }>("state").then((r) => setState(r.state), () => {}), 600);
		return () => clearTimeout(timer);
	}, [orphan]);

	return { state, settings, setSettings, startError, setStartError };
}

/** Collects input events and sends them once per animation frame, in order; mouse moves are coalesced. */
export class InputQueue {
	private queue: InputEvent[] = [];
	private scheduled = false;
	tab: string | null = null;

	push(e: InputEvent): void {
		const last = this.queue[this.queue.length - 1];
		if (e.k === "mouse" && e.type === "mouseMoved" && last?.k === "mouse" && last.type === "mouseMoved") this.queue[this.queue.length - 1] = e;
		else if (e.k === "wheel" && last?.k === "wheel" && last.x === e.x && last.y === e.y) this.queue[this.queue.length - 1] = { ...last, dx: last.dx + e.dx, dy: last.dy + e.dy };
		else this.queue.push(e);
		if (!this.scheduled) {
			this.scheduled = true;
			requestAnimationFrame(() => this.flush());
		}
	}

	flush(): void {
		this.scheduled = false;
		const events = this.queue;
		this.queue = [];
		if (!events.length || !this.tab) return;
		void browserCall("input", { tab: this.tab, events }).catch(() => {});
	}
}
