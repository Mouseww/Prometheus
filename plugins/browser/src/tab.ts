// One page target: navigation state, dialogs, file choosers, the screencast and the in-page bridge.
import type { CdpEvent, CdpSession } from "./cdp.ts";
import { BINDING, PAGE_SCRIPT, WORLD } from "./page-script.ts";
import type { DialogInfo, TabInfo, ViewMessage, Viewport } from "./types.ts";

export interface TabHost {
	readonly headless: boolean;
	userAgent(): string | undefined;
	rawUserAgent(): string | undefined;
	acceptLanguage(): string;
	viewport(): Viewport;
	changed(): void;
	view(msg: ViewMessage, binary?: Uint8Array, droppable?: boolean): void;
	screencastParams(): { quality: number; maxWidth: number; maxHeight: number; minIntervalMs: number };
}

/** The real user agent as an Android phone's Chrome would send it. */
export function mobileUserAgent(ua: string | undefined): string | undefined {
	if (!ua) return undefined;
	const phone = ua.replace("HeadlessChrome", "Chrome").replace(/\([^)]*\)/, "(Linux; Android 10; K)");
	return phone.includes(" Mobile Safari") ? phone : phone.replace(" Safari/", " Mobile Safari/");
}

type Waiter = { test: () => boolean; resolve: () => void };

export class Tab {
	readonly id: string;
	readonly targetId: string;
	readonly session: CdpSession;
	url = "about:blank";
	title = "";
	loading = false;
	canGoBack = false;
	canGoForward = false;
	agent = false;
	dialog: DialogInfo | undefined;
	fileChooser: { backendNodeId: number; multiple: boolean } | undefined;
	crashed = false;
	/** Set up (scripts, viewport) and running; only then may it be shown. */
	ready = false;
	mainFrameId = "";
	/** Bumped on every main-frame navigation; refs from an older document are stale. */
	navigations = 0;
	loads = 0;
	lastFrame: { data: Buffer; width: number; height: number } | undefined;
	private screencasting = false;
	private bridge = false;
	private frameSeq = 0;
	private lastFrameAt = 0;
	private ackTimer: NodeJS.Timeout | undefined;
	private axEnabled = false;
	private waiters = new Set<Waiter>();
	private readonly host: TabHost;

	constructor(host: TabHost, session: CdpSession, targetId: string, id: string) {
		this.host = host;
		this.session = session;
		this.targetId = targetId;
		this.id = id;
	}

	info(): TabInfo {
		return {
			id: this.id,
			url: this.url,
			title: this.title,
			loading: this.loading,
			canGoBack: this.canGoBack,
			canGoForward: this.canGoForward,
			agent: this.agent,
			...(this.dialog ? { dialog: this.dialog } : {}),
			...(this.fileChooser ? { fileChooser: { multiple: this.fileChooser.multiple } } : {}),
			...(this.crashed ? { crashed: true } : {}),
		};
	}

