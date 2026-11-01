import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { createJsonStore, definePlugin } from "@prometheus/plugin-sdk";
import { BrowserAgent } from "./agent.ts";
import { BrowserCore, UserFacingError } from "./browser.ts";
import { DEFAULT_SETTINGS, type BrowserSettings, sanitizeSettings } from "./settings.ts";
import { browserTools } from "./tools.ts";
import { guestInfo } from "./guest.ts";
import type { InputEvent, Viewport } from "./types.ts";

const TOPIC = "view";
const MAX_UPLOAD = 512 * 1024 * 1024;
const PIECE = 4 * 1024 * 1024;

const str = (v: unknown, max = 8192) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const optTab = (v: unknown) => (typeof v === "string" && /^t\d{1,6}$/.test(v) ? v : undefined);

export default definePlugin({
	name: "browser",
	version: "0.1.0",
	optional: true,
	setup(ctx) {
		const store = createJsonStore<{ settings: Partial<BrowserSettings> }>(join(ctx.dataDir, "settings.json"), () => ({ settings: {} }));
		const fromConfig = sanitizeSettings(ctx.settings);
		let saved: Partial<BrowserSettings> = {};
		const settings = (): BrowserSettings => ({ ...DEFAULT_SETTINGS, ...fromConfig, ...saved });
		const ready = store.read().then((s) => {
			saved = sanitizeSettings(s.settings);
		});

		const browser = new BrowserCore({
			dataDir: ctx.dataDir,
			settings,
			publish: (msg, binary, droppable) => ctx.stream.publish(TOPIC, msg, { ...(binary ? { binary } : {}), ...(droppable ? { droppable } : {}) }),
			watchers: () => ctx.stream.watchers(TOPIC),
			log: (m) => ctx.log.info(m),
		});
		const agent = new BrowserAgent(browser, () => settings().allowEval);

		let lastWatchers = 0;
		ctx.stream.onWatch((topic, count) => {
			if (topic !== TOPIC) return;
			if (count > lastWatchers) browser.greet();
			lastWatchers = count;
			browser.lastUse = Date.now();
			browser.updateScreencast();
		});

		const uploads = join(ctx.dataDir, "uploads");
		void rm(uploads, { recursive: true, force: true }).catch(() => {});
		ctx.onDispose(async () => {
			await browser.dispose();
			await rm(uploads, { recursive: true, force: true }).catch(() => {});
		});

		for (const tool of browserTools(browser, agent)) ctx.tools.register(tool);

		// ---------- RPC for the app's browser view ----------

		const tabOf = (p: Record<string, unknown>) => browser.tab(optTab(p.tab));
		/** Expected failures reach the UI as their message, not as an internal error. */
		const rpc = (method: string, fn: (p: Record<string, unknown>) => unknown) =>
			ctx.rpc(method, async (p) => {
				await ready;
				try {
					return (await fn(p)) ?? {};
				} catch (err) {
					if (err instanceof UserFacingError) throw new Error(err.message);
					throw err;
				}
			});

		rpc("state", () => {
			// Whether the phone's browser component is installed can change behind our back (the app installs it): tell viewers.
			if (guestInfo() && !browser.running) browser.changed();
			return { state: browser.state(), settings: settings() };
		});
		rpc("start", async () => {
			await browser.ensure();
			return browser.state();
		});
		rpc("stop", () => browser.stop());
		rpc("settings.set", async (p) => {
			const prev = settings();
			const next = await store.update((s) => ({ settings: { ...sanitizeSettings(s.settings), ...sanitizeSettings(p.settings) } }));
			saved = sanitizeSettings(next.settings);
			const cur = settings();
			if (browser.running && (cur.executablePath !== prev.executablePath || cur.proxy !== prev.proxy || cur.lang !== prev.lang || cur.downloadDir !== prev.downloadDir)) await browser.setMode(browser.mode, true);
			else if (cur.mode !== prev.mode) await browser.setMode(cur.mode);
			else if (cur.mobile !== prev.mobile) await browser.reapplyViewport();
			else if (cur.quality !== prev.quality || cur.maxFps !== prev.maxFps) await browser.activeTab?.restartScreencast();
			browser.changed();
			return { state: browser.state(), settings: cur };
		});
		rpc("install", async () => {
			await browser.installBrowser();
			return browser.state();
		});
		rpc("install.cancel", () => browser.cancelInstall());
		rpc("wipe", () => browser.wipeProfile());

		rpc("tab.new", async (p) => {
			const t = await browser.newTab("about:blank", true);
			if (str(p.url)) await browser.navigate(t, str(p.url));
			return { id: t.id };
		});
		rpc("tab.close", (p) => browser.closeTab(tabOf(p).id));
		rpc("tab.activate", (p) => browser.activate(tabOf(p).id));
		rpc("navigate", async (p) => {
			await browser.ensure();
			return { url: await browser.navigate(tabOf(p), str(p.url)) };
		});
		rpc("history", (p) => {
			const action = p.action;
			if (action !== "back" && action !== "forward" && action !== "reload" && action !== "stop") throw new UserFacingError("bad action");
			return browser.history(tabOf(p), action);
		});
		rpc("viewport", (p) => browser.setViewport({ width: num(p.width, 1280), height: num(p.height, 800), dpr: num(p.dpr, 1), mobile: p.mobile === true } satisfies Viewport));
		rpc("input", async (p) => {
			if (!browser.running || !Array.isArray(p.events)) return;
			const tab = optTab(p.tab);
			if (!tab || !browser.hasTab(tab)) return;
			await browser.input(browser.tab(tab), p.events as InputEvent[]);
		});
		rpc("dialog", (p) => browser.respondDialog(tabOf(p), p.accept === true, typeof p.text === "string" ? p.text.slice(0, 10_000) : undefined));
		rpc("select", (p) => browser.chooseOption(tabOf(p), num(p.index, -1)));
		rpc("takeover", () => browser.takeOver());
		rpc("handback", () => browser.handBack());

		// Files the user picks in the app travel to the server first; the page's file input then takes them from there.
		rpc("files.upload", async (p) => {
			const token = typeof p.token === "string" && /^[\w-]{8,64}$/.test(p.token) ? p.token : randomUUID();
			const name = basename(str(p.name, 255).replace(/[\\/:*?"<>|\0]/g, "_")) || "file";
			const offset = num(p.offset);
			const data = Buffer.from(str(p.data, PIECE * 2), "base64");
			if (offset < 0 || offset + data.length > MAX_UPLOAD) throw new UserFacingError("文件太大");
			const dir = join(uploads, token);
			await mkdir(dir, { recursive: true });
			const path = join(dir, name);
			const fh = await open(path, offset === 0 ? "w" : "r+");
			try {
				await fh.write(data, 0, data.length, offset);
			} finally {
				await fh.close();
			}
			return { token, path };
		});
		rpc("files.choose", async (p) => {
			const root = resolve(uploads) + sep;
			const paths = (Array.isArray(p.paths) ? p.paths : []).map((x) => resolve(str(x, 4096)));
			if (!paths.length || paths.some((x) => !x.startsWith(root))) throw new UserFacingError("只能选择刚上传的文件");
			await browser.chooseFiles(tabOf(p), paths);
		});
		rpc("files.cancel", (p) => browser.cancelFiles(tabOf(p)));

		rpc("download.read", async (p) => {
			const d = browser.download(str(p.id, 100));
			if (d.state !== "completed" || !d.path) throw new UserFacingError("下载还没有完成");
			const size = (await stat(d.path)).size;
			const offset = Math.max(0, Math.floor(num(p.offset)));
			const length = Math.min(PIECE, Math.max(1, Math.floor(num(p.length, PIECE))));
			const chunks: Buffer[] = [];
			if (offset < size) {
				for await (const c of createReadStream(d.path, { start: offset, end: Math.min(size, offset + length) - 1 })) chunks.push(c as Buffer);
			}
			const buf = Buffer.concat(chunks);
			return { data: buf.toString("base64"), size, eof: offset + buf.length >= size, name: d.name };
		});
		rpc("download.cancel", (p) => browser.cancelDownload(str(p.id, 100)));
		rpc("download.forget", (p) => browser.forgetDownload(str(p.id, 100)));
	},
});
