import clsx from "clsx";
import { ArrowUp, BarChart3, Star, ChevronRight, CircleHelp, Clock, FileSpreadsheet, FileText, Flame, LoaderCircle, Mail, MessageCircle, PenLine, Plus, Presentation, Share2, Sparkles, Video, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutomationTask, ImageContent } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { type Attachment, AttachmentError, fileToAttachment, formatSize, isPicture, MAX_FILE_MB, MAX_FILES } from "../lib/attachments.ts";
import { fileToImage, ImageError, imageSrc, MAX_IMAGES } from "../lib/images.ts";
import { onPluginChange, openAssistantMain, openSession, type PendingQuestion, pluginCall, refreshCommands, sendPrompt, toast, useStore } from "../lib/store.ts";
import { delegatedRuns, delegationTitle } from "../lib/spaces.ts";
import { answerStar, REPO_URL, useStar } from "../lib/star.ts";
import { openExternal } from "../lib/links.ts";
import { Badge, Button } from "./ui.tsx";
import { Mentions, SlashCommands, SuggestionPanel } from "./suggestions.tsx";

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
		canDoHint: "点一张卡片，这句话会填进对话框，你可以先改再发",
		hello: "想做点什么？",
		helloHint: "说一句就好，剩下的交给我：查资料、做文件、写报告",
		composerHint: "有什么要我做的吗？",
		composerTools: "@ 引用文件，/ 调用技能",
		submit: "发送",
		sendFailed: "没能打开对话，请再试一次",
		sendBusy: "对话正忙，稍后会把它留在输入框里",
		starTitle: "帮到你了的话，给一颗 Star 吧",
		starBody: "Prometheus 是开源的，Star 能让还在找这类工具的人看到它。不想点也没关系，以后不再打扰。",
		starYes: "去点 Star",
		starLater: "以后再说",
		attach: "添加文件或图片",
		remove: "移除",
		reading: "读取中…",
		tooManyImages: "最多 {n} 张图片",
		tooManyFiles: "最多 {n} 个文件",
		badImageType: "不支持这种图片格式",
		imageTooBig: "图片太大了",
		badImage: "这张图片读不了",
		fileTooBig: "{name} 超过 {n} MB",
		filesTotal: "附件总大小超过 {n} MB",
		fileRead: "读不了 {name}",
		attachHint: "打开对话，可以带文件进去",
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
		canDoHint: "Tap a card and the request lands in the chat, ready for you to edit",
		hello: "What shall we do?",
		helloHint: "Just say it — research, files and reports are my job",
		composerHint: "What can I do for you?",
		composerTools: "@ files, / skills",
		submit: "Send",
		sendFailed: "Could not open the chat. Please try again.",
		sendBusy: "The chat is busy; your message was kept",
		starTitle: "If this helped, a star means a lot",
		starBody: "Prometheus is open source, and stars help the next person find it. No thanks is fine too — this will not ask again.",
		starYes: "Star it",
		starLater: "Not now",
		attach: "Add files or images",
		remove: "Remove",
		reading: "Reading…",
		tooManyImages: "At most {n} images",
		tooManyFiles: "At most {n} files",
		badImageType: "That image type is not supported",
		imageTooBig: "That image is too large",
		badImage: "That image cannot be read",
		fileTooBig: "{name} is over {n} MB",
		filesTotal: "Attachments total over {n} MB",
		fileRead: "Cannot read {name}",
		attachHint: "Open the chat, where you can attach files",
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

/**
 * The one-time star card. Deliberately quiet: no image, no exclamation marks, two small buttons and an X. It is not a
 * gate and not a modal — the page works exactly the same without touching it.
 */
