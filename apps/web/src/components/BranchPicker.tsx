import clsx from "clsx";
import { Check, ChevronDown, GitBranch, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { GitBranch as Branch, GitStatus } from "@prometheus/protocol";
import { promptDialog } from "../lib/dialogs.ts";
import { gitQuiet } from "../lib/git.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { onPluginChange, pluginActive, pluginCall, toast, useStore } from "../lib/store.ts";
import { usePopover } from "./TitleBar.tsx";

const M = defineMessages({
	zh: {
		branch: "切换分支",
		newBranch: "新建分支…",
		branchName: "新分支名称",
		switched: "已切换到 {name}",
		running: "对话运行中，暂不能切换分支",
		detached: "游离 HEAD",
		none: "没有本地分支",
	},
	en: {
		branch: "Switch branch",
		newBranch: "New branch…",
		branchName: "New branch name",
		switched: "Switched to {name}",
		running: "A run is in progress; branches can't be switched now",
		detached: "Detached HEAD",
		none: "No local branches",
	},
});

/** Current git branch of the open conversation's workspace, with a switcher. Renders nothing outside a git repo. */
export function BranchPicker() {
	const t = useT(M);
	const enabled = useStore((s) => pluginActive(s.plugins, "git"));
	const path = useStore((s) => s.workspaces.find((w) => w.id === s.session?.workspaceId)?.path);
	const streaming = useStore((s) => s.session?.isStreaming ?? false);
	const { open, setOpen, ref } = usePopover();
	const [status, setStatus] = useState<GitStatus | null>(null);
	const [branches, setBranches] = useState<Branch[]>([]);

	const refresh = useCallback(async () => {
		if (!enabled || !path) return setStatus(null);
		setStatus((await gitQuiet<GitStatus>(path, "status")) ?? null);
	}, [enabled, path]);

	// Also after every run: the agent may have switched branches itself.
	useEffect(() => {
		void refresh();
	}, [refresh, streaming]);
	useEffect(() => onPluginChange("git", () => void refresh()), [refresh]);
	useEffect(() => {
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	useEffect(() => {
		if (open) void gitQuiet<Branch[]>(path, "branches").then((b) => setBranches(b ?? []));
	}, [open, path]);

	if (!status?.isRepo) return null;
	const label = status.detached ? t("detached") : (status.branch ?? "");

	const checkout = async (name: string, create: boolean) => {
		setOpen(false);
		const res = await pluginCall("git", "checkout", { workspace: path, name, create });
		if (res !== undefined) toast(t("switched", { name }));
		await refresh();
	};

	const local = branches.filter((b) => !b.remote);
	return (
		<div ref={ref} className="relative min-w-0 shrink-0">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex max-w-48 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100"
				title={t("branch")}
				aria-label={t("branch")}
			>
				<GitBranch className="size-3.5 shrink-0 text-ember-400" />
				<span className="truncate">{label}</span>
				{(status.ahead > 0 || status.behind > 0) && (
					<span className="shrink-0 font-mono text-[10px] text-ink-500">
						{status.ahead > 0 && `↑${status.ahead}`}
						{status.behind > 0 && `↓${status.behind}`}
					</span>
				)}
				<ChevronDown className="size-3 shrink-0 opacity-60" />
			</button>
			{open && (
				<div className="absolute bottom-full left-0 z-40 mb-2 w-64 animate-rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur">
					{streaming && <div className="border-b border-ink-800 px-3.5 py-2 text-xs text-ember-300">{t("running")}</div>}
					<div className="max-h-[min(16rem,40dvh)] overflow-y-auto py-1">
						{local.length === 0 && <div className="px-3.5 py-3 text-center text-sm text-ink-500">{t("none")}</div>}
						{local.map((b) => (
							<button
								key={b.name}
								type="button"
								disabled={streaming && !b.current}
								onClick={() => (b.current ? setOpen(false) : void checkout(b.name, false))}
								className={clsx("flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-sm disabled:opacity-40", b.current ? "bg-ember-500/10 text-ember-200" : "text-ink-200 hover:bg-ink-800")}
							>
								<span className="w-3.5 shrink-0">{b.current && <Check className="size-3.5" />}</span>
								<span className="min-w-0 flex-1 truncate font-mono text-[13px]">{b.name}</span>
							</button>
						))}
					</div>
					<button
						type="button"
						disabled={streaming}
						onClick={() => {
							setOpen(false);
							void promptDialog(t("branchName")).then((n) => n && void checkout(n, true));
						}}
						className="flex w-full items-center gap-2 border-t border-ink-800 px-3.5 py-2.5 text-left text-sm text-ember-300 hover:bg-ink-800 disabled:opacity-40"
					>
						<Plus className="size-4" /> {t("newBranch")}
					</button>
				</div>
			)}
		</div>
	);
}
