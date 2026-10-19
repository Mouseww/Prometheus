import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkbenchBrowserState } from "@prometheus/protocol";

export const VIEWPORT = { width: 1280, height: 800 };
const IDLE_MS = 10 * 60_000;
const NAV_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 15_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BrowserError extends Error {}

/** Chrome / Edge / Chromium installed on this machine, or the one named in PROMETHEUS_BROWSER. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
	const named = env.PROMETHEUS_BROWSER;
	if (named) return exists(named) ? named : undefined;
	const pf = env.PROGRAMFILES ?? "C:\\Program Files";
	const pf86 = env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
	const local = env.LOCALAPPDATA ?? "";
	const candidates =
		process.platform === "win32"
			? [
					join(pf, "Google/Chrome/Application/chrome.exe"),
					join(pf86, "Google/Chrome/Application/chrome.exe"),
					local && join(local, "Google/Chrome/Application/chrome.exe"),
					join(pf86, "Microsoft/Edge/Application/msedge.exe"),
					join(pf, "Microsoft/Edge/Application/msedge.exe"),
				]
			: process.platform === "darwin"
				? [
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
						"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
						"/Applications/Chromium.app/Contents/MacOS/Chromium",
					]
				: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
	return candidates.find((c): c is string => !!c && exists(c));
}

/** Only web pages: file:, chrome: and javascript: URLs would let a page or the model reach local data. */
export function normalizeUrl(input: string): string {
	const raw = input.trim();
	if (!raw) throw new BrowserError("请提供网址");
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/]+:\d+(\/|$)/.test(raw) ? raw : `https://${raw}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new BrowserError(`网址无效: ${input}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new BrowserError("只允许打开 http / https 网址");
	return url.href;
}

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Minimal Chrome DevTools Protocol client over the global WebSocket (Node 22). */
class Cdp {
	private ws: WebSocket;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
	closed = false;

	private constructor(ws: WebSocket, onClose: () => void) {
		this.ws = ws;
		ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
			if (msg.id !== undefined) {
				const p = this.pending.get(msg.id);
				if (!p) return;
				this.pending.delete(msg.id);
				clearTimeout(p.timer);
				if (msg.error) p.reject(new BrowserError(msg.error.message));
				else p.resolve(msg.result);
			} else if (msg.method) {
				for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {});
			}
		});
		ws.addEventListener("close", () => {
			this.closed = true;
			for (const p of this.pending.values()) {
				clearTimeout(p.timer);
				p.reject(new BrowserError("浏览器已关闭"));
			}
			this.pending.clear();
			onClose();
		});
	}

	static connect(url: string, onClose: () => void): Promise<Cdp> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			ws.addEventListener("open", () => resolve(new Cdp(ws, onClose)), { once: true });
			ws.addEventListener("error", () => reject(new BrowserError("无法连接浏览器调试端口")), { once: true });
		});
	}

	send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		if (this.closed) return Promise.reject(new BrowserError("浏览器已关闭"));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new BrowserError(`${method} 超时`));
			}, CALL_TIMEOUT_MS);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	once(method: string, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const set = this.listeners.get(method) ?? new Set();
			this.listeners.set(method, set);
			const done = (ok: boolean) => {
				clearTimeout(timer);
				set.delete(fn);
				resolve(ok);
			};
			const fn = () => done(true);
			const timer = setTimeout(() => done(false), timeoutMs);
			set.add(fn);
		});
	}

	close(): void {
		this.closed = true;
		try {
			this.ws.close();
		} catch {
			// already gone
		}
	}
}

// Runs inside the page. Numbers the visible interactive elements so the model can refer to them by `ref`.
export const SNAPSHOT_JS = `(() => {
  const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[onclick],[contenteditable=""],[contenteditable=true]';
  document.querySelectorAll('[data-pi-ref]').forEach((e) => e.removeAttribute('data-pi-ref'));
  const items = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none' || el.disabled) continue;
    if (r.bottom < -2000 || r.top > 6000) continue;
    n += 1;
    el.setAttribute('data-pi-ref', String(n));
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    items.push({ ref: n, tag: el.tagName.toLowerCase(), type: el.type || undefined, label, href: el.tagName === 'A' ? el.href : undefined });
    if (n >= 150) break;
  }
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000), items };
})()`;

// Links that open a new tab would leave the viewer showing the old page; keep everything in one tab.
const SAME_TAB_JS = `document.addEventListener('click', (e) => { const a = e.target && e.target.closest && e.target.closest('a[target]'); if (a) a.target = '_self'; }, true); window.open = (u) => { if (u) location.href = u; return null; };`;

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
	Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
	Tab: { key: "Tab", code: "Tab", vk: 9 },
	Escape: { key: "Escape", code: "Escape", vk: 27 },
	Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
	PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
};
export const KEY_NAMES = Object.keys(KEYS);

export interface SnapshotItem {
	ref: number;
	tag: string;
	type?: string;
	label: string;
	href?: string;
}
export interface Snapshot {
	title: string;
	url: string;
	text: string;
	items: SnapshotItem[];
}