function StarCard({ onAnswer }: { onAnswer: (starred: boolean) => void }) {
	const t = useT(M);
	return (
		<section className="relative rounded-xl border border-ember-500/25 bg-ember-500/[0.05] p-4">
			<button type="button" onClick={() => onAnswer(false)} title={t("starLater")} aria-label={t("starLater")} className="absolute top-2.5 right-2.5 grid size-6 place-items-center rounded-md text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-200">
				<X className="size-3.5" />
			</button>
			<div className="flex items-start gap-3 pr-6">
				<span className="grid size-9 shrink-0 place-items-center rounded-lg bg-ember-500/12 text-ember-300">
					<Star className="size-4" />
				</span>
				<div className="min-w-0 flex-1">
					<h2 className="text-sm font-medium text-ink-100">{t("starTitle")}</h2>
					<p className="mt-1 text-[12.5px] leading-relaxed text-ink-400">{t("starBody")}</p>
					<div className="mt-3 flex flex-wrap items-center gap-2">
						<Button
							variant="primary"
							onClick={() => {
								onAnswer(true);
								void openExternal(REPO_URL);
							}}
						>
							<Star className="size-4" /> {t("starYes")}
						</Button>
						<Button variant="ghost" onClick={() => onAnswer(false)}>
							{t("starLater")}
						</Button>
					</div>
				</div>
			</div>
		</section>
	);
}

/**
 * The skill rail above the input: one compact pill per shipped skill, the way an agent workbench offers capabilities.
 * No heading and no grid — a returning user wants to start working, not read a feature list. Clicking one puts its
 * example request in the input so the user can adjust it before sending, rather than sending blind.
 */
