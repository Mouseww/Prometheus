// Drives a real Chromium-family browser. Skipped where none is installed.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserAgent } from "../src/agent.ts";
import { BrowserCore } from "../src/browser.ts";
import { systemBrowsers } from "../src/chrome.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import type { ViewMessage } from "../src/types.ts";
import { startSite } from "./fixtures.ts";

const haveBrowser = systemBrowsers().length > 0 && process.env.PROMETHEUS_SKIP_BROWSER !== "1";

/** Ref of the first snapshot line with this role whose name starts with `name`. */
function refOf(snapshot: string, role: string, name: string): string {
	for (const line of snapshot.split("\n")) {
		const m = /^\s*\[(e\d+)\] (\S+)(?: "([^"]*)")?/.exec(line);
		if (m && m[2] === role && (m[3] ?? "").startsWith(name)) return m[1] as string;
	}
	throw new Error(`no ${role} "${name}" in:\n${snapshot}`);
}

describe.skipIf(!haveBrowser)("built-in browser (real Chromium)", () => {
	let site: Awaited<ReturnType<typeof startSite>>;
	let dataDir: string;
	let core: BrowserCore;
	let agent: BrowserAgent;
	let watchers = 0;
	const messages: { msg: ViewMessage; binary?: Uint8Array }[] = [];
	const signal = new AbortController().signal;
	const run = <T>(fn: (s: AbortSignal) => Promise<T>) => core.asAgent("s1", "test", fn, signal);

	beforeAll(async () => {
		site = await startSite();
		dataDir = await mkdtemp(join(tmpdir(), "pm-browser-e2e-"));
		core = new BrowserCore({
			dataDir,
			settings: () => ({ ...DEFAULT_SETTINGS, restoreTabs: false, maxFps: 60 }),
			publish: (msg, binary) => void messages.push({ msg, binary }),
			watchers: () => watchers,
			log: () => {},
		});
		agent = new BrowserAgent(core, () => true);
	});

	afterAll(async () => {
		await core?.dispose();
		site?.server.close();
		await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
	});

	it("starts, navigates and reads the page as a tree with refs", async () => {
		const out = await run((s) => agent.navigate("s1", { url: `${site.url}/form` }, s));
		expect(core.state().status).toBe("running");
		expect(out).toContain('"Form"');
		expect(out).toMatch(/\[e\d+\] textbox "Name" editable/);
		// Password values never reach the model.
		expect(out).toMatch(/textbox "Password" = "••••" editable password/);
		expect(out).not.toContain("hunter2");
		expect(core.userAgent() ?? "").not.toContain("Headless");
	});

	it("fills a form and reports what changed", async () => {
		const snap = await run(() => agent.snapshot("s1", {}));
		const file = join(dataDir, "upload.txt");
		await writeFile(file, "hi");
		// The file input is a button whose label depends on the system language; it is the one with a value.
		const fileRef = /\[(e\d+)\] button "[^"]*" = "[^"]*"/.exec(snap)?.[1] ?? "";
		const out = await run((s) =>
			agent.act(
				"s1",
				[
					{ ref: refOf(snap, "textbox", "Name"), op: "set_value", value: "Ada 你好" },
					{ ref: refOf(snap, "combobox", "Color"), op: "select", value: "blue" },
					{ ref: refOf(snap, "checkbox", "I agree"), op: "toggle" },
					{ ref: fileRef, op: "upload", value: file },
					{ ref: refOf(snap, "button", "Submit"), op: "click" },
				],
				undefined,
				s,
			),
		);
		expect(out).not.toContain("✗");
		expect(out).toContain('value → "Ada 你好"');
		const result = await run(() => agent.evaluate("s1", { expression: "document.getElementById('result').textContent" }));
		expect(result).toBe("Hello Ada 你好 b true upload.txt");
	});

	it("refuses to click through something that covers the element, unless forced", async () => {
		await run(() => agent.evaluate("s1", { expression: "document.getElementById('cover').style.display = 'block'" }));
		const snap = await run(() => agent.snapshot("s1", {}));
		const submit = refOf(snap, "button", "Submit");
		const blocked = await run((s) => agent.act("s1", [{ ref: submit, op: "click" }], undefined, s));
		expect(blocked).toContain("挡住");
		const forced = await run((s) => agent.act("s1", [{ ref: submit, op: "click", value: "force" }], undefined, s));
		expect(forced).toContain("✓");
		await run(() => agent.evaluate("s1", { expression: "document.getElementById('cover').style.display = 'none'" }));
	});

	it("handles JavaScript dialogs without hanging", async () => {
		await run((s) => agent.navigate("s1", { url: site.url }, s));
		const snap = await run(() => agent.snapshot("s1", {}));
		const opened = await run((s) => agent.act("s1", [{ ref: refOf(snap, "button", "Confirm me"), op: "click" }], undefined, s));
		expect(opened).toContain("confirm 对话框");
		expect(core.activeTab?.dialog?.message).toBe("sure?");
		const answered = await run((s) => agent.act("s1", [{ ref: "dialog", op: "dismiss" }], undefined, s));
		expect(answered).toContain("已取消对话框");
		expect(await run(() => agent.evaluate("s1", { expression: "document.getElementById('out').textContent" }))).toBe("no");
	});

	it("follows a link that opens a new tab", async () => {
		const snap = await run(() => agent.snapshot("s1", {}));
		const out = await run((s) => agent.act("s1", [{ ref: refOf(snap, "link", "Open popup"), op: "click" }], undefined, s));
		expect(out).toContain("页面打开了新标签");
		expect(out).toContain('"Popup"');
		expect(core.activeTab?.url).toContain("/popup");
		const tabs = await run(() => agent.tabs("s1", {}));
		expect(tabs.split("\n").length).toBeGreaterThanOrEqual(3);
		await run(() => agent.tabs("s1", { action: "close" }));
		expect(core.allTabs().some((t) => t.url.includes("/popup"))).toBe(false);
	});

	it("reads same-origin iframes and plain page text", async () => {
		const out = await run((s) => agent.navigate("s1", { url: `${site.url}/frame` }, s));
		expect(out).toContain('h1 "Outer"');
		expect(out).toContain('h1 "Sign up"');
		const text = await run(() => agent.snapshot("s1", { mode: "text" }));
		expect(text).toContain("Outer");
	});

	it("keys and screenshots", async () => {
		await run((s) => agent.navigate("s1", { url: `${site.url}/form` }, s));
		const snap = await run(() => agent.snapshot("s1", {}));
		await run((s) => agent.act("s1", [{ ref: refOf(snap, "textbox", "Name"), op: "focus" }], undefined, s));
		await run((s) => agent.keys("s1", { text: "abc", keys: "shift+arrowleft backspace" }, s));
		expect(await run(() => agent.evaluate("s1", { expression: "document.getElementById('name').value" }))).toBe("ab");
		const shot = await run(() => agent.screenshot("s1", {}));
		expect(Buffer.from(shot.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
	});

	it("streams frames to watchers and takes user input", async () => {
		messages.length = 0;
		watchers = 1;
		core.greet();
		core.updateScreencast();
		const tab = core.activeTab!;
		await run(() => agent.evaluate("s1", { expression: "document.getElementById('name').value = ''" }));
		await core.setViewport({ width: 900, height: 600, dpr: 1 });
		const deadline = Date.now() + 5000;
		while (!messages.some((m) => m.msg.k === "frame" && m.binary?.length) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		const frame = messages.find((m) => m.msg.k === "frame" && m.binary?.length);
		expect(frame?.binary?.[0]).toBe(0xff);
		const box = JSON.parse(
			(await tab.send<{ result: { value: string } }>("Runtime.evaluate", { expression: "JSON.stringify(document.getElementById('name').getBoundingClientRect())", returnByValue: true })).result.value,
		) as { x: number; y: number };
		await core.input(tab, [
			{ k: "mouse", type: "mousePressed", x: box.x + 4, y: box.y + 4, button: "left", buttons: 1, clickCount: 1 },
			{ k: "mouse", type: "mouseReleased", x: box.x + 4, y: box.y + 4, button: "left", clickCount: 1 },
			{ k: "text", text: "typed" },
		]);
		expect(await run(() => agent.evaluate("s1", { expression: "document.getElementById('name').value" }))).toBe("typed");
		// The select popup Chromium cannot draw headless is reported for the app to draw.
		const sel = JSON.parse(
			(await tab.send<{ result: { value: string } }>("Runtime.evaluate", { expression: "JSON.stringify(document.getElementById('color').getBoundingClientRect())", returnByValue: true })).result.value,
		) as { x: number; y: number };
		await core.input(tab, [
			{ k: "mouse", type: "mousePressed", x: sel.x + 4, y: sel.y + 4, button: "left", buttons: 1, clickCount: 1 },
			{ k: "mouse", type: "mouseReleased", x: sel.x + 4, y: sel.y + 4, button: "left", clickCount: 1 },
		]);
		const deadline2 = Date.now() + 3000;
		while (!messages.some((m) => m.msg.k === "select") && Date.now() < deadline2) await new Promise((r) => setTimeout(r, 50));
		const popup = messages.find((m) => m.msg.k === "select")?.msg;
		expect(popup && popup.k === "select" && popup.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue"]);
		await core.chooseOption(tab, 1);
		expect(await run(() => agent.evaluate("s1", { expression: "document.getElementById('color').value" }))).toBe("g");
		watchers = 0;
		core.updateScreencast();
	});

	it("blocks the agent after a takeover until the browser is handed back", async () => {
		core.takeOver();
		await expect(run(() => agent.snapshot("s1", {}))).rejects.toThrow("用户已接管");
		core.handBack();
		expect(await run(() => agent.snapshot("s1", {}))).toContain("Form");
	});

	it("lays pages out as a phone for a phone-sized viewer, and takes real touches", async () => {
		await run((s) => agent.navigate("s1", { url: `${site.url}/touch` }, s));
		const tab = core.activeTab!;
		const evalIn = async (expr: string) => (await tab.send<{ result: { value: unknown } }>("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
		const touchPointsBefore = await evalIn("navigator.maxTouchPoints");
		await core.setViewport({ width: 400, height: 700, dpr: 2, mobile: true });
		await run((s) => agent.navigate("s1", { action: "reload" }, s));
		expect(await evalIn("document.getElementById('info').textContent")).toBe("400,5,true,true");
		// A tap is a touch, and Chromium turns it into the click.
		await core.input(tab, [
			{ k: "touch", type: "touchStart", points: [{ x: 100, y: 40, id: 0 }] },
			{ k: "touch", type: "touchEnd", points: [] },
		]);
		await expect.poll(() => evalIn("document.title"), { timeout: 4000 }).toBe("tapped");
		// A drag scrolls the page.
		for (const dy of [0, -30, -60, -90, -120, -150]) await core.input(tab, [{ k: "touch", type: dy === 0 ? "touchStart" : "touchMove", points: [{ x: 100, y: 400 + dy, id: 0 }] }]);
		await core.input(tab, [{ k: "touch", type: "touchEnd", points: [] }]);
		await expect.poll(() => evalIn("scrollY"), { timeout: 4000 }).toBeGreaterThan(50);
		// Turning it off lays the page out as on a computer again.
		await core.setViewport({ width: 400, height: 700, dpr: 2, mobile: false });
		await run((s) => agent.navigate("s1", { action: "reload" }, s));
		expect(await evalIn("navigator.maxTouchPoints")).toBe(touchPointsBefore);
		expect(await evalIn("/Mobile/.test(navigator.userAgent)")).toBe(false);
	});

	it("restarts with the same tabs when the mode changes", async () => {
		const before = core.allTabs().map((t) => t.url);
		await core.setMode("headless", true);
		await new Promise((r) => setTimeout(r, 1500));
		expect(core.running).toBe(true);
		expect(core.allTabs().map((t) => t.url)).toEqual(before.filter((u) => u !== "about:blank"));
	});
});
