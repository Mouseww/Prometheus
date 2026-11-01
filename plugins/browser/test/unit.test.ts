import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { decodeBinaryFrame, encodeBinaryFrame } from "@prometheus/protocol";
import { describe, expect, it } from "vitest";
import { checkUrl, toUrl } from "../src/browser.ts";
import { launchArgs } from "../src/chrome.ts";
import { extractZip } from "../src/install.ts";
import { comboEvents, MOD, parseCombo } from "../src/keys.ts";
import { sanitizeSettings } from "../src/settings.ts";
import { type AXNode, backendIdOf, toCUTree } from "../src/snapshot.ts";

describe("address bar", () => {
	const search = "https://www.bing.com/search?q=%s";
	it("keeps URLs, completes host names and searches the rest", () => {
		expect(toUrl("https://example.com/a?b", search)).toBe("https://example.com/a?b");
		expect(toUrl("example.com", search)).toBe("https://example.com");
		expect(toUrl("docs.python.org/3/library", search)).toBe("https://docs.python.org/3/library");
		expect(toUrl("localhost:5173", search)).toBe("http://localhost:5173");
		expect(toUrl("192.168.1.10:8080/x", search)).toBe("http://192.168.1.10:8080/x");
		expect(toUrl("how to cook rice", search)).toBe("https://www.bing.com/search?q=how%20to%20cook%20rice");
		expect(toUrl("天气 北京", search)).toBe(`https://www.bing.com/search?q=${encodeURIComponent("天气 北京")}`);
		expect(toUrl("", search)).toBe("about:blank");
		expect(toUrl("about:blank", search)).toBe("about:blank");
	});

	it("refuses browser-internal and script URLs", () => {
		for (const bad of ["chrome://settings", "javascript:alert(1)", "devtools://x", "edge://flags", "chrome-extension://abc/x.html"]) expect(() => checkUrl(bad)).toThrow();
		expect(() => checkUrl("https://example.com")).not.toThrow();
		// A typed "chrome://..." becomes a search, never a navigation to it.
		expect(toUrl("chrome://settings", search)).toContain("bing.com");
	});
});

describe("keys", () => {
	it("parses combos with modifiers and aliases", () => {
		const c = parseCombo("ctrl+shift+t");
		expect(c.modifiers).toBe(MOD.ctrl | MOD.shift);
		expect(c.key.code).toBe("KeyT");
		expect(parseCombo("Enter").key).toMatchObject({ key: "Enter", keyCode: 13, text: "\r" });
		expect(parseCombo("cmd+a").modifiers).toBe(MOD.meta);
		expect(parseCombo("ctrl++").key.key).toBe("+");
		expect(() => parseCombo("hyper+x")).toThrow("修饰键");
		expect(() => parseCombo("nosuchkey")).toThrow("按键");
	});

	it("presses modifiers around the key and types only without shortcut modifiers", () => {
		const ev = comboEvents(parseCombo("shift+a"), "win32");
		expect(ev.map((e) => `${e.type}:${e.key}`)).toEqual(["rawKeyDown:Shift", "keyDown:A", "keyUp:A", "keyUp:Shift"]);
		expect(ev[1]).toMatchObject({ text: "A", modifiers: MOD.shift });
		const ctrlA = comboEvents(parseCombo("ctrl+a"), "win32");
		expect(ctrlA[1]).toMatchObject({ type: "rawKeyDown", modifiers: MOD.ctrl });
		expect(ctrlA[1]).not.toHaveProperty("text");
		expect(ctrlA[1]).not.toHaveProperty("commands");
		// macOS needs the editing command spelled out.
		expect(comboEvents(parseCombo("cmd+a"), "darwin")[1]).toMatchObject({ commands: ["selectAll"] });
		expect(comboEvents(parseCombo("cmd+shift+z"), "darwin")[2]).toMatchObject({ commands: ["redo"] });
	});
});

