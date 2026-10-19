import { Type } from "@earendil-works/pi-ai";
import { definePlugin } from "@prometheus/plugin-sdk";
import { BROWSER_TOOL_PREFIX, OPEN_FILE_TOOL } from "@prometheus/protocol";
import { BrowserError, formatSnapshot, KEY_NAMES, normalizeUrl, type Snapshot, BrowserSession } from "./browser.ts";
import { NativeBrowser } from "./native.ts";
import { readForViewer, resolveAllowed } from "./files.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

const GUIDELINES = [
	`Use ${OPEN_FILE_TOOL} to show the user a file in the app's side viewer when they ask to see it or when pointing at a specific spot; it is not needed for reading a file yourself.`,
	`${BROWSER_TOOL_PREFIX}* tools drive a real browser the user can watch in a side panel. Call ${BROWSER_TOOL_PREFIX}navigate first, then ${BROWSER_TOOL_PREFIX}snapshot to get numbered elements; refs are only valid until the next snapshot or page change. Close it with ${BROWSER_TOOL_PREFIX}close when done.`,
];

export default definePlugin({
	name: "workbench",
	version: "0.1.0",
	// The side panels only appear when one of these tools runs (or the user opens a file), so switching it off loses nothing else.
	optional: true,
	setup(ctx) {
		const browser = new BrowserSession(`${ctx.dataDir}/browser-profile`, (m) => ctx.log.info(m));
		browser.onChange = () => ctx.notifyChanged();
		const native = new NativeBrowser();
		ctx.onDispose(() => browser.close());

		/** The desktop app's embedded webview when its browser tab is open, otherwise the background Chrome. */
		type Driver = Pick<BrowserSession, "navigate" | "snapshot" | "click" | "type" | "press" | "scroll" | "back">;
		const driver = async (): Promise<{ d: Driver; native: boolean }> => {
			if (native.hasDriver || (native.desktopLikely && (await native.waitForDriver(4000)))) return { d: native, native: true };
			return { d: browser, native: false };
		};
		ctx.rpc("nativeHello", () => void native.hello());
		ctx.rpc("nativePoll", () => native.poll());
		ctx.rpc("nativeResult", (p) => void native.answer(str(p.id), p.ok === true, p.value, str(p.error)));

		const roots = async (extra?: string): Promise<string[]> => {
			const list = (await ctx.workspaces()).map((w) => w.path);
			list.push(ctx.cwd);
			if (extra) list.push(extra);
			return list;
		};

		// ---- UI RPCs: these take what the client sends, so every path goes through resolveAllowed. ----
		ctx.rpc("readFile", async (p) => {
			const cwd = str(p.cwd) || ctx.cwd;
			// The session's own folder counts as a root, but only when it is a folder the app knows.
			const known = await roots();
			const real = await resolveAllowed(str(p.path), cwd, known);
			return readForViewer(real);
		});
		ctx.rpc("browserState", (p) => browser.state(p.refresh === true));
		ctx.rpc("browserNavigate", async (p) => {
			await browser.navigate(str(p.url));
			return browser.state(false);
		});
		ctx.rpc("browserBack", async () => {
			await browser.back();
			return browser.state(false);
		});
		ctx.rpc("browserClick", async (p) => {
			await browser.clickAt(num(p.x), num(p.y));
			return browser.state(false);
		});
		ctx.rpc("browserType", async (p) => {
			await browser.typeFocused(str(p.text), p.submit === true);
			return browser.state(false);
		});
		ctx.rpc("browserScroll", async (p) => {
			await browser.scroll(num(p.dy) || 0);
			return browser.state(false);
		});
		ctx.rpc("browserClose", async () => {
			await browser.close();
			return browser.state(false);
		});

		// ---- Agent tools ----
		ctx.extension((pi) => {
			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.promptGuidelines?.push(...GUIDELINES);
			});

			pi.registerTool({
				name: OPEN_FILE_TOOL,
				label: "查看文件",
				description: "Show a file in the user's side file viewer, optionally scrolled to a line. Only files inside the project folders can be shown.",
				promptSnippet: `${OPEN_FILE_TOOL}: show a file to the user in the app's side viewer`,
				parameters: Type.Object({
					path: Type.String({ description: "File path, relative to the working directory or absolute" }),
					line: Type.Optional(Type.Integer({ minimum: 1, description: "Line to scroll to and highlight" })),
				}),
				async execute(_id, params, _signal, _update, tctx) {
					const real = await resolveAllowed(params.path, tctx.cwd, await roots(tctx.cwd));
					return { content: [{ type: "text", text: `Opened ${real}${params.line ? ` at line ${params.line}` : ""} in the viewer.` }], details: { path: real, line: params.line } };
				},
			});

			const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
				try {
					return await fn();
				} catch (e) {
					if (e instanceof BrowserError) throw new Error(e.message);
					throw e;
				}
			};
			const page = (s: Snapshot) => text(formatSnapshot(s));

			pi.registerTool({
				name: "browser_navigate",
				label: "浏览器：打开网址",
				description: "Open a web page (http/https) in the built-in browser and return its interactive elements and text. Starts the browser if needed.",
				parameters: Type.Object({ url: Type.String({ description: "Web address; https:// is assumed when missing" }) }),
				execute: (_id, p) => guard(async () => page(await (await driver()).d.navigate(normalizeUrl(p.url)))),
			});
			pi.registerTool({
				name: "browser_snapshot",
				label: "浏览器：读取页面",
				description: "Read the current page: numbered interactive elements ([ref]) and visible text. Call again after the page changes.",
				parameters: Type.Object({}),
				execute: () => guard(async () => page(await (await driver()).d.snapshot())),
			});
			pi.registerTool({
				name: "browser_click",
				label: "浏览器：点击",
				description: "Click the element with the given ref from the latest snapshot. Returns the new page state.",
				parameters: Type.Object({ ref: Type.Integer({ minimum: 1 }) }),
				execute: (_id, p) => guard(async () => page(await (await driver()).d.click(p.ref))),
			});
			pi.registerTool({
				name: "browser_type",
				label: "浏览器：输入",
				description: "Replace the content of an input (by ref) with text, optionally pressing Enter afterwards.",
				parameters: Type.Object({ ref: Type.Integer({ minimum: 1 }), text: Type.String(), submit: Type.Optional(Type.Boolean()) }),
				execute: (_id, p) => guard(async () => page(await (await driver()).d.type(p.ref, p.text, p.submit === true))),
			});
			pi.registerTool({
				name: "browser_press",
				label: "浏览器：按键",
				description: `Press a key on the page. One of: ${KEY_NAMES.join(", ")}.`,
				parameters: Type.Object({ key: Type.String() }),
				execute: (_id, p) => guard(async () => page(await (await driver()).d.press(p.key))),
			});
			pi.registerTool({
				name: "browser_scroll",
				label: "浏览器：滚动",
				description: "Scroll the page down (positive) or up (negative) by pixels; a screen is about 800.",
				parameters: Type.Object({ dy: Type.Integer({ description: "Pixels; default 600", default: 600 }) }),
				execute: (_id, p) => guard(async () => page(await (await driver()).d.scroll(p.dy ?? 600))),
			});
			pi.registerTool({
				name: "browser_back",
				label: "浏览器：后退",
				description: "Go back one page in the browser history.",
				parameters: Type.Object({}),
				execute: () => guard(async () => page(await (await driver()).d.back())),
			});
			pi.registerTool({
				name: "browser_screenshot",
				label: "浏览器：截图",
				description: "Take a screenshot of the current page as an image.",
				parameters: Type.Object({}),
				execute: () =>
					guard(async () => {
						if ((await driver()).native) throw new Error("内嵌浏览器不支持截图，请用 browser_snapshot 读取页面");
						const data = await browser.screenshot();
						return { content: [{ type: "image" as const, data, mimeType: "image/jpeg" }, { type: "text" as const, text: "Screenshot of the current page." }], details: {} };
					}),
			});
			pi.registerTool({
				name: "browser_close",
				label: "浏览器：关闭",
				description: "Close the built-in browser and its panel.",
				parameters: Type.Object({}),
				execute: async () => {
					await native.close();
					await browser.close();
					return text("Browser closed.");
				},
			});
		});
	},
});
