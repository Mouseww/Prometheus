import clsx from "clsx";
import {
	Archive,
	ArchiveRestore,
	BookOpen,
	Brain,
	ChevronDown,
	ChevronRight,
	FolderOpen,
	FolderPlus,
	LogOut,
	MoreHorizontal,
	Pencil,
	Plus,
	PuzzleIcon,
	Settings,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PanelInfo, SessionSummary, WorkspaceInfo } from "@prometheus/protocol";
import { saveMode, saveRemote } from "../lib/backend.ts";
import type { BackendTarget } from "../lib/client.ts";
import { defineMessages, relativeTime, useT } from "../lib/i18n.ts";
import { usePrefs } from "../lib/prefs.ts";
import {
	addWorkspace,
	archiveSession,
	call,
	createSession,
	deleteSession,
	openSession,
	openSettings,
	renameSession,
	setView,
	startNewChat,
	useStore,
} from "../lib/store.ts";
import { FolderPicker } from "./FolderPicker.tsx";
import { usePopover } from "./TitleBar.tsx";

const M = defineMessages({
	zh: {
		knowledge: "知识库",
		memory: "记忆",
		settings: "设置",
		workspaces: "工作区",
		openFolder: "打开项目目录",
		newChat: "在此工作区新建对话",
		newSession: "新会话",
		startChat: "新对话",
		messages: "{n} 条",
		archived: "已归档 ({n})",
		rename: "重命名",
		archive: "归档",
		unarchive: "取消归档",
		delete: "删除",
		confirmDelete: "永久删除会话「{name}」？此操作不可撤销。",
		removeWorkspace: "从列表移除",
		confirmRemove: "从列表移除工作区「{name}」？会话文件不会被删除。",
		renameWorkspace: "重命名工作区",
		empty: "暂无对话",
		disconnect: "断开连接",
		local: "本机",
		noWorkspace: "打开一个项目目录开始对话",
		about: "关于 / 版本",
	},
	en: {
		knowledge: "Knowledge",
		memory: "Memory",
		settings: "Settings",
		workspaces: "Workspaces",
		openFolder: "Open project folder",
		newChat: "New chat in this workspace",
		newSession: "New chat",
		startChat: "New chat",
		messages: "{n} msgs",
		archived: "Archived ({n})",
		rename: "Rename",
		archive: "Archive",
		unarchive: "Unarchive",
		delete: "Delete",
		confirmDelete: "Permanently delete \"{name}\"? This cannot be undone.",
		removeWorkspace: "Remove from list",
		confirmRemove: "Remove workspace \"{name}\" from the list? Session files are kept.",
		renameWorkspace: "Rename workspace",
		empty: "No chats yet",
		disconnect: "Disconnect",
		local: "Local",
		noWorkspace: "Open a project folder to start",
		about: "About / version",
	},
});

const menuItem = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]";

