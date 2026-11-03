import { ChevronRight, Clock, Flame, Share2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AutomationTask } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { onPluginChange, openSession, pluginCall, useStore } from "../lib/store.ts";
import { delegatedRuns, delegationTitle } from "../lib/spaces.ts";
import { Badge, PageHeader } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "主页",
		subtitle: "个人空间：简报、普罗派出去的活、自动化",
		briefing: "今日简报",
		noBriefing: "还没有简报。对普罗说「每天 8 点给我一份简报」即可开启。",
		briefingOn: "每天 {time} 生成，存为笔记",
		briefingOff: "未开启",
		delegations: "委派中",
		delegationsHint: "普罗派到项目里的活",
		noDelegations: "还没有派出去的活。",
		running: "进行中",
		done: "最近完成",
		automations: "自动化",
		noAutomations: "没有自动化任务。",
		next: "下次 {at}",
		paused: "已暂停",
		open: "查看",
	},
	en: {
		title: "Home",
		subtitle: "Personal space: briefing, work handed to projects, automations",
		briefing: "Today's briefing",
		noBriefing: "No briefing yet. Tell the assistant \"brief me every day at 8\" to turn it on.",
		briefingOn: "Every day at {time}, saved as a note",
		briefingOff: "Off",
		delegations: "Delegated",
		delegationsHint: "Work the assistant handed to projects",
		noDelegations: "Nothing handed out yet.",
		running: "Running",
		done: "Recently done",
		automations: "Automations",
		noAutomations: "No automations.",
		next: "Next {at}",
		paused: "Paused",
		open: "Open",
	},
});

interface Overview {
	briefing: { name: string; text: string } | null;
	settings: { enabled: boolean; time: string };
}

function Card({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode }) {
	return (
		<section className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
			<h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-ink-100">
				{icon}
				{title}
				{hint && <span className="ml-auto text-[11px] font-normal text-ink-500">{hint}</span>}
			</h2>
			{children}
		</section>
	);
}

const Empty = ({ text }: { text: string }) => <p className="text-xs text-ink-500">{text}</p>;

/** The personal space's home page: what the assistant did and is doing, at a glance. */
export function PersonalHome() {
	const t = useT(M);
	const sessions = useStore((s) => s.sessions);
	const workspaces = useStore((s) => s.workspaces);
	const delegated = useStore((s) => s.assistant?.delegated);
	const [overview, setOverview] = useState<Overview | null>(null);
	const [tasks, setTasks] = useState<AutomationTask[]>([]);

	const load = useCallback(async () => {
		const [o, a] = await Promise.all([pluginCall<Overview>("assistant", "overview"), pluginCall<{ tasks: AutomationTask[] }>("automations", "list")]);
		if (o) setOverview(o);
		if (a) setTasks(a.tasks);
	}, []);
	useEffect(() => {
		void load();
		const offA = onPluginChange("assistant", () => void load());
		const offB = onPluginChange("automations", () => void load());
		return () => {
			offA();
			offB();
		};
	}, [load]);

	const runs = useMemo(() => delegatedRuns(sessions, delegated ?? new Set()), [sessions, delegated]);
	const projectOf = (workspaceId: string) => workspaces.find((w) => w.id === workspaceId)?.name ?? "";
	const row = (s: (typeof runs.running)[number], live: boolean) => (
		<li key={s.id}>
			<button type="button" onClick={() => void openSession(s.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-ink-800/70">
				{live ? <span className="size-2 shrink-0 animate-breathe rounded-full bg-amber-400" /> : <span className="size-2 shrink-0 rounded-full bg-emerald-500/70" />}
				<span className="min-w-0 flex-1 truncate text-[13px] text-ink-100">{delegationTitle(s.name) || s.firstMessage}</span>
				<span className="shrink-0 font-mono text-[11px] text-ink-500">{projectOf(s.workspaceId)}</span>
				<ChevronRight className="size-3.5 shrink-0 text-ink-600" aria-label={t("open")} />
			</button>
		</li>
	);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto p-4 @3xl:grid-cols-2 @3xl:p-8">
				<Card icon={<Flame className="size-4 text-ember-300" />} title={t("briefing")} hint={overview ? (overview.settings.enabled ? t("briefingOn", { time: overview.settings.time }) : t("briefingOff")) : undefined}>
					{overview?.briefing ? <pre className="max-h-64 overflow-y-auto font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-ink-200">{overview.briefing.text}</pre> : <Empty text={t("noBriefing")} />}
				</Card>
				<Card icon={<Share2 className="size-4 text-ember-300" />} title={t("delegations")} hint={t("delegationsHint")}>
					{runs.running.length + runs.done.length === 0 ? (
						<Empty text={t("noDelegations")} />
					) : (
						<div className="space-y-2">
							{runs.running.length > 0 && (
								<div>
									<div className="px-2 pb-1 font-mono text-[10.5px] tracking-[0.18em] text-ink-500 uppercase">{t("running")}</div>
									<ul>{runs.running.map((s) => row(s, true))}</ul>
								</div>
							)}
							{runs.done.length > 0 && (
								<div>
									<div className="px-2 pb-1 font-mono text-[10.5px] tracking-[0.18em] text-ink-500 uppercase">{t("done")}</div>
									<ul>{runs.done.map((s) => row(s, false))}</ul>
								</div>
							)}
						</div>
					)}
				</Card>
				<Card icon={<Clock className="size-4 text-ember-300" />} title={t("automations")}>
					{tasks.length === 0 ? (
						<Empty text={t("noAutomations")} />
					) : (
						<ul className="space-y-1">
							{tasks.map((a) => (
								<li key={a.id} className="flex items-center gap-2 px-2 py-1">
									<span className="min-w-0 flex-1 truncate text-[13px] text-ink-100">{a.name}</span>
									{a.enabled && a.nextRunAt ? <span className="shrink-0 text-[11px] text-ink-500">{t("next", { at: new Date(a.nextRunAt).toLocaleString() })}</span> : <Badge>{t("paused")}</Badge>}
								</li>
							))}
						</ul>
					)}
				</Card>
			</div>
		</div>
	);
}
