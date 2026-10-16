import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { NO_SUBAGENTS, selectSubagent, useStore } from "../lib/store.ts";
import { formatElapsed, isLive, StateIcon } from "./SubagentPanel.tsx";

const M = defineMessages({
	zh: { title: "子代理", live: "{n} 个运行中", done: "{n} 个已结束", view: "在右侧查看过程" },
	en: { title: "Subagents", live: "{n} running", done: "{n} finished", view: "View the process on the right" },
});

/**
 * Compact stand-in for the raw tool card of a `subagent` launch. Renders `fallback` while the panel
 * knows nothing about the call (arguments still streaming, a management call, or an old background run).
 */
export function SubagentCard({ callId, fallback }: { callId: string; fallback: React.ReactNode }) {
	const t = useT(M);
	const all = useStore((s) => s.session?.subagents ?? NO_SUBAGENTS);
	const selected = useStore((s) => s.subagentUi.selected);
	const runs = useMemo(() => all.filter((r) => r.callId === callId), [all, callId]);
	if (!runs.length) return <>{fallback}</>;

	const live = runs.filter(isLive).length;
	return (
		<div className="overflow-hidden rounded-xl border border-ink-800 bg-ink-900/70">
			<div className="flex items-center gap-2 border-b border-ink-800 px-3 py-1.5 text-[11px] text-ink-500">
				<span className="font-medium text-ink-300">{t("title")}</span>
				<span className={clsx("font-mono", live > 0 && "text-ember-300")}>{live > 0 ? t("live", { n: live }) : t("done", { n: runs.length })}</span>
			</div>
			<ul>
				{runs.map((r) => (
					<li key={r.id} className="border-b border-ink-800 last:border-b-0">
						<button
							type="button"
							onClick={() => selectSubagent(r.id)}
							title={t("view")}
							className={clsx("flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-ink-850", selected === r.id && "bg-ember-500/8")}
						>
							<StateIcon state={r.state} />
							<span className="shrink-0 font-mono text-[13px] font-medium text-ink-100">{r.agent}</span>
							<span className="min-w-0 flex-1 truncate text-xs text-ink-400">{r.task || r.error || "—"}</span>
							<span className="shrink-0 font-mono text-[11px] text-ink-500 tabular-nums">{formatElapsed((r.endedAt ?? Date.now()) - r.startedAt)}</span>
							<ChevronRight className="size-3.5 shrink-0 text-ink-600" />
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
