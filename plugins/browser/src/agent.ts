// What the browser tools do: read the page as an accessibility tree, act on elements by ref, report what changed.
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { diff, treeSignature } from "@prometheus/plugin-computer-use/engine/diff.ts";
import { indexTree, type PNode, prune } from "@prometheus/plugin-computer-use/engine/prune.ts";
import { render } from "@prometheus/plugin-computer-use/engine/render.ts";
import { type BrowserCore, UserFacingError } from "./browser.ts";
import { comboEvents, parseCombo } from "./keys.ts";
import { backendIdOf, readTree } from "./snapshot.ts";
import type { Tab } from "./tab.ts";

export const BROWSER_OPS = [
	"click",
	"double_click",
	"right_click",
	"hover",
	"focus",
	"set_value",
	"type",
	"clear",
	"toggle",
	"select",
	"expand",
	"collapse",
	"scroll",
	"upload",
	"accept",
	"dismiss",
] as const;
export type BrowserOp = (typeof BROWSER_OPS)[number];

export interface Action {
	ref: string;
	op: BrowserOp;
	value?: string;
}

interface Remembered {
	tab: string;
	navigations: number;
	tree: PNode;
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export class BrowserAgent {
	private readonly browser: BrowserCore;
	private readonly settingsAllowEval: () => boolean;
	/** Per chat: the tab it works in and the last tree it saw there. */
	private readonly sessions = new Map<string, { tab?: string; last?: Remembered }>();

	constructor(browser: BrowserCore, allowEval: () => boolean) {
		this.browser = browser;
		this.settingsAllowEval = allowEval;
	}

	private mem(sid: string) {
		let m = this.sessions.get(sid);
		if (!m) {
			m = {};
			this.sessions.set(sid, m);
		}
		return m;
	}

	/** The tab a call works on: the one named, else the chat's own, else the one on screen (opened if there is none). */
	private async tabFor(sid: string, id?: string): Promise<Tab> {
		await this.browser.ensure();
		const m = this.mem(sid);
		if (id) {
			const t = this.browser.tab(id);
			m.tab = t.id;
			return t;
		}
		if (m.tab && this.browser.hasTab(m.tab)) return this.browser.tab(m.tab);
		const t = this.browser.activeTab ?? (await this.browser.newTab("about:blank", true, true));
		m.tab = t.id;
		return t;
	}

	header(tab: Tab): string {
		const lines = [`标签 ${tab.id}${tab.loading ? "（加载中）" : ""} · ${tab.title ? `"${clip(tab.title, 120)}" · ` : ""}${clip(tab.url, 300)}`];
		if (tab.crashed) lines.push("⚠ 页面已崩溃，用 browser_navigate action=reload 重新加载。");
		if (tab.dialog) {
			const d = tab.dialog;
			lines.push(`⚠ 页面弹出了 ${d.type} 对话框："${clip(d.message, 500)}"。页面在它关闭前不会响应：用 browser_act ref=dialog op=accept（prompt 用 value 填写）或 op=dismiss。`);
		}
		if (tab.fileChooser) lines.push(`⚠ 页面在等待选择文件：用 browser_act ref=file op=upload value=<绝对路径，多个用换行分隔>。`);
		return lines.join("\n");
	}

	// ---------- reading ----------

	private async tree(tab: Tab): Promise<{ tree: PNode; focus?: string; skippedFrames: number }> {
		const raw = await readTree(tab);
		return { tree: prune(raw.root).tree, focus: raw.focus, skippedFrames: raw.skippedFrames };
	}

	private remember(sid: string, tab: Tab, tree: PNode): void {
		this.mem(sid).last = { tab: tab.id, navigations: tab.navigations, tree };
	}

	private renderTree(tree: PNode, opts: { budget: number; focus?: string; query?: string; scope?: string }): string {
		let root = tree;
		if (opts.scope) {
			const hit = indexTree(tree).get(opts.scope);
			if (!hit) throw new UserFacingError(`快照里没有 ${opts.scope}，元素可能已消失，请重新 browser_snapshot。`);
			root = hit.node;
		}
		const r = render(root, { budget: opts.budget, focus: opts.focus, query: opts.query });
		const notes: string[] = [];
		if (r.cut > 0) notes.push(`共 ${r.total} 个元素，显示 ${r.shown} 个；用 scope=<ref> 展开或 query 过滤`);
		return notes.length ? `${r.text}\n（${notes.join("；")}）` : r.text || "（页面没有可读的内容）";
	}

	async snapshot(sid: string, p: { tab?: string; scope?: string; query?: string; maxTokens?: number; mode?: "tree" | "text"; offset?: number }): Promise<string> {
		const tab = await this.tabFor(sid, p.tab);
		this.browser.setAgentTab(tab, "snapshot");
		if (p.mode === "text") return `${this.header(tab)}\n\n${await this.pageText(tab, p.offset ?? 0, p.maxTokens ?? 6000)}`;
		if (tab.dialog) return this.header(tab);
		const { tree, focus, skippedFrames } = await this.tree(tab);
		this.remember(sid, tab, tree);
		const body = this.renderTree(tree, { budget: Math.min(Math.max(p.maxTokens ?? 2500, 300), 20_000), focus, query: p.query, scope: p.scope });
		const frames = skippedFrames ? `\n（${skippedFrames} 个跨域 iframe 的内容读不到，需要时用 browser_screenshot 看）` : "";
		return `${this.header(tab)}\n\n${body}${frames}`;
	}

	private async pageText(tab: Tab, offset: number, maxTokens: number): Promise<string> {
		const r = await tab.send<{ result: { value?: string } }>("Runtime.evaluate", {
			expression: `(() => { const b = document.body; if (!b) return ""; return b.innerText; })()`,
			returnByValue: true,
		});
		const full = String(r.result.value ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
		const max = Math.max(500, Math.min(maxTokens, 30_000)) * 3;
		const start = Math.max(0, Math.min(offset, full.length));
		const part = full.slice(start, start + max);
		const end = start + part.length;
		const more = end < full.length ? `\n\n（第 ${start}–${end} 字符，共 ${full.length}；用 offset=${end} 继续）` : "";
		return (part || "（页面没有文字）") + more;
	}

	// ---------- navigating ----------

	async navigate(sid: string, p: { url?: string; action?: "back" | "forward" | "reload" | "stop"; newTab?: boolean; tab?: string }, signal: AbortSignal): Promise<string> {
		let tab: Tab;
		if (p.newTab) {
			tab = await this.browser.newTab("about:blank", true, true);
			this.mem(sid).tab = tab.id;
		} else tab = await this.tabFor(sid, p.tab);
		this.browser.setAgentTab(tab, p.action ?? "navigate");
		const before = tab.navigations;
		let target = "";
		if (p.action) await this.browser.history(tab, p.action);
		else if (p.url) target = await this.browser.navigate(tab, p.url);
		else throw new UserFacingError("需要 url 或 action");
		if (p.action !== "stop") {
			await tab.waitFor(() => tab.navigations !== before || !!tab.dialog, 5000, signal);
			const loaded = await tab.waitFor(() => !tab.loading || !!tab.dialog, 20_000, signal);
			if (!loaded && !signal.aborted) return `${this.header(tab)}\n\n页面 20 秒内没有加载完，可以 browser_wait 或 browser_snapshot 看看现在的样子。`;
		}
		await sleep(250, signal);
		const snap = await this.freshSnapshot(sid, tab, 1500, signal);
		return `${target && tab.url !== target && !tab.url.startsWith(target) ? `（已跳转）\n` : ""}${this.header(tab)}\n\n${snap}`;
	}

	private async freshSnapshot(sid: string, tab: Tab, budget: number, signal?: AbortSignal): Promise<string> {
		if (tab.dialog) return "";
		const t = await this.quietTree(tab, signal);
		this.remember(sid, tab, t.tree);
		return this.renderTree(t.tree, { budget, focus: t.focus });
	}

	/** Reads the tree until two reads in a row agree (the page stopped changing), at most a few times. */
	private async quietTree(tab: Tab, signal?: AbortSignal): Promise<{ tree: PNode; focus?: string }> {
		let prev = await this.tree(tab);
		for (let i = 0; i < 3 && !signal?.aborted && !tab.dialog; i++) {
			await sleep(300, signal);
			const next = await this.tree(tab);
			if (treeSignature(next.tree) === treeSignature(prev.tree)) return next;
			prev = next;
		}
		return prev;
	}

	async tabs(sid: string, p: { action?: "list" | "new" | "select" | "close"; tab?: string; url?: string }): Promise<string> {
		const action = p.action ?? "list";
		if (action === "new") {
			const t = await this.browser.newTab(p.url ? undefined : "about:blank", true, true);
			if (p.url) await this.browser.navigate(t, p.url);
			this.mem(sid).tab = t.id;
			await t.waitFor(() => !t.loading, 15_000);
		} else if (action === "select") {
			if (!p.tab) throw new UserFacingError("需要 tab");
			const t = this.browser.tab(p.tab);
			this.browser.activate(t.id);
			this.mem(sid).tab = t.id;
		} else if (action === "close") {
			const t = await this.tabFor(sid, p.tab);
			await this.browser.closeTab(t.id);
			this.mem(sid).tab = undefined;
		}
		const mine = this.mem(sid).tab;
		const lines = this.browser.allTabs().map((t) => `${t.id}${t.id === this.browser.activeTab?.id ? " *" : ""}${t.id === mine ? " (当前)" : ""} "${clip(t.title || "无标题", 80)}" ${clip(t.url, 200)}${t.dialog ? " [对话框]" : ""}`);
		return lines.length ? `标签（* 为屏幕上显示的）：\n${lines.join("\n")}` : "没有打开的标签";
	}

	// ---------- acting ----------

	private async objectFor(tab: Tab, ref: string): Promise<{ id: number; objectId: string }> {
		const id = backendIdOf(ref);
		if (id === undefined) throw new UserFacingError(`无效的 ref：${ref}（应为快照里的 e123 这样的编号）`);
		try {
			const r = await tab.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: id });
			if (!r.object.objectId) throw new Error("no object");
			return { id, objectId: r.object.objectId };
		} catch {
			throw new UserFacingError(`${ref} 已不在页面上（页面变了），请重新 browser_snapshot。`);
		}
	}

