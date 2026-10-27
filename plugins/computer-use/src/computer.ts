import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AuditLog } from "./audit.ts";
import type { Decider } from "./decider.ts";
import { DriverCallError } from "./driver/rpc.ts";
import { diff, treeSignature } from "./engine/diff.ts";
import { indexTree, type PNode, prune, walk } from "./engine/prune.ts";
import { estimateTokens, formatNode, render } from "./engine/render.ts";
import { type ActionTarget, appVerdict, irreversibleByRule, isSecretWrite, keysLookIrreversible, type PolicySettings } from "./policy.ts";
import { type Driver, type Op, OPS, type WindowInfo } from "./protocol.ts";

export interface ComputerSettings extends PolicySettings {
	/** Token budget of one snapshot. */
	snapshotTokens: number;
	/** Quiet period that counts as "the UI has settled" after an action. */
	settleMs: number;
	settleTimeoutMs: number;
	/** Ask before actions that look irreversible (send, pay, delete…). Auto mode never asks. */
	confirmIrreversible: boolean;
	/** Unattended runs refuse irreversible actions unless this is on. */
	allowIrreversibleUnattended: boolean;
	/** Which machine the tools operate: this computer, or an Android device over adb. */
	device: "local" | "adb";
	adbPath: string;
	/** adb serial when several devices are attached; empty picks the only one. */
	adbSerial: string;
}

export const DEFAULT_SETTINGS: ComputerSettings = {
	allowApps: [],
	denyApps: [],
	snapshotTokens: 2000,
	settleMs: 250,
	settleTimeoutMs: 3000,
	confirmIrreversible: true,
	allowIrreversibleUnattended: false,
	device: "local",
	adbPath: "adb",
	adbSerial: "",
};

interface WindowSnap {
	window: WindowInfo;
	tree: PNode;
	focus?: string;
}

interface SessionState {
	lastWindow?: string;
	/** Latest snapshot per window id; the base for diffs and for knowing what a ref is. */
	snaps: Map<string, WindowSnap>;
}

export interface ActionSpec {
	ref: string;
	op: Op;
	value?: string;
}

export class UserFacingError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new UserFacingError("已中止"));
			},
			{ once: true },
		);
	});

function explain(e: unknown): string {
	if (e instanceof DriverCallError) {
		switch (e.code) {
			case "stale_ref":
			case "unknown_ref":
				return `${e.message}（界面已变化，请先 computer_observe 再操作）`;
			case "window_gone":
				return `${e.message}（用 computer_apps 查看现有窗口）`;
			case "input_blocked":
				return `${e.message}（可能是更高权限的窗口挡在前面，例如 UAC 或管理员程序）`;
			default:
				return e.message;
		}
	}
	return e instanceof Error ? e.message : String(e);
}

export interface ServiceOptions {
	driver: () => Promise<Driver>;
	settings: () => ComputerSettings;
	decider: Decider;
	audit: AuditLog;
	selfPids: ReadonlySet<number>;
	/** Label of the machine operated, for results and the audit log. */
	device?: () => string;
}

type RunMode = "interactive" | "auto" | "unattended";

function runModeOf(ctx: ExtensionContext | undefined): RunMode {
	let prompt = "";
	try {
		prompt = ctx?.getSystemPrompt() ?? "";
	} catch {}
	if (prompt.includes("# Unattended run")) return "unattended";
	if (prompt.includes("# Auto mode")) return "auto";
	return "interactive";
}

export class ComputerService {
	paused = false;
	private readonly sessions = new Map<string, SessionState>();

	private readonly opts: ServiceOptions;

	private deviceName(): string {
		return this.opts.device?.() ?? "local";
	}

	constructor(opts: ServiceOptions) {
		this.opts = opts;
	}

	private session(id: string): SessionState {
		let s = this.sessions.get(id);
		if (!s) {
			s = { snaps: new Map() };
			this.sessions.set(id, s);
			if (this.sessions.size > 64) this.sessions.delete(this.sessions.keys().next().value!);
		}
		return s;
	}

