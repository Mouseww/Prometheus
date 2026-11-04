import { BarChart3, ChevronRight, CircleHelp, Clock, FileSpreadsheet, FileText, Flame, Mail, MessageCircle, PenLine, Presentation, Share2, Sparkles, Video, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AutomationTask } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { onPluginChange, openAssistantMain, openSession, type PendingQuestion, pluginCall, toast, useStore } from "../lib/store.ts";
import { delegatedRuns, delegationTitle } from "../lib/spaces.ts";
import { Badge, PageHeader } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "主页",
		subtitle: "个人空间：简报、普罗派出去的活、自动化",
		chat: "和普罗对话",
		chatHint: "助理的长期对话：它有自己的家，需要时把活派到你的项目里",
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
		needsYou: "等你回答",
		answerPlaceholder: "或者直接写答案…",
		send: "回答",
		gone: "这个问题已经不需要回答了（运行已结束）",
		canDo: "普罗能做什么",
		canDoHint: "点一个，直接用这句话开始",
		tryIt: "试一下",
		cat_office: "办公",
		cat_creative: "创作",
		cat_utility: "工具",
	},
	en: {
		title: "Home",
		subtitle: "Personal space: briefing, work handed to projects, automations",
		chat: "Talk to the assistant",
		chatHint: "The assistant's long-running chat: it has a home of its own and hands work to your projects when needed",
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
		needsYou: "Waiting for you",
		answerPlaceholder: "Or type an answer…",
		send: "Answer",
		gone: "This question is no longer open (the run ended)",
		canDo: "What I can do for you",
		canDoHint: "Pick one to start with that sentence",
		tryIt: "Try it",
		cat_office: "Office",
		cat_creative: "Creative",
		cat_utility: "Tools",
	},
});

interface Overview {
	briefing: { name: string; text: string } | null;
	settings: { enabled: boolean; time: string };
}

/** Mirrors the skills plugin's `catalog` rpc: a shipped capability the user can ask for by name. */
interface SkillCard {
	name: string;
	title: string;
	tagline: string;
	category: "office" | "creative" | "utility";
	examples: string[];
}

const CARD_ICON: Record<string, React.ReactNode> = {
	"office-pptx": <Presentation className="size-4" />,
	"office-docx": <FileText className="size-4" />,
	"office-xlsx": <FileSpreadsheet className="size-4" />,
	"diagram-chart": <BarChart3 className="size-4" />,
	"work-report": <PenLine className="size-4" />,
	"meeting-minutes": <MessageCircle className="size-4" />,
	"email-writing": <Mail className="size-4" />,
	"novel-writing": <Sparkles className="size-4" />,
	"make-video": <Video className="size-4" />,
	"make-poster": <Flame className="size-4" />,
	"web-research": <CircleHelp className="size-4" />,
	"pc-maintenance": <Wrench className="size-4" />,
};

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

/** One question a delegated run is waiting on: option buttons plus a free answer. */
function QuestionRow({ q, project, title }: { q: PendingQuestion; project: string; title: string }) {
	const t = useT(M);
	const [text, setText] = useState("");
	const send = async (answer: string) => {
		const r = await pluginCall<{ ok: boolean }>("assistant", "answer", { id: q.id, text: answer });
		if (r && !r.ok) toast(t("gone"));
	};
	return (
		<li className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3">
			<div className="mb-1 flex items-center gap-2 text-[11px] text-ink-500">
				<button type="button" onClick={() => void openSession(q.sessionId)} className="truncate hover:text-ember-300">
					{title}
				</button>
				<span className="font-mono">{project}</span>
			</div>
			<p className="mb-2 text-[13px] whitespace-pre-wrap text-ink-100">{q.question}</p>
			{q.options.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-1.5">
					{q.options.map((o) => (
						<button key={o} type="button" onClick={() => void send(o)} className="rounded-md border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs text-ink-100 hover:border-ember-500/60">
							{o}
						</button>
					))}
				</div>
			)}
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (text.trim()) void send(text);
				}}
			>
				<input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("answerPlaceholder")} className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-100 outline-none focus:border-ember-500/60" />
				<button type="submit" disabled={!text.trim()} className="rounded-md bg-ember-500 px-3 py-1 text-xs font-medium text-white disabled:opacity-40">
					{t("send")}
				</button>
			</form>
		</li>
	);
}

const Empty = ({ text }: { text: string }) => <p className="text-xs text-ink-500">{text}</p>;

const CATEGORY_TITLE = { office: "cat_office", creative: "cat_creative", utility: "cat_utility" } as const;

/**
 * "What can you do?": the shipped skills as cards. Clicking an example opens the assistant's chat with that request
 * as a draft, so the user sees exactly what is about to be asked (and can edit it) instead of the app sending blind.
 */
