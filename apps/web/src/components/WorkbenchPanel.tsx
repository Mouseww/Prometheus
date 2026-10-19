import clsx from "clsx";
import { Eye, FileText, LoaderCircle, RefreshCw, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkbenchFile } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { activateWorkbenchTab, closeWorkbenchTab, pluginCall, useStore, type WorkbenchTab } from "../lib/store.ts";
import { Markdown } from "./Markdown.tsx";
import { TerminalView } from "./TerminalView.tsx";

const M = defineMessages({
	zh: {
		title: "查看器",
		close: "关闭",
		terminal: "终端",
		refresh: "刷新",
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
		terminal: "Terminal",
		refresh: "Refresh",
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
	if (!enabled || !tabs.length) return null;
	const tab = tabs.find((x) => x.id === active) ?? tabs[0];
	if (!tab) return null;
	return (
		<aside
			className={clsx(pageOpen ? "hidden" : "flex", "w-[28rem] shrink-0 flex-col border-l hairline bg-ink-900/80 backdrop-blur max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:w-[min(30rem,100%)] max-md:bg-ink-900 max-md:shadow-2xl lg:w-[38rem]")}
			aria-label={t("title")}
		>
			<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b hairline px-1.5 py-1">
				{tabs.map((x) => (
					<div key={x.id} className={clsx("group flex max-w-48 shrink-0 items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-xs", x.id === tab.id ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:bg-ink-850")}>
						<button type="button" onClick={() => activateWorkbenchTab(x.id)} className="flex min-w-0 items-center gap-1.5" title={x.kind === "file" ? x.path : t("terminal")}>
							{x.kind === "terminal" ? <SquareTerminal className="size-3.5 shrink-0" /> : <FileText className="size-3.5 shrink-0" />}
							<span className="truncate">{x.kind === "terminal" ? t("terminal") : baseName(x.path)}</span>
						</button>
						<button type="button" onClick={() => closeWorkbenchTab(x.id)} className="grid size-4 place-items-center rounded hover:bg-ink-700" aria-label={t("close")}>
							<X className="size-3" />
						</button>
					</div>
				))}
			</div>
			<div className="min-h-0 flex-1">{tab.kind === "terminal" ? <TerminalView key={tab.id} tab={tab} /> : <FileView key={tab.id} tab={tab} />}</div>
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
