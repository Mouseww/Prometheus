import clsx from "clsx";
import { Check, ChevronDown, FolderOpen, FolderPlus } from "lucide-react";
import { useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { addWorkspace, chooseWorkspace, useStore } from "../lib/store.ts";
import { FolderPicker } from "./FolderPicker.tsx";
import { usePopover } from "./TitleBar.tsx";

const M = defineMessages({
	zh: {
		pick: "选择工作区",
		add: "添加工作区…",
		none: "还没有工作区",
	},
	en: {
		pick: "Choose workspace",
		add: "Add workspace…",
		none: "No workspaces yet",
	},
});

/** Composer-footer workspace chooser for the new-chat page; the last entry opens the folder browser. */
export function WorkspacePicker() {
	const t = useT(M);
	const workspaces = useStore((s) => s.workspaces);
	const currentId = useStore((s) => s.session?.workspaceId);
	const { open, setOpen, ref } = usePopover();
	// Kept outside the popover: the folder dialog is a portal, so a click inside it would count as "outside" and unmount it.
	const [picking, setPicking] = useState(false);
	const active = workspaces.find((w) => w.id === currentId);

	return (
		<div ref={ref} className="md:relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className={clsx(
					"flex max-w-52 items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors",
					active ? "text-ink-300 hover:bg-ink-800 hover:text-ink-100" : "bg-ember-500/10 text-ember-300 hover:bg-ember-500/15",
				)}
				title={active?.path}
			>
				<FolderOpen className="size-3.5 shrink-0" />
				<span className="truncate">{active?.name ?? t("pick")}</span>
				<ChevronDown className="size-3 shrink-0 opacity-60" />
			</button>
			{open && (
				<div className="absolute bottom-full left-3 right-3 z-40 mb-2 md:left-0 md:right-auto md:w-72 animate-rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="max-h-64 overflow-y-auto py-1">
						{workspaces.length === 0 && <div className="px-3.5 py-4 text-center text-sm text-ink-500">{t("none")}</div>}
						{workspaces.map((w) => {
							const on = w.id === currentId;
							return (
								<button
									key={w.id}
									type="button"
									title={w.path}
									onClick={() => {
										setOpen(false);
										if (!on) void chooseWorkspace(w.path);
									}}
									className={clsx("flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-sm", on ? "bg-ember-500/10 text-ember-200" : "text-ink-200 hover:bg-ink-800")}
								>
									<span className="w-3.5 shrink-0">{on && <Check className="size-3.5" />}</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate">{w.name}</span>
										<span className="block truncate font-mono text-[10.5px] text-ink-500">{w.path}</span>
									</span>
								</button>
							);
						})}
					</div>
					<button
						type="button"
						onClick={() => {
							setOpen(false);
							setPicking(true);
						}}
						className="flex w-full items-center gap-2 border-t border-ink-800 px-3.5 py-2.5 text-left text-sm text-ember-300 hover:bg-ink-800"
					>
						<FolderPlus className="size-4" /> {t("add")}
					</button>
				</div>
			)}
			{picking && (
				<FolderPicker
					onClose={() => setPicking(false)}
					onPick={async (path) => {
						setPicking(false);
						const w = await addWorkspace(path);
						if (w) await chooseWorkspace(w.path);
					}}
				/>
			)}
		</div>
	);
}