	private ensureRunning(): void {
		if (this.paused) throw new UserFacingError("Computer Use 已被用户暂停（/computer resume 恢复）。不要重试，告诉用户当前进度。");
	}

	private verdict(w: WindowInfo) {
		return appVerdict(w, this.opts.settings(), this.opts.selfPids);
	}

	// ---------- windows ----------

	async apps(): Promise<string> {
		const d = await this.opts.driver();
		const wins = await d.call("windows.list", {});
		if (!wins.length) return "没有可见窗口。";
		const lines = [`设备：${this.deviceName() === "local" ? "本机" : this.deviceName()}（${d.hello.platform} ${d.hello.os ?? ""}）`.trim(), ""];
		for (const w of wins) {
			const v = this.verdict(w);
			const flags = [w.focused ? "前台" : "", w.minimized ? "最小化" : "", v.ok ? "" : `禁止：${v.reason}`].filter(Boolean).join("，");
			lines.push(`[${w.id}] ${w.app} — "${w.title}"${flags ? `（${flags}）` : ""}`);
		}
		lines.push("", "用 computer_observe window=<id、应用名或标题片段> 查看窗口内容。");
		return lines.join("\n");
	}

	/** id, app name or title substring; falls back to the last window used in this chat, then the foreground one. */
	async resolveWindow(sessionId: string, spec?: string): Promise<WindowInfo> {
		const d = await this.opts.driver();
		const wins = await d.call("windows.list", {});
		const s = this.session(sessionId);
		let found: WindowInfo | undefined;
		const want = spec?.trim();
		if (want) {
			const lw = want.toLowerCase();
			found =
				wins.find((w) => w.id === want) ??
				wins.find((w) => w.app.toLowerCase() === lw.replace(/\.exe$/, "")) ??
				wins.find((w) => w.title.toLowerCase() === lw) ??
				wins.find((w) => w.title.toLowerCase().includes(lw)) ??
				wins.find((w) => w.app.toLowerCase().includes(lw));
			if (!found && /^\d+$/.test(want)) {
				// Untitled windows (menus, popups) only show up in the full list.
				found = (await d.call("windows.list", { all: true })).find((w) => w.id === want);
			}
			if (!found) throw new UserFacingError(`找不到窗口「${want}」。用 computer_apps 查看现有窗口。`);
		} else {
			found = (s.lastWindow && wins.find((w) => w.id === s.lastWindow)) || wins.find((w) => w.focused && this.verdict(w).ok) || wins.find((w) => this.verdict(w).ok);
			if (!found) throw new UserFacingError("没有可操作的窗口。用 computer_apps 查看，或 computer_launch 启动应用。");
		}
		const v = this.verdict(found);
		if (!v.ok) throw new UserFacingError(`不能操作该窗口：${v.reason}。`);
		s.lastWindow = found.id;
		return found;
	}

	private async snap(win: WindowInfo, scope?: string): Promise<WindowSnap & { hidden: number; truncated: boolean }> {
		const d = await this.opts.driver();
		const r = await d.call("tree.snapshot", { window: win.id, ...(scope ? { scope } : {}) }, 30_000);
		const { tree, hidden } = prune(r.root);
		return { window: win, tree, focus: r.focus, hidden, truncated: r.truncated };
	}

	private header(w: WindowInfo): string {
		return `窗口 [${w.id}] ${w.app} — "${w.title}"${w.focused ? "（前台）" : ""}`;
	}

	// ---------- observe / find / wait ----------