function Capabilities({ cards }: { cards: SkillCard[] }) {
	const t = useT(M);
	const groups = useMemo(() => {
		const order: SkillCard["category"][] = ["office", "creative", "utility"];
		return order.map((cat) => ({ cat, items: cards.filter((c) => c.category === cat) })).filter((g) => g.items.length > 0);
	}, [cards]);
	if (cards.length === 0) return null;
	const start = async (text: string) => {
		await openAssistantMain();
		// Same channel as "edit message": the composer takes the text in and focuses, so one send is all it takes.
		useStore.setState({ editorText: { text, nonce: Date.now() } });
	};
	return (
		<Card icon={<Sparkles className="size-4 text-ember-300" />} title={t("canDo")} hint={t("canDoHint")}>
			<div className="space-y-3">
				{groups.map((g) => (
					<div key={g.cat}>
						<div className="px-1 pb-1.5 font-mono text-[10.5px] tracking-[0.18em] text-ink-500 uppercase">{t(CATEGORY_TITLE[g.cat])}</div>
						<div className="grid gap-2 @xl:grid-cols-2">
							{g.items.map((c) => (
								<div key={c.name} className="rounded-lg border border-ink-800 bg-ink-950/40 p-2.5 transition-colors hover:border-ember-500/40">
									<div className="flex items-center gap-1.5 text-[13px] font-medium text-ink-100">
										<span className="text-ember-300">{CARD_ICON[c.name] ?? <Sparkles className="size-4" />}</span>
										{c.title}
									</div>
									<p className="mt-0.5 line-clamp-1 text-[11.5px] text-ink-500">{c.tagline}</p>
									{c.examples.length > 0 && (
										<button type="button" onClick={() => void start(c.examples[0]!)} title={c.examples[0]} className="mt-2 flex w-full items-start gap-1 rounded-md bg-ink-900 px-2 py-1.5 text-left text-[11.5px] leading-snug text-ink-300 hover:bg-ink-800 hover:text-ink-100">
											<span className="line-clamp-2 min-w-0 flex-1">{c.examples[0]}</span>
											<span className="shrink-0 pt-px text-ember-300/80">{t("tryIt")}</span>
										</button>
									)}
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		</Card>
	);
}

/** The personal space's home page: what the assistant did and is doing, at a glance. */
export function PersonalHome() {
	const t = useT(M);
	const sessions = useStore((s) => s.sessions);
	const workspaces = useStore((s) => s.workspaces);
	const delegated = useStore((s) => s.assistant?.delegated);
	const pending = useStore((s) => s.assistant?.pending);
	const [overview, setOverview] = useState<Overview | null>(null);
	const [tasks, setTasks] = useState<AutomationTask[]>([]);
	const [cards, setCards] = useState<SkillCard[]>([]);

	const load = useCallback(async () => {
		const [o, a, s] = await Promise.all([
			pluginCall<Overview>("assistant", "overview"),
			pluginCall<{ tasks: AutomationTask[] }>("automations", "list"),
			pluginCall<SkillCard[]>("skills", "catalog"),
		]);
		if (o) setOverview(o);
		if (a) setTasks(a.tasks);
		if (s) setCards(s);
	}, []);
	useEffect(() => {
		void load();
		const offA = onPluginChange("assistant", () => void load());
		const offB = onPluginChange("automations", () => void load());
		// Skills are added and switched off in Settings: the cards follow.
		const offC = onPluginChange("skills", () => void load());
		return () => {
			offA();
			offB();
			offC();
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
				{pending && pending.length > 0 && (
					<div className="@3xl:col-span-2">
						<Card icon={<CircleHelp className="size-4 text-amber-400" />} title={t("needsYou")}>
							<ul className="space-y-2">
								{pending.map((q) => {
									const s = sessions.find((x) => x.id === q.sessionId);
									return <QuestionRow key={q.id} q={q} project={projectOf(s?.workspaceId ?? "")} title={delegationTitle(s?.name) || s?.firstMessage || ""} />;
								})}
							</ul>
						</Card>
					</div>
				)}
				<button type="button" onClick={() => void openAssistantMain()} className="flex items-center gap-3 rounded-xl border border-ember-500/20 bg-ember-500/[0.05] px-4 py-3 text-left transition-colors hover:bg-ember-500/10 @3xl:col-span-2">
					<MessageCircle className="size-5 shrink-0 text-ember-300" />
					<span className="min-w-0 flex-1">
						<span className="block text-sm font-medium text-ink-100">{t("chat")}</span>
						<span className="block truncate text-xs text-ink-500">{t("chatHint")}</span>
					</span>
					<ChevronRight className="size-4 shrink-0 text-ink-600" />
				</button>
				<div className="@3xl:col-span-2">
					<Capabilities cards={cards} />
				</div>
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
