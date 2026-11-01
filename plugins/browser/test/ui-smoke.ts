// UI smoke test: starts a Prometheus server with the built web app, opens it in a (separate) headless browser
// driven by this plugin's own core, opens the built-in browser panel and saves screenshots.
// Usage: node plugins/browser/test/ui-smoke.ts <outDir>   (needs apps/web/dist: pnpm --filter @prometheus/web build)
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserAgent } from "../src/agent.ts";
import { BrowserCore } from "../src/browser.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { startSite } from "./fixtures.ts";

const out = resolve(process.argv[2] ?? join(tmpdir(), "pm-ui-smoke"));
await mkdir(out, { recursive: true });
const root = fileURLToPath(new URL("../../../", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "pm-ui-home-"));
const work = await mkdtemp(join(tmpdir(), "pm-ui-work-"));
const PORT = 17600 + Math.floor(Math.random() * 300);
const site = await startSite();

const server = spawn(process.execPath, [join(root, "apps/server/src/main.ts")], {
	env: { ...process.env, PROMETHEUS_PORT: String(PORT), PROMETHEUS_HOME: home, PROMETHEUS_HOST: "127.0.0.1", PROMETHEUS_TOKEN: "", PROMETHEUS_CWD: work, PROMETHEUS_PARENT_WATCH: "", HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "*" },
	stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 120 && !log.includes("PROMETHEUS_READY"); i++) await new Promise((r) => setTimeout(r, 250));
if (!log.includes("PROMETHEUS_READY")) throw new Error(`server did not start:\n${log}`);
console.log(log.trim());

const viewer = new BrowserCore({
	dataDir: await mkdtemp(join(tmpdir(), "pm-ui-viewer-")),
	settings: () => ({ ...DEFAULT_SETTINGS, restoreTabs: false, lang: "zh-CN" }),
	publish: () => {},
	watchers: () => 0,
	log: () => {},
});
const agent = new BrowserAgent(viewer, () => true);
const signal = new AbortController().signal;
await viewer.ensure();
await viewer.setViewport(process.env.MOBILE ? { width: 400, height: 860, dpr: 2, mobile: true } : { width: 1500, height: 900, dpr: 1 });
const shot = async (name: string) => {
	const s = await agent.screenshot("v", {});
	await writeFile(join(out, `${name}.jpg`), Buffer.from(s.data, "base64"));
	console.log("saved", name);
};
const evalJs = (expression: string) => agent.evaluate("v", { expression });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
	await agent.navigate("v", { url: `http://127.0.0.1:${PORT}/` }, signal);
	await sleep(4000);
	console.log("debug:", await evalJs(`JSON.stringify({ splash: !!document.getElementById("splash"), text: document.body.innerText.slice(0, 200), res: performance.getEntriesByType("resource").map((r) => r.name).slice(-8), ls: Object.keys(localStorage) })`));
	// Start a chat in the working folder, so the title bar shows the session tools.
	const t1 = Date.now();
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((r) => ws.addEventListener("open", r));
	ws.send(JSON.stringify({ type: "rpc", id: "1", method: "session.create", params: { cwd: work } }));
	const created = await new Promise<string>((r) =>
		ws.addEventListener("message", (ev: MessageEvent) => {
			const f = JSON.parse(String(ev.data));
			if (f.type === "response") r(JSON.stringify(f).slice(0, 200));
		}),
	);
	console.log(`session.create ${Date.now() - t1} ms`, created);
	ws.close();
	const sessionId = /"id":"([^"]+)"/.exec(created.replace(/^.*?"data":/, ""))?.[1] ?? "";
	await evalJs(`localStorage.setItem("prometheus.lastSession", ${JSON.stringify(sessionId)})`);
	await agent.navigate("v", { action: "reload" }, signal);
	await sleep(6000);
	// The splash waits for every start-up request; a fresh data folder may keep one of them busy for a while.
	await evalJs(`document.getElementById("splash")?.remove()`);
	await shot("01-app");
	if (process.env.MOBILE) {
		await evalJs(`document.querySelector('[aria-label="切换侧栏"], [aria-label="Toggle sidebar"]')?.click()`);
		await sleep(800);
	}
	console.log("new chat:", await evalJs(`(() => { const b = document.querySelector('[aria-label="在此工作区新建对话"], [aria-label="New chat in this workspace"], [title="在此工作区新建对话"], [title="New chat in this workspace"]'); if (!b) return "none"; b.click(); return "clicked"; })()`));
	for (let i = 0; i < 30; i++) {
		await sleep(1000);
		const has = await evalJs(`!![...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "内置浏览器")`);
		if (has === "true") break;
	}
	const clicked = await evalJs(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "内置浏览器" || x.getAttribute("aria-label") === "Built-in browser"); if (!b) return "no button"; b.click(); return "clicked"; })()`);
	console.log("toggle:", clicked);
	await sleep(6000);
	await shot("02-browser-panel");
	// Type into the start page search box of the panel, as a user would.
	let typed = "";
	for (let k = 0; k < 40 && typed !== "submitted"; k++) {
		typed = (await evalJs(`(() => { const i = document.querySelector('input[placeholder="搜索，或者输入网址"], input[placeholder="Search or type a URL"]'); if (!i) return "no start page"; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, ${JSON.stringify(`${site.url}/touch`)}); i.dispatchEvent(new Event("input", { bubbles: true })); i.form.requestSubmit(); return "submitted"; })()`)) as string;
		if (typed !== "submitted") await sleep(500);
	}
	console.log("start page:", typed);
	await sleep(4000);
	await shot("03-page-loaded");
	const canvas = await evalJs(`(() => { const c = document.querySelector(".browser-viewport canvas"); if (!c) return "no canvas"; const g = c.getContext("2d"); const d = g.getImageData(c.width / 2, 40, 1, 1).data; return c.width + "x" + c.height + " px=" + [...d].join(","); })()`);
	console.log("canvas:", canvas);
	// Click into the page's Name field through the canvas and type.
	const rect = await evalJs(`JSON.stringify(document.querySelector(".browser-viewport canvas").getBoundingClientRect())`);
	console.log("canvas rect", rect);
	const cr = JSON.parse(rect) as { x: number; y: number };
	const vt = viewer.activeTab!;
	const click = async (x: number, y: number) => {
		await vt.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		await vt.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
		await vt.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
	};
	// The Name field sits at about (150, 13) inside the page (fixture layout, default fonts).
	await click(cr.x + 150, cr.y + 103);
	await sleep(300);
	await vt.send("Input.insertText", { text: "hello 世界" });
	for (const key of ["!"]) {
		await vt.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: "Digit1", windowsVirtualKeyCode: 49, text: key, modifiers: 8 });
		await vt.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: "Digit1", windowsVirtualKeyCode: 49, modifiers: 8 });
	}
	await sleep(1200);
	await shot("04-typed");
	// The Color select: the app draws its popup.
	await click(cr.x + 565, cr.y + 103);
	await sleep(1200);
	await shot("05-select-popup");
	console.log("popup:", await evalJs(`[...document.querySelectorAll(".browser-viewport button")].map((b) => b.textContent).join("|")`));
	await evalJs(`[...document.querySelectorAll(".browser-viewport button")].find((b) => b.textContent === "Blue")?.click()`);
	await sleep(1200);
	await shot("06-select-chosen");
	// Right click: the app's context menu.
	await vt.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cr.x + 120, y: cr.y + 40, button: "right", buttons: 2, clickCount: 1 });
	await vt.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cr.x + 120, y: cr.y + 40, button: "right", clickCount: 1 });
	await sleep(1000);
	await shot("07-context-menu");
	await vt.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await evalJs(`document.querySelector(".browser-viewport .fixed, .browser-viewport .absolute.inset-0.z-10")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
	// The user takes the browser over: the pill appears.
	const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((r) => ws2.addEventListener("open", r));
	ws2.send(JSON.stringify({ type: "rpc", id: "2", method: "plugin.call", params: { plugin: "browser", method: "takeover", params: {} } }));
	await sleep(1200);
	await shot("08-takeover");
	ws2.close();
	await shot("09-final");
	console.log("server log tail:\n", log.split("\n").slice(-15).join("\n"));
} finally {
	await viewer.dispose();
	server.kill();
	site.server.close();
}