	async observe(sessionId: string, spec: string | undefined, o: { scope?: string; query?: string; maxTokens?: number }): Promise<string> {
		this.ensureRunning();
		const win = await this.resolveWindow(sessionId, spec);
		const snap = await this.snap(win, o.scope);
		const s = this.session(sessionId);
		if (!o.scope) s.snaps.set(win.id, snap);
		const budget = Math.max(300, Math.min(o.maxTokens ?? this.opts.settings().snapshotTokens, 12_000));
		const r = render(snap.tree, { budget, focus: snap.focus, query: o.query });
		const notes: string[] = [];
		if (r.cut) notes.push(`${r.cut} 个元素因预算未显示`);
		if (snap.hidden) notes.push(`${snap.hidden} 个离屏/装饰元素已省略`);
		if (snap.truncated) notes.push("窗口元素过多，驱动只返回了一部分");
		if (o.query && r.shown <= 1) notes.push(`没有匹配「${o.query}」的元素`);
		return [this.header(win), snap.focus ? `焦点：${snap.focus}` : "", r.text, notes.length ? `（${notes.join("；")}）` : ""].filter(Boolean).join("\n");
	}

	async find(sessionId: string, ctx: ExtensionContext | undefined, spec: string | undefined, text: string, role: string | undefined, signal?: AbortSignal): Promise<string> {
		this.ensureRunning();
		const win = await this.resolveWindow(sessionId, spec);
		const snap = await this.snap(win);
		this.session(sessionId).snaps.set(win.id, snap);
		const words = text.toLowerCase().split(/\s+/).filter(Boolean);
		const paths = new Map<string, string>();
		const scored: { node: PNode; score: number }[] = [];
		const trail: string[] = [];
		for (const { node, depth } of walk(snap.tree)) {
			trail.length = depth;
			trail[depth] = node.name ? `${node.role} "${node.name.slice(0, 30)}"` : node.role;
			if (role && node.role !== role) continue;
			const name = (node.name ?? "").toLowerCase();
			const hay = `${name} ${(node.value ?? "").toLowerCase()}`;
			let score = 0;
			if (name === text.toLowerCase()) score += 10;
			for (const w of words) if (hay.includes(w)) score += 3;
			if (node.actions.length || node.states.includes("editable")) score += 1;
			if (score > 1) {
				scored.push({ node, score });
				paths.set(node.ref, trail.slice(1, depth).join(" › "));
			}
		}
		scored.sort((a, b) => b.score - a.score);
		let note = "";
		// Ambiguous or no lexical hit: let the decision model pick among interactive candidates.
		const top = scored[0]?.score ?? 0;
		const ties = scored.filter((x) => x.score === top).length;
		if (this.opts.decider.enabled && (scored.length === 0 || ties > 1)) {
			const pool = (scored.length ? scored.map((x) => x.node) : [...walk(snap.tree)].map((e) => e.node).filter((n) => n.actions.length || n.states.includes("editable"))).slice(0, 20);
			if (pool.length > 1) {
				const criteria: Record<string, string> = {};
				for (const n of pool) criteria[n.ref] = formatNode(n);
				const r = await this.opts.decider.ask(
					ctx,
					{
						state: { window: win.title, app: win.app, request: text },
						questions: { target: { type: "choice", instructions: "Which UI element best matches what `request` describes?", criteria } },
					},
					signal,
				);
				const a = r?.answers.target;
				if (a?.type === "choice" && a.confidence > 0.2) {
					const best = pool.find((n) => n.ref === a.choice)!;
					const rest = scored.filter((x) => x.node !== best);
					scored.splice(0, scored.length, { node: best, score: 99 }, ...rest);
					if (!paths.has(best.ref)) paths.set(best.ref, "");
					note = `（第一项由决策模型 ${r!.via} 选出，置信度 ${a.confidence.toFixed(2)}）`;
				}
			}
		}
		if (!scored.length) return `${this.header(win)}\n没有找到「${text}」。试试 computer_observe 查看整个窗口。`;
		const lines = scored.slice(0, 10).map(({ node }) => {
			const p = paths.get(node.ref);
			return `${formatNode(node)}${p ? `   ← ${p}` : ""}`;
		});
		return [this.header(win), ...lines, note].filter(Boolean).join("\n");
	}