	send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
		return this.session.send<T>(method, params, timeoutMs);
	}

	/** Prepares a freshly attached (and paused) target, then lets it run. */
	async init(): Promise<void> {
		const s = this.session;
		const ua = this.host.userAgent();
		// A paused target (auto-attached, waiting for the debugger) answers only once it runs, so everything is sent
		// first, in order, then the target is resumed, then the answers are awaited.
		const tasks: Promise<unknown>[] = [
			s.send("Page.enable"),
			s.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SCRIPT, worldName: WORLD, runImmediately: true }),
			s.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD }),
			s.send("Page.setInterceptFileChooserDialog", { enabled: true }),
			s.send("Inspector.enable").catch(() => {}),
		];
		if (this.host.headless) {
			tasks.push(s.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {}));
			tasks.push(this.applyViewport());
		}
		// Headless tabs get theirs together with the viewport (a phone has another one).
		if (ua && !this.host.headless) tasks.push(s.send("Emulation.setUserAgentOverride", { userAgent: ua, acceptLanguage: this.host.acceptLanguage() }).catch(() => {}));
		tasks.push(s.send("Runtime.runIfWaitingForDebugger").catch(() => {}));
		await Promise.all(tasks);
		const tree = await s.send<{ frameTree: { frame: { id: string; url: string } } }>("Page.getFrameTree").catch(() => undefined);
		if (tree) {
			this.mainFrameId = tree.frameTree.frame.id;
			if (tree.frameTree.frame.url) this.url = tree.frameTree.frame.url;
		}
	}

	async applyViewport(): Promise<void> {
		if (!this.host.headless) {
			await this.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
			return;
		}
		const v = this.host.viewport();
		const mobile = !!v.mobile;
		const ua = mobile ? mobileUserAgent(this.host.rawUserAgent()) : (this.host.userAgent() ?? this.host.rawUserAgent());
		// Touch first and alone: Chromium keeps the old touch-point count when it is switched off together with the size.
		await this.send("Emulation.setTouchEmulationEnabled", mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }).catch(() => {});
		await Promise.all([
			this.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile, screenWidth: v.width, screenHeight: v.height }).catch(() => {}),
			ua ? this.send("Emulation.setUserAgentOverride", { userAgent: ua, acceptLanguage: this.host.acceptLanguage() }).catch(() => {}) : undefined,
		]);
		if (this.screencasting) await this.restartScreencast();
	}

	// ---------- events ----------

	handle(e: CdpEvent): void {
		const p = e.params;
		switch (e.method) {
			case "Page.frameNavigated":
				if (!p.frame.parentId) {
					this.mainFrameId = p.frame.id;
					this.url = p.frame.url + (p.frame.urlFragment ?? "");
					this.navigations++;
					this.fileChooser = undefined;
					void this.refreshHistory();
				}
				break;
			case "Page.navigatedWithinDocument":
				if (p.frameId === this.mainFrameId) {
					this.url = p.url;
					void this.refreshHistory();
					setTimeout(() => void this.refreshTitle(), 300);
				}
				break;
			case "Page.frameStartedLoading":
				if (p.frameId === this.mainFrameId || !this.mainFrameId) this.loading = true;
				break;
			case "Page.frameStoppedLoading":
				if (p.frameId === this.mainFrameId) {
					this.loading = false;
					void this.refreshHistory();
					void this.refreshTitle();
				}
				break;
			case "Page.domContentEventFired":
				void this.refreshTitle();
				return;
			case "Page.loadEventFired":
				this.loads++;
				break;
			case "Page.javascriptDialogOpening":
				this.dialog = { type: p.type, message: String(p.message ?? ""), url: String(p.url ?? ""), ...(p.type === "prompt" ? { defaultPrompt: String(p.defaultPrompt ?? "") } : {}) };
				break;
			case "Page.javascriptDialogClosed":
				this.dialog = undefined;
				break;
			case "Page.fileChooserOpened":
				if (typeof p.backendNodeId === "number") this.fileChooser = { backendNodeId: p.backendNodeId, multiple: p.mode === "selectMultiple" };
				break;
			case "Page.screencastFrame":
				this.onFrame(p.data, p.metadata, p.sessionId);
				return;
			case "Runtime.bindingCalled":
				if (p.name === BINDING) this.onBridge(String(p.payload ?? ""));
				return;
			case "Inspector.targetCrashed":
				this.crashed = true;
				this.loading = false;
				break;
			default:
				return;
		}
		this.host.changed();
		this.checkWaiters();
	}

	/** Chromium's target info keeps the URL as the title on many pages; the document knows better. */
	async refreshTitle(): Promise<void> {
		const r = await this.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: "document.title", returnByValue: true }, 5000).catch(() => undefined);
		const title = typeof r?.result.value === "string" ? r.result.value.trim().slice(0, 500) : undefined;
		if (title !== undefined && title !== this.title) {
			this.title = title;
			this.host.changed();
		}
	}

	/**
	 * The in-page bridge (cursor, select popups, context menu, copied text) reports through Runtime.bindingCalled, which
	 * needs the Runtime domain. Pages can tell when it is on, so it is on only for the tab someone is looking at.
	 */
	async setBridge(on: boolean): Promise<void> {
		if (on === this.bridge) return;
		this.bridge = on;
		await this.send(on ? "Runtime.enable" : "Runtime.disable").catch(() => {});
		// Worlds that already exist only get the binding when it is added again with the domain on.
		if (on) await this.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD }).catch(() => {});
	}

	private async refreshHistory(): Promise<void> {
		const h = await this.send<{ currentIndex: number; entries: { id: number; url: string; title: string }[] }>("Page.getNavigationHistory").catch(() => undefined);
		if (!h) return;
		const back = h.currentIndex > 0;
		const fwd = h.currentIndex < h.entries.length - 1;
		if (back !== this.canGoBack || fwd !== this.canGoForward) {
			this.canGoBack = back;
			this.canGoForward = fwd;
			this.host.changed();
		}
	}

	private onBridge(payload: string): void {
		if (payload.length > 2_000_000) return;
		let m: Record<string, unknown>;
		try {
			m = JSON.parse(payload);
		} catch {
			return;
		}
		const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		switch (m.t) {
			case "cursor":
				if (typeof m.v === "string") this.host.view({ k: "cursor", tab: this.id, cursor: m.v.slice(0, 64) });
				return;
			case "select":
				if (!Array.isArray(m.options)) return;
				this.host.view({
					k: "select",
					tab: this.id,
					x: num(m.x),
					y: num(m.y),
					rect: (Array.isArray(m.rect) ? m.rect.slice(0, 4).map(num) : [0, 0, 0, 0]) as [number, number, number, number],
					options: (m.options as Record<string, unknown>[]).slice(0, 2000).map((o) => ({
						label: String(o.label ?? "").slice(0, 300),
						value: String(o.value ?? "").slice(0, 300),
						disabled: o.disabled === true,
						selected: o.selected === true,
						...(typeof o.group === "string" ? { group: o.group.slice(0, 200) } : {}),
					})),
				});
				return;
			case "menu":
				this.host.view({
					k: "menu",
					tab: this.id,
					x: num(m.x),
					y: num(m.y),
					editable: m.editable === true,
					...(typeof m.link === "string" ? { link: m.link.slice(0, 4000) } : {}),
					...(typeof m.image === "string" && !m.image.startsWith("data:") ? { image: m.image.slice(0, 4000) } : {}),
					...(typeof m.selection === "string" && m.selection ? { selection: m.selection } : {}),
				});
				return;
			case "copy":
				if (typeof m.text === "string") this.host.view({ k: "copy", tab: this.id, text: m.text });
				return;
		}
	}

	// ---------- waiting ----------

	/** Resolves once `test()` holds (checked on every page event) or after `timeoutMs`; true when it held. */
	waitFor(test: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		if (test()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const w: Waiter = {
				test,
				resolve: () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					this.waiters.delete(w);
					resolve(true);
				},
			};
			const onAbort = () => {
				this.waiters.delete(w);
				clearTimeout(timer);
				resolve(false);
			};
			const timer = setTimeout(onAbort, timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.waiters.add(w);
		});
	}

	private checkWaiters(): void {
		for (const w of [...this.waiters]) if (w.test()) w.resolve();
	}

	/**
	 * Input that opens a JavaScript dialog does not return until the dialog is closed; waiting for it alone would hang.
	 * Settles when the call returns or a dialog appears.
	 */
	async untilDialog<T>(p: Promise<T>): Promise<T | undefined> {
		let off = () => {};
		const opened = new Promise<undefined>((resolve) => {
			const w: Waiter = { test: () => !!this.dialog, resolve: () => resolve(undefined) };
			this.waiters.add(w);
			off = () => this.waiters.delete(w);
		});
		if (this.dialog) {
			off();
			p.catch(() => {});
			return undefined;
		}
		try {
			return await Promise.race([p, opened]);
		} finally {
			off();
			p.catch(() => {});
		}
	}

	// ---------- screencast ----------

	async startScreencast(): Promise<void> {
		if (this.screencasting) return;
		this.screencasting = true;
		const c = this.host.screencastParams();
		await this.send("Page.startScreencast", { format: "jpeg", quality: c.quality, maxWidth: c.maxWidth, maxHeight: c.maxHeight, everyNthFrame: 1 }).catch(() => {
			this.screencasting = false;
		});
		// The screencast only sends a frame when something is painted; a still page needs one to begin with.
		if (this.lastFrame) this.republish();
		else void this.captureStill();
	}

	async stopScreencast(): Promise<void> {
		if (!this.screencasting) return;
		this.screencasting = false;
		clearTimeout(this.ackTimer);
		await this.send("Page.stopScreencast").catch(() => {});
	}

	async restartScreencast(): Promise<void> {
		if (!this.screencasting) return;
		await this.stopScreencast();
		await this.startScreencast();
	}

	get isScreencasting(): boolean {
		return this.screencasting;
	}

	republish(): void {
		if (!this.lastFrame) return;
		this.host.view({ k: "frame", tab: this.id, seq: ++this.frameSeq, width: this.lastFrame.width, height: this.lastFrame.height }, this.lastFrame.data, false);
	}

	private async captureStill(): Promise<void> {
		const c = this.host.screencastParams();
		const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: c.quality }, 10_000).catch(() => undefined);
		if (!shot || this.lastFrame) return;
		const v = this.host.viewport();
		const layout = await this.send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics").catch(() => undefined);
		const width = layout?.cssVisualViewport?.clientWidth ?? v.width;
		const height = layout?.cssVisualViewport?.clientHeight ?? v.height;
		this.lastFrame = { data: Buffer.from(shot.data, "base64"), width, height };
		this.republish();
	}

	private onFrame(data: string, meta: { deviceWidth?: number; deviceHeight?: number }, ackId: number): void {
		const buf = Buffer.from(data, "base64");
		const width = meta.deviceWidth ?? this.host.viewport().width;
		const height = meta.deviceHeight ?? this.host.viewport().height;
		this.lastFrame = { data: buf, width, height };
		this.host.view({ k: "frame", tab: this.id, seq: ++this.frameSeq, width, height }, buf, true);
		// Acknowledging asks for the next frame; holding the ack back is how the frame rate is capped.
		const now = Date.now();
		const wait = Math.max(0, this.lastFrameAt + this.host.screencastParams().minIntervalMs - now);
		this.lastFrameAt = now + wait;
		clearTimeout(this.ackTimer);
		const ack = () => void this.send("Page.screencastFrameAck", { sessionId: ackId }).catch(() => {});
		if (wait === 0) ack();
		else this.ackTimer = setTimeout(ack, wait);
	}

	// ---------- accessibility ----------

	async ensureAccessibility(): Promise<void> {
		if (this.axEnabled) return;
		await this.send("Accessibility.enable").catch(() => {});
		await this.send("DOM.enable").catch(() => {});
		this.axEnabled = true;
	}

	dispose(): void {
		clearTimeout(this.ackTimer);
		for (const w of this.waiters) w.resolve();
		this.waiters.clear();
	}
}
