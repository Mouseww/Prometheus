import clsx from "clsx";
import { Check, ChevronDown, ClipboardList, FilePen, Hand, ShieldAlert } from "lucide-react";
import { PERMISSION_MODES, type PermissionMode } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { setPermissionMode, useStore } from "../lib/store.ts";
import { usePopover } from "./TitleBar.tsx";

const M = defineMessages({
	zh: {
		title: "权限模式",
		hint: "Shift+Tab 切换",
		default: "默认",
		defaultDesc: "编辑文件、执行命令前先询问",
		acceptEdits: "自动编辑",
		acceptEditsDesc: "项目内的文件编辑自动通过，命令仍需确认",
		plan: "计划模式",
		planDesc: "只读调研，不做任何修改；给出计划并获批后才开始",
		bypassPermissions: "完全放行",
		bypassPermissionsDesc: "不再询问，直接执行所有操作（有风险）",
	},
	en: {
		title: "Permission mode",
		hint: "Shift+Tab to switch",
		default: "Default",
		defaultDesc: "Ask before editing files or running commands",
		acceptEdits: "Accept edits",
		acceptEditsDesc: "Edits inside the project pass; commands still ask",
		plan: "Plan mode",
		planDesc: "Read-only research; nothing changes until you approve the plan",
		bypassPermissions: "Bypass permissions",
		bypassPermissionsDesc: "Never ask; everything runs (risky)",
	},
});

const ICONS = { default: Hand, acceptEdits: FilePen, plan: ClipboardList, bypassPermissions: ShieldAlert } as const;
const TONE: Record<PermissionMode, string> = {
	default: "text-ink-400 hover:text-ink-200",
	acceptEdits: "text-moss-400",
	plan: "text-sky-400",
	bypassPermissions: "text-rose-400",
};

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
	return PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length] ?? "default";
}

export function usePermissionMode(): PermissionMode {
	return useStore((s) => s.session?.permissionMode ?? s.draftPermission);
}

/** Composer-footer chooser for how tool calls are gated; the same cycle is on Shift+Tab. */
export function PermissionPicker() {
	const t = useT(M);
	const mode = usePermissionMode();
	const { open, setOpen, ref } = usePopover();
	const Icon = ICONS[mode];

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className={clsx("flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-ink-800", TONE[mode])}
				title={`${t("title")} · ${t("hint")}`}
			>
				<Icon className="size-3.5 shrink-0" />
				<span>{t(mode)}</span>
				<ChevronDown className="size-3 shrink-0 opacity-60" />
			</button>
			{open && (
				<div className="absolute bottom-full left-0 z-40 mb-2 w-80 animate-rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="flex items-baseline justify-between px-3.5 pt-3 pb-1.5">
						<span className="text-sm font-medium text-ink-100">{t("title")}</span>
						<span className="font-mono text-[10.5px] text-ink-500">{t("hint")}</span>
					</div>
					<div className="pb-1.5">
						{PERMISSION_MODES.map((m) => {
							const ModeIcon = ICONS[m];
							return (
								<button
									key={m}
									type="button"
									onClick={() => {
										setOpen(false);
										void setPermissionMode(m);
									}}
									className={clsx("flex w-full items-start gap-2.5 px-3.5 py-2 text-left", m === mode ? "bg-ember-500/10" : "hover:bg-ink-800")}
								>
									<ModeIcon className={clsx("mt-0.5 size-4 shrink-0", m === "default" ? "text-ink-400" : TONE[m])} />
									<span className="min-w-0 flex-1">
										<span className={clsx("block text-sm", m === mode ? "text-ember-200" : "text-ink-100")}>{t(m)}</span>
										<span className="block text-xs text-ink-500">{t(`${m}Desc`)}</span>
									</span>
									{m === mode && <Check className="mt-0.5 size-3.5 shrink-0 text-ember-300" />}
								</button>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