	async wait(sessionId: string, spec: string | undefined, text: string, gone: boolean, timeoutMs: number, signal?: AbortSignal): Promise<string> {
		this.ensureRunning();
		const deadline = Date.now() + Math.min(Math.max(timeoutMs, 500), 60_000);
		const words = text.toLowerCase();
		for (;;) {
			let present = false;
			let win: WindowInfo | undefined;
			try {
				win = await this.resolveWindow(sessionId, spec);
				const snap = await this.snap(win);
				this.session(sessionId).snaps.set(win.id, snap);
				present = [...walk(snap.tree)].some(({ node }) => `${node.name ?? ""} ${node.value ?? ""}`.toLowerCase().includes(words));
			} catch (e) {
				// A window that has not appeared yet is part of waiting.
				if (!(e instanceof UserFacingError) || !spec) throw e;
			}
			if (present !== gone) {
				return `${gone ? "已消失" : "已出现"}：「${text}」${win ? `（${this.header(win)}）` : ""}`;
			}
			if (Date.now() > deadline) return `等待超时：「${text}」${gone ? "仍然存在" : "没有出现"}。`;
			await sleep(400, signal);
			this.ensureRunning();
		}
	}

	// ---------- acting ----------

	/** Settled snapshot: re-read until two consecutive reads match or the timeout passes. */
	private async settle(win: WindowInfo, signal?: AbortSignal): Promise<(WindowSnap & { hidden: number }) | undefined> {
		const { settleMs, settleTimeoutMs } = this.opts.settings();
		const end = Date.now() + settleTimeoutMs;
		const driver = await this.opts.driver();
		if (driver.hello.capabilities.includes("settle_events")) {
			// The driver listens to the app's accessibility events: one wait, one snapshot.
			try {
				await driver.call("ui.settle", { window: win.id, quietMs: settleMs, timeoutMs: settleTimeoutMs }, settleTimeoutMs + 5000);
				return await this.snap(win);
			} catch (e) {
				if (e instanceof DriverCallError && e.code === "window_gone") return undefined;
				// Anything else: fall back to polling below.
			}
		}
		await sleep(Math.min(150, settleMs), signal);
		let last: (WindowSnap & { hidden: number }) | undefined;
		let lastSig = "";
		for (;;) {
			try {
				const s = await this.snap(win);
				const sig = treeSignature(s.tree);
				if (last && sig === lastSig) return s;
				last = s;
				lastSig = sig;
			} catch (e) {
				if (e instanceof DriverCallError && e.code === "window_gone") return undefined;
				throw e;
			}
			if (Date.now() > end) return last;
			await sleep(settleMs, signal);
		}
	}

	private targetOf(s: SessionState, ref: string): { target?: ActionTarget & { ref: string }; window?: WindowInfo } {
		for (const snap of s.snaps.values()) {
			const hit = indexTree(snap.tree).get(ref);
			if (hit) return { target: { ref, role: hit.node.role, name: hit.node.name, states: hit.node.states }, window: snap.window };
		}
		return {};
	}

	/** Returns undefined when allowed, or the reason it was refused. */
	private async guard(ctx: ExtensionContext | undefined, title: string, detail: string): Promise<string | undefined> {
		const mode = runModeOf(ctx);
		const s = this.opts.settings();
		if (mode === "unattended") return s.allowIrreversibleUnattended ? undefined : "无人值守运行不允许不可逆操作（设置 allowIrreversibleUnattended 可放开）";
		if (mode === "auto" || !s.confirmIrreversible) return undefined;
		if (!ctx?.hasUI) return "没有可确认的界面";
		const ok = await ctx.ui.confirm(title, detail);
		return ok ? undefined : "用户拒绝了此操作";
	}

