import { Bug, FileCode2, FolderTree, LoaderCircle, RotateCcw, ScanSearch } from "lucide-react";
import clsx from "clsx";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { loadEarlier, useStore } from "../lib/store.ts";
import { ChatWidthControls } from "./ChatWidthControls.tsx";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { Flame } from "./ui.tsx";

const M = defineMessages({
	zh: {
		reconnecting: "连接中断，正在重连…",
		opening: "正在打开会话…",
		syncing: "正在同步最新内容…",
		headline1: "想做什么，",
		headline2: "直接告诉我",
		tagline: "我是 Prometheus，你的 AI 助手。可以帮你读写文件、执行命令、查资料、写代码，先想清楚再动手。",
		night: "夜深了",
		morning: "早上好",
		noon: "中午好",
		afternoon: "下午好",
		evening: "晚上好",
		s1t: "梳理项目",
		s1: "帮我快速梳理这个项目的结构、技术栈和关键模块",
		s2t: "排查问题",
		s2: "帮我排查一个问题：",
		s3t: "代码审查",
		s3: "审查最近的改动，指出潜在的 bug 和可以改进的地方",
		s4t: "写个脚本",
		s4: "帮我写一个脚本，用来",
	},
	en: {
		reconnecting: "Connection lost, reconnecting…",
		opening: "Opening conversation…",
		syncing: "Syncing the latest…",
		headline1: "What do you want to do? ",
		headline2: "Just tell me",
		tagline: "I'm Prometheus, your AI assistant. I can read and write files, run commands, look things up and write code, thinking first before acting.",
		night: "Burning the midnight oil",
		morning: "Good morning",
		noon: "Good afternoon",
		afternoon: "Good afternoon",
		evening: "Good evening",
		s1t: "Map the project",
		s1: "Give me a quick tour of this project: structure, tech stack and key modules",
		s2t: "Debug an issue",
		s2: "Help me track down a problem: ",
		s3t: "Review changes",
		s3: "Review the recent changes and point out likely bugs and improvements",
		s4t: "Write a script",
		s4: "Write me a script that ",
	},
});

function Widgets({ placement }: { placement: string }) {
	const widgets = useStore((s) => s.session?.widgets);
	const list = Object.entries(widgets ?? {}).filter(([, w]) => w.placement === placement);
	if (!list.length) return null;
	return (
		<div className="chat-col mx-auto mb-2 w-full space-y-1.5 px-5">
			{list.map(([key, w]) => (
				<pre key={key} className="overflow-x-auto rounded-lg border border-ink-800 bg-ink-900/70 px-3 py-2 font-mono text-xs text-ink-300">
					{w.lines.join("\n")}
				</pre>
			))}
		</div>
	);
}

export function ChatView() {
	const [box, setBox] = useState<HTMLDivElement | null>(null);
	return (
		<div ref={setBox} className="relative flex min-h-0 flex-1 flex-col">
			<ChatBody />
			<ChatWidthControls container={box} />
		</div>
	);
}