function SessionMenu({ s, onRename }: { s: SessionSummary; onRename: () => void }) {
	const t = useT(M);
	const { open, setOpen, ref } = usePopover();
	const title = s.name || s.firstMessage || t("newSession");
	return (
		<div ref={ref} className="relative" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className={clsx("rounded p-0.5 text-ink-500 hover:bg-ink-700 hover:text-ink-100", open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100")}
				aria-label="menu"
			>
				<MoreHorizontal className="size-4" />
			</button>
			{open && (
				<div className="absolute top-full right-0 z-40 mt-1 w-40 animate-rise rounded-lg border border-ink-700 bg-ink-900 p-1 shadow-xl shadow-black/40">
					<button
						type="button"
						className={clsx(menuItem, "text-ink-200 hover:bg-ink-800")}
						onClick={() => {
							setOpen(false);
							onRename();
						}}
					>
						<Pencil className="size-3.5" /> {t("rename")}
					</button>
					<button
						type="button"
						className={clsx(menuItem, "text-ink-200 hover:bg-ink-800")}
						onClick={() => {
							setOpen(false);
							void archiveSession(s.id, !s.archived);
						}}
					>
						{s.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />} {s.archived ? t("unarchive") : t("archive")}
					</button>
					<button
						type="button"
						className={clsx(menuItem, "text-rose-400 hover:bg-rose-400/10")}
						onClick={() => {
							setOpen(false);
							if (confirm(t("confirmDelete", { name: title }))) void deleteSession(s.id);
						}}
					>
						<Trash2 className="size-3.5" /> {t("delete")}
					</button>
				</div>
			)}
		</div>
	);
}

function SessionRow({ s, active }: { s: SessionSummary; active: boolean }) {
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState("");
	const title = s.name || s.firstMessage || t("newSession");
	const startRename = () => {
		setName(s.name || s.firstMessage || "");
		setEditing(true);
	};

	if (editing) {
		return (
			<form
				className="px-1 py-0.5"
				onSubmit={(e) => {
					e.preventDefault();
					setEditing(false);
					if (name.trim() && name.trim() !== s.name) void renameSession(s.id, name.trim());
				}}
			>
				<input
					autoFocus
					value={name}
					onChange={(e) => setName(e.target.value)}
					onBlur={() => setEditing(false)}
					onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
					className="w-full rounded-md border border-ember-500/50 bg-ink-900 px-2 py-1 text-sm text-ink-100 focus:outline-none"
				/>
			</form>
		);
	}

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => !active && void openSession(s.id)}
			onKeyDown={(e) => e.key === "Enter" && void openSession(s.id)}
			onDoubleClick={startRename}
			className={clsx(
				"group relative flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-1.5 pl-3 transition-colors",
				active ? "bg-ink-800" : "hover:bg-ink-850",
				s.archived && "opacity-60",
			)}
		>
			{active && <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-ember-500" />}
			<div className="min-w-0 flex-1">
				<div className="truncate text-[13px] text-ink-200">{title}</div>
				<div className="flex items-center gap-1.5 text-[10.5px] text-ink-500">
					{s.live && <span className="size-1.5 rounded-full bg-moss-400" />}
					<span>{relativeTime(s.modified, lang)}</span>
					<span>·</span>
					<span>{t("messages", { n: s.messageCount })}</span>
				</div>
			</div>
			<SessionMenu s={s} onRename={startRename} />
		</div>
	);
}

function WorkspaceGroup({ w, sessions, activeId, current }: { w: WorkspaceInfo; sessions: SessionSummary[]; activeId?: string; current: boolean }) {
	const t = useT(M);
	const [open, setOpen] = useState(current);
	const [showArchived, setShowArchived] = useState(false);
	const live = sessions.filter((s) => !s.archived);
	const archived = sessions.filter((s) => s.archived);
	const menu = usePopover();

	useEffect(() => {
		if (current) setOpen(true);
	}, [current]);

	return (
		<div className="mb-1">
			<div className="group flex items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-ink-850">
				<button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={w.path}>
					{open ? <ChevronDown className="size-3.5 shrink-0 text-ink-500" /> : <ChevronRight className="size-3.5 shrink-0 text-ink-500" />}
					<FolderOpen className={clsx("size-4 shrink-0", current ? "text-ember-400" : "text-ink-400")} />
					<span className="truncate text-[13px] font-medium text-ink-200">{w.name}</span>
					{live.length > 0 && <span className="ml-1 font-mono text-[10px] text-ink-600">{live.length}</span>}
				</button>
				<div ref={menu.ref} className="relative flex items-center">
					<button
						type="button"
						onClick={() => menu.setOpen(!menu.open)}
						className={clsx("rounded p-0.5 text-ink-500 hover:bg-ink-700 hover:text-ink-100", menu.open ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
						aria-label="menu"
					>
						<MoreHorizontal className="size-4" />
					</button>
					{menu.open && (
						<div className="absolute top-full right-0 z-40 mt-1 w-44 animate-rise rounded-lg border border-ink-700 bg-ink-900 p-1 shadow-xl shadow-black/40">
							<button
								type="button"
								className={clsx(menuItem, "text-ink-200 hover:bg-ink-800")}
								onClick={() => {
									menu.setOpen(false);
									const name = prompt(t("renameWorkspace"), w.name);
									if (name?.trim()) void call((c) => c.rpc("workspace.rename", { id: w.id, name: name.trim() }));
								}}
							>
								<Pencil className="size-3.5" /> {t("rename")}
							</button>
							<button
								type="button"
								className={clsx(menuItem, "text-rose-400 hover:bg-rose-400/10")}
								onClick={() => {
									menu.setOpen(false);
									if (confirm(t("confirmRemove", { name: w.name }))) void call((c) => c.rpc("workspace.remove", { id: w.id }));
								}}
							>
								<X className="size-3.5" /> {t("removeWorkspace")}
							</button>
						</div>
					)}
				</div>
				<button type="button" onClick={() => void createSession(w.path)} className="rounded p-0.5 text-ink-500 hover:bg-ink-700 hover:text-ember-300" title={t("newChat")}>
					<Plus className="size-4" />
				</button>
			</div>
			{open && (
				<div className="mt-0.5 ml-3 space-y-0.5 border-l border-ink-800 pl-1.5">
					{live.length === 0 && <div className="px-3 py-1.5 text-xs text-ink-600">{t("empty")}</div>}
					{live.map((s) => (
						<SessionRow key={s.id} s={s} active={s.id === activeId} />
					))}
					{archived.length > 0 && (
						<>
							<button type="button" onClick={() => setShowArchived(!showArchived)} className="flex items-center gap-1 px-2 py-1 text-[11px] text-ink-500 hover:text-ink-300">
								{showArchived ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
								<Archive className="size-3" /> {t("archived", { n: archived.length })}
							</button>
							{showArchived && archived.map((s) => <SessionRow key={s.id} s={s} active={s.id === activeId} />)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

export function Sidebar({ target, onDisconnect }: { target: BackendTarget; onDisconnect: () => void }) {
	const t = useT(M);
	const sessions = useStore((s) => s.sessions);
	const workspaces = useStore((s) => s.workspaces);
	const active = useStore((s) => s.session);
	const view = useStore((s) => s.view);
	const conn = useStore((s) => s.conn);
	const [panels, setPanels] = useState<PanelInfo[]>([]);
	const [picking, setPicking] = useState(false);

	useEffect(() => {
		if (conn !== "open") return;
		void call((c) => c.rpc("plugin.list", {})).then((list) => list && setPanels(list.flatMap((p) => p.panels)));
	}, [conn]);

	const grouped = useMemo(() => {
		const map = new Map<string, SessionSummary[]>();
		for (const s of sessions) map.set(s.workspaceId, [...(map.get(s.workspaceId) ?? []), s]);
		return map;
	}, [sessions]);

	const nav = [
		{ view: "knowledge" as const, label: t("knowledge"), icon: BookOpen },
		{ view: "memory" as const, label: t("memory"), icon: Brain },
	];
	const navClass = (on: boolean) =>
		clsx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors", on ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:bg-ink-850 hover:text-ink-100");

	return (
		<aside className="flex w-72 shrink-0 flex-col border-r hairline bg-ink-950/60 backdrop-blur">
			<div className="px-2 pt-3">
				<button
					type="button"
					onClick={startNewChat}
					className="flex w-full items-center gap-2 rounded-lg border border-ink-700 px-3 py-2 text-sm font-medium text-ink-100 transition-colors hover:border-ember-500/50 hover:bg-ink-850"
				>
					<Plus className="size-4 text-ember-400" /> {t("startChat")}
				</button>
			</div>
			<div className="flex items-center justify-between px-3 pt-3 pb-1.5">
				<span className="px-1 font-mono text-[10.5px] tracking-[0.18em] text-ink-500 uppercase">{t("workspaces")}</span>
				<button type="button" onClick={() => setPicking(true)} className="rounded-md p-1 text-ink-400 hover:bg-ink-800 hover:text-ember-300" title={t("openFolder")}>
					<FolderPlus className="size-4" />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
				{workspaces.length === 0 && (
					<button
						type="button"
						onClick={() => setPicking(true)}
						className="mt-2 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-ink-700 px-4 py-6 text-sm text-ink-400 hover:border-ember-500/50 hover:text-ink-200"
					>
						<FolderPlus className="size-5 text-ember-400" />
						{t("noWorkspace")}
					</button>
				)}
				{workspaces.map((w) => (
					<WorkspaceGroup key={w.id} w={w} sessions={grouped.get(w.id) ?? []} activeId={active?.id} current={active?.workspaceId === w.id} />
				))}
			</div>

			<nav className="space-y-0.5 border-t hairline px-2 py-2">
				{nav.map((n) => (
					<button key={n.view} type="button" onClick={() => setView(n.view)} className={navClass(view === n.view)}>
						<n.icon className={clsx("size-4", view === n.view && "text-ember-400")} />
						{n.label}
					</button>
				))}
				{panels.map((p) => {
					const on = typeof view === "object" && view.panel === p.url;
					return (
						<button key={`${p.plugin}:${p.id}`} type="button" onClick={() => setView({ panel: p.url })} className={navClass(on)}>
							<PuzzleIcon className={clsx("size-4", on && "text-ember-400")} />
							{p.title}
						</button>
					);
				})}
				<button type="button" onClick={() => openSettings()} className={navClass(view === "settings")}>
					<Settings className={clsx("size-4", view === "settings" && "text-ember-400")} />
					{t("settings")}
				</button>
			</nav>

			<div className="flex items-center justify-between border-t hairline px-4 py-2.5 text-xs text-ink-500">
				<span className="flex min-w-0 items-center gap-1.5" title={target.httpBase}>
					<span className={clsx("size-1.5 shrink-0 rounded-full", conn === "open" ? "bg-moss-400" : "animate-breathe bg-ember-400")} />
					<span className="truncate">{target.label === "local" ? t("local") : target.label}</span>
					<button type="button" onClick={() => openSettings("general")} className="shrink-0 font-mono text-[11px] text-ink-600 hover:text-ink-300" title={t("about")}>
						v{__APP_VERSION__}
					</button>
				</span>
				<button
					type="button"
					onClick={() => {
						saveRemote(null);
						saveMode(null);
						onDisconnect();
					}}
					className="rounded p-1 hover:bg-ink-800 hover:text-ink-200"
					title={t("disconnect")}
				>
					<LogOut className="size-3.5" />
				</button>
			</div>

			{picking && (
				<FolderPicker
					onClose={() => setPicking(false)}
					onPick={async (path) => {
						setPicking(false);
						const w = await addWorkspace(path);
						if (w) await createSession(w.path);
					}}
				/>
			)}
		</aside>
	);
}
