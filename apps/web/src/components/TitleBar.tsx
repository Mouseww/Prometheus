import clsx from "clsx";
import { FolderOpen, Minimize2, Minus, PanelLeft, Square, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ToolInfo } from "@prometheus/protocol";
import { isTauri } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call, toast, useStore } from "../lib/store.ts";
import { Flame } from "./ui.tsx";

const M = defineMessages({
	zh: {
		tools: "工具",
		toolSwitch: "工具开关",
		compact: "压缩上下文",
		compacting: "开始压缩上下文…",
		toggleSidebar: "切换侧栏",
		minimize: "最小化",
		maximize: "最大化",
		close: "关闭",
		newChat: "新会话",
		input: "输入 {i} · 输出 {o}",
		knowledge: "知识库",
		memory: "记忆",
		settings: "设置",
	},
	en: {
		tools: "Tools",
		toolSwitch: "Tool switches",
		compact: "Compact context",
		compacting: "Compacting context…",
		toggleSidebar: "Toggle sidebar",
		minimize: "Minimize",
		maximize: "Maximize",
		close: "Close",
		newChat: "New chat",
		input: "Input {i} · Output {o}",
		knowledge: "Knowledge",
		memory: "Memory",
		settings: "Settings",
	},
});

export function usePopover() {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
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

function ToolsPopover() {
	const t = useT(M);
	const sessionId = useStore((s) => s.session?.id);
	const { open, setOpen, ref } = usePopover();
	const [tools, setTools] = useState<ToolInfo[]>([]);

	useEffect(() => {
		if (open && sessionId) void call((c) => c.rpc("tools.list", { sessionId })).then((list) => list && setTools(list));
	}, [open, sessionId]);

	const toggle = async (name: string) => {
		if (!sessionId) return;
		const next = tools.map((x) => (x.name === name ? { ...x, active: !x.active } : x));
		setTools(next);
		await call((c) => c.rpc("tools.set", { sessionId, active: next.filter((x) => x.active).map((x) => x.name) }));
	};

	return (
		<div ref={ref} className="relative">
			<button type="button" onClick={() => setOpen(!open)} className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100" title={t("tools")}>
				<Wrench className="size-4" />
			</button>
			{open && (
				<div className="absolute top-full right-0 z-40 mt-2 w-80 animate-rise rounded-xl border border-ink-700 bg-ink-900/97 p-1.5 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="px-2.5 pt-1.5 pb-2 font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">{t("toolSwitch")}</div>
					<div className="max-h-96 overflow-y-auto">
						{tools.map((x) => (
							<label key={x.name} className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-ink-800">
								<input type="checkbox" checked={x.active} onChange={() => void toggle(x.name)} className="mt-0.5 accent-ember-500" />
								<span className="min-w-0">
									<span className="block font-mono text-[13px] text-ink-100">{x.name}</span>
									<span className="line-clamp-2 text-xs text-ink-500">{x.description}</span>
								</span>
							</label>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

function ContextRing({ percent }: { percent: number | null }) {
	const p = Math.min(Math.max(percent ?? 0, 0), 100);
	const r = 8;
	const c = 2 * Math.PI * r;
	const color = p > 85 ? "var(--color-rose-400)" : p > 60 ? "var(--color-ember-300)" : "var(--color-moss-400)";
	return (
		<svg viewBox="0 0 20 20" className="size-4 -rotate-90">
			<circle cx="10" cy="10" r={r} fill="none" stroke="var(--color-ink-700)" strokeWidth="2.5" />
			<circle cx="10" cy="10" r={r} fill="none" stroke={color} strokeWidth="2.5" strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} strokeLinecap="round" />
		</svg>
	);
}

function SessionTools() {
	const t = useT(M);
	const session = useStore((s) => s.session);
	if (!session) return null;
	const stats = session.stats;
	const compact = async () => {
		const ok = await call((c) => c.rpc("chat.compact", { sessionId: session.id }));
		if (ok !== undefined) toast(t("compacting"));
	};
	return (
		<div className="flex items-center gap-1">
			{Object.entries(session.statuses).map(([k, v]) => (
				<span key={k} className="hidden rounded-md bg-ink-850 px-2 py-0.5 font-mono text-[11px] text-ink-400 md:inline">
					{v}
				</span>
			))}
			{stats && (
				<div className="flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] text-ink-400" title={t("input", { i: stats.inputTokens, o: stats.outputTokens })}>
					<ContextRing percent={stats.contextPercent} />
					<span className="hidden sm:inline">
						{stats.contextTokens != null ? `${(stats.contextTokens / 1000).toFixed(1)}k` : "—"} / {Math.round(stats.contextWindow / 1000)}k
					</span>
					{stats.totalCost > 0 && <span className="hidden text-ink-500 lg:inline">${stats.totalCost.toFixed(4)}</span>}
				</div>
			)}
			<button type="button" onClick={() => void compact()} disabled={session.isStreaming} className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100 disabled:opacity-30" title={t("compact")}>
				<Minimize2 className="size-4" />
			</button>
			<ToolsPopover />
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
	const view = useStore((s) => s.view);
	const session = useStore((s) => s.session);
	const workspaces = useStore((s) => s.workspaces);
	const title = useStore((s) => s.title);
	const desktop = isTauri();
	const ws = workspaces.find((w) => w.id === session?.workspaceId);

	let heading: React.ReactNode = null;
	if (bare) {
		heading = null;
	} else if (view === "chat") {
		heading = (
			<span className="flex min-w-0 items-center gap-2" data-tauri-drag-region>
				{ws && (
					<span className="flex shrink-0 items-center gap-1.5 rounded-md bg-ink-850 px-2 py-0.5 text-xs text-ink-300" title={ws.path} data-tauri-drag-region>
						<FolderOpen className="size-3.5 text-ember-400" />
						{ws.name}
					</span>
				)}
				<span className="truncate text-sm text-ink-200" data-tauri-drag-region>
					{title ?? session?.name ?? t("newChat")}
				</span>
			</span>
		);
	} else {
		const label = view === "settings" ? t("settings") : view === "knowledge" ? t("knowledge") : view === "memory" ? t("memory") : "";
		heading = (
			<span className="truncate text-sm text-ink-200" data-tauri-drag-region>
				{label}
			</span>
		);
	}

	return (
		<header className="titlebar relative z-30 flex h-11 shrink-0 items-center gap-2 border-b hairline bg-ink-950/70 pl-2 backdrop-blur" data-tauri-drag-region>
			{onToggleSidebar && (
				<button type="button" onClick={onToggleSidebar} className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100" aria-label={t("toggleSidebar")}>
					<PanelLeft className="size-4" />
				</button>
			)}
			<span className="flex items-center gap-1.5 pr-2 pl-1" data-tauri-drag-region>
				<Flame className="pointer-events-none size-5" />
				<span className="pointer-events-none font-display text-sm font-semibold tracking-tight">Prometheus</span>
			</span>
			{!bare && <span className="h-4 w-px bg-ink-700" />}
			<div className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-1" data-tauri-drag-region>
				{heading}
			</div>
			{!bare && view === "chat" && <SessionTools />}
			{desktop ? <WindowControls /> : <span className="w-2" />}
		</header>
	);
}