	private async checkAction(
		ctx: ExtensionContext | undefined,
		win: WindowInfo,
		target: (ActionTarget & { ref: string }) | undefined,
		a: ActionSpec,
		signal?: AbortSignal,
	): Promise<{ refused?: string; guard?: string }> {
		const what = target ? `${target.role}${target.name ? `「${target.name}」` : ""}` : a.ref;
		if (target && isSecretWrite(target, a.op)) {
			const r = await this.guard(ctx, "Agent 要向密码框输入内容", `${win.app} — ${win.title}\n目标：${what}`);
			return r ? { refused: r, guard: "secret-write" } : { guard: "secret-write:confirmed" };
		}
		const keyword = target && irreversibleByRule(target, a.op);
		if (keyword) {
			const r = await this.guard(ctx, `确认：${keyword}`, `Agent 要在 ${win.app}「${win.title}」中执行 ${a.op} ${what}。\n此操作可能无法撤销。`);
			return r ? { refused: r, guard: `rule:${keyword}` } : { guard: `rule:${keyword}:confirmed` };
		}
		if (target?.name && this.opts.decider.enabled && ["click", "double_click", "select", "toggle"].includes(a.op)) {
			const d = await this.opts.decider.ask(
				ctx,
				{
					state: { app: win.app, window: win.title, action: a.op, element: { role: target.role, name: target.name } },
					questions: {
						irreversible: {
							type: "bool",
							instructions: "Would performing `action` on `element` have an effect that cannot be undone, such as sending a message, publishing, paying, purchasing, deleting data or submitting a form?",
							criteria: { true: "Sends, publishes, pays, buys, deletes, submits or is otherwise irreversible", false: "Navigation, editing, opening, selecting or anything that can be undone" },
						},
					},
				},
				signal,
			);
			const ans = d?.answers.irreversible;
			if (ans?.type === "bool" && ans.probability >= 0.5) {
				const tag = `model:${d!.via}:${ans.probability.toFixed(2)}`;
				const r = await this.guard(ctx, "确认可能不可逆的操作", `决策模型（${d!.via}）认为此操作可能无法撤销（p=${ans.probability.toFixed(2)}）。\n${win.app}「${win.title}」：${a.op} ${what}`);
				return r ? { refused: r, guard: tag } : { guard: `${tag}:confirmed` };
			}
		}
		return {};
	}

	async act(sessionId: string, ctx: ExtensionContext | undefined, spec: string | undefined, actions: ActionSpec[], signal?: AbortSignal): Promise<string> {
		this.ensureRunning();
		if (!actions.length) throw new UserFacingError("actions 为空");
		for (const a of actions) if (!OPS.includes(a.op)) throw new UserFacingError(`未知操作 ${a.op}；可用：${OPS.join(", ")}`);
		const s = this.session(sessionId);
		const d = await this.opts.driver();
		// The window comes from the first ref we know, else from `window` / the last one used.
		const known = this.targetOf(s, actions[0]!.ref).window;
		const win = spec || !known ? await this.resolveWindow(sessionId, spec) : known;
		const v = this.verdict(win);
		if (!v.ok) throw new UserFacingError(`不能操作该窗口：${v.reason}。`);
		if (!s.snaps.has(win.id)) s.snaps.set(win.id, await this.snap(win));
		const before = s.snaps.get(win.id)!;
		const windowsBefore = new Set((await d.call("windows.list", { all: true })).map((w) => w.id));

		const log: string[] = [];
		let failed = false;
		for (const a of actions) {
			this.ensureRunning();
			const { target, window: owner } = this.targetOf(s, a.ref);
			const where = owner ?? win;
			const ov = this.verdict(where);
			if (!ov.ok) {
				log.push(`✗ ${a.op} ${a.ref}：${ov.reason}`);
				failed = true;
				break;
			}
			const check = await this.checkAction(ctx, where, target, a, signal);
			const base = { session: sessionId, device: this.deviceName(), app: where.app, window: where.title, op: a.op, ref: a.ref, role: target?.role, name: target?.name, valueLength: a.value?.length, guard: check.guard };
			if (check.refused) {
				this.opts.audit.write({ ...base, ok: false, error: `refused: ${check.refused}` });
				log.push(`✗ ${a.op} ${a.ref}：已拒绝（${check.refused}）`);
				failed = true;
				break;
			}
			try {
				const r = await d.call("node.act", { ref: a.ref, op: a.op, ...(a.value !== undefined ? { value: a.value } : {}) });
				this.opts.audit.write({ ...base, ok: true, method: r.method });
				log.push(`✓ ${a.op} ${a.ref}${r.method === "synthetic" ? "（模拟输入）" : ""}`);
			} catch (e) {
				this.opts.audit.write({ ...base, ok: false, error: explain(e) });
				log.push(`✗ ${a.op} ${a.ref}：${explain(e)}`);
				failed = true;
				break;
			}
		}

		const out = [...log, "", ...(await this.report(s, win, before, windowsBefore, signal))];
		if (failed) out.push("", "后续操作已停止。");
		return out.join("\n").trim();
	}

