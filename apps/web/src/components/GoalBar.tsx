import clsx from "clsx";
import { ChevronDown, CircleCheck, CirclePause, CircleStop, OctagonAlert, Play, Target, X } from "lucide-react";
import { useState } from "react";
import type { GoalStatus } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { controlGoal, useStore } from "../lib/store.ts";

const M = defineMessages({
	zh: {
		goal: "目标",
		active: "自动推进中",
		paused: "已暂停",
		complete: "已完成",
		blocked: "需要你介入",
		limit: "已达轮数上限",
		turns: "第 {n}/{max} 轮",
		pause: "暂停",
		resume: "继续",
		resumeMore: "再给 {n} 轮",
		clear: "清除目标",
		dismiss: "关闭",
		details: "展开",
		hint: "Agent 会一轮接一轮地自己推进，直到报告完成、受阻或用完轮数。中途发消息会作为补充指示，目标继续。",
	},
	en: {
		goal: "Goal",
		active: "Working on it",
		paused: "Paused",
		complete: "Done",
		blocked: "Needs you",
		limit: "Turn limit reached",
		turns: "Turn {n}/{max}",
		pause: "Pause",
		resume: "Resume",
		resumeMore: "{n} more turns",
		clear: "Clear goal",
		dismiss: "Dismiss",
		details: "Details",
		hint: "The agent keeps taking turns on its own until it reports the goal done, blocked, or runs out of turns. Messages you send meanwhile steer it; the goal carries on.",
	},
});

const TONE: Record<GoalStatus, string> = {
	active: "text-ember-300",
	paused: "text-ink-400",
	complete: "text-moss-400",
	blocked: "text-amber-300",
	limit: "text-amber-300",
};

function StatusIcon({ status, className }: { status: GoalStatus; className?: string }) {
	const cls = clsx("size-3.5 shrink-0", className);
	if (status === "complete") return <CircleCheck className={cls} />;
	if (status === "paused") return <CirclePause className={cls} />;
	if (status === "blocked" || status === "limit") return <OctagonAlert className={cls} />;
	return <Target className={clsx(cls, "animate-pulse")} />;
}

/** The open conversation's /goal: what it is, how far along, and pause / resume / clear. */
export function GoalBar() {
	const t = useT(M);
	const goal = useStore((s) => s.session?.goal ?? null);
	const [open, setOpen] = useState(false);
	if (!goal) return null;
	const done = goal.status === "complete";
	const btn = "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors";
	return (
		<div className="mb-2 rounded-xl border border-ink-800 bg-ink-900/70 px-3 py-2 backdrop-blur">
			<div className="flex min-w-0 items-center gap-2">
				<StatusIcon status={goal.status} className={TONE[goal.status]} />
				<span className={clsx("shrink-0 text-xs font-medium", TONE[goal.status])}>{t(goal.status)}</span>
				<button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={t("details")} aria-expanded={open}>
					<span className="min-w-0 truncate text-xs text-ink-200">{goal.objective}</span>
					<ChevronDown className={clsx("size-3 shrink-0 text-ink-500 transition-transform", open && "rotate-180")} />
				</button>
				<span className="hidden shrink-0 font-mono text-[10.5px] text-ink-500 sm:inline">{t("turns", { n: goal.turns, max: goal.maxTurns })}</span>
				{goal.status === "active" && (
					<button type="button" onClick={() => void controlGoal("pause")} className={clsx(btn, "text-ink-400 hover:bg-ink-800 hover:text-ink-100")}>
						<CircleStop className="size-3.5" /> <span className="hidden sm:inline">{t("pause")}</span>
					</button>
				)}
				{!done && goal.status !== "active" && (
					<button type="button" onClick={() => void controlGoal("resume")} className={clsx(btn, "text-ember-300 hover:bg-ember-500/10")}>
						<Play className="size-3.5" /> {goal.status === "limit" ? t("resumeMore", { n: Math.min(goal.maxTurns, 30) }) : t("resume")}
					</button>
				)}
				<button type="button" onClick={() => void controlGoal("clear")} title={done ? t("dismiss") : t("clear")} aria-label={done ? t("dismiss") : t("clear")} className={clsx(btn, "px-1.5 text-ink-500 hover:bg-ink-800 hover:text-rose-400")}>
					<X className="size-3.5" />
				</button>
			</div>
			{!open && goal.note && goal.status !== "active" && <p className="mt-1 line-clamp-2 pl-5.5 text-xs text-ink-400">{goal.note}</p>}
			{open && (
				<div className="mt-2 space-y-2 pl-5.5 text-xs">
					<p className="whitespace-pre-wrap text-ink-200">{goal.objective}</p>
					{goal.note && <p className="whitespace-pre-wrap text-ink-400">{goal.note}</p>}
					<p className="text-ink-500">
						{t("turns", { n: goal.turns, max: goal.maxTurns })} · {t("hint")}
					</p>
				</div>
			)}
		</div>
	);
}