describe("settings", () => {
	it("keeps sane values only", () => {
		expect(sanitizeSettings({ quality: 500, maxFps: 1, idleMinutes: -3, mode: "window", proxy: "socks5://127.0.0.1:1080", lang: "zh-CN", allowEval: false })).toEqual({
			quality: 95,
			maxFps: 5,
			idleMinutes: 0,
			mode: "window",
			proxy: "socks5://127.0.0.1:1080",
			lang: "zh-CN",
			allowEval: false,
		});
		expect(sanitizeSettings({ proxy: "rm -rf /", searchUrl: "javascript:x", lang: "zh CN; x", mode: "fullscreen", extra: 1 })).toEqual({});
		expect(sanitizeSettings({ proxy: "" })).toEqual({ proxy: "" });
	});
});

describe("launch arguments", () => {
	const base = { executable: "chrome", profileDir: "/p", proxy: "", lang: "en-US", window: { width: 800, height: 600 } };
	it("uses a pipe, a private profile and no automation switch", () => {
		const a = launchArgs({ ...base, headless: true });
		expect(a).toContain("--remote-debugging-pipe");
		expect(a).toContain("--user-data-dir=/p");
		expect(a).toContain("--headless=new");
		expect(a).toContain("--disable-blink-features=AutomationControlled");
		expect(a.some((x) => x.startsWith("--remote-debugging-port"))).toBe(false);
		expect(a).not.toContain("--enable-automation");
		expect(a[a.length - 1]).toBe("about:blank");
		expect(launchArgs({ ...base, headless: false })).not.toContain("--headless=new");
		expect(launchArgs({ ...base, headless: true, proxy: "http://h:1" })).toContain("--proxy-server=http://h:1");
	});
});

describe("accessibility tree", () => {
	const v = (value: unknown) => ({ type: "string", value });
	const nodes: AXNode[] = [
		{ nodeId: "1", role: v("RootWebArea"), name: v("Page"), childIds: ["2", "3", "6", "8"], backendDOMNodeId: 10 },
		{ nodeId: "2", parentId: "1", role: v("heading"), name: v("Title"), properties: [{ name: "level", value: { type: "integer", value: 2 } }], childIds: [], backendDOMNodeId: 11 },
		// An ignored wrapper: its children move up.
		{ nodeId: "3", parentId: "1", ignored: true, role: v("generic"), childIds: ["4", "5"], backendDOMNodeId: 12 },
		{ nodeId: "4", parentId: "3", role: v("textbox"), name: v("Email"), value: v("a@b.c"), properties: [{ name: "focused", value: { type: "boolean", value: true } }], childIds: [], backendDOMNodeId: 13 },
		{ nodeId: "5", parentId: "3", role: v("textbox"), name: v("Password"), value: v("•••"), childIds: [], backendDOMNodeId: 14 },
		{ nodeId: "6", parentId: "1", role: v("link"), name: v("Docs"), properties: [{ name: "url", value: v("https://x.dev/docs") }], childIds: ["7"], backendDOMNodeId: 15 },
		{ nodeId: "7", parentId: "6", role: v("InlineTextBox"), childIds: [] },
		{ nodeId: "8", parentId: "1", role: v("Iframe"), childIds: [], backendDOMNodeId: 16 },
	];
	const frame: AXNode[] = [
		{ nodeId: "1", role: v("RootWebArea"), name: v("Inner"), childIds: ["2"], backendDOMNodeId: 20 },
		{ nodeId: "2", parentId: "1", role: v("checkbox"), name: v("Agree"), properties: [{ name: "checked", value: { type: "tristate", value: "false" } }], childIds: [], backendDOMNodeId: 21 },
	];

	it("maps roles and states, flattens ignored nodes and grafts frames", () => {
		const { root, focus } = toCUTree({ nodes, frames: new Map([[16, frame]]), secrets: new Set([14]) });
		expect(focus).toBe("e13");
		expect(root.role).toBe("document");
		const kids = root.children ?? [];
		expect(kids.map((k) => `${k.ref} ${k.role} ${k.name ?? ""}`)).toEqual(["e11 h2 Title", "e13 textbox Email", "e14 textbox Password", "e15 link Docs", "e16 frame "]);
		expect(kids[1]).toMatchObject({ value: "a@b.c", states: ["focused", "editable"] });
		expect(kids[2]?.states).toContain("password");
		expect(kids[3]).toMatchObject({ value: "https://x.dev/docs" });
		expect(kids[3]?.children).toBeUndefined();
		expect(kids[4]?.children?.[0]?.children?.[0]).toMatchObject({ ref: "e21", role: "checkbox", states: ["unchecked"] });
	});

	it("reads refs back", () => {
		expect(backendIdOf("e42")).toBe(42);
		expect(backendIdOf(" e7 ")).toBe(7);
		expect(backendIdOf("a42")).toBeUndefined();
		expect(backendIdOf("42")).toBeUndefined();
	});
});