	private async callOn<T>(tab: Tab, objectId: string, fn: string, args: unknown[] = []): Promise<T> {
		const r = await tab.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: fn,
			arguments: args.map((value) => ({ value })),
			returnByValue: true,
			awaitPromise: true,
			userGesture: true,
		});
		if (r.exceptionDetails) throw new UserFacingError(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "脚本出错");
		return r.result.value as T;
	}

	private async viewportSize(tab: Tab): Promise<{ w: number; h: number }> {
		const m = await tab.send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics").catch(() => undefined);
		const v = this.browser.viewport();
		return { w: m?.cssVisualViewport?.clientWidth ?? v.width, h: m?.cssVisualViewport?.clientHeight ?? v.height };
	}

	/** Scrolls the element into view and returns a point inside it. */
	private async pointOf(tab: Tab, backendNodeId: number): Promise<{ x: number; y: number }> {
		await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
		const { quads } = await tab.send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId }).catch(() => ({ quads: [] as number[][] }));
		const vp = await this.viewportSize(tab);
		for (const q of quads) {
			const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
			const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
			const x0 = Math.max(0, Math.min(...xs));
			const x1 = Math.min(vp.w, Math.max(...xs));
			const y0 = Math.max(0, Math.min(...ys));
			const y1 = Math.min(vp.h, Math.max(...ys));
			if (x1 - x0 >= 1 && y1 - y0 >= 1) return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
		}
		throw new UserFacingError("元素没有可见的区域（可能被隐藏或尺寸为 0）");
	}

	private async mouse(tab: Tab, x: number, y: number, button: "left" | "right", clickCount: number, op: string): Promise<void> {
		this.browser.view({ k: "pointer", tab: tab.id, x, y, op });
		await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
		for (let c = 1; c <= clickCount; c++) {
			const buttons = button === "left" ? 1 : 2;
			await tab.untilDialog(tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: c }));
			if (tab.dialog) return;
			await tab.untilDialog(tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: c }));
			if (tab.dialog) return;
		}
	}

	private async click(tab: Tab, ref: string, opts: { button?: "left" | "right"; count?: number; force?: boolean; op: string }): Promise<void> {
		const { id, objectId } = await this.objectFor(tab, ref);
		const p = await this.pointOf(tab, id);
		if (!opts.force) {
			const cover = await this.callOn<string>(
				tab,
				objectId,
				`function(x, y) { if (window !== window.top) return ""; const e = document.elementFromPoint(x, y);
				if (!e || this === e || this.contains(e) || e.contains(this)) return "";
				let s = e.tagName.toLowerCase(); if (e.id) s += "#" + e.id; if (typeof e.className === "string" && e.className.trim()) s += "." + e.className.trim().split(/\\s+/).slice(0, 2).join(".");
				const t = (e.innerText || e.getAttribute("aria-label") || "").trim().slice(0, 60); return t ? s + ' "' + t + '"' : s; }`,
				[p.x, p.y],
			).catch(() => "");
			if (cover) throw new UserFacingError(`${ref} 被 <${cover}> 挡住了（弹窗、横幅或浮层？）。先关掉它；确定要点在这个位置就用 value="force"。`);
		}
		await this.mouse(tab, p.x, p.y, opts.button ?? "left", opts.count ?? 1, opts.op);
	}

	private async pressDelete(tab: Tab): Promise<void> {
		for (const e of comboEvents(parseCombo("delete"))) await tab.send("Input.dispatchKeyEvent", e);
	}

	private async doAction(tab: Tab, a: Action): Promise<string> {
		const ref = String(a.ref ?? "").trim();
		if (ref === "dialog" || a.op === "accept" || a.op === "dismiss") {
			if (!tab.dialog) throw new UserFacingError("当前没有对话框");
			const accept = a.op !== "dismiss";
			await this.browser.respondDialog(tab, accept, tab.dialog.type === "prompt" && accept ? (a.value ?? "") : undefined);
			return accept ? "已确认对话框" : "已取消对话框";
		}
		if (a.op === "upload") {
			const files = (a.value ?? "").split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);
			if (!files.length) throw new UserFacingError("upload 需要 value：文件的绝对路径");
			for (const f of files) if (!isAbsolute(f) || !existsSync(f)) throw new UserFacingError(`文件不存在或不是绝对路径：${f}`);
			if (ref !== "file") {
				const { id, objectId } = await this.objectFor(tab, ref);
				const isFile = await this.callOn<boolean>(tab, objectId, `function() { return this.tagName === "INPUT" && this.type === "file"; }`);
				if (isFile) {
					await tab.send("DOM.setFileInputFiles", { files: files.map((f) => resolve(f)), backendNodeId: id });
					tab.fileChooser = undefined;
					return `已选择 ${files.length} 个文件`;
				}
				if (!tab.fileChooser) {
					// A styled upload button: clicking it opens the (intercepted) chooser, which then takes the files.
					await this.click(tab, ref, { op: "click" });
					await tab.waitFor(() => !!tab.fileChooser, 2000);
				}
			}
			if (!tab.fileChooser) throw new UserFacingError("页面没有在等待选择文件；对 <input type=file> 或上传按钮的 ref 使用 upload");
			await this.browser.chooseFiles(tab, files.map((f) => resolve(f)));
			return `已选择 ${files.length} 个文件`;
		}
		if (ref === "page" && a.op === "scroll") {
			const vp = await this.viewportSize(tab);
			await this.wheel(tab, vp.w / 2, vp.h / 2, a.value ?? "down", vp);
			return `页面已滚动 ${a.value ?? "down"}`;
		}
		switch (a.op) {
			case "click":
			case "toggle":
				await this.click(tab, ref, { force: a.value === "force", op: a.op });
				return `已点击 ${ref}`;
			case "double_click":
				await this.click(tab, ref, { count: 2, force: a.value === "force", op: a.op });
				return `已双击 ${ref}`;
			case "right_click":
				await this.click(tab, ref, { button: "right", force: a.value === "force", op: a.op });
				return `已右键 ${ref}`;
			case "hover": {
				const { id } = await this.objectFor(tab, ref);
				const p = await this.pointOf(tab, id);
				this.browser.view({ k: "pointer", tab: tab.id, x: p.x, y: p.y, op: "hover" });
				await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none" });
				return `鼠标停在 ${ref}`;
			}
			case "focus": {
				const { id } = await this.objectFor(tab, ref);
				await tab.send("DOM.focus", { backendNodeId: id });
				return `已聚焦 ${ref}`;
			}
			case "set_value":
			case "clear": {
				const value = a.op === "clear" ? "" : (a.value ?? "");
				const { objectId } = await this.objectFor(tab, ref);
				const how = await this.callOn<string>(tab, objectId, SET_VALUE_FN, [value]);
				if (how === "select") return this.selectOption(tab, objectId, ref, value);
				if (how === "nofield") throw new UserFacingError(`${ref} 不是输入框；先 click 它，或对其中的输入框 ref 使用 set_value`);
				if (how === "typed") {
					if (value) await tab.untilDialog(tab.send("Input.insertText", { text: value }));
					else await this.pressDelete(tab);
				}
				return value ? `${ref} 已填入 "${clip(value, 80)}"` : `${ref} 已清空`;
			}
			case "type": {
				const { id, objectId } = await this.objectFor(tab, ref);
				const focused = await this.callOn<boolean>(tab, objectId, `function() { this.focus(); return document.activeElement === this || this.contains(document.activeElement); }`).catch(() => false);
				if (!focused) await tab.send("DOM.focus", { backendNodeId: id }).catch(() => this.click(tab, ref, { op: "click" }));
				await tab.untilDialog(tab.send("Input.insertText", { text: a.value ?? "" }));
				return `已在 ${ref} 输入 "${clip(a.value ?? "", 80)}"`;
			}
			case "select": {
				const { objectId } = await this.objectFor(tab, ref);
				const isSelect = await this.callOn<boolean>(tab, objectId, `function() { return this.tagName === "SELECT"; }`);
				if (isSelect) return this.selectOption(tab, objectId, ref, a.value ?? "");
				await this.click(tab, ref, { op: "select" });
				return `已选中 ${ref}`;
			}
			case "expand":
			case "collapse": {
				const { objectId } = await this.objectFor(tab, ref);
				const open = await this.callOn<boolean | null>(
					tab,
					objectId,
					`function() { const a = this.getAttribute("aria-expanded"); if (a !== null) return a === "true"; if (this.tagName === "DETAILS") return this.open;
					if (this.tagName === "SUMMARY" && this.parentElement && this.parentElement.tagName === "DETAILS") return this.parentElement.open; return null; }`,
				);
				if (open === (a.op === "expand")) return `${ref} 已经是${a.op === "expand" ? "展开" : "收起"}的`;
				await this.click(tab, ref, { op: a.op });
				return `已${a.op === "expand" ? "展开" : "收起"} ${ref}`;
			}
			case "scroll": {
				const dir = (a.value ?? "into_view").toLowerCase();
				const { id } = await this.objectFor(tab, ref);
				if (dir === "into_view") {
					await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: id });
					return `已把 ${ref} 滚到可见处`;
				}
				const p = await this.pointOf(tab, id);
				await this.wheel(tab, p.x, p.y, dir, await this.viewportSize(tab));
				return `已在 ${ref} 上滚动 ${dir}`;
			}
			default:
				throw new UserFacingError(`未知的操作：${a.op}`);
		}
	}

	private async wheel(tab: Tab, x: number, y: number, dir: string, vp: { w: number; h: number }): Promise<void> {
		const dy = dir === "down" ? vp.h * 0.8 : dir === "up" ? -vp.h * 0.8 : 0;
		const dx = dir === "right" ? vp.w * 0.8 : dir === "left" ? -vp.w * 0.8 : 0;
		if (!dx && !dy) throw new UserFacingError("scroll 的 value 是 up、down、left、right 或 into_view");
		await tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
		await sleep(200);
	}

	private async selectOption(tab: Tab, objectId: string, ref: string, value: string): Promise<string> {
		const r = await this.callOn<{ ok: boolean; label?: string; options?: string[]; disabled?: boolean }>(tab, objectId, SELECT_FN, [value]);
		if (r.ok) return `${ref} 已选择 "${r.label}"`;
		if (r.disabled) throw new UserFacingError(`选项 "${value}" 不可选`);
		throw new UserFacingError(`${ref} 没有选项 "${value}"。可选：${(r.options ?? []).map((o) => `"${o}"`).join("、")}`);
	}

	async act(sid: string, actions: Action[], tabId: string | undefined, signal: AbortSignal): Promise<string> {
		const tab = await this.tabFor(sid, tabId);
		const before = this.mem(sid).last;
		const nav = tab.navigations;
		const tabsBefore = new Set(this.browser.allTabs().map((t) => t.id));
		const done: string[] = [];
		let failure: string | undefined;
		for (const [i, a] of actions.entries()) {
			if (signal.aborted) {
				failure = "已中止";
				break;
			}
			this.browser.setAgentTab(tab, a.op);
			try {
				done.push(`✓ ${await this.doAction(tab, a)}`);
			} catch (err) {
				failure = `✗ 第 ${i + 1} 步（${a.op} ${a.ref}）失败：${err instanceof Error ? err.message : String(err)}`;
				break;
			}
			if (tab.dialog && i < actions.length - 1) {
				failure = `页面弹出了对话框，后面 ${actions.length - i - 1} 步没有执行。`;
				break;
			}
			if (tab.navigations !== nav && i < actions.length - 1) {
				failure = `页面跳转了，后面 ${actions.length - i - 1} 步没有执行（ref 已失效）。`;
				break;
			}
		}
		await this.settle(tab, nav, signal);
		const out = [...done, ...(failure ? [failure] : [])];
		// A link with target=_blank or window.open: the work continues in the new tab, as it would for a person.
		const opened = this.browser.allTabs().filter((t) => !tabsBefore.has(t.id));
		const fresh = opened[opened.length - 1];
		if (fresh) {
			this.mem(sid).tab = fresh.id;
			fresh.agent = true;
			await fresh.waitFor(() => !fresh.loading, 15_000, signal);
			await fresh.refreshTitle();
			out.push("", `页面打开了新标签 ${fresh.id}，之后的操作默认在它上面进行（原标签是 ${tab.id}）。`, this.header(fresh));
			if (!fresh.dialog) out.push("", await this.freshSnapshot(sid, fresh, 1500, signal));
			return out.join("\n");
		}
		out.push("", this.header(tab));
		if (!tab.dialog) out.push("", await this.changes(sid, tab, before, nav, signal));
		return out.join("\n");
	}

	/** Gives the page time to react: a navigation to load, a click handler to render. */
	private async settle(tab: Tab, nav: number, signal: AbortSignal): Promise<void> {
		await sleep(150, signal);
		if (tab.dialog) return;
		if (tab.loading || tab.navigations !== nav) await tab.waitFor(() => !tab.loading || !!tab.dialog, 15_000, signal);
	}

	private async changes(sid: string, tab: Tab, before: Remembered | undefined, nav: number, signal: AbortSignal): Promise<string> {
		const now = await this.quietTree(tab, signal);
		this.remember(sid, tab, now.tree);
		if (!before || before.tab !== tab.id || before.navigations !== nav || tab.navigations !== nav) {
			return `页面${tab.navigations !== nav ? "已跳转" : ""}，当前内容：\n${this.renderTree(now.tree, { budget: 1500, focus: now.focus })}`;
		}
		const d = diff(before.tree, now.tree, 40, now.focus);
		if (!d.changes) return "页面没有可见的变化。";
		if (d.big) return `页面变化较大，当前内容：\n${this.renderTree(now.tree, { budget: 1500, focus: now.focus })}`;
		return `变化：\n${d.text}`;
	}

	async keys(sid: string, p: { keys?: string; text?: string; tab?: string }, signal: AbortSignal): Promise<string> {
		const tab = await this.tabFor(sid, p.tab);
		this.browser.setAgentTab(tab, "keys");
		const before = this.mem(sid).last;
		const nav = tab.navigations;
		if (!p.keys && !p.text) throw new UserFacingError("需要 keys 或 text");
		if (p.text) await tab.untilDialog(tab.send("Input.insertText", { text: p.text }));
		for (const combo of (p.keys ?? "").split(/\s+/).filter(Boolean)) {
			if (tab.dialog || signal.aborted) break;
			for (const e of comboEvents(parseCombo(combo))) {
				await tab.untilDialog(tab.send("Input.dispatchKeyEvent", e));
				if (tab.dialog) break;
			}
		}
		await this.settle(tab, nav, signal);
		const out = [`✓ 已发送${p.text ? ` 文本 "${clip(p.text, 60)}"` : ""}${p.keys ? ` 按键 ${p.keys}` : ""}`, "", this.header(tab)];
		if (!tab.dialog) out.push("", await this.changes(sid, tab, before, nav, signal));
		return out.join("\n");
	}

	async screenshot(sid: string, p: { tab?: string; fullPage?: boolean; ref?: string }): Promise<{ text: string; data: string }> {
		const tab = await this.tabFor(sid, p.tab);
		this.browser.setAgentTab(tab, "screenshot");
		const m = await tab.send<{ cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }; cssContentSize: { width: number; height: number } }>("Page.getLayoutMetrics");
		const vv = m.cssVisualViewport;
		let clipRect = { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight };
		if (p.ref) {
			const { id } = await this.objectFor(tab, p.ref);
			await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: id }).catch(() => {});
			const box = await tab.send<{ model: { border: number[] } }>("DOM.getBoxModel", { backendNodeId: id }).catch(() => undefined);
			if (!box) throw new UserFacingError(`${p.ref} 没有可见的区域`);
			const xs = box.model.border.filter((_, i) => i % 2 === 0);
			const ys = box.model.border.filter((_, i) => i % 2 === 1);
			const m2 = await tab.send<{ cssVisualViewport: { pageX: number; pageY: number } }>("Page.getLayoutMetrics");
			clipRect = { x: Math.min(...xs) + m2.cssVisualViewport.pageX, y: Math.min(...ys) + m2.cssVisualViewport.pageY, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
		} else if (p.fullPage) {
			clipRect = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 12_000) };
		}
		const dpr = this.browser.headless ? this.browser.viewport().dpr : 1;
		const scale = Math.min(1, 1280 / Math.max(1, clipRect.width * dpr));
		const shot = await tab.send<{ data: string }>(
			"Page.captureScreenshot",
			{ format: "jpeg", quality: 80, clip: { ...clipRect, scale }, captureBeyondViewport: !!p.fullPage || !!p.ref },
			30_000,
		);
		return { text: `${this.header(tab)}\n截图 ${Math.round(clipRect.width)}×${Math.round(clipRect.height)}${p.fullPage ? "（整页）" : p.ref ? `（${p.ref}）` : "（可视区域）"}`, data: shot.data };
	}

	async wait(sid: string, p: { text?: string; gone?: boolean; url?: string; timeoutMs?: number; tab?: string }, signal: AbortSignal): Promise<string> {
		const tab = await this.tabFor(sid, p.tab);
		this.browser.setAgentTab(tab, "wait");
		const deadline = Date.now() + Math.min(Math.max(p.timeoutMs ?? 10_000, 100), 60_000);
		const want = p.text?.toLowerCase();
		while (!signal.aborted) {
			if (tab.dialog) return this.header(tab);
			let ok = true;
			if (p.url) ok = tab.url.includes(p.url);
			if (ok && want !== undefined) {
				const r = await tab.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true }, 5000).catch(() => undefined);
				const has = String(r?.result.value ?? "").toLowerCase().includes(want);
				ok = p.gone ? !has : has;
			}
			if (ok && !p.text && !p.url) ok = !tab.loading;
			if (ok) return `✓ 条件已满足\n${this.header(tab)}`;
			if (Date.now() > deadline) return `✗ 超时，条件没有满足\n${this.header(tab)}`;
			await sleep(300, signal);
		}
		return "已中止";
	}

	async evaluate(sid: string, p: { expression: string; tab?: string }): Promise<string> {
		if (!this.settingsAllowEval()) throw new UserFacingError("浏览器设置里关闭了「允许 Agent 执行页面脚本」");
		const tab = await this.tabFor(sid, p.tab);
		this.browser.setAgentTab(tab, "eval");
		const r = await tab.untilDialog(
			tab.send<{ result: { value?: unknown; type: string; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
				"Runtime.evaluate",
				{ expression: p.expression, returnByValue: true, awaitPromise: true, userGesture: true, replMode: true },
				20_000,
			),
		);
		if (!r) return this.header(tab);
		if (r.exceptionDetails) return `✗ ${clip(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "出错", 4000)}`;
		const v = r.result.value;
		const text = v === undefined ? (r.result.description ?? r.result.type) : typeof v === "string" ? v : JSON.stringify(v, null, 2);
		return clip(text ?? "undefined", 20_000);
	}
}

