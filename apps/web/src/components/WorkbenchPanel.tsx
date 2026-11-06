import clsx from "clsx";
import { Check, Copy, Eye, FileText, FolderTree, Globe, LoaderCircle, PanelRightClose, RefreshCw, SquareTerminal, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyToClipboard } from "../lib/clipboard.ts";
import { usePanelWidth } from "../lib/panelWidth.ts";
import { useIsMobile } from "../lib/viewport.ts";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { highlightLines, languageFor } from "../lib/highlight.ts";
import type { WorkbenchFile } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { activateWorkbenchTab, closeWorkbenchTab, pluginCall, toast, toggleWorkbenchPanel, useStore, type WorkbenchTab } from "../lib/store.ts";
import { Markdown } from "./Markdown.tsx";
import { FolderView } from "./FolderView.tsx";
import { TerminalView } from "./TerminalView.tsx";

const DocumentPreview = lazy(() => import("./DocumentPreview.tsx"));
const BrowserView = lazy(() => import("./browser/BrowserView.tsx").then((m) => ({ default: m.BrowserView })));

const M = defineMessages({
	zh: {
		title: "查看器",
		close: "关闭",
		fold: "收起侧边栏",
		terminal: "终端",
		folder: "文件夹",
		browser: "浏览器",
		refresh: "刷新",
		copy: "复制内容",
		loading: "加载中…",
		binary: "二进制文件，无法预览",
		tooLarge: "文件太大，无法预览",
		truncated: "文件较大，只显示前 1 MB",
		preview: "渲染预览",
		source: "源码",
	},
	en: {
		title: "Viewer",
		close: "Close",
		fold: "Collapse side panel",
		terminal: "Terminal",
		folder: "Folder",
		browser: "Browser",
		refresh: "Refresh",
		copy: "Copy content",
		loading: "Loading…",
		binary: "Binary file, no preview",
		tooLarge: "File too large to preview",
		truncated: "Large file: showing the first 1 MB",
		preview: "Preview",
		source: "Source",
	},
});

