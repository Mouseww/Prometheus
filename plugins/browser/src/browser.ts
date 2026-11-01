// The one browser the app shares between the user (through the streamed view) and the agent (through tools).
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { CdpConnection, CdpEvent } from "./cdp.ts";
import { CdpSession } from "./cdp.ts";
import { GUEST_RUNTIME, guestInfo } from "./guest.ts";
import { closeBrowser, type FoundBrowser, type Launched, launchBrowser, locateBrowser } from "./chrome.ts";
import { cftExecutable, cftPlatform, type InstallProgress, installChrome } from "./install.ts";
import { MOD } from "./keys.ts";
import type { BrowserSettings } from "./settings.ts";
import { Tab, type TabHost } from "./tab.ts";
import type { AgentState, BrowserMode, BrowserState, DownloadInfo, InputEvent, ViewMessage, Viewport } from "./types.ts";

export class UserFacingError extends Error {}

export interface BrowserDeps {
	dataDir: string;
	settings: () => BrowserSettings;
	publish: (msg: ViewMessage, binary?: Uint8Array, droppable?: boolean) => void;
	watchers: () => number;
	log: (m: string) => void;
}

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800, dpr: 1 };
const MAX_FRAME_PIXELS = 2560 * 1600;
const MAX_TABS = 30;
const BLOCKED_SCHEMES = /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|brave|javascript|vbscript):/i;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The phone's local server (Termux Node, process.platform "android") has no Chromium it can start: the Chrome app is
 * an APK, and Chrome for Testing has no Linux ARM build. Use the browser from a computer's Prometheus instead.
 */
export const UNSUPPORTED_HERE = process.platform === ("android" as NodeJS.Platform) && !guestInfo() ?  "此安装包缺少运行浏览器所需的组件，手机本机模式暂时无法使用内置浏览器。请更新应用，或连接电脑上的 Prometheus 使用。" : undefined;

/** What the address bar turns into a URL: a URL, a host name, or a search. */
export function toUrl(input: string, searchUrl: string): string {
	const s = input.trim();
	if (!s) return "about:blank";
	if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z0-9.-]+:\d+/i.test(s)) {
		if (/^(https?|file|about|data|view-source|ftp):/i.test(s)) return s;
	}
	if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#].*)?$/i.test(s)) return `http://${s}`;
	if (!/\s/.test(s) && /^[^/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(s)) return `https://${s}`;
	return searchUrl.includes("%s") ? searchUrl.replace("%s", encodeURIComponent(s)) : `${searchUrl}${encodeURIComponent(s)}`;
}

export function checkUrl(url: string): void {
	if (BLOCKED_SCHEMES.test(url.trim())) throw new UserFacingError(`不允许打开这个地址：${url.slice(0, 80)}`);
}

export class BrowserCore implements TabHost {
	status: BrowserState["status"] = "stopped";
	error: string | undefined;
	mode: BrowserMode = "headless";
	found: FoundBrowser | undefined;
	product = "";
	takeover = false;
	agent: AgentState = { busy: false };
	install: InstallProgress | undefined;
	lastUse = Date.now();

	private launched: Launched | undefined;
	private starting: Promise<void> | undefined;
	private tabs = new Map<string, Tab>();
	private bySession = new Map<string, Tab>();
	private order: string[] = [];
	private activeId: string | null = null;
	private tabSeq = 0;
	private view_: Viewport = DEFAULT_VIEWPORT;
	private rawUa: string | undefined;
	private ua: string | undefined;
	private downloads: DownloadInfo[] = [];
	private changeTimer: NodeJS.Timeout | undefined;
	private idleTimer: NodeJS.Timeout;
	private installing: AbortController | undefined;
	private stopping = false;
	private agentQueue: Promise<unknown> = Promise.resolve();
	private agentAbort: AbortController | undefined;
	/** Tabs the next launch opens (restored session or a mode switch). */
	private pendingUrls: { urls: string[]; active: number } | undefined;
	private readonly deps: BrowserDeps;