const SET_VALUE_FN = `function(v) {
	const el = this, tag = el.tagName;
	if (tag === "SELECT") return "select";
	if (tag === "INPUT" && ["date", "time", "datetime-local", "month", "week", "color", "range"].includes(el.type)) {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		return "done";
	}
	if (tag === "INPUT" || tag === "TEXTAREA") { el.focus(); el.select(); return "typed"; }
	if (el.isContentEditable) {
		el.focus();
		const r = document.createRange(); r.selectNodeContents(el);
		const s = getSelection(); s.removeAllRanges(); s.addRange(r);
		return "typed";
	}
	const inner = el.querySelector && el.querySelector("input:not([type=hidden]), textarea, [contenteditable=''], [contenteditable=true]");
	if (inner) { inner.focus(); if (inner.select) inner.select(); else { const r = document.createRange(); r.selectNodeContents(inner); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } return "typed"; }
	return "nofield";
}`;

const SELECT_FN = `function(v) {
	const want = String(v).trim().toLowerCase();
	const opts = [...this.options];
	const o = opts.find((o) => o.label.trim().toLowerCase() === want || o.value.toLowerCase() === want) || opts.find((o) => want && o.label.toLowerCase().includes(want));
	if (!o) return { ok: false, options: opts.slice(0, 40).map((o) => o.label.trim()) };
	if (o.disabled) return { ok: false, disabled: true };
	if (this.multiple) o.selected = true; else this.value = o.value;
	this.dispatchEvent(new Event("input", { bubbles: true }));
	this.dispatchEvent(new Event("change", { bubbles: true }));
	return { ok: true, label: o.label.trim() };
}`;
