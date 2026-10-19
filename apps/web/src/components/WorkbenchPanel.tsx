import clsx from "clsx";
import { ArrowLeft, Eye, FileText, Globe, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkbenchBrowserState, WorkbenchFile } from "@prometheus/protocol";
import { isDesktopShell } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { activateWorkbenchTab, closeWorkbenchTab, onPluginChange, pluginCall, toast, useStore, type WorkbenchTab } from "../lib/store.ts";
import { Markdown } from "./Markdown.tsx";

const M = defineMessages({
	zh: {
		title: "查看器",
		close: "关闭",
		browser: "浏览器",
		refresh: "刷新",
		loading: "加载中…",
		binary: "二进制文件，无法预览",
		tooLarge: "文件太大，无法预览",
		truncated: "文件较大，只显示前 1 MB",
		preview: "渲染预览",
		source: "源码",
		url: "输入网址，回车打开",
		back: "后退",
		closed: "浏览器未打开。让助手访问网页，或在上方输入网址。",
		closeBrowser: "关闭浏览器",
		typeHint: "输入到页面焦点处，回车发送",
		send: "发送",
		clickHint: "点击画面可直接操作页面",
	},
	en: {
		title: "Viewer",
		close: "Close",
		browser: "Browser",
		refresh: "Refresh",
		loading: "Loading…",
		binary: "Binary file, no preview",
		tooLarge: "File too large to preview",
		truncated: "Large file: showing the first 1 MB",
		preview: "Preview",
		source: "Source",
		url: "Enter a URL and press Enter",
		back: "Back",
		closed: "The browser is not open. Ask the assistant to visit a page, or enter a URL above.",
		closeBrowser: "Close browser",
		typeHint: "Type into the focused page element, Enter to send",
		send: "Send",
		clickHint: "Click the picture to interact with the page",
	},
});

