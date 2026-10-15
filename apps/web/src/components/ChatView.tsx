import { LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useRef } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { useStore } from "../lib/store.ts";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";
import { Flame } from "./ui.tsx";

const M = defineMessages({
	zh: {
		reconnecting: "连接中断，正在重连…",
		headline1: "盗火，",
		headline2: "然后锻造",
		cwd: "项目目录",
		hint: "读写文件、执行命令、检索知识库——输入 / 浏览全部命令与技能。",
	},
	en: {
		reconnecting: "Connection lost, reconnecting…",
		headline1: "Steal the fire, ",
		headline2: "then forge",
		cwd: "Project folder",
		hint: "Read and write files, run commands, search knowledge — type / for every command and skill.",
	},
});

function Widgets({ placement }: { placement: string }) {
	const widgets = useStore((s) => s.session?.widgets);
	const list = Object.entries(widgets ?? {}).filter(([, w]) => w.placement === placement);
	if (!list.length) return null;
	return (
		<div className="mx-auto mb-2 w-full max-w-3xl space-y-1.5 px-5">
			{list.map(([key, w]) => (
				<pre key={key} className="overflow-x-auto rounded-lg border border-ink-800 bg-ink-900/70 px-3 py-2 font-mono text-xs text-ink-300">
					{w.lines.join("\n")}
				</pre>
			))}
		</div>
	);
}

export function ChatView() {
	const t = useT(M);
	const session = useStore((s) => s.session);
	const conn = useStore((s) => s.conn);
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);

	useEffect(() => {
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	});

	if (!session) {
		return (
			<div className="grid flex-1 place-items-center text-ink-500">
				<LoaderCircle className="size-5 animate-spin" />
			</div>
		);
	}

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
				{session.messages.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
						<Flame className="size-16 drop-shadow-[0_0_30px_rgb(var(--glow)/0.45)]" />
						<h2 className="font-display text-4xl font-semibold tracking-tight">
							{t("headline1")}
							<span className="ember-text">{t("headline2")}</span>
						</h2>
						<p className="max-w-md text-sm text-ink-400">
							{t("cwd")} <code className="rounded bg-ink-850 px-1.5 py-0.5 font-mono text-xs text-ink-300">{session.cwd}</code>
							<br />
							{t("hint")}
						</p>
					</div>
				) : (
					<MessageList messages={session.messages} tools={session.tools} streaming={session.isStreaming} />
				)}
			</div>
			<Widgets placement="aboveEditor" />
			<Composer />
			<Widgets placement="belowEditor" />
		</>
	);
}