function ChatBody() {
	const t = useT(M);
	const session = useStore((s) => s.session);
	const booted = useStore((s) => s.booted);
	const conn = useStore((s) => s.conn);
	const opening = useStore((s) => s.opening);
	const scroller = useRef<HTMLDivElement | null>(null);
	const pinned = useRef(true);
	// The scroll container is unmounted whenever the view swaps to the placeholder / new-chat page (e.g. a messages reset)
	// and comes back at scrollTop 0. A fresh container always starts at the end, otherwise the chat appears to jump to the top.
	const attach = useCallback((el: HTMLDivElement | null) => {
		scroller.current = el;
		if (el) {
			pinned.current = true;
			el.scrollTop = el.scrollHeight;
		}
	}, []);

	// Another conversation opens at its end, whatever was scrolled in the previous one, before it is painted.
	useLayoutEffect(() => {
		pinned.current = true;
		const el = scroller.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [session?.id, opening]);

	useEffect(() => {
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	});

	if (!session && !booted) {
		return (
			<div className="grid flex-1 place-items-center text-ink-500">
				<LoaderCircle className="size-5 animate-spin" />
			</div>
		);
	}

	// Switched to a conversation whose contents are still on the way: show that the click landed.
	if (opening && session?.id !== opening.id) return <Opening title={opening.title} />;

	// No session yet, or one that has not received its first message: the new-chat page, which also hosts the workspace chooser.
	if (!session || (session.messages.length === 0 && !session.pending)) return <NewChat reconnecting={conn !== "open"} />;

	return (
		<>
			{conn !== "open" && (
				<div className="flex items-center justify-center gap-2 bg-ember-500/10 py-1.5 text-xs text-ember-300">
					<LoaderCircle className="size-3 animate-spin" /> {t("reconnecting")}
				</div>
			)}
			{session.banner && (
				<div className="flex items-center justify-center gap-2 border-b border-ember-500/20 bg-ember-500/8 py-1.5 text-xs text-ember-200">
					{session.banner.kind === "retry" ? <RotateCcw className="size-3" /> : <LoaderCircle className="size-3 animate-spin" />}
					<span className="truncate">{session.banner.text}</span>
				</div>
			)}
			<div
				ref={attach}
				onScroll={(e) => {
					const el = e.currentTarget;
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
				className="relative min-h-0 flex-1 overflow-y-auto"
			>
				{session.preview && (
					<div className="sticky top-0 z-10 flex h-0 justify-center">
						<span className="mt-2 flex h-6 items-center gap-1.5 rounded-full border border-ink-700 bg-ink-900/90 px-2.5 text-[11px] text-ink-400 shadow-lg backdrop-blur">
							<LoaderCircle className="size-3 animate-spin" /> {t("syncing")}
						</span>
					</div>
				)}
				<div key={session.id} className="animate-fade">
					<MessageList key={session.id} messages={session.messages} offset={session.messageOffset} onLoadEarlier={loadEarlier} tools={session.tools} streaming={session.isStreaming} pending={session.pending} />
				</div>
			</div>
			<Widgets placement="aboveEditor" />
			<TaskPanel />
			<Composer />
			<Widgets placement="belowEditor" />
		</>
	);
}

/** Placeholder while a conversation never seen in this tab comes over the network: its title, and the shape of a chat. */
function Opening({ title }: { title?: string }) {
	const t = useT(M);
	const bar = "rounded-2xl bg-ink-800/70 animate-pulse";
	return (
		<div className="flex min-h-0 flex-1 flex-col animate-fade" aria-busy="true">
			<div className="chat-col mx-auto flex w-full flex-1 flex-col justify-end gap-5 overflow-hidden px-5 pb-6">
				<div className={clsx(bar, "ml-auto h-10 w-2/5")} />
				<div className="space-y-2.5">
					<div className={clsx(bar, "h-3.5 w-11/12")} />
					<div className={clsx(bar, "h-3.5 w-4/5")} />
					<div className={clsx(bar, "h-3.5 w-3/5")} />
				</div>
				<div className={clsx(bar, "ml-auto h-10 w-1/3")} />
				<div className="space-y-2.5">
					<div className={clsx(bar, "h-3.5 w-5/6")} />
					<div className={clsx(bar, "h-3.5 w-2/3")} />
				</div>
			</div>
			<div className="chat-col mx-auto flex w-full items-center justify-center gap-2 px-5 pb-6 text-sm text-ink-400">
				<LoaderCircle className="size-4 shrink-0 animate-spin text-ember-400" />
				<span className="truncate">{title || t("opening")}</span>
			</div>
		</div>
	);
}

function greetingKey(): "night" | "morning" | "noon" | "afternoon" | "evening" {
	const h = new Date().getHours();
	return h < 5 ? "night" : h < 11 ? "morning" : h < 13 ? "noon" : h < 18 ? "afternoon" : h < 23 ? "evening" : "night";
}

const SUGGESTIONS = [
	{ title: "s1t", text: "s1", icon: FolderTree },
	{ title: "s2t", text: "s2", icon: Bug },
	{ title: "s3t", text: "s3", icon: ScanSearch },
	{ title: "s4t", text: "s4", icon: FileCode2 },
] as const;

/** Landing page for a chat that has no messages yet: branding plus the shared composer with a workspace chooser. */
function NewChat({ reconnecting }: { reconnecting: boolean }) {
	const t = useT(M);
	const [greeting] = useState(greetingKey);
	return (
		<>
			{reconnecting && (
				<div className="flex items-center justify-center gap-2 bg-ember-500/10 py-1.5 text-xs text-ember-300">
					<LoaderCircle className="size-3 animate-spin" /> {t("reconnecting")}
				</div>
			)}
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-4 py-6 text-center md:px-6">
				<div className="hero-flame relative animate-pop">
					<Flame className="relative size-16 drop-shadow-[0_0_30px_rgb(var(--glow)/0.45)]" />
				</div>
				<p className="animate-rise text-xs font-medium tracking-[0.25em] text-ember-300/80 uppercase [animation-delay:60ms]">{t(greeting)}</p>
				<h2 className="-mt-2 animate-rise font-display text-3xl font-semibold tracking-tight [animation-delay:120ms] md:text-4xl">
					{t("headline1")}
					<span className="ember-text">{t("headline2")}</span>
				</h2>
				<p className="max-w-md animate-rise text-sm text-ink-400 [animation-delay:180ms]">{t("tagline")}</p>
				<div className="mt-3 grid w-full max-w-2xl grid-cols-2 gap-2.5 md:grid-cols-4">
					{SUGGESTIONS.map((s, i) => (
						<button
							key={s.title}
							type="button"
							onClick={() => useStore.setState({ editorText: { text: t(s.text), nonce: Date.now() } })}
							style={{ animationDelay: `${240 + i * 60}ms` }}
							className="suggest-card group flex animate-rise flex-col items-start gap-2 rounded-xl border border-ink-800 bg-ink-900/50 p-3 text-left backdrop-blur-sm"
						>
							<s.icon className="size-4 text-ember-400 transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:scale-110" />
							<span className="text-[13px] font-medium text-ink-200">{t(s.title)}</span>
							<span className="line-clamp-2 text-xs text-ink-500">{t(s.text)}</span>
						</button>
					))}
				</div>
			</div>
			<Composer newChat />
		</>
	);
}