	constructor(deps: BrowserDeps) {
		this.deps = deps;
		this.idleTimer = setInterval(() => void this.reapIdle(), 60_000);
		this.idleTimer.unref();
	}

	// ---------- TabHost ----------

	get headless(): boolean {
		return this.mode === "headless";
	}
	userAgent(): string | undefined {
		return this.ua;
	}
	acceptLanguage(): string {
		return this.deps.settings().lang;
	}
	/** What pages are laid out at: the viewer's size, as a phone when the viewer is one and the setting allows it. */
	viewport(): Viewport {
		const mobile = !!this.view_.mobile && this.deps.settings().mobile && this.headless;
		return { ...this.view_, mobile };
	}
	rawUserAgent(): string | undefined {
		return this.rawUa;
	}
	changed(): void {
		if (this.changeTimer) return;
		this.changeTimer = setTimeout(() => {
			this.changeTimer = undefined;
			this.deps.publish({ k: "state", state: this.state() });
		}, 40);
	}
	view(msg: ViewMessage, binary?: Uint8Array, droppable?: boolean): void {
		// Only the tab on screen streams; other tabs' bridge messages (cursor, copy) are dropped too.
		if ("tab" in msg && msg.tab !== this.activeId) return;
		this.deps.publish(msg, binary, droppable);
	}
	screencastParams() {
		const s = this.deps.settings();
		const v = this.view_;
		let w = Math.round(v.width * v.dpr);
		let h = Math.round(v.height * v.dpr);
		if (w * h > MAX_FRAME_PIXELS) {
			const f = Math.sqrt(MAX_FRAME_PIXELS / (w * h));
			w = Math.round(w * f);
			h = Math.round(h * f);
		}
		return { quality: s.quality, maxWidth: w, maxHeight: h, minIntervalMs: Math.round(1000 / s.maxFps) };
	}

	// ---------- state ----------

	private bundledPath(): string | undefined {
		const p = cftPlatform();
		return p ? cftExecutable(join(this.deps.dataDir, "chrome"), p) : undefined;
	}

	locate(): FoundBrowser | undefined {
		const guest = guestInfo();
		if (guest) return guest.installed ? { path: guest.exe, kind: "bundled" } : undefined;
		return locateBrowser(this.deps.settings().executablePath, this.bundledPath());
	}

	state(): BrowserState {
		const found = guestInfo() ? this.locate() : (this.found ?? this.locate());
		// Every running browser shows one of its (ready) tabs.
		if (!this.activeId && this.status === "running") {
			const ready = this.order.find((id) => this.tabs.get(id)?.ready);
			if (ready) queueMicrotask(() => this.activate(ready));
		}
		return {
			status: this.status,
			...(this.error ? { error: this.error } : {}),
			mode: this.mode,
			...(found ? { browser: { kind: found.kind, path: found.path, product: this.product } } : {}),
			missing: !found,
			canInstall: !guestInfo() && !!cftPlatform(),
			...(guestInfo() ? { guest: true, nativeInstall: { runtime: GUEST_RUNTIME } } : {}),
			...(UNSUPPORTED_HERE ? { unsupported: UNSUPPORTED_HERE } : {}),
			...(this.install ? { install: this.install } : {}),
			tabs: this.order.map((id) => this.tabs.get(id)?.info()).filter((t) => !!t),
			active: this.activeId,
			agent: this.agent,
			takeover: this.takeover,
			downloads: this.downloads,
			viewport: this.viewport(),
			platform: process.platform,
		};
	}

	get running(): boolean {
		return this.status === "running" && !!this.launched && !this.launched.conn.closed;
	}

	private get conn(): CdpConnection {
		if (!this.launched || this.launched.conn.closed) throw new UserFacingError("浏览器未运行");
		return this.launched.conn;
	}

	// ---------- lifecycle ----------

