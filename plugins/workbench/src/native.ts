import { BrowserError, SNAPSHOT_JS, type Snapshot } from "./browser.ts";

/** What the desktop app's native webview is asked to do. `exec` runs a function body in the page and returns its value. */
export type NativeCommand = { id: string; kind: "navigate"; url: string } | { id: string; kind: "exec"; script: string } | { id: string; kind: "close" };
type Send = { kind: "navigate"; url: string } | { kind: "exec"; script: string } | { kind: "close" };

interface Waiting {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DRIVER_FRESH_MS = 30_000;
const DESKTOP_FRESH_MS = 3 * 60_000;

/**
 * The browser as the desktop app shows it: a native webview living in the client. The server cannot reach it,
 * so commands wait in a queue that the client drains by long-polling, and answers come back through `answer`.
 */
export class NativeBrowser {
	private queue: NativeCommand[] = [];
	private waiting = new Map<string, Waiting>();
	private wake: (() => void) | undefined;
	private driverSeen = 0;
	private desktopSeen = 0;
	private n = 0;

	/** A desktop client exists, so a driver is worth waiting for. */
	hello(): void {
		this.desktopSeen = Date.now();
	}
	get desktopLikely(): boolean {
		return Date.now() - this.desktopSeen < DESKTOP_FRESH_MS;
	}
	get hasDriver(): boolean {
		return Date.now() - this.driverSeen < DRIVER_FRESH_MS;
	}

	/** Wait for the client to have its browser tab open and polling. */
	async waitForDriver(ms: number): Promise<boolean> {
		const end = Date.now() + ms;
		while (!this.hasDriver && Date.now() < end) await sleep(100);
		return this.hasDriver;
	}

	/** Long-poll by the client: hands over queued commands, or an empty list after ~10 s. */
	async poll(): Promise<NativeCommand[]> {
		this.driverSeen = Date.now();
		if (!this.queue.length) await new Promise<void>((r) => { this.wake = r; setTimeout(r, 10_000); });
		this.wake = undefined;
		this.driverSeen = Date.now();
		const out = this.queue;
		this.queue = [];
		return out;
	}

	answer(id: string, ok: boolean, value: unknown, error?: string): void {
		const w = this.waiting.get(id);
		if (!w) return;
		this.waiting.delete(id);
		clearTimeout(w.timer);
		if (ok) w.resolve(value);
		else w.reject(new BrowserError(error || "浏览器操作失败"));
	}

	private send(cmd: Send, timeoutMs = 25_000): Promise<unknown> {
		const id = `n${++this.n}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				this.queue = this.queue.filter((c) => c.id !== id);
				reject(new BrowserError("浏览器没有响应（请确认右侧浏览器面板已打开）"));
			}, timeoutMs);
			this.waiting.set(id, { resolve, reject, timer });
			this.queue.push({ id, ...cmd } as NativeCommand);
			this.wake?.();
		});
	}

	private exec(script: string): Promise<unknown> {
		return this.send({ kind: "exec", script });
	}

	async snapshot(): Promise<Snapshot> {
		return (await this.exec(`return ${SNAPSHOT_JS};`)) as Snapshot;
	}

	private async settled(ms: number): Promise<Snapshot> {
		await sleep(ms);
		// A page that is mid-navigation drops the first script; one retry is enough in practice.
		try {
			return await this.snapshot();
		} catch {
			await sleep(1000);
			return this.snapshot();
		}
	}

	async navigate(url: string): Promise<Snapshot> {
		await this.send({ kind: "navigate", url }, 30_000);
		return this.settled(300);
	}

	async back(): Promise<Snapshot> {
		await this.exec("history.back(); return true;");
		return this.settled(800);
	}

	private pick(ref: number): string {
		return `const el = document.querySelector('[data-pi-ref="${Math.trunc(ref)}"]'); if (!el) throw new Error('没有编号为 ${Math.trunc(ref)} 的元素，请先 browser_snapshot'); el.scrollIntoView({ block: 'center', inline: 'center' });`;
	}

	async click(ref: number): Promise<Snapshot> {
		await this.exec(`${this.pick(ref)} if (el.focus) el.focus(); el.click(); return true;`);
		return this.settled(700);
	}

	async type(ref: number, text: string, submit: boolean): Promise<Snapshot> {
		await this.exec(`${this.pick(ref)}
			el.focus();
			const T = ${JSON.stringify(text)};
			if (el.isContentEditable) el.textContent = T;
			else {
				const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
				Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, T);
			}
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			${submit ? "const f = el.form; const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }; const go = el.dispatchEvent(new KeyboardEvent('keydown', k)); el.dispatchEvent(new KeyboardEvent('keyup', k)); if (go && f) { if (f.requestSubmit) f.requestSubmit(); else f.submit(); }" : ""}
			return true;`);
		return this.settled(submit ? 1000 : 300);
	}

	async press(key: string): Promise<Snapshot> {
		await this.exec(`const el = document.activeElement || document.body; const key = ${JSON.stringify(key)};
			const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, PageDown: 34, PageUp: 33 };
			const k = { key, code: key, keyCode: codes[key] || 0, which: codes[key] || 0, bubbles: true, cancelable: true };
			const go = el.dispatchEvent(new KeyboardEvent('keydown', k)); el.dispatchEvent(new KeyboardEvent('keyup', k));
			if (go && key === 'Enter') { if (el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); } else if (el.tagName === 'BUTTON' || el.tagName === 'A') el.click(); }
			if (go && (key === 'PageDown' || key === 'PageUp')) window.scrollBy(0, (key === 'PageDown' ? 1 : -1) * window.innerHeight * 0.9);
			return true;`);
		return this.settled(600);
	}

	async scroll(dy: number): Promise<Snapshot> {
		await this.exec(`window.scrollBy(0, ${Math.trunc(dy) || 0}); return true;`);
		return this.settled(300);
	}

	async close(): Promise<void> {
		this.queue = [];
		for (const [id, w] of this.waiting) {
			clearTimeout(w.timer);
			w.reject(new BrowserError("浏览器已关闭"));
			this.waiting.delete(id);
		}
		if (this.hasDriver) await this.send({ kind: "close" }, 5000).catch(() => undefined);
	}
}
