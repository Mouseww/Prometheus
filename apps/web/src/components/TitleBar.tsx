import clsx from "clsx";
import { Code, ExternalLink, FolderOpen, FolderTree, Minus, PanelLeft, PanelRight, Square, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isDesktopShell, isLoopbackHost } from "../lib/backend.ts";
import { localizeError } from "../lib/errors.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call, closeWorkbenchTab, NO_SUBAGENTS, openFolderTab, openTerminalTab, pluginActive, toggleSubagentPanel, useStore } from "../lib/store.ts";
import { Flame } from "./ui.tsx";

const M = defineMessages({
	zh: {
		terminal: "终端",
		folder: "文件夹",
		subagents: "子代理",
		toggleSidebar: "切换侧栏",
		minimize: "最小化",
		maximize: "最大化",
		close: "关闭",
		newChat: "新会话",
		knowledge: "知识库",
		memory: "记忆",
		settings: "设置",
		openIn: "在其他应用中打开",
	},
	en: {
		terminal: "Terminal",
		folder: "Folder",
		subagents: "Subagents",
		toggleSidebar: "Toggle sidebar",
		minimize: "Minimize",
		maximize: "Maximize",
		close: "Close",
		newChat: "New chat",
		knowledge: "Knowledge",
		memory: "Memory",
		settings: "Settings",
		openIn: "Open in…",
	},
});

export function usePopover() {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent) => {
			const target = e.target as Element;
			// Menus portalled to <body> (FloatingMenu) live outside `ref` but belong to it.
			if (!ref.current?.contains(target) && !target.closest?.("[data-floating-menu]")) setOpen(false);
		};
		const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		document.addEventListener("mousedown", close);
		document.addEventListener("keydown", esc);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("keydown", esc);
		};
	}, [open]);
	return { open, setOpen, ref };
}