/** A minimal zip writer (stored + deflated entries) to feed the extractor. */
function makeZip(entries: { name: string; data?: Buffer; mode?: number }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name);
		const raw = e.data ?? Buffer.alloc(0);
		const deflate = raw.length > 0;
		const body = deflate ? deflateRawSync(raw) : raw;
		const crc = crc32(raw);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(deflate ? 8 : 0, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, body);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(deflate ? 8 : 0, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(((e.mode ?? (e.name.endsWith("/") ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += 30 + name.length + body.length;
	}
	const cd = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

describe("zip extraction", () => {
	it("unpacks folders and files, keeps the executable bit, and refuses paths that escape", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pm-zip-"));
		try {
			const zip = join(dir, "a.zip");
			const text = Buffer.from("hello ".repeat(1000));
			await writeFile(zip, makeZip([{ name: "chrome-x/" }, { name: "chrome-x/chrome", data: text, mode: 0o100755 }, { name: "chrome-x/empty.txt" }]));
			await extractZip(zip, join(dir, "out"));
			expect(readFileSync(join(dir, "out/chrome-x/chrome"), "utf8")).toBe(text.toString());
			expect(existsSync(join(dir, "out/chrome-x/empty.txt"))).toBe(true);
			const evil = join(dir, "evil.zip");
			await writeFile(evil, makeZip([{ name: "../escape.txt", data: Buffer.from("x") }]));
			await expect(extractZip(evil, join(dir, "out2"))).rejects.toThrow("越界");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("binary frames", () => {
	it("round-trips a header and raw bytes", () => {
		const payload = new Uint8Array([0xff, 0xd8, 0, 1, 2, 3]);
		const bytes = encodeBinaryFrame({ type: "plugin.event", plugin: "browser", topic: "view", data: { k: "frame", w: 10 } }, payload);
		const back = decodeBinaryFrame(bytes);
		expect(back?.header).toEqual({ type: "plugin.event", plugin: "browser", topic: "view", data: { k: "frame", w: 10 } });
		expect([...(back?.payload ?? [])]).toEqual([...payload]);
		expect(decodeBinaryFrame(new Uint8Array([0, 0, 0, 99, 1]))).toBeUndefined();
		expect(decodeBinaryFrame(new Uint8Array([0, 0]))).toBeUndefined();
	});
});

describe("phone support", () => {
	it("turns the user agent into an Android phone's", async () => {
		const { mobileUserAgent } = await import("../src/tab.ts");
		const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36";
		expect(mobileUserAgent(ua)).toBe("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36");
		expect(mobileUserAgent(undefined)).toBeUndefined();
	});

	it("finds the browser the app installs in its rootfs", async () => {
		const { guestInfo } = await import("../src/guest.ts");
		expect(guestInfo({})).toBeUndefined();
		const g = guestInfo({ PROMETHEUS_ROOTFS: "/data/rootfs", PROMETHEUS_TOOLS_BIN: "/data/bin" } as NodeJS.ProcessEnv)!;
		expect(g.exe).toBe("/opt/chromium/chrome-headless-shell-linux-arm64/chrome-headless-shell");
		expect(g.runner.split("\\").join("/")).toBe("/data/bin/guestrun");
		expect(g.installed).toBe(false);
	});

	it("starts the phone's browser on a debugging port with the flags PRoot needs", async () => {
		const { launchArgs } = await import("../src/chrome.ts");
		const args = launchArgs({ executable: "/x", profileDir: "/p", headless: true, proxy: "", lang: "en-US", window: { width: 1, height: 1 }, guest: { runner: "/r", cwd: "/c" } });
		expect(args).toContain("--remote-debugging-port=0");
		expect(args).not.toContain("--remote-debugging-pipe");
		expect(args).not.toContain("--headless=new");
		expect(args).toEqual(expect.arrayContaining(["--no-sandbox", "--no-zygote", "--disable-gpu", "--disable-dev-shm-usage"]));
	});
});