/** Right-hand viewer for files and terminals. Renders nothing until a tab exists. */
export function WorkbenchPanel() {
	const t = useT(M);
	const tabs = useStore((s) => s.workbench.tabs);
	const active = useStore((s) => s.workbench.active);
	const enabled = useStore((s) => s.plugins.some((p) => p.name === "workbench" && p.status === "loaded"));
	// Settings and other pages open over the chat area; the panel steps aside (kept mounted) so they get the full width.
	const pageOpen = useStore((s) => s.view !== "chat");
	const wide = useStore((s) => s.workbench.wide ?? false);
	const collapsed = useStore((s) => s.workbench.collapsed ?? false);
	const isMobile = useIsMobile();
	const fileWidth = usePanelWidth("workbench", { min: 320, max: 1100, edge: "left" });
	const browserWidth = usePanelWidth("workbench.browser", { min: 360, max: 1400, edge: "left" });
	if (!enabled || !tabs.length) return null;
	const tab = tabs.find((x) => x.id === active) ?? tabs[0];
	if (!tab) return null;
	const browser = tab.kind === "browser";
	const pw = browser ? browserWidth : fileWidth;
	const resizable = !isMobile && !(browser && wide);
	return (
		<aside
			className={clsx(
				pageOpen || collapsed ? "hidden" : "flex",
				"relative shrink-0 flex-col border-l hairline bg-ink-900/80 backdrop-blur max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:w-full max-md:bg-ink-900 max-md:shadow-2xl",
				browser && wide ? "w-[min(80rem,calc(100%-24rem))]" : browser ? "w-[32rem] lg:w-[44rem] 2xl:w-[56rem]" : "w-[28rem] max-md:w-[min(30rem,100%)] lg:w-[38rem]",
			)}
			style={resizable && pw.width !== null ? { width: pw.width } : undefined}
			aria-label={t("title")}
		>
			{resizable && <ResizeHandle panel={pw} />}
			<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b hairline px-1.5 py-1">
				{tabs.map((x) => (
					<div key={x.id} className={clsx("group flex max-w-48 shrink-0 items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-xs", x.id === tab.id ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:bg-ink-850")}>
						<button type="button" onClick={() => activateWorkbenchTab(x.id)} className="flex min-w-0 items-center gap-1.5" title={x.kind === "file" ? x.path : t(x.kind)}>
							{x.kind === "terminal" ? (
								<SquareTerminal className="size-3.5 shrink-0" />
							) : x.kind === "folder" ? (
								<FolderTree className="size-3.5 shrink-0" />
							) : x.kind === "browser" ? (
								<Globe className="size-3.5 shrink-0" />
							) : (
								<FileText className="size-3.5 shrink-0" />
							)}
							<span className="truncate">{x.kind === "file" ? baseName(x.path) : t(x.kind)}</span>
						</button>
						<button type="button" onClick={() => closeWorkbenchTab(x.id)} className="grid size-4 place-items-center rounded hover:bg-ink-700" aria-label={t("close")}>
							<X className="size-3" />
						</button>
					</div>
				))}
				<button type="button" onClick={toggleWorkbenchPanel} className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100" title={t("fold")} aria-label={t("fold")}>
					<PanelRightClose className="size-4" />
				</button>
			</div>
			<div className="min-h-0 flex-1">
				{tab.kind === "terminal" ? (
					<TerminalView key={tab.id} tab={tab} />
				) : tab.kind === "folder" ? (
					<FolderView key={tab.id} cwd={tab.cwd} />
				) : tab.kind === "browser" ? (
					<Suspense fallback={<LoaderCircle className="m-4 size-5 animate-spin text-ink-500" />}>
						<BrowserView />
					</Suspense>
				) : (
					<FileView key={tab.id} tab={tab} />
				)}
			</div>
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
	const [reloads, setReloads] = useState(0);
	const streaming = useStore((s) => s.session?.isStreaming ?? false);
	const lineRef = useRef<HTMLTableRowElement>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setReloads((n) => n + 1);
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

	const [copied, setCopied] = useState(false);
	const lines = useMemo(() => (file?.kind === "text" ? (file.text ?? "").split("\n") : []), [file]);
	const isMd = file?.language === "markdown";
	// Coloured lines, same count as `lines`; null shows the text plain (unknown language, or too big to colour quickly).
	const colored = useMemo(() => {
		if (file?.kind !== "text") return null;
		const html = highlightLines(file.text ?? "", languageFor(file.name, file.language));
		return html && html.length === lines.length ? html : null;
	}, [file, lines]);
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
				{file?.kind === "text" && (
					<button
						type="button"
						onClick={() =>
							void copyToClipboard(file.text ?? "").then(
								() => {
									setCopied(true);
									setTimeout(() => setCopied(false), 1500);
								},
								(err) => toast(err instanceof Error ? err.message : String(err), "error"),
							)
						}
						className="grid size-6 place-items-center rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100"
						title={t("copy")}
					>
						{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
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
				{(file?.kind === "binary" || file?.kind === "tooLarge") && (
					<Suspense fallback={<LoaderCircle className="m-4 size-5 animate-spin text-ink-500" />}>
						<DocumentPreview path={tab.path} name={file.name} refreshKey={reloads} />
					</Suspense>
				)}
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
					<table className={clsx("code-view w-full border-collapse font-mono text-[12px] leading-5", colored && "hljs")}>
						<tbody>
							{lines.map((line, i) => (
								<tr key={i} ref={tab.line === i + 1 ? lineRef : undefined} className={clsx(tab.line === i + 1 && "bg-ember-500/15")}>
									<td className="w-10 select-none px-2 text-right align-top text-ink-600">{i + 1}</td>
									{colored ? (
										<td className="whitespace-pre-wrap break-all pr-3" dangerouslySetInnerHTML={{ __html: colored[i] || " " }} />
									) : (
										<td className="whitespace-pre-wrap break-all pr-3 text-ink-200">{line || " "}</td>
									)}
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
