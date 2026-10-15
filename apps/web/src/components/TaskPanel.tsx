import clsx from "clsx";
import { Check, ChevronDown, ChevronUp, ListChecks, LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { latestTodos } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginActive, useStore } from "../lib/store.ts";

const M = defineMessages({
	zh: { title: "任务清单", progress: "{done}/{total} 已完成", allDone: "全部完成", expand: "展开", collapse: "收起" },
	en: { title: "Tasks", progress: "{done}/{total} done", allDone: "All done", expand: "Expand", collapse: "Collapse" },
});

/** The agent's live checklist, shown above the input. Hidden when the todos plugin is off or no list exists. */
export function TaskPanel() {
	const t = useT(M);
	const messages = useStore((s) => s.session?.messages);
	const enabled = useStore((s) => pluginActive(s.plugins, "todos"));
	const sessionId = useStore((s) => s.session?.id);
	const todos = useMemo(() => (enabled && messages ? latestTodos(messages) : []), [enabled, messages]);
	// Remember the collapsed state per conversation, not globally.
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	if (!todos.length) return null;

	const done = todos.filter((x) => x.status === "completed").length;
	const current = todos.find((x) => x.status === "in_progress");
	const finished = done === todos.length;
	const closed = collapsed[sessionId ?? ""] ?? false;

	return (
		<div className="mx-auto mb-2 w-full max-w-3xl px-5">
			<div className="overflow-hidden rounded-xl border border-ink-800 bg-ink-900/70 backdrop-blur">
				<button
					type="button"
					onClick={() => setCollapsed((c) => ({ ...c, [sessionId ?? ""]: !closed }))}
					className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs hover:bg-ink-850"
					aria-expanded={!closed}
					title={closed ? t("expand") : t("collapse")}
				>
					<ListChecks className={clsx("size-4 shrink-0", finished ? "text-moss-400" : "text-ember-400")} />
					<span className="font-medium text-ink-200">{t("title")}</span>
					<span className="font-mono text-ink-500">{finished ? t("allDone") : t("progress", { done, total: todos.length })}</span>
					{closed && current && <span className="min-w-0 flex-1 truncate text-ink-400">· {current.activeForm || current.content}</span>}
					<span className="flex-1" />
					<span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-ink-800">
						<span className={clsx("block h-full rounded-full transition-all duration-500", finished ? "bg-moss-400" : "bg-ember-500")} style={{ width: `${(done / todos.length) * 100}%` }} />
					</span>
					{closed ? <ChevronUp className="size-3.5 shrink-0 text-ink-500" /> : <ChevronDown className="size-3.5 shrink-0 text-ink-500" />}
				</button>
				{!closed && (
					<ul className="max-h-48 space-y-0.5 overflow-y-auto border-t border-ink-800 px-3.5 py-2">
						{todos.map((item, i) => (
							<li key={i} className="flex items-start gap-2 py-0.5 text-[13px]">
								<span className="mt-0.5 grid size-4 shrink-0 place-items-center">
									{item.status === "completed" ? (
										<Check className="size-3.5 text-moss-400" strokeWidth={3} />
									) : item.status === "in_progress" ? (
										<LoaderCircle className="size-3.5 animate-spin text-ember-400" />
									) : (
										<span className="size-2.5 rounded-full border border-ink-600" />
									)}
								</span>
								<span className={clsx(item.status === "completed" ? "text-ink-500 line-through" : item.status === "in_progress" ? "text-ink-100" : "text-ink-300")}>
									{item.status === "in_progress" ? item.activeForm || item.content : item.content}
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