export function formatSnapshot(s: Snapshot): string {
	const lines = s.items.map((i) => `[${i.ref}] ${i.tag}${i.type ? `:${i.type}` : ""}${i.label ? ` "${i.label}"` : ""}${i.href ? ` -> ${i.href}` : ""}`);
	return [`Title: ${s.title}`, `URL: ${s.url}`, "", "Interactive elements:", lines.join("\n") || "(none)", "", "Page text:", s.text || "(empty)"].join("\n");
}

/** One headless Chrome shared by the whole app, started on first use and closed after ten idle minutes. */
export class BrowserSession {
	private proc: ChildProcess | undefined;
	private cdp: Cdp | undefined;
	private starting: Promise<Cdp> | undefined;
	private idle: ReturnType<typeof setTimeout> | undefined;
	private last: WorkbenchBrowserState = { open: false, url: "", title: "", ...VIEWPORT };
	/** Called when the visible state changed because of an action, so viewers can refresh. */
	onChange: () => void = () => undefined;

	private readonly profileDir: string;
	private readonly log: (m: string) => void;

	constructor(profileDir: string, log: (m: string) => void = () => undefined) {
		this.profileDir = profileDir;
		this.log = log;
	}

	get isOpen(): boolean {
		return !!this.cdp && !this.cdp.closed;
	}

	private touch(): void {
		clearTimeout(this.idle);
		this.idle = setTimeout(() => void this.close(), IDLE_MS);
	}