function SkillRail({ cards, onPick }: { cards: SkillCard[]; onPick: (text: string) => void }) {
	const t = useT(M);
	if (cards.length === 0) return null;
	return (
		<div className="rail-x -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label={t("canDo")}>
			{cards.map((c) => (
				<button
					key={c.name}
					type="button"
					onClick={() => onPick(c.examples[0] ?? c.title)}
					title={c.examples[0] ?? c.tagline}
					className={clsx(
						"flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-ink-800 bg-ink-900/70 px-3 text-[12.5px] text-ink-300 transition-colors",
						"hover:border-ember-500/50 hover:bg-ember-500/10 hover:text-ember-200",
						"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember-400",
					)}
				>
					<span className="text-ember-400">{CARD_ICON[c.name] ?? <Sparkles className="size-3.5" />}</span>
					{c.title}
				</button>
			))}
		</div>
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
	const asking = useStar((s) => s.asking);

	const load = useCallback(async () => {
		const [o, a, s] = await Promise.all([
			pluginCall<Overview>("assistant", "overview"),
			pluginCall<{ tasks: AutomationTask[] }>("automations", "list"),
			pluginCall<SkillCard[]>("skills", "catalog"),
		]);
		if (o) setOverview(o);
		if (a) setTasks(a.tasks);
		if (s) setCards(s);
		// The "/" menu reads the store's command list, which is otherwise filled when a conversation opens.
		void refreshCommands();
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

	// The home page's own input. Sending opens the assistant's long-running chat and delivers the message there:
	// the user types once and the work starts, with no bounce through an empty conversation.
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [pictures, setPictures] = useState<ImageContent[]>([]);
	const [docs, setDocs] = useState<Attachment[]>([]);
	const [reading, setReading] = useState(0);
	const input = useRef<HTMLTextAreaElement>(null);
	const files = useRef<HTMLInputElement>(null);

	// "/" lists commands (skills among them) and "@" lists files, both read from the caret the way the chat
	// composer does: the home box is the first thing many people type into, so it should behave like the real one.
	const commands = useStore((s) => s.commands);
	const home = useStore((s) => s.assistant?.home);
	const [caret, setCaret] = useState(0);
	const [cursor, setCursor] = useState(0);
	const [mentionItems, setMentionItems] = useState<{ path: string; dir: boolean }[]>([]);
	const [mentionCursor, setMentionCursor] = useState(0);
	const [dismissed, setDismissed] = useState<string | null>(null);

	const slashQuery = /^\/(\S*)$/.exec(draft)?.[1];
	const matches = useMemo(() => {
		if (slashQuery === undefined) return [];
		const q = slashQuery.toLowerCase();
		return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
	}, [commands, slashQuery]);
	useEffect(() => setCursor(0), [slashQuery]);

	const mention = useMemo(() => {
		const m = /(^|\s)@([^\s@]*)$/.exec(draft.slice(0, caret));
		if (!m) return null;
		const query = m[2] ?? "";
		return { query, start: caret - query.length - 1 };
	}, [draft, caret]);
	const mentionQuery = mention && dismissed !== `${mention.start}:${mention.query}` ? mention.query : undefined;

	useEffect(() => {
		if (mentionQuery === undefined || !home) {
			setMentionItems([]);
			return;
		}
		let stale = false;
		// Slight debounce so a fast typist does not fire a search per keystroke.
		const timer = setTimeout(() => {
			void pluginCall<{ items: { path: string; dir: boolean }[] }>("folder", "search", { query: mentionQuery, cwd: home })
				.then((res) => {
					if (stale) return;
					setMentionItems(res?.items ?? []);
					setMentionCursor(0);
				})
				.catch(() => !stale && setMentionItems([]));
		}, 80);
		return () => {
			stale = true;
			clearTimeout(timer);
		};
	}, [mentionQuery, home]);

	const showMention = mentionQuery !== undefined && mentionItems.length > 0;
	const showCommands = !showMention && matches.length > 0;

	const pickMention = (item: { path: string; dir: boolean }) => {
		if (!mention) return;
		const quoted = /\s/.test(item.path) ? `"${item.path}"` : item.path;
		const token = `@${quoted}${item.dir ? "/" : " "}`;
		const next = draft.slice(0, mention.start) + token + draft.slice(caret);
		const pos = mention.start + token.length;
		setDraft(next);
		setCaret(pos);
		requestAnimationFrame(() => {
			const el = input.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(pos, pos);
		});
	};

	const pickSlash = (c: { name: string; description?: string }) => {
		const next = `/${c.name} `;
		setDraft(next);
		setCaret(next.length);
		requestAnimationFrame(() => {
			const el = input.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(next.length, next.length);
		});
	};

	/** Same split the composer makes: pictures go to the vision model, everything else goes as bytes. */
	const addFiles = useCallback(
		async (list: File[]) => {
			if (!list.length) return;
			const pics = list.filter(isPicture);
			const rest = list.filter((f) => !isPicture(f));
			const room = MAX_IMAGES - pictures.length;
			if (pics.length > Math.max(room, 0)) toast(t("tooManyImages", { n: MAX_IMAGES }), "warning");
			const docRoom = MAX_FILES - docs.length;
			if (rest.length > Math.max(docRoom, 0)) toast(t("tooManyFiles", { n: MAX_FILES }), "warning");
			const takePics = pics.slice(0, Math.max(room, 0));
			const takeDocs = rest.slice(0, Math.max(docRoom, 0));
			if (!takePics.length && !takeDocs.length) return;

			setReading((n) => n + takePics.length + takeDocs.length);
			for (const file of takePics) {
				try {
					const image = await fileToImage(file);
					setPictures((cur) => (cur.length < MAX_IMAGES ? [...cur, image] : cur));
				} catch (err) {
					const reason = err instanceof ImageError ? err.reason : "decode";
					toast(t(reason === "type" ? "badImageType" : reason === "size" ? "imageTooBig" : "badImage"), "error");
				} finally {
					setReading((n) => n - 1);
				}
			}
			let bytes = docs.reduce((sum, d) => sum + d.size, 0);
			for (const file of takeDocs) {
				try {
					const doc = await fileToAttachment(file, bytes);
					bytes += doc.size;
					setDocs((cur) => (cur.length < MAX_FILES ? [...cur, doc] : cur));
				} catch (err) {
					const reason = err instanceof AttachmentError ? err.reason : "read";
					toast(t(reason === "size" ? "fileTooBig" : reason === "total" ? "filesTotal" : "fileRead", { name: file.name, n: MAX_FILE_MB }), "error");
				} finally {
					setReading((n) => n - 1);
				}
			}
		},
		[docs, pictures.length, t],
	);

	const ask = useCallback(
		async (text = draft) => {
			const said = text.trim();
			// A picture or a file on its own is a complete request; text is not required.
			const hasPayload = Boolean(said) || pictures.length > 0 || docs.length > 0;
			if (!hasPayload || sending || reading > 0) return;
			setSending(true);
			try {
				await openAssistantMain();
				// openAssistantMain resolves once the chat is on screen; without a session there is nothing to prompt.
				if (!useStore.getState().session) {
					toast(t("sendFailed"), "error");
					return;
				}
				setDraft("");
				const sent = await sendPrompt(said, undefined, pictures.length ? pictures : undefined, docs.length ? docs : undefined);
				if (!sent) {
					// The chat was already busy with another run: keep what was typed so it is not lost.
					setDraft(said);
					toast(t("sendBusy"), "warning");
					return;
				}
				setPictures([]);
				setDocs([]);
			} finally {
				setSending(false);
			}
		},
		[draft, docs, pictures, reading, sending, t],
	);
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
			{/* No page title above the greeting: the greeting is the title, the way WorkBuddy's own home reads. */}
			<div className="@container min-h-0 flex-1 overflow-y-auto px-4 py-6 @3xl:px-8 @3xl:py-10">
				<div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
					{/* Above everything else: a run is blocked until the user answers. */}
					{pending && pending.length > 0 && (
						<Card icon={<CircleHelp className="size-4 text-amber-400" />} title={t("needsYou")}>
							<ul className="space-y-2">
								{pending.map((q) => {
									const s = sessions.find((x) => x.id === q.sessionId);
									return <QuestionRow key={q.id} q={q} project={projectOf(s?.workspaceId ?? "")} title={delegationTitle(s?.name) || s?.firstMessage || ""} />;
								})}
							</ul>
						</Card>
					)}
					{/* The workbench centre: the way in is the input, not a pitch. The panel below is the page's main object —
					    wide and tall like a real composer, with the skill rail on top of it and its own toolbar at the bottom. */}
					<div className="mx-auto w-full max-w-3xl pt-2 @3xl:pt-6">
						<h2 className="text-center font-display text-[17px] font-semibold tracking-tight text-ink-100">{t("hello")}</h2>
						<p className="mt-1 text-center text-[12px] leading-relaxed text-ink-500">{t("helloHint")}</p>
						<div className="mt-3.5">
							<SkillRail
							cards={cards}
							onPick={(text) => {
								setDraft(text);
								input.current?.focus();
							}}
						/>
						</div>
						{/* A real input, not a picture of one: typing here and pressing Enter opens the assistant's chat with
						    the message already sent. Clicking anywhere in the panel puts the caret in it. */}
						<form
							onSubmit={(e) => {
								e.preventDefault();
								void ask();
							}}
							className="relative mt-2 flex min-h-[clamp(9rem,26vh,13rem)] w-full cursor-text flex-col rounded-2xl border border-ink-800 bg-ink-900/85 p-4 text-left shadow-[0_10px_40px_-12px_rgb(0_0_0/0.45)] backdrop-blur transition-colors focus-within:border-ember-500/50 hover:border-ember-500/40"
							onClick={(e) => {
								// Clicking the panel's padding should focus the field, as in a real composer.
								if (e.target === e.currentTarget) input.current?.focus();
							}}
						>
							<textarea
								ref={input}
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
								onKeyDown={(e) => {
									if (!e.nativeEvent.isComposing) {
										if (showMention) {
											if (e.key === "ArrowDown" || e.key === "ArrowUp") {
												e.preventDefault();
												setMentionCursor((c) => (c + (e.key === "ArrowDown" ? 1 : mentionItems.length - 1)) % mentionItems.length);
												return;
										}
											if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
												const pick = mentionItems[mentionCursor];
												if (pick) {
													e.preventDefault();
													pickMention(pick);
													return;
												}
											}
											if (e.key === "Escape" && mention) {
												e.preventDefault();
												setDismissed(`${mention.start}:${mention.query}`);
												return;
											}
										}
										if (showCommands) {
											if (e.key === "ArrowDown" || e.key === "ArrowUp") {
												e.preventDefault();
												setCursor((c) => (c + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
												return;
											}
											if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
												const pick = matches[cursor];
												// A complete command is already what the user meant: let Enter send it.
												if (pick && `/${pick.name}` !== draft) {
													e.preventDefault();
													pickSlash(pick);
													return;
												}
											}
										}
									}
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										void ask();
									}
								}}
								onPaste={(e) => {
									const pasted = [...e.clipboardData.files];
									if (!pasted.length) return;
									// A screenshot arrives as a file with no text; leave ordinary text pastes alone.
									e.preventDefault();
									void addFiles(pasted);
								}}
								onDragOver={(e) => e.preventDefault()}
								onDrop={(e) => {
									e.preventDefault();
									void addFiles([...e.dataTransfer.files]);
								}}
								placeholder={t("composerHint")}
								rows={2}
								aria-label={t("composerHint")}
								className="w-full resize-none bg-transparent text-[14.5px] leading-relaxed text-ink-100 outline-none placeholder:text-ink-500"
							/>
							{showMention && (
								<SuggestionPanel>
									<Mentions items={mentionItems} cursor={mentionCursor} onPick={pickMention} onHover={setMentionCursor} />
								</SuggestionPanel>
							)}
							{showCommands && (
								<SuggestionPanel>
									<SlashCommands items={matches} cursor={cursor} onPick={pickSlash} />
								</SuggestionPanel>
							)}
							{/* What is attached so far: the same chips the chat shows, each removable before sending. */}
							{(pictures.length > 0 || docs.length > 0 || reading > 0) && (
								<div className="mt-2 flex flex-wrap gap-1.5">
									{pictures.map((p, i) => (
										<span key={`img-${i}`} className="group relative">
											<img src={imageSrc(p)} alt="" className="size-11 rounded-lg border border-ink-800 object-cover" />
											<button
												type="button"
												title={t("remove")}
												aria-label={t("remove")}
												onClick={() => setPictures((cur) => cur.filter((_, j) => j !== i))}
												className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-ink-100 text-ink-950 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
											>
												<X className="size-3" />
											</button>
										</span>
									))}
									{docs.map((d, i) => (
										<span key={`doc-${i}`} className="flex h-7 max-w-52 items-center gap-1.5 rounded-full border border-ink-800 bg-ink-950/50 px-2 text-[11.5px] text-ink-300">
											<FileText className="size-3.5 shrink-0 text-ember-400" />
											<span className="truncate">{d.name}</span>
											<span className="shrink-0 text-ink-600">{formatSize(d.size)}</span>
											<button type="button" title={t("remove")} aria-label={t("remove")} onClick={() => setDocs((cur) => cur.filter((_, j) => j !== i))} className="shrink-0 text-ink-500 hover:text-ink-100">
												<X className="size-3" />
											</button>
										</span>
									))}
									{reading > 0 && <span className="flex h-7 items-center gap-1.5 rounded-full border border-ink-800 px-2 text-[11.5px] text-ink-500"><LoaderCircle className="size-3.5 animate-spin" />{t("reading")}</span>}
								</div>
							)}
							{/* The composer's own bottom bar: attach, the shortcut hint, then send. */}
							<div className="mt-auto flex items-center gap-2 pt-4">
								<input ref={files} type="file" multiple className="hidden" onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
								<button
									type="button"
									onClick={() => files.current?.click()}
									disabled={pictures.length >= MAX_IMAGES && docs.length >= MAX_FILES}
									title={t("attach")}
									aria-label={t("attach")}
									className="grid size-8 place-items-center rounded-full border border-ink-800 text-ink-400 transition-colors hover:border-ember-500/40 hover:text-ember-300 disabled:opacity-40"
								>
									<Plus className="size-4" />
								</button>
								<span className="text-[11.5px] text-ink-600">{t("composerTools")}</span>
								<button
									type="submit"
									disabled={(!draft.trim() && !pictures.length && !docs.length) || sending || reading > 0}
									title={t("submit")}
									aria-label={t("submit")}
									className="btn-glow ml-auto grid size-8 shrink-0 place-items-center rounded-full bg-ember-500 text-ink-950 transition-opacity disabled:opacity-40"
								>
									{sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
								</button>
							</div>
						</form>
					</div>
					{/* The one and only ask for a star: shown at most once per machine, only after runs have actually
					    finished on a couple of different days, and never while a run is going. Answering it — either way —
					    silences it forever. See lib/star.ts. */}
					{asking && <StarCard onAnswer={answerStar} />}
					{/* What already happened: quieter, and only shown when there is something to say. */}
					<div className="grid gap-3 @2xl:grid-cols-2">
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
			</div>
		</div>
	);
}