function SubagentToggle() {
	const t = useT(M);
	const open = useStore((s) => s.subagentUi.open);
	const count = useStore((s) => (s.session?.subagents ?? NO_SUBAGENTS).length);
	const live = useStore((s) => (s.session?.subagents ?? NO_SUBAGENTS).some((r) => r.state === "running" || r.state === "queued"));
	// Nothing to show until the conversation has used a subagent.
	if (count === 0) return null;
	return (
		<button
			type="button"
			onClick={toggleSubagentPanel}
			aria-pressed={open}
			className={clsx("relative rounded-md p-1.5 hover:bg-ink-800", open ? "bg-ink-800 text-ember-300" : "text-ink-400 hover:text-ink-100")}
			title={t("subagents")}
			aria-label={t("subagents")}
		>
			<PanelRight className="size-4" />
			{live && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-ember-400" />}
		</button>
	);
}

function TerminalToggle() {
	const t = useT(M);
	const enabled = useStore((s) => pluginActive(s.plugins, "terminal"));
	const open = useStore((s) => s.workbench.tabs.some((x) => x.kind === "terminal"));
	const cwd = useStore((s) => s.session?.cwd ?? "");
	if (!enabled) return null;
	return (
		<button
			type="button"
			onClick={() => (open ? closeWorkbenchTab("terminal") : openTerminalTab(cwd))}
			aria-pressed={open}
			className={clsx("rounded-md p-1.5 hover:bg-ink-800", open ? "bg-ink-800 text-ember-300" : "text-ink-400 hover:text-ink-100")}
			title={t("terminal")}
			aria-label={t("terminal")}
		>
			<SquareTerminal className="size-4" />
		</button>
	);
}

function FolderToggle() {
	const t = useT(M);
	const enabled = useStore((s) => pluginActive(s.plugins, "folder"));
	const open = useStore((s) => s.workbench.tabs.some((x) => x.kind === "folder"));
	const cwd = useStore((s) => s.session?.cwd ?? "");
	if (!enabled) return null;
	return (
		<button
			type="button"
			onClick={() => (open ? closeWorkbenchTab("folder") : openFolderTab(cwd))}
			aria-pressed={open}
			className={clsx("rounded-md p-1.5 hover:bg-ink-800", open ? "bg-ink-800 text-ember-300" : "text-ink-400 hover:text-ink-100")}
			title={t("folder")}
			aria-label={t("folder")}
		>
			<FolderTree className="size-4" />
		</button>
	);
}

/** Hands the workspace folder to the file manager or an installed editor. Only offered when the server is this machine. */
function OpenInMenu() {
	const t = useT(M);
	const client = useStore((s) => s.client);
	const path = useStore((s) => s.workspaces.find((w) => w.id === s.session?.workspaceId)?.path);
	const local = client ? isLoopbackHost(client.target.httpBase) : false;
	const { open, setOpen, ref } = usePopover();
	const [apps, setApps] = useState<{ id: string; label: string }[]>([]);

	useEffect(() => {
		if (open && local) void call((c) => c.rpc("system.apps", {})).then((list) => list && setApps(list));
	}, [open, local]);

	if (!local || !path) return null;
	return (
		<div ref={ref} className="relative">
			<button type="button" onClick={() => setOpen(!open)} className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100" title={t("openIn")} aria-label={t("openIn")}>
				<ExternalLink className="size-4" />
			</button>
			{open && (
				<div className="absolute top-full right-0 z-40 mt-2 w-52 animate-rise rounded-xl border border-ink-700 bg-ink-900/97 p-1.5 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="px-2.5 pt-1 pb-1.5 font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">{t("openIn")}</div>
					{apps.map((a) => (
						<button
							key={a.id}
							type="button"
							onClick={async () => {
								setOpen(false);
								await call((c) => c.rpc("system.openIn", { app: a.id, path }));
							}}
							className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-ink-200 hover:bg-ink-800"
						>
							{a.id === "files" ? <FolderOpen className="size-4 text-ember-400" /> : <Code className="size-4 text-sky-400" />}
							{localizeError(a.label)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

function SessionTools() {
	const session = useStore((s) => s.session);
	if (!session) return null;
	return (
		<div className="flex items-center gap-1">
			{Object.entries(session.statuses).map(([k, v]) => (
				<span key={k} className="hidden rounded-md bg-ink-850 px-2 py-0.5 font-mono text-[11px] text-ink-400 md:inline">
					{v}
				</span>
			))}
			<OpenInMenu />
			<FolderToggle />
			<TerminalToggle />
			<SubagentToggle />
		</div>
	);
}

function WindowControls() {
	const t = useT(M);
	const act = async (op: "minimize" | "toggleMaximize" | "close") => {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		await getCurrentWindow()[op]();
	};
	const base = "grid h-full w-11 place-items-center text-ink-400 transition-colors";
	return (
		<div className="ml-1 flex h-full items-stretch">
			<button type="button" className={clsx(base, "hover:bg-ink-800 hover:text-ink-100")} onClick={() => void act("minimize")} aria-label={t("minimize")}>
				<Minus className="size-4" />
			</button>
			<button type="button" className={clsx(base, "hover:bg-ink-800 hover:text-ink-100")} onClick={() => void act("toggleMaximize")} aria-label={t("maximize")}>
				<Square className="size-3" />
			</button>
			<button type="button" className={clsx(base, "hover:bg-rose-500 hover:text-white")} onClick={() => void act("close")} aria-label={t("close")}>
				<X className="size-4" />
			</button>
		</div>
	);
}

export function TitleBar({ onToggleSidebar, bare }: { onToggleSidebar?: () => void; bare?: boolean }) {
	const t = useT(M);
	const session = useStore((s) => s.session);
	const workspaces = useStore((s) => s.workspaces);
	const title = useStore((s) => s.title);
	const summary = useStore((s) => s.sessions.find((x) => x.id === s.session?.id));
	const desktop = isDesktopShell();
	const ws = workspaces.find((w) => w.id === session?.workspaceId);
	const firstUser = session?.messages.find((m) => m.role === "user");
	const firstText = firstUser ? (typeof firstUser.content === "string" ? firstUser.content : firstUser.content.map((c) => (c.type === "text" ? c.text : "")).join("")) : "";
	const name = title || session?.name || summary?.name || firstText.trim() || localizeError(summary?.firstMessage ?? "") || t("newChat");

	let heading: React.ReactNode = null;
	if (bare) {
		heading = null;
	} else {
		heading = (
			<span className="flex min-w-0 items-center gap-2" data-tauri-drag-region>
				{ws && (
					<span className="flex shrink-0 items-center gap-1.5 rounded-md bg-ink-850 px-2 py-0.5 text-xs text-ink-300 max-sm:hidden" title={ws.path} data-tauri-drag-region>
						<FolderOpen className="size-3.5 text-ember-400" />
						{ws.name}
					</span>
				)}
				<span className="truncate text-sm text-ink-200" title={name} data-tauri-drag-region>
					{name}
				</span>
			</span>
		);
	}

	return (
		<header className="titlebar relative z-30 flex min-h-11 shrink-0 items-center gap-2 border-b hairline bg-ink-950/70 pl-2 backdrop-blur" data-tauri-drag-region>
			{onToggleSidebar && (
				<button type="button" onClick={onToggleSidebar} className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100 max-md:p-2.5" aria-label={t("toggleSidebar")}>
					<PanelLeft className="size-4" />
				</button>
			)}
			<span className="flex items-center gap-1.5 pr-2 pl-1" data-tauri-drag-region>
				<Flame className="pointer-events-none size-5" />
				<span className="pointer-events-none font-display text-sm font-semibold tracking-tight max-sm:hidden">Prometheus</span>
			</span>
			{!bare && <span className="h-4 w-px bg-ink-700" />}
			<div className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-1" data-tauri-drag-region>
				{heading}
			</div>
			{!bare && <SessionTools />}
			{desktop ? <WindowControls /> : <span className="w-2" />}
		</header>
	);
}