	private ensure(): Promise<Cdp> {
		if (this.cdp && !this.cdp.closed) {
			this.touch();
			return Promise.resolve(this.cdp);
		}
		this.starting ??= this.launch().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async launch(): Promise<Cdp> {
		const exe = findBrowser();
		if (!exe) throw new BrowserError("没有找到 Chrome / Edge / Chromium。请安装其中之一，或用环境变量 PROMETHEUS_BROWSER 指定可执行文件。");
		await mkdir(this.profileDir, { recursive: true });
		const proc = spawn(
			exe,
			[
				"--remote-debugging-port=0",
				`--user-data-dir=${this.profileDir}`,
				"--headless=new",
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-extensions",
				"--disable-background-networking",
				`--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
				"about:blank",
			],
			{ stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
		);
		this.proc = proc;
		proc.on("exit", () => {
			if (this.proc === proc) this.reset();
		});
		const port = await new Promise<number>((resolve, reject) => {
			let buf = "";
			const timer = setTimeout(() => reject(new BrowserError("浏览器启动超时")), 20_000);
			proc.stderr?.on("data", (d: Buffer) => {
				buf += d.toString();
				const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(buf);
				if (m) {
					clearTimeout(timer);
					resolve(Number(m[1]));
				}
			});
			proc.once("error", (e) => {
				clearTimeout(timer);
				reject(new BrowserError(`无法启动浏览器: ${e.message}`));
			});
			proc.once("exit", () => {
				clearTimeout(timer);
				reject(new BrowserError("浏览器启动后立即退出（可能已有同一配置目录的实例在运行）"));
			});
		}).catch((e) => {
			proc.kill();
			this.proc = undefined;
			throw e;
		});
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = (await res.json()) as { type: string; webSocketDebuggerUrl?: string }[];
			const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
			if (!page?.webSocketDebuggerUrl) throw new BrowserError("浏览器没有可用页面");
			const cdp = await Cdp.connect(page.webSocketDebuggerUrl, () => {
				if (this.cdp?.closed) this.reset();
			});
			await cdp.send("Page.enable");
			await cdp.send("Runtime.enable");
			await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
			await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SAME_TAB_JS });
			this.cdp = cdp;
			this.last = { ...this.last, open: true };
			this.touch();
			this.log(`browser started: ${exe}`);
			return cdp;
		} catch (e) {
			proc.kill();
			this.proc = undefined;
			throw e;
		}
	}

	private reset(): void {
		clearTimeout(this.idle);
		this.cdp = undefined;
		this.proc = undefined;
		this.last = { open: false, url: "", title: "", ...VIEWPORT };
		this.onChange();
	}

	async close(): Promise<void> {
		const { cdp, proc } = this;
		this.cdp = undefined;
		this.proc = undefined;
		clearTimeout(this.idle);
		try {
			await cdp?.send("Browser.close");
		} catch {
			// fall through to kill
		}
		cdp?.close();
		proc?.kill();
		this.last = { open: false, url: "", title: "", ...VIEWPORT };
		this.onChange();
	}

	private async evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
		const res = await cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (res.exceptionDetails) throw new BrowserError(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
		return res.result.value as T;
	}

	async navigate(rawUrl: string): Promise<Snapshot> {
		const url = normalizeUrl(rawUrl);
		const cdp = await this.ensure();
		const loaded = cdp.once("Page.loadEventFired", NAV_TIMEOUT_MS);
		const nav = await cdp.send<{ errorText?: string }>("Page.navigate", { url });
		if (nav.errorText) throw new BrowserError(`打开失败: ${nav.errorText}`);
		await loaded;
		return this.afterAction(cdp);
	}

	async back(): Promise<Snapshot> {
		const cdp = await this.ensure();
		const history = await cdp.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
		const prev = history.entries[history.currentIndex - 1];
		if (!prev) throw new BrowserError("没有上一页");
		const loaded = cdp.once("Page.loadEventFired", NAV_TIMEOUT_MS);
		await cdp.send("Page.navigateToHistoryEntry", { entryId: prev.id });
		await loaded;
		return this.afterAction(cdp);
	}

	private async afterAction(cdp: Cdp): Promise<Snapshot> {
		await sleep(300);
		const snap = await this.snapshotOn(cdp);
		await this.capture(cdp, snap);
		return snap;
	}

	private async snapshotOn(cdp: Cdp): Promise<Snapshot> {
		return this.evaluate<Snapshot>(cdp, SNAPSHOT_JS);
	}

	async snapshot(): Promise<Snapshot> {
		const cdp = await this.requireOpen();
		const snap = await this.snapshotOn(cdp);
		await this.capture(cdp, snap);
		return snap;
	}

	private async requireOpen(): Promise<Cdp> {
		if (!this.cdp || this.cdp.closed) throw new BrowserError("浏览器还没有打开页面，请先调用 browser_navigate");
		this.touch();
		return this.cdp;
	}

	private async capture(cdp: Cdp, snap?: { title: string; url: string }, notify = true): Promise<void> {
		const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 60 });
		const info = snap ?? (await this.evaluate<{ title: string; url: string }>(cdp, "({ title: document.title, url: location.href })"));
		this.last = { open: true, url: info.url, title: info.title, shot: shot.data, ...VIEWPORT };
		if (notify) this.onChange();
	}

	/** Current screen for the viewer. With `refresh` it takes a new picture first. */
	async state(refresh: boolean): Promise<WorkbenchBrowserState> {
		if (!this.isOpen) return { open: false, url: "", title: "", ...VIEWPORT };
		if (refresh && this.cdp) {
			try {
				await this.capture(this.cdp, undefined, false);
			} catch {
				// Mid-navigation screenshots can fail; keep the previous frame.
			}
		}
		return this.last;
	}

	async screenshot(): Promise<string> {
		const cdp = await this.requireOpen();
		await this.capture(cdp);
		return this.last.shot ?? "";
	}

	private async centerOf(cdp: Cdp, ref: number): Promise<{ x: number; y: number }> {
		const pos = await this.evaluate<{ x: number; y: number } | null>(
			cdp,
			`(() => { const el = document.querySelector('[data-pi-ref="${Math.trunc(ref)}"]'); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
		);
		if (!pos) throw new BrowserError(`没有编号为 ${ref} 的元素，请先 browser_snapshot 获取最新编号`);
		return pos;
	}

	private async mouseClick(cdp: Cdp, x: number, y: number): Promise<void> {
		await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
		await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
	}

	async click(ref: number): Promise<Snapshot> {
		const cdp = await this.requireOpen();
		const { x, y } = await this.centerOf(cdp, ref);
		await this.mouseClick(cdp, x, y);
		await sleep(600);
		return this.afterAction(cdp);
	}

	/** A click made by the user on the picture, in page coordinates. */
	async clickAt(x: number, y: number): Promise<void> {
		const cdp = await this.requireOpen();
		if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x > VIEWPORT.width || y > VIEWPORT.height) throw new BrowserError("坐标超出页面");
		await this.mouseClick(cdp, x, y);
		await sleep(500);
		await this.capture(cdp);
	}

	async type(ref: number, text: string, submit: boolean): Promise<Snapshot> {
		const cdp = await this.requireOpen();
		const { x, y } = await this.centerOf(cdp, ref);
		await this.mouseClick(cdp, x, y);
		await this.evaluate(cdp, `(() => { const el = document.activeElement; if (el && el.select) el.select(); })()`);
		await cdp.send("Input.insertText", { text });
		if (submit) await this.pressOn(cdp, "Enter");
		await sleep(submit ? 800 : 200);
		return this.afterAction(cdp);
	}

	/** Typing from the viewer's own text box into whatever is focused. */
	async typeFocused(text: string, submit: boolean): Promise<void> {
		const cdp = await this.requireOpen();
		if (text) await cdp.send("Input.insertText", { text });
		if (submit) await this.pressOn(cdp, "Enter");
		await sleep(400);
		await this.capture(cdp);
	}

	private async pressOn(cdp: Cdp, name: string): Promise<void> {
		const k = KEYS[name];
		if (!k) throw new BrowserError(`不支持的按键: ${name}（可用: ${KEY_NAMES.join(", ")}）`);
		const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk };
		await cdp.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) });
		await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
	}

	async press(name: string): Promise<Snapshot> {
		const cdp = await this.requireOpen();
		await this.pressOn(cdp, name);
		await sleep(500);
		return this.afterAction(cdp);
	}

	async scroll(dy: number): Promise<Snapshot> {
		const cdp = await this.requireOpen();
		await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: VIEWPORT.width / 2, y: VIEWPORT.height / 2, deltaX: 0, deltaY: dy });
		await sleep(300);
		return this.afterAction(cdp);
	}
}
