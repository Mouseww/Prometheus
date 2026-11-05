import clsx from "clsx";
import { AlertCircle, CheckCircle2, ChevronRight, Loader2, MessageSquare, Pencil, ShieldQuestion, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Empty } from "../../../components/ui.tsx";
import { Markdown } from "../../../components/Markdown.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useCommonT } from "../../i18n.ts";
import { ErrorBox } from "../../kit.tsx";
import { argsPreview, argsText, type RequestItem, type ToolItem, type TranscriptItem } from "../../logic/transcript.ts";
import type { SessionEventsState } from "./useSessionEvents.ts";

const M = defineMessages({
	zh: {
		empty: "这个会话还没有内容",
		emptyHint: "所有者开始对话后，消息会出现在这里。",
		user: "用户",
		assistant: "助手",
		args: "参数",
		result: "结果",
		running: "运行中",
		failed: "失败",
		noResult: "没有输出",
		request: "需要确认",
		resolved: "已处理",
		pending: "等待处理",
		renamed: "会话重命名为 {name}",
		loadMore: "加载更多",
		loadingMore: "加载中",
		end: "已到最新",
		transcript: "会话记录",
		subTool: "子任务",
	},
	en: {
		empty: "Nothing in this session yet",
		emptyHint: "Messages appear here once the owner starts talking to the agent.",
		user: "User",
		assistant: "Assistant",
		args: "Arguments",
		result: "Result",
		running: "Running",
		failed: "Failed",
		noResult: "No output",
		request: "Needs an answer",
		resolved: "Handled",
		pending: "Waiting",
		renamed: "Session renamed to {name}",
		loadMore: "Load more",
		loadingMore: "Loading",
		end: "Up to date",
		transcript: "Session transcript",
		subTool: "sub-task",
	},
});

function Bubble({ label, tone, children }: { label: string; tone: "user" | "assistant"; children: ReactNode }) {
	return (
		<article className={clsx("rounded-xl border px-4 py-3", tone === "user" ? "border-ember-500/30 bg-ember-500/5" : "border-ink-700 bg-ink-900/60")}>
			<h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-400 uppercase">{label}</h3>
			{children}
		</article>
	);
}

function ToolBlock({ item }: { item: ToolItem }) {
	const t = useT(M);
	const preview = argsPreview(item.args);
	const StatusIcon = item.status === "running" ? Loader2 : item.status === "error" ? AlertCircle : CheckCircle2;
	return (
		<details className={clsx("group rounded-lg border bg-ink-900/40", item.status === "error" ? "border-rose-400/40" : "border-ink-700", item.parentToolCallId && "ml-6")}>
			<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm marker:hidden focus-visible:outline-2 focus-visible:outline-ember-400 [&::-webkit-details-marker]:hidden">
				<ChevronRight className="size-3.5 shrink-0 text-ink-500 transition-transform group-open:rotate-90" aria-hidden />
				<Wrench className="size-3.5 shrink-0 text-ink-400" aria-hidden />
				<span className="shrink-0 font-mono text-xs font-medium text-ink-200">{item.name}</span>
				{item.parentToolCallId && <span className="shrink-0 rounded bg-ink-800 px-1 text-[10px] text-ink-400">{t("subTool")}</span>}
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-500">{preview}</span>
				<span className={clsx("flex shrink-0 items-center gap-1 text-xs", item.status === "error" ? "text-rose-400" : item.status === "running" ? "text-ember-400" : "text-moss-400")}>
					<StatusIcon className={clsx("size-3.5", item.status === "running" && "animate-spin")} aria-hidden />
					<span className="sr-only">{item.status === "running" ? t("running") : item.status === "error" ? t("failed") : ""}</span>
				</span>
			</summary>
			<div className="space-y-2 border-t hairline px-3 py-2.5">
				{item.args !== undefined && (
					<section>
						<h4 className="mb-1 text-[11px] font-medium text-ink-400">{t("args")}</h4>
						<pre className="max-h-60 overflow-auto rounded-md bg-ink-950/60 p-2 font-mono text-xs break-words whitespace-pre-wrap text-ink-300">{argsText(item.args)}</pre>
					</section>
				)}
				<section>
					<h4 className="mb-1 text-[11px] font-medium text-ink-400">{t("result")}</h4>
					<pre className="max-h-72 overflow-auto rounded-md bg-ink-950/60 p-2 font-mono text-xs break-words whitespace-pre-wrap text-ink-300">{item.status === "running" ? t("running") : item.result || t("noResult")}</pre>
				</section>
			</div>
		</details>
	);
}