	/** Starts the browser if needed. */
	ensure(): Promise<void> {
		this.lastUse = Date.now();
		if (this.running) return Promise.resolve();
		this.starting ??= this.start().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async start(): Promise<void> {
		const s = this.deps.settings();
		if (UNSUPPORTED_HERE && !s.executablePath) throw new UserFacingError(UNSUPPORTED_HERE);
		const guest = guestInfo();
		// The phone's browser has no window to show.
		this.mode = guest ? "headless" : s.mode;
		const found = this.locate();
		this.found = found;
		if (!found) {
			this.status = "error";
			this.error = guest ? "手机上还没有安装浏览器组件" : s.executablePath ? `找不到浏览器：${s.executablePath}` : "这台机器上没有找到 Chrome、Edge 或 Chromium";
			this.changed();
			throw new UserFacingError(guest ? `${this.error}。请在内置浏览器面板里点「安装」（也可以在 设置 > 运行环境 里安装 Chromium）。` : `${this.error}。可在浏览器面板中下载，或在设置里指定路径。`);
		}
		this.status = "starting";
		this.error = undefined;
		this.changed();
		try {
			const launched = await launchBrowser(
				{
					executable: found.path,
					profileDir: join(this.deps.dataDir, "profile"),
					headless: this.mode === "headless",
					...(guest ? { guest: { runner: guest.runner, cwd: this.deps.dataDir } } : process.env.PM_BROWSER_WS ? { transport: "ws" as const } : {}),
					proxy: s.proxy,
					lang: s.lang,
					window: { width: this.view_.width, height: this.view_.height + 90 },
					onExit: (code, stderr) => this.onExit(launched, code, stderr),
				},
				this.deps.dataDir,
			);
			this.launched = launched;
			this.product = launched.product;
			// Headless Chromium says so in its user agent; sites treat that as a bot. Only that word changes.
			this.rawUa = launched.userAgent.replace("HeadlessChrome", "Chrome");
			this.ua = launched.userAgent.includes("HeadlessChrome") ? launched.userAgent.replace("HeadlessChrome", "Chrome") : undefined;
			launched.conn.on((e) => this.onEvent(e));
			await mkdir(this.downloadDir(), { recursive: true });
			await launched.conn.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.downloadDir(), eventsEnabled: true }).catch(() => {});
			await launched.conn.send("Target.setDiscoverTargets", { discover: true });
			await launched.conn.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
			this.status = "running";
			this.changed();
			await this.waitFirstTab();
			await this.restoreTabs();
			this.updateScreencast();
		} catch (err) {
			this.status = "error";
			this.error = err instanceof Error ? err.message : String(err);
			this.changed();
			throw new UserFacingError(`浏览器启动失败：${this.error}`);
		}
	}

	private async waitFirstTab(): Promise<void> {
		// The start page attaches by itself; it counts once it is set up and on screen.
		for (let i = 0; i < 50 && !this.activeId; i++) await new Promise((r) => setTimeout(r, 100));
		if (!this.activeId) await this.newTab("about:blank");
	}

	private async restoreTabs(): Promise<void> {
		let pending = this.pendingUrls;
		this.pendingUrls = undefined;
		if (!pending && this.deps.settings().restoreTabs) {
			const saved = await readFile(join(this.deps.dataDir, "tabs.json"), "utf8").then((t) => JSON.parse(t) as { urls: string[]; active: number }, () => undefined);
			if (saved && Array.isArray(saved.urls)) pending = saved;
		}
		const urls = (pending?.urls ?? []).filter((u) => typeof u === "string" && u && u !== "about:blank").slice(0, MAX_TABS);
		if (!urls.length) return;
		const first = this.order[0] ? this.tabs.get(this.order[0]) : undefined;
		const opened: string[] = [];
		for (const [i, url] of urls.entries()) {
			if (i === 0 && first && first.url === "about:blank") {
				void first.send("Page.navigate", { url }).catch(() => {});
				opened.push(first.id);
			} else {
				const t = await this.newTab(url, false).catch(() => undefined);
				if (t) opened.push(t.id);
			}
		}
		const active = opened[clamp(pending?.active ?? 0, 0, opened.length - 1)];
		if (active) this.activate(active);
	}

	private async saveTabs(): Promise<void> {
		const urls = this.order.map((id) => this.tabs.get(id)?.url ?? "").filter((u) => u && u !== "about:blank");
		const active = Math.max(0, this.order.filter((id) => (this.tabs.get(id)?.url ?? "about:blank") !== "about:blank").indexOf(this.activeId ?? ""));
		await writeFile(join(this.deps.dataDir, "tabs.json"), JSON.stringify({ urls, active })).catch(() => {});
	}

	private onExit(l: Launched, code: number | null, stderr: string): void {
		if (this.launched !== l) return;
		this.launched = undefined;
		this.clearTabs();
		if (this.stopping) {
			this.status = "stopped";
		} else {
			this.status = "error";
			this.error = `浏览器意外退出（代码 ${code}）${stderr ? `：${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}` : ""}`;
			this.deps.log(this.error);
		}
		this.changed();
	}

	private clearTabs(): void {
		for (const t of this.tabs.values()) t.dispose();
		this.tabs.clear();
		this.bySession.clear();
		this.order = [];
		this.activeId = null;
	}

	async stop(): Promise<void> {
		const l = this.launched;
		if (!l) {
			this.status = "stopped";
			this.error = undefined;
			this.changed();
			return;
		}
		await this.saveTabs();
		this.stopping = true;
		try {
			await closeBrowser(l);
		} finally {
			this.stopping = false;
			this.launched = undefined;
			this.clearTabs();
			this.status = "stopped";
			this.changed();
		}
	}

	/** Headless (streamed) or a real window on the server's desktop. Relaunches with the same profile and tabs. */
	async setMode(mode: BrowserMode, force = false): Promise<void> {
		if (mode === this.mode && this.running && !force) return;
		const urls = this.order.map((id) => this.tabs.get(id)?.url ?? "about:blank");
		const active = Math.max(0, this.order.indexOf(this.activeId ?? ""));
		const wasRunning = this.running;
		await this.stop();
		this.mode = mode;
		if (wasRunning) {
			this.pendingUrls = { urls, active };
			await this.ensure();
		}
	}

	async wipeProfile(): Promise<void> {
		const wasRunning = this.running;
		await this.stop();
		await rm(join(this.deps.dataDir, "profile"), { recursive: true, force: true, maxRetries: 3 });
		await rm(join(this.deps.dataDir, "tabs.json"), { force: true });
		if (wasRunning) await this.ensure();
	}

	private async reapIdle(): Promise<void> {
		const minutes = this.deps.settings().idleMinutes;
		if (!minutes || !this.running || this.agent.busy || this.deps.watchers() > 0) return;
		if (Date.now() - this.lastUse < minutes * 60_000) return;
		this.deps.log("空闲超时，关闭浏览器");
		await this.stop().catch(() => {});
	}

	async dispose(): Promise<void> {
		clearInterval(this.idleTimer);
		clearTimeout(this.changeTimer);
		this.installing?.abort();
		this.agentAbort?.abort();
		await this.stop().catch(() => {});
	}

	// ---------- install ----------

	async installBrowser(): Promise<void> {
		if (this.installing) return;
		const ctl = new AbortController();
		this.installing = ctl;
		try {
			await installChrome(
				join(this.deps.dataDir, "chrome"),
				(p) => {
					this.install = p;
					this.changed();
				},
				ctl.signal,
			);
			this.found = undefined;
			if (this.status === "error") {
				this.status = "stopped";
				this.error = undefined;
			}
		} catch (err) {
			this.install = { stage: "error", done: 0, total: 0, message: err instanceof Error ? err.message : String(err) };
			throw err;
		} finally {
			this.installing = undefined;
			this.changed();
		}
	}

	cancelInstall(): void {
		this.installing?.abort();
	}

	// ---------- targets ----------

	private onEvent(e: CdpEvent): void {
		if (e.sessionId) {
			this.bySession.get(e.sessionId)?.handle(e);
			return;
		}
		const p = e.params;
		switch (e.method) {
			case "Target.attachedToTarget":
				void this.onAttached(p.sessionId, p.targetInfo);
				return;
			case "Target.detachedFromTarget": {
				const t = this.bySession.get(p.sessionId);
				if (t) this.removeTab(t);
				return;
			}
			case "Target.targetDestroyed": {
				const t = [...this.tabs.values()].find((x) => x.targetId === p.targetId);
				if (t) this.removeTab(t);
				return;
			}
			case "Target.targetInfoChanged": {
				const info = p.targetInfo;
				const t = [...this.tabs.values()].find((x) => x.targetId === info.targetId);
				if (t) {
					if (info.url) t.url = info.url;
					// Before a page sets a title Chromium reports its URL (without the scheme) as the title; that is not one.
					const bare = t.url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");
					if (info.title && info.title !== info.url && info.title !== bare) t.title = info.title;
					else void t.refreshTitle();
					this.changed();
				}
				return;
			}
			case "Browser.downloadWillBegin":
				this.downloads.unshift({ id: p.guid, url: p.url, name: p.suggestedFilename || "download", path: "", state: "inProgress", received: 0, total: 0, startedAt: Date.now() });
				this.downloads = this.downloads.slice(0, 50);
				this.changed();
				return;
			case "Browser.downloadProgress": {
				const d = this.downloads.find((x) => x.id === p.guid);
				if (!d) return;
				d.received = p.receivedBytes ?? d.received;
				d.total = p.totalBytes ?? d.total;
				if (p.state === "completed" || p.state === "canceled") {
					d.state = p.state;
					if (p.state === "completed") void this.finishDownload(d);
				}
				this.changed();
				return;
			}
		}
	}

	private async onAttached(sessionId: string, info: { targetId: string; type: string; url: string; title: string; openerId?: string }): Promise<void> {
		const conn = this.conn;
		if (info.type !== "page") {
			// Service workers and the like: let them run, we do not drive them.
			await conn.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
			await conn.send("Target.detachFromTarget", { sessionId }).catch(() => {});
			return;
		}
		const tab = new Tab(this, new CdpSession(conn, sessionId), info.targetId, `t${++this.tabSeq}`);
		tab.url = info.url || "about:blank";
		tab.title = "";
		this.tabs.set(tab.id, tab);
		this.bySession.set(sessionId, tab);
		const openerIdx = info.openerId ? this.order.findIndex((id) => this.tabs.get(id)?.targetId === info.openerId) : -1;
		if (openerIdx >= 0) {
			this.order.splice(openerIdx + 1, 0, tab.id);
			tab.agent = this.tabs.get(this.order[openerIdx] ?? "")?.agent ?? false;
		} else this.order.push(tab.id);
		await tab.init().catch((err) => this.deps.log(`标签初始化失败：${err instanceof Error ? err.message : err}`));
		tab.ready = true;
		// A page opening another (target=_blank, window.open) brings it to the front, like a browser does.
		if (!this.activeId || openerIdx >= 0 || this.pendingActivate === info.targetId) this.activate(tab.id);
		this.changed();
	}

	private pendingActivate: string | undefined;

	private removeTab(t: Tab): void {
		t.dispose();
		this.tabs.delete(t.id);
		this.bySession.delete(t.session.id);
		const idx = this.order.indexOf(t.id);
		this.order = this.order.filter((id) => id !== t.id);
		if (this.activeId === t.id) {
			this.activeId = null;
			const next = this.order[Math.min(idx, this.order.length - 1)];
			if (next) this.activate(next);
		}
		this.changed();
	}

	tab(id?: string): Tab {
		const t = id ? this.tabs.get(id) : this.activeId ? this.tabs.get(this.activeId) : undefined;
		if (!t) throw new UserFacingError(id ? `没有标签 ${id}` : "没有打开的标签");
		return t;
	}

	hasTab(id: string): boolean {
		return this.tabs.has(id);
	}

	allTabs(): Tab[] {
		return this.order.map((id) => this.tabs.get(id)).filter((t): t is Tab => !!t);
	}

	get activeTab(): Tab | undefined {
		return this.activeId ? this.tabs.get(this.activeId) : undefined;
	}

	async newTab(url = "about:blank", activate = true, byAgent = false): Promise<Tab> {
		checkUrl(url);
		await this.ensure();
		if (this.tabs.size >= MAX_TABS) throw new UserFacingError(`最多同时打开 ${MAX_TABS} 个标签`);
		const { targetId } = await this.conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", ...(this.headless ? {} : { newWindow: false }) });
		if (activate) this.pendingActivate = targetId;
		const found = await this.waitTab(targetId);
		this.pendingActivate = undefined;
		found.agent = byAgent;
		if (activate) this.activate(found.id);
		if (url !== "about:blank") await found.send("Page.navigate", { url }).catch(() => {});
		return found;
	}

	private async waitTab(targetId: string): Promise<Tab> {
		for (let i = 0; i < 100; i++) {
			const t = [...this.tabs.values()].find((x) => x.targetId === targetId);
			if (t) return t;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new UserFacingError("新标签没有打开");
	}

	async closeTab(id: string): Promise<void> {
		const t = this.tab(id);
		if (this.tabs.size === 1) {
			// Like a browser that keeps its window: the last tab becomes a blank one.
			await this.newTab("about:blank", true);
		}
		await this.conn.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
		this.removeTab(t);
	}

	activate(id: string): void {
		const t = this.tabs.get(id);
		if (!t || this.activeId === id) return;
		const prev = this.activeTab;
		this.activeId = id;
		void prev?.stopScreencast();
		if (!this.headless) void this.conn.send("Target.activateTarget", { targetId: t.targetId }).catch(() => {});
		void t.send("Page.bringToFront").catch(() => {});
		this.updateScreencast();
		this.changed();
	}

	/** Streams the active tab while someone watches. */
	updateScreencast(): void {
		if (!this.running) return;
		const want = this.deps.watchers() > 0;
		for (const t of this.tabs.values()) {
			const on = t.id === this.activeId && want;
			if (on) void t.startScreencast();
			else if (t.isScreencasting) void t.stopScreencast();
			void t.setBridge(on);
		}
	}

	/** A viewer joined: send what it needs to draw at once. */
	greet(): void {
		this.deps.publish({ k: "state", state: this.state() });
		this.activeTab?.republish();
	}

	async setViewport(v: Viewport): Promise<void> {
		const next = { width: Math.round(clamp(v.width, 200, 3840)), height: Math.round(clamp(v.height, 150, 2400)), dpr: clamp(Math.round(v.dpr * 100) / 100, 1, 3), mobile: !!v.mobile };
		if (next.width === this.view_.width && next.height === this.view_.height && next.dpr === this.view_.dpr && !next.mobile === !this.view_.mobile) return;
		this.view_ = next;
		if (this.running && this.headless) await Promise.all(this.allTabs().map((t) => t.applyViewport()));
		this.changed();
	}

	/** The phone setting changed: lay the open pages out again. */
	async reapplyViewport(): Promise<void> {
		if (this.running && this.headless) await Promise.all(this.allTabs().map((t) => t.applyViewport()));
		this.changed();
	}

	// ---------- navigation ----------

	async navigate(tab: Tab, input: string): Promise<string> {
		const url = toUrl(input, this.deps.settings().searchUrl);
		checkUrl(url);
		this.lastUse = Date.now();
		const r = await tab.send<{ errorText?: string }>("Page.navigate", { url }, 30_000);
		if (r.errorText && r.errorText !== "net::ERR_ABORTED") throw new UserFacingError(`打开 ${url} 失败：${r.errorText}`);
		return url;
	}

	async history(tab: Tab, action: "back" | "forward" | "reload" | "stop"): Promise<void> {
		this.lastUse = Date.now();
		if (action === "reload") return void (await tab.send("Page.reload", {}));
		if (action === "stop") return void (await tab.send("Page.stopLoading"));
		const h = await tab.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
		const entry = h.entries[h.currentIndex + (action === "back" ? -1 : 1)];
		if (!entry) throw new UserFacingError(action === "back" ? "没有可以后退的页面" : "没有可以前进的页面");
		await tab.send("Page.navigateToHistoryEntry", { entryId: entry.id });
	}

	// ---------- user input ----------

	/** Input from the user's view. Ignored while the agent drives, unless the user took over. */
	async input(tab: Tab, events: InputEvent[]): Promise<void> {
		if (this.agent.busy && !this.takeover) return;
		this.lastUse = Date.now();
		const darwin = process.platform === "darwin";
		const calls: Promise<unknown>[] = [];
		for (const e of events.slice(0, 200)) {
			switch (e.k) {
				case "mouse":
					calls.push(
						tab.send("Input.dispatchMouseEvent", {
							type: e.type,
							x: num(e.x),
							y: num(e.y),
							button: e.button ?? "none",
							buttons: e.buttons ?? 0,
							clickCount: e.clickCount ?? 0,
							modifiers: e.modifiers ?? 0,
						}),
					);
					break;
				case "wheel":
					calls.push(tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: num(e.x), y: num(e.y), deltaX: num(e.dx), deltaY: num(e.dy), modifiers: e.modifiers ?? 0 }));
					break;
				case "touch":
					calls.push(tab.send("Input.dispatchTouchEvent", { type: e.type, touchPoints: e.points.slice(0, 10).map((p) => ({ x: num(p.x), y: num(p.y), id: p.id })), modifiers: e.modifiers ?? 0 }));
					break;
				case "key": {
					let modifiers = e.modifiers ?? 0;
					// A Mac viewer presses Cmd for shortcuts; a browser on Windows or Linux expects Ctrl.
					if (!darwin && modifiers & MOD.meta && !(modifiers & MOD.ctrl) && /^Key[A-Z]$/.test(e.code)) modifiers = (modifiers & ~MOD.meta) | MOD.ctrl;
					const shortcut = darwin && modifiers & MOD.meta ? editingFor(e.code, modifiers) : undefined;
					calls.push(
						tab.send("Input.dispatchKeyEvent", {
							type: e.type,
							key: String(e.key).slice(0, 32),
							code: String(e.code).slice(0, 32),
							windowsVirtualKeyCode: e.keyCode,
							nativeVirtualKeyCode: e.keyCode,
							modifiers,
							location: e.location ?? 0,
							autoRepeat: e.repeat === true,
							...(e.text ? { text: e.text.slice(0, 8), unmodifiedText: e.text.slice(0, 8) } : {}),
							...(shortcut && e.type !== "keyUp" ? { commands: shortcut } : {}),
						}),
					);
					break;
				}
				case "text":
					if (e.text) calls.push(tab.send("Input.insertText", { text: e.text.slice(0, 100_000) }));
					break;
				case "ime":
					calls.push(tab.send("Input.imeSetComposition", { text: e.text.slice(0, 1000), selectionStart: e.start, selectionEnd: e.end }));
					break;
			}
		}
		await tab.untilDialog(Promise.all(calls));
	}

	async respondDialog(tab: Tab, accept: boolean, text?: string): Promise<void> {
		if (!tab.dialog) return;
		await tab.send("Page.handleJavaScriptDialog", { accept, ...(text !== undefined ? { promptText: text } : {}) });
		tab.dialog = undefined;
		this.changed();
	}

	/** The user picked an option in the select popup drawn by the app. */
	async chooseOption(tab: Tab, index: number): Promise<void> {
		await tab.send("Runtime.evaluate", {
			expression: `(() => { let d = document, a = d.activeElement; while (a && a.tagName === "IFRAME") { try { d = a.contentDocument; a = d.activeElement; } catch { break; } }
				if (!a || a.tagName !== "SELECT") return false; const o = a.querySelectorAll("option")[${Math.trunc(index)}]; if (!o || o.disabled) return false;
				if (!o.selected) { o.selected = true; a.dispatchEvent(new Event("input", { bubbles: true })); a.dispatchEvent(new Event("change", { bubbles: true })); } return true; })()`,
			userGesture: true,
		});
	}

	async chooseFiles(tab: Tab, files: string[]): Promise<void> {
		const fc = tab.fileChooser;
		if (!fc) throw new UserFacingError("页面没有在等待选择文件");
		const list = fc.multiple ? files : files.slice(0, 1);
		for (const f of list) if (!existsSync(f)) throw new UserFacingError(`文件不存在：${f}`);
		await tab.send("DOM.setFileInputFiles", { files: list, backendNodeId: fc.backendNodeId });
		tab.fileChooser = undefined;
		this.changed();
	}

	cancelFiles(tab: Tab): void {
		tab.fileChooser = undefined;
		this.changed();
	}

	// ---------- downloads ----------

	downloadDir(): string {
		// Under the phone's rootfs only the data folder is shared with the browser.
		if (guestInfo()) return join(this.deps.dataDir, "downloads");
		return this.deps.settings().downloadDir || join(this.deps.dataDir, "downloads");
	}

	private async finishDownload(d: DownloadInfo): Promise<void> {
		const dir = this.downloadDir();
		const ext = extname(d.name);
		const stem = basename(d.name, ext).replace(/[\\/:*?"<>|]/g, "_") || "download";
		let target = join(dir, `${stem}${ext}`);
		for (let i = 1; existsSync(target) && i < 1000; i++) target = join(dir, `${stem} (${i})${ext}`);
		try {
			await rename(join(dir, d.id), target);
			d.path = target;
			d.name = basename(target);
		} catch {
			d.path = join(dir, d.id);
		}
		this.changed();
	}

	download(id: string): DownloadInfo {
		const d = this.downloads.find((x) => x.id === id);
		if (!d) throw new UserFacingError("下载记录不存在");
		return d;
	}

	async cancelDownload(id: string): Promise<void> {
		await this.conn.send("Browser.cancelDownload", { guid: id }).catch(() => {});
	}

	forgetDownload(id: string): void {
		this.downloads = this.downloads.filter((d) => d.id !== id);
		this.changed();
	}

	// ---------- agent arbitration ----------

	/**
	 * Runs one agent operation at a time. The tab it works on comes to the front so the user sees it, and the user's
	 * own input is held back until it finishes. A takeover aborts it and refuses further calls.
	 */
	async asAgent<T>(sessionId: string | undefined, action: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		const run = async (): Promise<T> => {
			if (this.takeover) throw new UserFacingError("用户已接管浏览器。等用户在浏览器面板里点「交还给 Agent」后再继续；如有需要，先问问用户做了什么。");
			await this.ensure();
			const ctl = new AbortController();
			const onAbort = () => ctl.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			this.agentAbort = ctl;
			this.agent = { busy: true, sessionId, tab: this.activeId ?? undefined, action };
			this.changed();
			try {
				return await fn(ctl.signal);
			} finally {
				signal?.removeEventListener("abort", onAbort);
				this.agentAbort = undefined;
				this.agent = { busy: false, sessionId, tab: this.activeId ?? undefined };
				this.lastUse = Date.now();
				this.changed();
			}
		};
		const next = this.agentQueue.then(run, run);
		this.agentQueue = next.catch(() => {});
		return next;
	}

	setAgentTab(tab: Tab, action: string): void {
		if (this.activeId !== tab.id) this.activate(tab.id);
		this.agent = { ...this.agent, tab: tab.id, action };
		this.changed();
	}

	takeOver(): void {
		this.takeover = true;
		this.agentAbort?.abort();
		this.changed();
	}

	handBack(): void {
		this.takeover = false;
		this.changed();
	}
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function editingFor(code: string, modifiers: number): string[] | undefined {
	if (code === "KeyZ") return modifiers & MOD.shift ? ["redo"] : ["undo"];
	return ({ KeyA: ["selectAll"], KeyC: ["copy"], KeyX: ["cut"], KeyV: ["paste"] } as Record<string, string[]>)[code];
}
