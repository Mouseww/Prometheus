import { execFile } from "node:child_process";
import type { ActResult, CUNode, Driver, DriverHello, DriverMethod, DriverMethods, Op, SnapshotResult, WindowInfo } from "../protocol.ts";
import { DriverCallError } from "./rpc.ts";

/**
 * Android over adb (USB or wireless debugging): the screen is read with `uiautomator dump` and acted on with
 * `input`. Nothing is installed on the phone. Limits compared with the other drivers: a dump takes 1-2 s, there
 * are no change events (the host polls), and `input text` cannot type non-ASCII unless the ADB Keyboard IME is
 * installed. The AccessibilityService driver replaces this for daily use.
 */

// ---------- uiautomator XML ----------

interface RawNode {
	attrs: Record<string, string>;
	children: RawNode[];
}

const ATTR = /([\w:-]+)="([^"]*)"/g;
const unescapeXml = (s: string) =>
	s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Minimal parser for the flat `<node .../>` XML uiautomator writes. */
export function parseDump(xml: string): RawNode | undefined {
	const start = xml.indexOf("<hierarchy");
	if (start < 0) return undefined;
	const root: RawNode = { attrs: {}, children: [] };
	const stack: RawNode[] = [root];
	const tag = /<(\/?)(hierarchy|node)\b([^>]*?)(\/?)>/g;
	tag.lastIndex = start;
	let m: RegExpExecArray | null;
	while ((m = tag.exec(xml))) {
		const [, closing, name, body, selfClose] = m;
		if (closing) {
			if (stack.length > 1) stack.pop();
			continue;
		}
		const attrs: Record<string, string> = {};
		for (const a of body!.matchAll(ATTR)) attrs[a[1]!] = unescapeXml(a[2]!);
		const node: RawNode = { attrs, children: [] };
		stack[stack.length - 1]!.children.push(node);
		if (name === "node" && !selfClose) stack.push(node);
		else if (name === "hierarchy" && !selfClose) stack.push(node);
	}
	const hierarchy = root.children[0];
	// uiautomator wraps a single top node (one display) in <hierarchy>; hand back that node.
	return hierarchy && hierarchy.children.length === 1 ? hierarchy.children[0] : hierarchy;
}

const CLASS_ROLES: [RegExp, string][] = [
	[/EditText|AutoCompleteTextView|SearchView/, "textbox"],
	[/Button$|ImageButton/, "button"],
	[/CheckBox|Switch|ToggleButton/, "checkbox"],
	[/RadioButton/, "radio"],
	[/Spinner/, "combobox"],
	[/SeekBar|Slider/, "slider"],
	[/ProgressBar/, "progressbar"],
	[/TabWidget|TabLayout/, "tablist"],
	[/WebView/, "document"],
	[/ListView|RecyclerView|GridView|ViewPager/, "list"],
	[/ScrollView/, "pane"],
	[/ImageView/, "image"],
	[/TextView|CheckedTextView/, "text"],
	[/Toolbar|ActionBar/, "toolbar"],
];

function parseBounds(s: string | undefined): [number, number, number, number] | undefined {
	const m = s?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
	if (!m) return undefined;
	const [l, t, r, b] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	return r > l && b > t ? [l, t, r - l, b - t] : undefined;
}

export interface AndroidTree {
	root: CUNode;
	/** ref -> screen centre, for taps. */
	centres: Map<string, [number, number]>;
	/** ref -> text currently in the field. */
	texts: Map<string, string>;
}

