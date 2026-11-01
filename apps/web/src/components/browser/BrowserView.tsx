// The built-in browser in the side panel. The browser itself runs next to the server (headless Chromium driven over
// CDP); this view shows its frames on a canvas and sends input back. Because the page is just a canvas in the DOM,
// every menu, dialog and toast of the app layers over it normally — no native webview, no z-order fights.
import clsx from "clsx";
import { ArrowLeft, ArrowRight, Bot, Download, ExternalLink, Globe, Hand, LoaderCircle, Lock, Maximize2, Minimize2, Plus, RotateCw, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { openExternal } from "../../lib/links.ts";
import { usePrefs } from "../../lib/prefs.ts";
import { setWorkbenchWide, toast, useStore } from "../../lib/store.ts";
import { DownloadsPopover, SettingsPopover } from "./Menus.tsx";
import { CrashedPage, FileChooser, PageDialog, StartPage, StatusScreen } from "./Panels.tsx";
import type { BrowserSettings, TabInfo, ViewMessage } from "./types.ts";
import { browserCall, InputQueue, useBrowser } from "./useBrowser.ts";
import { Viewport, type ViewportHandle } from "./Viewport.tsx";

const M = defineMessages({
	zh: {
		newTab: "新标签页",
		closeTab: "关闭标签页",
		back: "后退",
		forward: "前进",
		reload: "重新加载",
		stop: "停止加载",
		address: "搜索或输入网址",
		settings: "浏览器设置",
		downloads: "下载",
		wide: "加宽面板",
		narrow: "恢复面板宽度",
		external: "在系统浏览器中打开",
		agentWorking: "Agent 正在操作浏览器",
		takeOver: "接管",
		takenOver: "你正在控制浏览器，Agent 已暂停",
		handBack: "交还给 Agent",
		openedByAgent: "由 Agent 打开",
		windowMode: "浏览器在独立窗口中运行，这里同步显示",
	},
	en: {
		newTab: "New tab",
		closeTab: "Close tab",
		back: "Back",
		forward: "Forward",
		reload: "Reload",
		stop: "Stop loading",
		address: "Search or type a URL",
		settings: "Browser settings",
		downloads: "Downloads",
		wide: "Widen panel",
		narrow: "Restore panel width",
		external: "Open in system browser",
		agentWorking: "The agent is using the browser",
		takeOver: "Take over",
		takenOver: "You control the browser; the agent is paused",
		handBack: "Hand back to agent",
		openedByAgent: "Opened by the agent",
		windowMode: "The browser runs in its own window; mirrored here",
	},
});

const ACTIONS: Record<string, [zh: string, en: string]> = {
	navigate: ["打开网页", "opening a page"],
	back: ["后退", "back"],
	forward: ["前进", "forward"],
	reload: ["刷新", "reload"],
	act: ["操作页面", "acting on the page"],
	click: ["点击", "click"],
	double_click: ["双击", "double click"],
	right_click: ["右键", "right click"],
	hover: ["悬停", "hover"],
	set_value: ["填写", "filling in"],
	type: ["输入", "typing"],
	select: ["选择", "select"],
	toggle: ["切换", "toggle"],
	scroll: ["滚动", "scroll"],
	upload: ["上传文件", "uploading"],
	keys: ["按键", "keys"],
	snapshot: ["读取页面", "reading the page"],
	screenshot: ["截图", "screenshot"],
	wait: ["等待", "waiting"],
	eval: ["执行脚本", "running a script"],
	tabs: ["管理标签", "tabs"],
};

function tabLabel(tab: TabInfo, fallback: string): string {
	if (tab.title) return tab.title;
	if (tab.url === "about:blank") return fallback;
	try {
		return new URL(tab.url).host || tab.url;
	} catch {
		return tab.url;
	}
}

const isBlank = (url: string) => url === "about:blank" || url === "";

export function BrowserView() {
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const wide = useStore((s) => s.workbench.wide ?? false);
	const local = useStore((s) => s.client?.local ?? false);
	const view = useRef<ViewportHandle>(null);
	const queue = useMemo(() => new InputQueue(), []);
	const [address, setAddress] = useState<string | null>(null);
	const [popover, setPopover] = useState<"settings" | "downloads" | null>(null);
	const activeRef = useRef<string | null>(null);

	const onFrame = useCallback((jpeg: Uint8Array, width: number, height: number, tab: string) => {
		if (tab === activeRef.current) view.current?.draw(jpeg, width, height);
	}, []);
	const onEvent = useCallback((msg: Exclude<ViewMessage, { k: "state" } | { k: "frame" }>) => {
		if (msg.tab === activeRef.current) view.current?.event(msg);
	}, []);
	const { state, settings, setSettings, startError, setStartError } = useBrowser(onFrame, onEvent);

	const active = state?.tabs.find((x) => x.id === state.active) ?? null;
	activeRef.current = active?.id ?? null;
	const agentBusy = !!state?.agent.busy && !state.takeover;
	const locked = agentBusy;
	const running = state?.status === "running" && !!state.tabs.length;

	// A different tab or page: the address bar shows where we are now, unless the user is typing in it.
	useEffect(() => {
		setAddress(null);
	}, [active?.id, active?.url]);

	const onResize = useCallback(
		(width: number, height: number, dpr: number) => {
			if (state?.mode === "window") return;
			// A phone-sized, touch-driven viewer gets pages laid out as a phone would.
			const mobile = width <= 700 && window.matchMedia("(pointer: coarse)").matches;
			void browserCall("viewport", { width, height, dpr, mobile }).catch(() => {});
		},
		[state?.mode],
	);

	const start = useCallback(() => {
		setStartError(null);
		void browserCall("start").catch((e: unknown) => setStartError(e instanceof Error ? e.message : String(e)));
	}, [setStartError]);

	const saveSettings = useCallback(
		async (patch: Partial<BrowserSettings>) => {
			try {
				const r = await browserCall<{ settings: BrowserSettings }>("settings.set", { settings: patch });
				setSettings(r.settings);
			} catch (e) {
				toast(e instanceof Error ? e.message : String(e), "error");
			}
		},
		[setSettings],
	);

	const navigate = (input: string) => {
		if (!active) return;
		setAddress(null);
		void browserCall("navigate", { tab: active.id, url: input }).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"));
		view.current?.focus();
	};
	const history = (action: "back" | "forward" | "reload" | "stop") => active && void browserCall("history", { tab: active.id, action }).catch(() => {});
	const openTab = (url?: string) => void browserCall("tab.new", url ? { url } : {}).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"));

	const iconBtn = "grid size-7 shrink-0 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100 disabled:opacity-30 disabled:hover:bg-transparent";
	const downloading = state?.downloads.some((d) => d.state === "inProgress") ?? false;
	const secure = active?.url.startsWith("https://");
	const actionLabel = state?.agent.action ? (ACTIONS[state.agent.action]?.[lang === "zh" ? 0 : 1] ?? state.agent.action) : "";

	return (
		<div className="flex h-full flex-col bg-ink-950">
			{/* Tabs */}
			<div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b hairline px-1 pt-1">
				{state?.tabs.map((x) => (
					<div
						key={x.id}
						onMouseDown={(e) => e.button === 1 && (e.preventDefault(), void browserCall("tab.close", { tab: x.id }))}
						className={clsx(
							"group flex h-7 max-w-44 min-w-20 shrink-0 items-center gap-1.5 rounded-t-md border-x border-t pr-1 pl-2 text-xs",
							x.id === state.active ? "border-ink-700 bg-ink-900 text-ink-100" : "border-transparent text-ink-400 hover:bg-ink-900/50",
						)}
					>
						<button type="button" onClick={() => void browserCall("tab.activate", { tab: x.id })} className="flex min-w-0 flex-1 items-center gap-1.5" title={`${x.title}\n${x.url}`}>
							{x.loading ? <LoaderCircle className="size-3 shrink-0 animate-spin text-ember-400" /> : x.agent ? <Bot className="size-3 shrink-0 text-ember-400" aria-label={t("openedByAgent")} /> : <Globe className="size-3 shrink-0" />}
							<span className="truncate">{tabLabel(x, t("newTab"))}</span>
						</button>
						<button type="button" onClick={() => void browserCall("tab.close", { tab: x.id })} className="grid size-4 shrink-0 place-items-center rounded opacity-60 hover:bg-ink-700 hover:opacity-100" aria-label={t("closeTab")}>
							<X className="size-3" />
						</button>
					</div>
				))}
				{running && (
					<button type="button" onClick={() => openTab()} className={clsx(iconBtn, "size-6")} title={t("newTab")}>
						<Plus className="size-3.5" />
					</button>
				)}
			</div>

			{/* Toolbar */}
			<div className="relative flex shrink-0 items-center gap-0.5 border-b hairline bg-ink-900 px-1.5 py-1">
				<button type="button" className={iconBtn} disabled={!active?.canGoBack || locked} onClick={() => history("back")} title={t("back")}>
					<ArrowLeft className="size-4" />
				</button>
				<button type="button" className={iconBtn} disabled={!active?.canGoForward || locked} onClick={() => history("forward")} title={t("forward")}>
					<ArrowRight className="size-4" />
				</button>
				<button type="button" className={iconBtn} disabled={!active || locked} onClick={() => history(active?.loading ? "stop" : "reload")} title={active?.loading ? t("stop") : t("reload")}>
					{active?.loading ? <X className="size-4" /> : <RotateCw className="size-3.5" />}
				</button>
				<form
					className="mx-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-ink-800 bg-ink-950 px-3 py-1 focus-within:border-ember-500/60"
					onSubmit={(e) => {
						e.preventDefault();
						if (address?.trim()) navigate(address.trim());
					}}
				>
					{secure ? <Lock className="size-3 shrink-0 text-moss-400" /> : <Globe className="size-3 shrink-0 text-ink-500" />}
					<input
						value={address ?? (active && !isBlank(active.url) ? active.url : "")}
						onChange={(e) => setAddress(e.target.value)}
						onFocus={(e) => e.currentTarget.select()}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								setAddress(null);
								view.current?.focus();
							}
						}}
						disabled={!running || locked}
						placeholder={t("address")}
						spellCheck={false}
						className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink-200 placeholder:font-sans placeholder:text-ink-500 focus:outline-none"
					/>
				</form>
				{!!state?.downloads.length && (
					<button type="button" className={clsx(iconBtn, downloading && "text-ember-400")} onClick={() => setPopover(popover === "downloads" ? null : "downloads")} title={t("downloads")}>
						<Download className={clsx("size-3.5", downloading && "animate-pulse")} />
					</button>
				)}
				{active && !isBlank(active.url) && /^https?:/.test(active.url) && (
					<button type="button" className={iconBtn} onClick={() => void openExternal(active.url)} title={t("external")}>
						<ExternalLink className="size-3.5" />
					</button>
				)}
				<button type="button" className={iconBtn} onClick={() => setPopover(popover === "settings" ? null : "settings")} title={t("settings")}>
					<Settings2 className="size-3.5" />
				</button>
				<button type="button" className={clsx(iconBtn, "max-md:hidden")} onClick={() => setWorkbenchWide(!wide)} title={wide ? t("narrow") : t("wide")}>
					{wide ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
				</button>
				{popover === "settings" && settings && state && <SettingsPopover settings={settings} state={state} onSave={saveSettings} onClose={() => setPopover(null)} />}
				{popover === "downloads" && state && <DownloadsPopover downloads={state.downloads} onClose={() => setPopover(null)} />}
				{active?.loading && <div className="browser-loading absolute right-0 bottom-0 left-0 h-0.5" />}
			</div>

			{state?.mode === "window" && running && local && <div className="shrink-0 border-b hairline bg-sky-400/10 px-3 py-1 text-[11px] text-sky-300">{t("windowMode")}</div>}

			{/* Page */}
			<div className={clsx("relative min-h-0 flex-1", agentBusy && "browser-agent")}>
				<Viewport
					ref={view}
					tab={active?.id ?? null}
					queue={queue}
					locked={locked}
					onResize={onResize}
					touchMode={!!state?.viewport.mobile}
					onNavigateAction={history}
					onOpenTab={openTab}
					canGoBack={!!active?.canGoBack}
					canGoForward={!!active?.canGoForward}
				/>
				{running && active && isBlank(active.url) && !active.loading && !agentBusy && <StartPage onGo={navigate} />}
				{running && active?.crashed && <CrashedPage onReload={() => history("reload")} />}
				{running && active?.dialog && <PageDialog tab={active} agentBusy={agentBusy} />}
				{running && active?.fileChooser && !agentBusy && <FileChooser tab={active} />}
				<StatusScreen state={state} startError={startError} onStart={start} onSaveSettings={saveSettings} />

				{running && (agentBusy || state?.takeover) && (
					<div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
						<div className="pointer-events-auto flex max-w-full animate-rise items-center gap-2 rounded-full border border-ink-700 bg-ink-900/95 py-1 pr-1 pl-3 text-xs shadow-xl shadow-black/40 backdrop-blur">
							{agentBusy ? (
								<>
									<Bot className="size-3.5 shrink-0 animate-pulse text-ember-400" />
									<span className="truncate text-ink-200">
										{t("agentWorking")}
										{actionLabel && <span className="text-ink-500"> · {actionLabel}</span>}
									</span>
									<button type="button" onClick={() => void browserCall("takeover")} className="flex shrink-0 items-center gap-1 rounded-full bg-ember-500 px-2.5 py-1 font-medium text-ink-950 hover:bg-ember-400">
										<Hand className="size-3" />
										{t("takeOver")}
									</button>
								</>
							) : (
								<>
									<Hand className="size-3.5 shrink-0 text-sky-400" />
									<span className="truncate text-ink-200">{t("takenOver")}</span>
									<button type="button" onClick={() => void browserCall("handback")} className="flex shrink-0 items-center gap-1 rounded-full border border-ink-600 px-2.5 py-1 text-ink-100 hover:bg-ink-800">
										<Bot className="size-3" />
										{t("handBack")}
									</button>
								</>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