	/** After an action: wait for the UI to settle, describe what changed, and show windows it opened. */
	private async report(s: SessionState, win: WindowInfo, before: WindowSnap, windowsBefore: ReadonlySet<string>, signal?: AbortSignal): Promise<string[]> {
		const d = await this.opts.driver();
		const out: string[] = [];
		const after = await this.settle(win, signal);
		if (!after) {
			s.snaps.delete(win.id);
			out.push(`窗口 [${win.id}] 已关闭。`);
		} else {
			s.snaps.set(win.id, after);
			const dd = diff(before.tree, after.tree, 40, after.focus);
			if (dd.big) {
				const r = render(after.tree, { budget: this.opts.settings().snapshotTokens, focus: after.focus });
				out.push(`界面变化较大，当前快照：`, this.header(after.window), r.text);
			} else if (dd.changes) {
				out.push(`变化（${this.header(win)}）：`, dd.text);
			} else {
				out.push("界面没有可见变化。");
			}
			if (after.focus && after.focus !== before.focus) out.push(`焦点：${after.focus}`);
		}

		// Dialogs, menus and new windows opened by the action are shown right away, unless the
		// window's own tree already contains them (modal dialogs appear as children of their owner).
		const inTree = after ? indexTree(after.tree) : new Map();
		const now = await d.call("windows.list", { all: true });
		const fresh = now.filter((w) => !windowsBefore.has(w.id) && (w.pid === win.pid || w.title));
		let budget = Math.floor(this.opts.settings().snapshotTokens / 2);
		for (const w of fresh.slice(0, 3)) {
			const v2 = this.verdict(w);
			if (!v2.ok) {
				out.push(`新窗口 [${w.id}] ${w.app}（禁止操作：${v2.reason}）`);
				continue;
			}
			try {
				const snap = await this.snap(w);
				s.snaps.set(w.id, snap);
				if (inTree.has(snap.tree.ref)) {
					out.push("", `新窗口：${this.header(w)}（即上面的 [${snap.tree.ref}]，用 window=${w.id} 操作）`);
					continue;
				}
				const r = render(snap.tree, { budget, focus: snap.focus });
				budget = Math.max(300, budget - estimateTokens(r.text));
				out.push("", `新窗口：${this.header(w)}`, r.text);
			} catch {}
		}
		return out;
	}

