import clsx from "clsx";
import { ChevronRight, CircleAlert, CircleHelp, CircleCheck, CircleSlash, ShieldAlert } from "lucide-react";
import type { ToolResultMessage } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { openSession } from "../lib/store.ts";

const M = defineMessages({
	zh: {
		title: "派活",
		success: "已完成",
		error: "出错了",
		aborted: "已中止",
		refused: "没有派出",
		asking: "在向你提问",
		running: "仍在进行",
		readonly: "只读",
		edits: "可改文件",
		full: "完全权限",
		lowered: "权限被降为{to}（对话的权限模式不允许{from}）",
		open: "打开那个对话",
	},
	en: {
		title: "Delegated",
		success: "Done",
		error: "Failed",
		aborted: "Aborted",
		refused: "Not sent",
		asking: "Asking a question",
		running: "Still running",
		readonly: "Read-only",
		edits: "Can edit files",
		full: "Full access",
		lowered: "Access lowered to {to} (this chat's permission mode does not allow {from})",
		open: "Open that chat",
	},
});

export interface Delegation {
	sessionId?: string;
	project: string;
	status: "success" | "error" | "aborted" | "refused" | "asking" | "running";
	requested: "readonly" | "edits" | "full";
	access: "readonly" | "edits" | "full";
}

/** The delegation a tool result carries, if it has a well-formed one. */
export function delegationOf(result: ToolResultMessage | undefined): Delegation | undefined {
	const d = (result?.details as { delegation?: Partial<Delegation> } | undefined)?.delegation;
	if (!d || typeof d.project !== "string" || !d.status || !d.access || !d.requested) return undefined;
	return d as Delegation;
}

/** A delegated run shown as one line: where it went, how it ended, what it was allowed, and a way into its chat. */
export function DelegationCard({ card, fallback }: { card: Delegation; fallback: React.ReactNode }) {
	const t = useT(M);
	const Icon = card.status === "success" ? CircleCheck : card.status === "refused" ? CircleSlash : card.status === "asking" || card.status === "running" ? CircleHelp : CircleAlert;
	const lowered = card.access !== card.requested;
	return (
		<div className="space-y-2">
			<div className="overflow-hidden rounded-xl border border-ink-800 bg-ink-900/70">
				<div className="flex items-center gap-2.5 px-3 py-2">
					<Icon className={clsx("size-4 shrink-0", card.status === "success" ? "text-emerald-400" : card.status === "refused" ? "text-ink-500" : card.status === "asking" || card.status === "running" ? "text-amber-400" : "text-rose-400")} />
					<span className="shrink-0 text-[11px] text-ink-500">{t("title")}</span>
					<span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-ink-100">{card.project}</span>
					<span className="shrink-0 text-xs text-ink-400">{t(card.status)}</span>
					<span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-300">{t(card.access)}</span>
					{card.sessionId && (
						<button type="button" onClick={() => void openSession(card.sessionId!)} title={t("open")} className="shrink-0 rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ember-300">
							<ChevronRight className="size-4" />
						</button>
					)}
				</div>
				{lowered && (
					<div className="flex items-center gap-1.5 border-t border-ink-800 px-3 py-1.5 text-[11px] text-amber-400">
						<ShieldAlert className="size-3.5 shrink-0" />
						{t("lowered", { to: t(card.access), from: t(card.requested) })}
					</div>
				)}
			</div>
			{fallback}
		</div>
	);
}
