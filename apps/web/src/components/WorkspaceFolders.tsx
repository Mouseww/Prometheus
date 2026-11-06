import { FolderPlus, Folder, Star, X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceInfo } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { addWorkspace, setWorkspaceFolders } from "../lib/store.ts";
import { FolderPicker } from "./FolderPicker.tsx";
import { Button } from "./ui.tsx";

const M = defineMessages({
	zh: {
		titleNew: "添加工作区",
		titleEdit: "管理工作区文件夹",
		hint: "主要文件夹是对话的工作目录；附属文件夹也属于该项目，智能体可按绝对路径读写。",
		folders: "文件夹",
		primary: "主要",
		makePrimary: "设为主要",
		remove: "移除",
		add: "添加文件夹",
		cancel: "取消",
		create: "创建工作区",
		save: "保存",
		empty: "还没有文件夹，先添加一个",
	},
	en: {
		titleNew: "Add workspace",
		titleEdit: "Manage workspace folders",
		hint: "The primary folder is the chat's working directory; additional folders belong to the project too and the agent can read and edit them by absolute path.",
		folders: "Folders",
		primary: "Primary",
		makePrimary: "Make primary",
		remove: "Remove",
		add: "Add folder",
		cancel: "Cancel",
		create: "Create workspace",
		save: "Save",
		empty: "No folders yet; add one first",
	},
});

const key = (p: string) => p.replace(/[\/]+$/, "").toLowerCase();
const leaf = (p: string) => p.replace(/[\/]+$/, "").split(/[\/]/).pop() || p;

/**
 * Edits a project's folders. Without `existing` it creates a workspace (the first folder is the primary one and can be
 * changed before creating); with it only the additional folders change, because the primary path identifies the project.
 */
export function WorkspaceFolders({ existing, onClose, onDone }: { existing?: WorkspaceInfo; onClose: () => void; onDone?: (w: WorkspaceInfo) => void }) {
	const t = useT(M);
	const [folders, setFolders] = useState<string[]>(existing ? [existing.path, ...(existing.extraPaths ?? [])] : []);
	const [picking, setPicking] = useState(false);
	const [busy, setBusy] = useState(false);

	const makePrimary = (i: number) => setFolders((f) => [f[i]!, ...f.filter((_, j) => j !== i)]);
	const submit = async () => {
		if (!folders.length || busy) return;
		setBusy(true);
		const [main, ...extras] = folders;
		const w = existing ? await setWorkspaceFolders(existing.id, extras) : await addWorkspace(main!, extras);
		setBusy(false);
		if (!w) return;
		onClose();
		onDone?.(w);
	};

	return createPortal(
		<div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="flex max-h-[88vh] w-[min(520px,94vw)] animate-rise flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl shadow-black/50">
				<div className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
					<div className="min-w-0">
						<h2 className="font-display text-lg font-semibold">{existing ? t("titleEdit") : t("titleNew")}</h2>
						<p className="mt-0.5 text-xs text-ink-500">{t("hint")}</p>
					</div>
					<button type="button" onClick={onClose} className="rounded p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100" title={t("cancel")}>
						<X className="size-4" />
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
					<p className="pb-1.5 font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">
						{t("folders")} {folders.length}
					</p>
					<div className="overflow-hidden rounded-xl bg-ink-850">
						{folders.length === 0 && <p className="px-3 py-5 text-center text-sm text-ink-500">{t("empty")}</p>}
						{folders.map((p, i) => (
							<div key={key(p)} className="group flex items-center gap-2.5 px-3 py-2 hover:bg-ink-800">
								<Folder className="size-4 shrink-0 text-ember-400" />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm text-ink-100">{leaf(p)}</span>
									<span className="block truncate font-mono text-[10.5px] text-ink-500" title={p}>{p}</span>
								</span>
								{i === 0 ? (
									<span className="flex shrink-0 items-center gap-1 text-xs text-ink-300">
										<Star className="size-3 fill-current text-ember-400" /> {t("primary")}
									</span>
								) : (
									!existing && (
										<button type="button" onClick={() => makePrimary(i)} className="shrink-0 rounded px-1.5 py-0.5 text-xs text-ink-400 opacity-0 hover:bg-ink-700 hover:text-ember-300 group-hover:opacity-100 focus-visible:opacity-100">
											{t("makePrimary")}
										</button>
									)
								)}
								{(i > 0 || !existing) && (
									<button type="button" onClick={() => setFolders((f) => f.filter((_, j) => j !== i))} className="shrink-0 rounded p-1 text-ink-500 hover:bg-ink-700 hover:text-rose-400" title={t("remove")}>
										<X className="size-3.5" />
									</button>
								)}
							</div>
						))}
						<button type="button" onClick={() => setPicking(true)} className="flex w-full items-center gap-2.5 border-t border-ink-800 px-3 py-2.5 text-left text-sm text-ember-300 hover:bg-ink-800">
							<FolderPlus className="size-4" /> {t("add")}
						</button>
					</div>
				</div>
				<div className="flex justify-end gap-2 px-5 py-4">
					<Button variant="outline" onClick={onClose}>{t("cancel")}</Button>
					<Button variant="primary" disabled={!folders.length || busy} onClick={() => void submit()}>
						{existing ? t("save") : t("create")}
					</Button>
				</div>
			</div>
			{picking && (
				<FolderPicker
					onClose={() => setPicking(false)}
					onPick={(path) => {
						setPicking(false);
						setFolders((f) => (f.some((x) => key(x) === key(path)) ? f : [...f, path]));
					}}
				/>
			)}
		</div>,
		document.body,
	);
}