	async keys(sessionId: string, ctx: ExtensionContext | undefined, spec: string | undefined, keys: string | undefined, text: string | undefined, signal?: AbortSignal): Promise<string> {
		this.ensureRunning();
		if (!keys && !text) throw new UserFacingError("需要 keys 或 text");
		const s = this.session(sessionId);
		const win = await this.resolveWindow(sessionId, spec);
		const d = await this.opts.driver();
		if (!s.snaps.has(win.id)) s.snaps.set(win.id, await this.snap(win));
		const before = s.snaps.get(win.id)!;
		const focused = before.focus ? this.targetOf(s, before.focus).target : undefined;
		let guardTag: string | undefined;
		if (keys) {
			let reason = keysLookIrreversible(keys, win.app, focused);
			if (!reason && this.opts.decider.enabled && /(^|\+|\s)(enter|return)(\s|$)/i.test(keys)) {
				const r = await this.opts.decider.ask(
					ctx,
					{
						state: { app: win.app, window: win.title, keys, focused: focused ? { role: focused.role, name: focused.name ?? "" } : null },
						questions: {
							irreversible: {
								type: "bool",
								instructions: "Would pressing `keys` in this app most likely send, submit, publish, pay or delete something that cannot be undone?",
								criteria: { true: "Likely sends or submits irreversibly", false: "Inserts a newline, confirms a harmless dialog, navigates, or can be undone" },
							},
						},
					},
					signal,
				);
				const a = r?.answers.irreversible;
				if (a?.type === "bool" && a.probability >= 0.5) reason = `决策模型 ${r!.via}（p=${a.probability.toFixed(2)}）`;
			}
			if (reason) {
				guardTag = `keys:${reason}`;
				const refused = await this.guard(ctx, `确认按键：${keys}`, `在 ${win.app}「${win.title}」中按 ${keys} 可能会发送或提交内容（${reason}）。`);
				if (refused) {
					this.opts.audit.write({ session: sessionId, device: this.deviceName(), app: win.app, window: win.title, op: "keys", ok: false, error: `refused: ${refused}`, guard: guardTag });
					return `✗ 已拒绝按键 ${keys}：${refused}`;
				}
			}
		}
		const base = { session: sessionId, device: this.deviceName(), app: win.app, window: win.title, guard: guardTag };
		const windowsBefore = new Set((await d.call("windows.list", { all: true })).map((w) => w.id));
		try {
			if (text) {
				await d.call("input.text", { text, window: win.id }, 60_000);
				this.opts.audit.write({ ...base, op: "type_text", valueLength: text.length, ok: true, method: "synthetic" });
			}
			if (keys) {
				await d.call("input.keys", { keys, window: win.id });
				this.opts.audit.write({ ...base, op: "keys", name: keys, ok: true, method: "synthetic" });
			}
		} catch (e) {
			this.opts.audit.write({ ...base, op: keys ? "keys" : "type_text", ok: false, error: explain(e) });
			throw new UserFacingError(explain(e));
		}
		const head = `✓ 已发送${text ? `文本（${text.length} 字符）` : ""}${keys ? ` 按键 ${keys}` : ""}`;
		return [head, ...(await this.report(s, win, before, windowsBefore, signal))].join("\n").trim();
	}

	async launch(sessionId: string, target: string, args: string | undefined, signal?: AbortSignal): Promise<string> {
		this.ensureRunning();
		const base = target.split(/[\\/]/).pop() ?? target;
		const v = appVerdict({ app: base.replace(/\.(exe|app|lnk)$/i, ""), title: "", pid: -1 }, this.opts.settings(), this.opts.selfPids);
		if (!v.ok) throw new UserFacingError(`不能启动：${v.reason}`);
		const d = await this.opts.driver();
		const before = new Set((await d.call("windows.list", {})).map((w) => w.id));
		const r = await d.call("apps.launch", { target, ...(args ? { args } : {}) });
		this.opts.audit.write({ session: sessionId, device: this.deviceName(), app: base, window: "", op: "launch", name: target, ok: true });
		const end = Date.now() + 10_000;
		while (Date.now() < end) {
			await sleep(400, signal);
			const wins = await d.call("windows.list", {});
			const w = wins.find((x) => !before.has(x.id) && (r.pid === null || x.pid === r.pid)) ?? wins.find((x) => !before.has(x.id));
			if (w) {
				const allowed = this.verdict(w);
				if (!allowed.ok) return `已启动，但新窗口不能操作：${allowed.reason}`;
				this.session(sessionId).lastWindow = w.id;
				await sleep(300, signal);
				return `已启动。\n${await this.observe(sessionId, w.id, {})}`;
			}
		}
		return `已启动「${target}」${r.pid ? `（pid ${r.pid}）` : ""}，但 10 秒内没有出现新窗口。可能复用了已有窗口：用 computer_apps 查看。`;
	}
}