function RequestMarker({ item, actions }: { item: RequestItem; actions?: ReactNode }) {
	const t = useT(M);
	return (
		<div className={clsx("rounded-lg border px-3 py-2.5 text-sm", item.resolved ? "border-ink-700 bg-ink-900/40 text-ink-400" : "border-ember-400/50 bg-ember-400/8")}>
			<div className="flex flex-wrap items-center gap-2">
				<ShieldQuestion className={clsx("size-4 shrink-0", item.resolved ? "text-ink-500" : "text-ember-400")} aria-hidden />
				<span className="font-medium">{t("request")}</span>
				{item.toolName && <span className="font-mono text-xs">{item.toolName}</span>}
				<span className="ml-auto text-xs">{item.resolved ? t("resolved") : t("pending")}</span>
			</div>
			{item.title && <p className="mt-1 break-words">{item.title}</p>}
			{item.detail && <p className="mt-0.5 text-xs break-words whitespace-pre-wrap text-ink-400">{item.detail}</p>}
			{!item.resolved && actions}
		</div>
	);
}

/** Read-only transcript with an infinite-scroll sentinel at the end. `renderRequestActions` adds answer buttons for granted users. */
export function TranscriptView({ events, renderRequestActions }: { events: SessionEventsState; renderRequestActions?: (item: RequestItem) => ReactNode }) {
	const t = useT(M);
	const c = useCommonT();
	const { items, loading, hasMore, error, loadMore } = events;
	const sentinel = useRef<HTMLDivElement>(null);
	const bottom = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const lastCount = useRef(0);

	useEffect(() => {
		const el = sentinel.current;
		if (!el || typeof IntersectionObserver === "undefined") return;
		const io = new IntersectionObserver(
			(entries) => {
				const visible = entries.some((e) => e.isIntersecting);
				follow.current = visible;
				if (visible) loadMore();
			},
			{ rootMargin: "300px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [loadMore]);

	// New items arrive while the reader sits at the end: keep the end in view.
	useEffect(() => {
		if (items.length > lastCount.current && lastCount.current > 0 && follow.current && !hasMore) bottom.current?.scrollIntoView({ block: "end" });
		lastCount.current = items.length;
	}, [items.length, hasMore]);

	const render = (item: TranscriptItem): ReactNode => {
		switch (item.type) {
			case "user":
				return (
					<Bubble label={t("user")} tone="user">
						<p className="text-sm break-words whitespace-pre-wrap">{item.text}</p>
					</Bubble>
				);
			case "assistant":
				return (
					<Bubble label={t("assistant")} tone="assistant">
						<Markdown text={item.text} />
					</Bubble>
				);
			case "tool":
				return <ToolBlock item={item} />;
			case "request":
				return <RequestMarker item={item} actions={renderRequestActions?.(item)} />;
			case "rename":
				return (
					<p className="flex items-center gap-1.5 text-xs text-ink-500">
						<Pencil className="size-3" aria-hidden /> {t("renamed", { name: item.name })}
					</p>
				);
		}
	};

	return (
		<div role="log" aria-label={t("transcript")} aria-live="off">
			{error && <ErrorBox message={error} onRetry={loadMore} compact />}
			{items.length === 0 && !loading && !hasMore && !error && (
				<Empty icon={<MessageSquare className="size-5" />} title={t("empty")}>
					{t("emptyHint")}
				</Empty>
			)}
			<ol className="space-y-3">
				{items.map((item) => (
					<li key={item.key}>{render(item)}</li>
				))}
			</ol>
			<div ref={sentinel} className="flex min-h-10 items-center justify-center py-3 text-xs text-ink-500">
				{loading ? (
					<span role="status" className="flex items-center gap-1.5">
						<Loader2 className="size-3.5 animate-spin" aria-hidden /> {c("loading")}
					</span>
				) : hasMore ? (
					<button type="button" onClick={loadMore} className="rounded px-2 py-1 underline underline-offset-2 hover:text-ink-200 focus-visible:outline-2 focus-visible:outline-ember-400">
						{t("loadMore")}
					</button>
				) : items.length > 0 ? (
					t("end")
				) : null}
			</div>
			<div ref={bottom} />
		</div>
	);
}
