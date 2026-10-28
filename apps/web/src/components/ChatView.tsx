import { LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
		headline1: "想做什么，",
		headline2: "直接告诉我",
		tagline: "我是 Prometheus，你的 AI 助手。可以帮你读写文件、执行命令、查资料、写代码，先想清楚再动手。",
	},
	en: {
		reconnecting: "Connection lost, reconnecting…",
		headline1: "What do you want to do? ",
		headline2: "Just tell me",
		tagline: "I'm Prometheus, your AI assistant. I can read and write files, run commands, look things up and write code, thinking first before acting.",
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
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);

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
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
				className="min-h-0 flex-1 overflow-y-auto"
			>
				<MessageList key={session.id} messages={session.messages} offset={session.messageOffset} onLoadEarlier={loadEarlier} tools={session.tools} streaming={session.isStreaming} pending={session.pending} />
			</div>
			<Widgets placement="aboveEditor" />
			<TaskPanel />
			<Composer />
			<Widgets placement="belowEditor" />
		</>
	);
}

/** Landing page for a chat that has no messages yet: branding plus the shared composer with a workspace chooser. */
function NewChat({ reconnecting }: { reconnecting: boolean }) {
	const t = useT(M);
	return (
		<>
			{reconnecting && (
				<div className="flex items-center justify-center gap-2 bg-ember-500/10 py-1.5 text-xs text-ember-300">
					<LoaderCircle className="size-3 animate-spin" /> {t("reconnecting")}
				</div>
			)}
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-4 text-center md:px-6">
				<Flame className="size-16 drop-shadow-[0_0_30px_rgb(var(--glow)/0.45)]" />
				<h2 className="font-display text-4xl font-semibold tracking-tight">
					{t("headline1")}
					<span className="ember-text">{t("headline2")}</span>
				</h2>
				<p className="max-w-md text-sm text-ink-400">{t("tagline")}</p>
			</div>
			<Composer newChat />
		</>
	);
}