/** Right-hand viewer for files and the built-in browser. Renders nothing until a tab exists. */
export function WorkbenchPanel() {
	const t = useT(M);
	const tabs = useStore((s) => s.workbench.tabs);
	const active = useStore((s) => s.workbench.active);
	const enabled = useStore((s) => s.plugins.some((p) => p.name === "workbench" && p.status === "loaded"));
	if (!enabled || !tabs.length) return null;
	const tab = tabs.find((x) => x.id === active) ?? tabs[0];
	if (!tab) return null;
	return (
		<aside
			className="flex w-[28rem] shrink-0 flex-col border-l hairline bg-ink-900/80 backdrop-blur max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:w-[min(30rem,100%)] max-md:bg-ink-900 max-md:shadow-2xl lg:w-[38rem]"
			aria-label={t("title")}
		>
			<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b hairline px-1.5 py-1">
				{tabs.map((x) => (
					<div key={x.id} className={clsx("group flex max-w-48 shrink-0 items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-xs", x.id === tab.id ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:bg-ink-850")}>
						<button type="button" onClick={() => activateWorkbenchTab(x.id)} className="flex min-w-0 items-center gap-1.5" title={x.kind === "file" ? x.path : t("browser")}>
							{x.kind === "browser" ? <Globe className="size-3.5 shrink-0" /> : <FileText className="size-3.5 shrink-0" />}
							<span className="truncate">{x.kind === "browser" ? t("browser") : baseName(x.path)}</span>
						</button>
						<button type="button" onClick={() => closeWorkbenchTab(x.id)} className="grid size-4 place-items-center rounded hover:bg-ink-700" aria-label={t("close")}>
							<X className="size-3" />
						</button>
					</div>
				))}
			</div>
			<div className="min-h-0 flex-1">{tab.kind === "browser" ? (isDesktopShell() ? <NativeBrowserView key="browser" /> : <BrowserView key="browser" />) : <FileView key={tab.id} tab={tab} />}</div>
		</aside>
	);
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function FileView({ tab }: { tab: Extract<WorkbenchTab, { kind: "file" }> }) {
	const t = useT(M);
	const [file, setFile] = useState<WorkbenchFile | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [rendered, setRendered] = useState(true);
	const streaming = useStore((s) => s.session?.isStreaming ?? false);
	const lineRef = useRef<HTMLTableRowElement>(null);

	const load = useCallback(async () => {
		setLoading(true);
		const res = await pluginCall<WorkbenchFile>("workbench", "readFile", { path: tab.path, cwd: tab.cwd }).catch(() => undefined);
		// pluginCall reports failures as a toast and yields undefined; keep a visible reason in the pane too.
		if (res) {
			setFile(res);
			setError(null);
		} else setError(tab.path);
		setLoading(false);
	}, [tab.path, tab.cwd]);

	// Reload when opened, when the agent finishes a turn (it may have edited the file), and on explicit refresh.
	useEffect(() => {
		if (!streaming) void load();
	}, [load, streaming]);

	useEffect(() => {
		lineRef.current?.scrollIntoView({ block: "center" });
	}, [file, tab.line]);

	const lines = file?.kind === "text" ? (file.text ?? "").split("\n") : [];
	const isMd = file?.language === "markdown";
	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b hairline px-3 py-1.5 text-xs">
				<span className="min-w-0 flex-1 truncate font-mono text-ink-400" title={file?.path ?? tab.path}>
					{file?.path ?? tab.path}
				</span>
				{isMd && (
					<button type="button" onClick={() => setRendered(!rendered)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100">
						<Eye className="size-3.5" />
						{rendered ? t("source") : t("preview")}
					</button>
				)}
				<button type="button" onClick={() => void load()} className="grid size-6 place-items-center rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100" title={t("refresh")}>
					<RefreshCw className={clsx("size-3.5", loading && "animate-spin")} />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{!file && loading && (
					<div className="grid h-full place-items-center text-ink-500">
						<LoaderCircle className="size-5 animate-spin" />
					</div>
				)}
				{!file && error && <p className="p-4 text-sm text-ink-500">{error}</p>}
				{file?.kind === "binary" && <p className="p-4 text-sm text-ink-500">{t("binary")}</p>}
				{file?.kind === "tooLarge" && <p className="p-4 text-sm text-ink-500">{t("tooLarge")}</p>}
				{file?.kind === "image" && file.dataUrl && (
					<div className="grid min-h-full place-items-center bg-ink-950 p-3">
						<img src={file.dataUrl} alt={file.name} className="max-h-full max-w-full object-contain" />
					</div>
				)}
				{file?.kind === "text" && isMd && rendered && (
					<div className="p-4">
						<Markdown text={file.text ?? ""} />
					</div>
				)}
				{file?.kind === "text" && !(isMd && rendered) && (
					<table className="w-full border-collapse font-mono text-[12px] leading-5">
						<tbody>
							{lines.map((line, i) => (
								<tr key={i} ref={tab.line === i + 1 ? lineRef : undefined} className={clsx(tab.line === i + 1 && "bg-ember-500/15")}>
									<td className="w-10 select-none px-2 text-right align-top text-ink-600">{i + 1}</td>
									<td className="whitespace-pre-wrap break-all pr-3 text-ink-200">{line || " "}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{file?.truncated && <p className="border-t hairline px-3 py-1.5 text-[11px] text-ink-500">{t("truncated")}</p>}
			</div>
		</div>
	);
}

const POLL_MS = 1500;

function BrowserView() {
	const t = useT(M);
	const [state, setState] = useState<WorkbenchBrowserState | null>(null);
	const [address, setAddress] = useState("");
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const editing = useRef(false);
	const img = useRef<HTMLImageElement>(null);

	const apply = useCallback((s: WorkbenchBrowserState | undefined) => {
		if (!s) return;
		setState(s);
		if (!editing.current) setAddress(s.url);
	}, []);

	// The screenshot is refreshed while the tab is visible and whenever the plugin reports an action.
	useEffect(() => {
		let stop = false;
		const tick = async (refresh: boolean) => {
			const s = await pluginCall<WorkbenchBrowserState>("workbench", "browserState", { refresh }).catch(() => undefined);
			if (!stop) apply(s);
		};
		void tick(false);
		const timer = setInterval(() => void tick(true), POLL_MS);
		const off = onPluginChange("workbench", () => void tick(false));
		return () => {
			stop = true;
			clearInterval(timer);
			off();
		};
	}, [apply]);

	const act = async (method: string, params: Record<string, unknown> = {}) => {
		setBusy(true);
		apply(await pluginCall<WorkbenchBrowserState>("workbench", method, params));
		setBusy(false);
	};

	const onPicture = (e: React.MouseEvent<HTMLImageElement>) => {
		const el = img.current;
		if (!el || !state) return;
		const r = el.getBoundingClientRect();
		void act("browserClick", { x: ((e.clientX - r.left) / r.width) * state.width, y: ((e.clientY - r.top) / r.height) * state.height });
	};

	const wheel = (e: React.WheelEvent) => void act("browserScroll", { dy: Math.sign(e.deltaY) * 400 });

	return (
		<div className="flex h-full flex-col">
			<form
				className="flex shrink-0 items-center gap-1.5 border-b hairline px-2 py-1.5"
				onSubmit={(e) => {
					e.preventDefault();
					editing.current = false;
					if (address.trim()) void act("browserNavigate", { url: address });
				}}
			>
				<button type="button" disabled={!state?.open} onClick={() => void act("browserBack")} className="grid size-7 place-items-center rounded text-ink-400 hover:bg-ink-800 disabled:opacity-30" title={t("back")}>
					<ArrowLeft className="size-4" />
				</button>
				<input
					value={address}
					onChange={(e) => setAddress(e.target.value)}
					onFocus={() => (editing.current = true)}
					onBlur={() => (editing.current = false)}
					placeholder={t("url")}
					spellCheck={false}
					className="min-w-0 flex-1 rounded-md bg-ink-950 px-2.5 py-1 font-mono text-xs text-ink-100 outline-none ring-1 ring-ink-800 focus:ring-ember-500/60"
				/>
				{busy && <LoaderCircle className="size-4 shrink-0 animate-spin text-ember-400" />}
				<button type="button" disabled={!state?.open} onClick={() => void act("browserClose")} className="grid size-7 place-items-center rounded text-ink-400 hover:bg-ink-800 disabled:opacity-30" title={t("closeBrowser")}>
					<X className="size-4" />
				</button>
			</form>
			<div className="min-h-0 flex-1 overflow-auto bg-ink-950" onWheel={wheel}>
				{state?.open && state.shot ? (
					<img ref={img} src={`data:image/jpeg;base64,${state.shot}`} alt={state.title} onClick={onPicture} className="w-full cursor-pointer select-none" draggable={false} title={t("clickHint")} />
				) : (
					<p className="p-6 text-center text-sm text-ink-500">{t("closed")}</p>
				)}
			</div>
			{state?.open && (
				<form
					className="flex shrink-0 items-center gap-1.5 border-t hairline px-2 py-1.5"
					onSubmit={(e) => {
						e.preventDefault();
						void act("browserType", { text: typed, submit: true });
						setTyped("");
					}}
				>
					<input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t("typeHint")} className="min-w-0 flex-1 rounded-md bg-ink-950 px-2.5 py-1 text-xs text-ink-100 outline-none ring-1 ring-ink-800 focus:ring-ember-500/60" />
					<button type="submit" className="rounded-md bg-ink-800 px-2.5 py-1 text-xs text-ink-200 hover:bg-ink-700">
						{t("send")}
					</button>
				</form>
			)}
		</div>
	);
}

// ---------- desktop: a real webview laid over this panel ----------

type Rect = { x: number; y: number; w: number; h: number };
type Cmd = { id: string; kind: "navigate"; url: string } | { id: string; kind: "exec"; script: string } | { id: string; kind: "close" };

async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	const { invoke: inv } = await import("@tauri-apps/api/core");
	return inv<T>(cmd, args);
}

/** Quiet plugin call for the background loop: failures must not pop toasts every few seconds. */
const quiet = <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
	const client = useStore.getState().client;
	if (!client) return Promise.reject(new Error("offline"));
	return client.rpc("plugin.call", { plugin: "workbench", method, params }) as Promise<T>;
};

const rectOf = (el: HTMLElement): Rect => {
	const r = el.getBoundingClientRect();
	return { x: r.left, y: r.top, w: Math.max(1, r.width), h: Math.max(1, r.height) };
};

function NativeBrowserView() {
	const t = useT(M);
	const slot = useRef<HTMLDivElement>(null);
	const [address, setAddress] = useState("");
	const [ready, setReady] = useState(false);
	const [loading, setLoading] = useState(false);
	const editing = useRef(false);
	// A native view always paints above HTML, so it steps aside while a dialog or page covers the chat.
	const covered = useStore((s) => s.view !== "chat" || s.uiQueue.length > 0);
	const coveredRef = useRef(covered);
	coveredRef.current = covered;
	const resync = useRef<() => void>(() => undefined);
	const waiters = useRef<((url: string) => void)[]>([]);

	useEffect(() => {
		let dead = false;
		let unlisten: (() => void) | undefined;
		let raf = 0;
		let last = "";
		const el = slot.current;
		if (!el) return;
		void (async () => {
			try {
				await invoke("wb_open", { url: "about:blank", rect: rectOf(el) });
			} catch {
				return;
			}
			if (dead) return void invoke("wb_close").catch(() => undefined);
			setReady(true);
			const { listen } = await import("@tauri-apps/api/event");
			const un = await listen<{ phase: string; url: string }>("wb-load", (e) => {
				setLoading(e.payload.phase === "started");
				if (!editing.current && e.payload.url !== "about:blank") setAddress(e.payload.url);
				if (e.payload.phase === "finished") for (const w of waiters.current.splice(0)) w(e.payload.url);
			});
			if (dead) un();
			else unlisten = un;
			// The panel can move without resizing (other panels open and close), so follow its position every frame.
			const follow = () => {
				const key = JSON.stringify(rectOf(el));
				if (!coveredRef.current && key !== last) {
					last = key;
					void invoke("wb_bounds", { rect: rectOf(el) }).catch(() => undefined);
				}
				raf = requestAnimationFrame(follow);
			};
			follow();
			resync.current = () => (last = "");
			// Serve the assistant's browser tools: the server queues commands and this loop runs them in the page.
			void quiet("nativeHello").catch(() => undefined);
			while (!dead) {
				const cmds = await quiet<Cmd[]>("nativePoll").catch(() => undefined);
				if (!cmds) {
					await new Promise((r) => setTimeout(r, 2000));
					continue;
				}
				for (const cmd of cmds) void run(cmd);
			}
		})();

		async function run(cmd: Cmd) {
			const reply = (ok: boolean, value?: unknown, error?: string) => quiet("nativeResult", { id: cmd.id, ok, value, error }).catch(() => undefined);
			try {
				if (cmd.kind === "navigate") {
					const done = new Promise<void>((res) => {
						waiters.current.push(() => res());
						setTimeout(res, 20000);
					});
					await invoke("wb_navigate", { url: cmd.url });
					await done;
					await reply(true, true);
				} else if (cmd.kind === "exec") {
					const raw = await invoke<string>("wb_exec", { script: cmd.script });
					const res = JSON.parse(raw) as { ok: boolean; v?: unknown; e?: string };
					await reply(res.ok, res.v, res.e);
				} else {
					await reply(true, true);
					closeWorkbenchTab("browser");
				}
			} catch (e) {
				await reply(false, undefined, String(e));
			}
		}

		return () => {
			dead = true;
			cancelAnimationFrame(raf);
			unlisten?.();
			void invoke("wb_close").catch(() => undefined);
		};
	}, []);

	useEffect(() => {
		if (!ready) return;
		if (covered) void invoke("wb_visible", { visible: false }).catch(() => undefined);
		else {
			resync.current();
			void invoke("wb_visible", { visible: true }).catch(() => undefined);
		}
	}, [ready, covered]);

	const go = () => {
		const raw = address.trim();
		if (!raw) return;
		const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
		setLoading(true);
		void invoke("wb_navigate", { url }).catch((e) => {
			setLoading(false);
			toast(String(e), "error");
		});
	};

	return (
		<div className="flex h-full flex-col">
			<form
				className="flex shrink-0 items-center gap-1.5 border-b hairline px-2 py-1.5"
				onSubmit={(e) => {
					e.preventDefault();
					editing.current = false;
					go();
				}}
			>
				<button type="button" onClick={() => void invoke("wb_exec", { script: "history.back(); return true;" }).catch(() => undefined)} className="grid size-7 place-items-center rounded text-ink-400 hover:bg-ink-800" title={t("back")}>
					<ArrowLeft className="size-4" />
				</button>
				<input
					value={address}
					onChange={(e) => setAddress(e.target.value)}
					onFocus={() => (editing.current = true)}
					onBlur={() => (editing.current = false)}
					placeholder={t("url")}
					spellCheck={false}
					className="min-w-0 flex-1 rounded-md bg-ink-950 px-2.5 py-1 font-mono text-xs text-ink-100 outline-none ring-1 ring-ink-800 focus:ring-ember-500/60"
				/>
				{loading && <LoaderCircle className="size-4 shrink-0 animate-spin text-ember-400" />}
				<button type="button" onClick={() => closeWorkbenchTab("browser")} className="grid size-7 place-items-center rounded text-ink-400 hover:bg-ink-800" title={t("closeBrowser")}>
					<X className="size-4" />
				</button>
			</form>
			{/* The webview is positioned over this box. */}
			<div ref={slot} className="min-h-0 flex-1 bg-ink-950" />
		</div>
	);
}