/** Turns a dump into protocol nodes; `refFor` keeps a node's ref stable across dumps. */
export function toTree(raw: RawNode, refFor: (key: string) => string): AndroidTree {
	const centres = new Map<string, [number, number]>();
	const texts = new Map<string, string>();
	const conv = (n: RawNode, path: string): CUNode => {
		const a = n.attrs;
		const cls = a.class ?? "";
		let role = CLASS_ROLES.find(([re]) => re.test(cls))?.[1] ?? (n.children.length ? "group" : "custom");
		if (a.password === "true") role = "textbox";
		// A password field's text must never leak into its name.
		const name = ((a.password === "true" ? "" : a.text) || a["content-desc"] || "").trim();
		const rid = a["resource-id"]?.replace(/^.*:id\//, "");
		const key = `${a.package ?? ""}|${a["resource-id"] ?? ""}|${cls}|${name}|${path}`;
		const ref = refFor(key);
		const states: string[] = [];
		const actions: string[] = [];
		if (a.password === "true") states.push("password");
		if (a.enabled === "false") states.push("disabled");
		if (a.focused === "true") states.push("focused");
		if (a.selected === "true") states.push("selected");
		if (a.checkable === "true") {
			states.push(a.checked === "true" ? "checked" : "unchecked");
			actions.push("toggle");
		}
		if (/EditText|AutoCompleteTextView/.test(cls)) {
			states.push("editable");
			actions.push("set_value", "type", "clear");
		}
		if (a.clickable === "true" || a.checkable === "true") actions.push("click");
		if (a["long-clickable"] === "true") actions.push("right_click");
		if (a.scrollable === "true") actions.push("scroll");
		if (role === "combobox") actions.push("select");
		const out: CUNode = { ref, role, className: cls };
		if (name) out.name = name.slice(0, 400);
		if (rid) out.id = rid;
		if (a.password !== "true" && /EditText|AutoCompleteTextView/.test(cls) && a.text) out.value = a.text;
		if (a.text && a.password !== "true") texts.set(ref, a.text);
		const b = parseBounds(a.bounds);
		if (b) {
			out.bounds = b;
			centres.set(ref, [b[0] + Math.floor(b[2] / 2), b[1] + Math.floor(b[3] / 2)]);
		}
		if (states.length) out.states = states;
		if (actions.length) out.actions = [...new Set(actions)];
		if (n.children.length) out.children = n.children.map((c, i) => conv(c, `${path}/${i}`));
		return out;
	};
	return { root: conv(raw, "0"), centres, texts };
}

// ---------- keys ----------

const KEYCODES: Record<string, number> = {
	back: 4, esc: 4, escape: 4, home: 3, recents: 187, enter: 66, return: 66, tab: 61, space: 62, backspace: 67, delete: 112, del: 112,
	up: 19, down: 20, left: 21, right: 22, menu: 82, search: 84, power: 26, "volume_up": 24, "volume_down": 25, pageup: 92, pagedown: 93,
	end: 123, home_key: 122, notifications: 83,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- driver ----------

export class AdbDriver implements Driver {
	readonly hello: DriverHello;
	closed = false;
	private readonly adb: string;
	private readonly serial: string | undefined;
	private refs = new Map<string, string>();
	private next = 1;
	private last: AndroidTree | undefined;

	private constructor(adb: string, serial: string | undefined, hello: DriverHello) {
		this.adb = adb;
		this.serial = serial;
		this.hello = hello;
	}

	static async connect(adb = "adb", serial?: string): Promise<AdbDriver> {
		const probe = new AdbDriver(adb, serial, { platform: "android", version: "adb-0.1", capabilities: [], permissions: {} });
		const state = (await probe.sh(["get-state"], false)).trim();
		if (state !== "device") throw new DriverCallError("unsupported", `没有可用的 Android 设备（adb 状态：${state || "无"}）。请连接设备并开启 USB 调试。`);
		const model = (await probe.shell("getprop ro.product.model")).trim();
		const ver = (await probe.shell("getprop ro.build.version.release")).trim();
		const hasKbd = (await probe.shell("ime list -s")).includes("com.android.adbkeyboard");
		return new AdbDriver(adb, serial, {
			platform: "android",
			version: "adb-0.1",
			os: `Android ${ver} (${model})`,
			capabilities: ["tree", "semantic_actions", "synthetic_input"],
			permissions: { accessibility: "granted", adb_keyboard: hasKbd ? "installed" : "missing (non-ASCII text needs it)" },
		});
	}

	private args(extra: string[], exec: boolean): string[] {
		return [...(this.serial ? ["-s", this.serial] : []), ...(exec ? ["exec-out"] : []), ...extra];
	}

	private sh(args: string[], rejectOnFail = true): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(this.adb, this.args(args, false), { maxBuffer: 32 * 1024 * 1024, encoding: "utf8", timeout: 30_000 }, (err, stdout, stderr) => {
				if (err && rejectOnFail) reject(new DriverCallError("internal", `adb 失败：${(stderr || err.message).trim()}`));
				else resolve(String(stdout));
			});
		});
	}

	private shell(cmd: string): Promise<string> {
		return this.sh(["shell", cmd]);
	}

	close(): void {
		this.closed = true;
	}

	async call<M extends DriverMethod>(method: M, params: DriverMethods[M]["params"]): Promise<DriverMethods[M]["result"]> {
		const p = params as Record<string, unknown>;
		const out = await this.dispatch(method, p);
		return out as DriverMethods[M]["result"];
	}

	private async dispatch(method: string, p: Record<string, unknown>): Promise<unknown> {
		switch (method) {
			case "hello":
				return this.hello;
			case "windows.list":
				return this.windows();
			case "window.activate":
				return { ok: true, method: "noop" } satisfies ActResult;
			case "apps.launch":
				return this.launch(String(p.target ?? ""));
			case "tree.snapshot":
				return this.snapshot();
			case "node.act":
				return this.act(String(p.ref), p.op as Op, p.value as string | undefined);
			case "input.keys":
				return this.keys(String(p.keys ?? ""));
			case "input.text":
				await this.typeText(String(p.text ?? ""));
				return { ok: true, method: "synthetic" } satisfies ActResult;
			default:
				throw new DriverCallError("unknown_method", `Unknown method: ${method}`);
		}
	}

	private async windows(): Promise<WindowInfo[]> {
		const out = await this.shell("dumpsys window displays | grep -E 'mCurrentFocus|mFocusedApp'");
		const m = out.match(/mCurrentFocus=Window\{\S+ \S+ ([\w.]+)\/([\w.$]+)/) ?? out.match(/ActivityRecord\{\S+ \S+ ([\w.]+)\/([\w.$]+)/);
		const pkg = m?.[1] ?? "unknown";
		return [{ id: "screen", pid: 0, app: pkg, bundleId: pkg, title: m?.[2] ?? "", focused: true }];
	}

	private async launch(target: string): Promise<{ ok: boolean; pid: number | null }> {
		if (/^[a-z]+:\/\//i.test(target)) await this.shell(`am start -a android.intent.action.VIEW -d ${JSON.stringify(target)}`);
		else if (/^[\w.]+$/.test(target)) await this.shell(`monkey -p ${target} -c android.intent.category.LAUNCHER 1`);
		else throw new DriverCallError("bad_params", "target 应为包名（com.android.settings）或 URL");
		return { ok: true, pid: null };
	}

	private refFor = (key: string): string => {
		let r = this.refs.get(key);
		if (!r) {
			r = `e${this.next++}`;
			this.refs.set(key, r);
		}
		return r;
	};

	private dumpOnce(): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			execFile(this.adb, this.args(["uiautomator", "dump", "/dev/tty"], true), { maxBuffer: 64 * 1024 * 1024, encoding: "utf8", timeout: 30_000 }, (err, stdout) => {
				if (err) reject(new DriverCallError("internal", `uiautomator dump 失败：${err.message}`));
				else resolve(String(stdout));
			});
		});
	}

	private async dump(): Promise<AndroidTree> {
		// While a transition or animation runs, uiautomator cannot reach an idle state and prints an error instead of XML.
		let raw: RawNode | undefined;
		for (let attempt = 0; attempt < 5 && !raw; attempt++) {
			if (attempt) await sleep(600);
			raw = parseDump(await this.dumpOnce());
		}
		if (!raw) throw new DriverCallError("internal", "uiautomator 没有返回界面（屏幕可能已锁定、一直在动画，或应用禁止了无障碍读取）");
		this.last = toTree(raw, this.refFor);
		return this.last;
	}

	private async snapshot(): Promise<SnapshotResult> {
		const t = await this.dump();
		const focus = [...t.texts.keys()].find(() => false);
		return { root: t.root, truncated: false, ...(focus ? { focus } : {}) };
	}

	private async tap(x: number, y: number, hold = 0): Promise<void> {
		await this.shell(hold ? `input swipe ${x} ${y} ${x} ${y} ${hold}` : `input tap ${x} ${y}`);
	}

	private centre(ref: string): [number, number] {
		const c = this.last?.centres.get(ref);
		if (!c) throw new DriverCallError(this.refs.size ? "stale_ref" : "unknown_ref", `${ref} 不在最近一次界面中，请重新 computer_observe`);
		return c;
	}

	private async act(ref: string, op: Op, value?: string): Promise<ActResult> {
		const [x, y] = this.centre(ref);
		const done = (method: string): ActResult => ({ ok: true, method });
		switch (op) {
			case "click":
			case "focus":
			case "toggle":
				await this.tap(x, y);
				return done("tap");
			case "double_click":
				await this.tap(x, y);
				await sleep(80);
				await this.tap(x, y);
				return done("tap");
			case "right_click":
				await this.tap(x, y, 800);
				return done("long_press");
			case "clear":
			case "set_value": {
				await this.tap(x, y);
				await sleep(150);
				const len = (this.last?.texts.get(ref) ?? "").length;
				await this.shell("input keyevent 123"); // move to end
				if (len) await this.shell(`input keyevent ${Array(len + 2).fill(67).join(" ")}`);
				if (op === "set_value" && value) await this.typeText(value);
				return done("synthetic");
			}
			case "type":
				await this.tap(x, y);
				await sleep(150);
				await this.typeText(value ?? "");
				return done("synthetic");
			case "select": {
				await this.tap(x, y);
				if (value) {
					await sleep(500);
					const t = await this.dump();
					const hit = [...t.texts].find(([r, s]) => s === value && r !== ref);
					if (!hit) throw new DriverCallError("not_found", `没有名为「${value}」的选项`);
					const [hx, hy] = t.centres.get(hit[0])!;
					await this.tap(hx, hy);
				}
				return done("tap");
			}
			case "scroll": {
				const b = this.boundsOf(ref);
				const [cx] = [x];
				const h = b?.[3] ?? 800;
				const d = (value ?? "down").toLowerCase();
				const dy = Math.floor(h * 0.35);
				const w = b?.[2] ?? 600;
				const dx = Math.floor(w * 0.35);
				const cmd = { down: [cx, y + dy, cx, y - dy], up: [cx, y - dy, cx, y + dy], left: [x - dx, y, x + dx, y], right: [x + dx, y, x - dx, y] }[d];
				if (!cmd) throw new DriverCallError("bad_params", "scroll value must be up, down, left or right");
				await this.shell(`input swipe ${cmd.join(" ")} 300`);
				return done("swipe");
			}
			default:
				throw new DriverCallError("unsupported", `Android 暂不支持 ${op}`);
		}
	}

	private boundsOf(ref: string): [number, number, number, number] | undefined {
		const find = (n: CUNode): CUNode | undefined => (n.ref === ref ? n : n.children?.map(find).find(Boolean));
		return this.last ? find(this.last.root)?.bounds : undefined;
	}

	private async typeText(text: string): Promise<void> {
		if (!text) return;
		if (/^[\x20-\x7e]*$/.test(text)) {
			// `input text` takes %s for a space and needs shell metacharacters escaped.
			const esc = text.replace(/([\\"'`$&|;<>()*?!#~{}[\]^])/g, "\\$1").replace(/ /g, "%s");
			for (const line of esc.split("\n")) {
				if (line) await this.shell(`input text "${line}"`);
				if (esc.includes("\n")) await this.shell("input keyevent 66");
			}
			return;
		}
		if (this.hello.permissions.adb_keyboard === "installed") {
			const b64 = Buffer.from(text, "utf8").toString("base64");
			await this.shell(`am broadcast -a ADB_INPUT_B64 --es msg ${b64}`);
			return;
		}
		throw new DriverCallError("unsupported", "输入中文等非 ASCII 文本需要在手机上安装并启用 ADB Keyboard（com.android.adbkeyboard）。");
	}

	private async keys(combo: string): Promise<ActResult> {
		for (const part of combo.split(/\s+/).filter(Boolean)) {
			const k = KEYCODES[part.toLowerCase()];
			if (k === undefined) throw new DriverCallError("bad_params", `Android 不支持按键「${part}」；可用：${Object.keys(KEYCODES).join(", ")}`);
			await this.shell(`input keyevent ${k}`);
		}
		return { ok: true, method: "synthetic" };
	}
}
