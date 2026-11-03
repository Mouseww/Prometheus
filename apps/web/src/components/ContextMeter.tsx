import clsx from "clsx";
import { Minimize2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ContextBreakdown } from "@prometheus/protocol";
import { cacheRate, fmtPercent, fmtTokens } from "../lib/format.ts";
import { speedTracker } from "../lib/speed.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call, refreshStats, toast, useStore } from "../lib/store.ts";
import { Button } from "./ui.tsx";
import { usePopover } from "./TitleBar.tsx";

const M = defineMessages({
	zh: {
		title: "上下文用量",
		system: "系统提示词",
		tools: "工具定义",
		user: "用户消息",
		assistant: "助手回复",
		toolResults: "工具结果",
		other: "其他",
		unattributed: "未归因",
		free: "剩余空间",
		estimate: "各项为估算值（约 4 字符 ≈ 1 token），与模型上报总量的差额计入「未归因」",
		unknown: "模型未返回用量（或刚压缩完），以下均为本地估算值",
		compact: "压缩上下文",
		compacting: "开始压缩上下文…",
		busy: "对话进行中，无法压缩",
		io: "累计输入 {i} · 输出 {o}",
		cacheHit: "缓存命中率 {r}（读取 {c} / 写入 {w}）",
		speed: "生成速度",
		speedNow: "当前 {v} tokens/s（估算）",
		speedLast: "上一条回复 {v} tokens/s · 输出 {n} tokens",
		speedAvg: "本次打开以来平均 {v} tokens/s（{n} 条回复）",
		speedTtft: "首字延迟 {v}",
		speedNone: "还没有可统计的回复（需要流式输出）",
		speedNote: "从第一个字出来开始计时，不含等待首字的时间；输出 token 数以模型上报为准，进行中的速度为估算。",
	},
	en: {
		title: "Context usage",
		system: "System prompt",
		tools: "Tool definitions",
		user: "User messages",
		assistant: "Assistant replies",
		toolResults: "Tool results",
		other: "Other",
		unattributed: "Unattributed",
		free: "Free space",
		estimate: "Per-item sizes are estimates (~4 chars per token); the gap to the model-reported total is shown as \"Unattributed\"",
		unknown: "The model reported no usage (or the chat was just compacted); all figures are local estimates",
		compact: "Compact context",
		compacting: "Compacting context…",
		busy: "Cannot compact while a run is in progress",
		io: "Total input {i} · output {o}",
		cacheHit: "Cache hit rate {r} (read {c} / write {w})",
		speed: "Generation speed",
		speedNow: "Now {v} tokens/s (estimated)",
		speedLast: "Last reply {v} tokens/s · {n} tokens out",
		speedAvg: "Average since opening {v} tokens/s ({n} replies)",
		speedTtft: "Time to first token {v}",
		speedNone: "No timed reply yet (needs streaming output)",
		speedNote: "Timed from the first token, so the wait for it is not included. Token counts come from the model; the live figure is an estimate.",
	},
});

const PARTS: { key: keyof ContextBreakdown | "unattributed"; color: string }[] = [
	{ key: "system", color: "bg-sky-400" },
	{ key: "tools", color: "bg-moss-400" },
	{ key: "user", color: "bg-ember-300" },
	{ key: "assistant", color: "bg-ember-500" },
	{ key: "toolResults", color: "bg-rose-400" },
	{ key: "other", color: "bg-ink-400" },
	{ key: "unattributed", color: "bg-ink-600" },
];

const fmt = fmtTokens;

/** Speed of the open conversation; re-reads twice a second while a reply is being written so the live figure moves. */
function useSpeed() {
	const id = useStore((s) => s.session?.id);
	const streaming = useStore((s) => s.session?.isStreaming ?? false);
	const summary = useSyncExternalStore(speedTracker.subscribe, () => speedTracker.summary(id ?? ""));
	const [, tick] = useState(0);
	useEffect(() => {
		if (!streaming) return;
		const iv = setInterval(() => tick((n) => n + 1), 500);
		return () => clearInterval(iv);
	}, [streaming]);
	return { summary, live: id && streaming ? speedTracker.live(id, Date.now()) : null };
}

const fmtRate = (v: number) => (v >= 100 ? String(Math.round(v)) : v.toFixed(1));
const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

function Ring({ percent }: { percent: number | null }) {
	const p = Math.min(Math.max(percent ?? 0, 0), 100);
	const r = 8;
	const c = 2 * Math.PI * r;
	const color = p > 85 ? "var(--color-rose-400)" : p > 60 ? "var(--color-ember-300)" : "var(--color-moss-400)";
	return (
		<svg viewBox="0 0 20 20" className="size-4 -rotate-90">
			<circle cx="10" cy="10" r={r} fill="none" stroke="var(--color-ink-700)" strokeWidth="2.5" />
			<circle cx="10" cy="10" r={r} fill="none" stroke={color} strokeWidth="2.5" strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} strokeLinecap="round" />
		</svg>
	);
}

/** Composer-footer usage ring; opens a popover with the context makeup and a manual compact action. */
export function ContextMeter() {
	const t = useT(M);
	const session = useStore((s) => s.session);
	const { open, setOpen, ref } = usePopover();
	const [starting, setStarting] = useState(false);
	const { summary, live } = useSpeed();
	const stats = session?.stats;
	if (!session || !stats) return null;

	const window_ = stats.contextWindow;
	const used = stats.contextTokens;
	const parts = PARTS.map((p) => ({ ...p, tokens: p.key === "unattributed" ? 0 : (stats.breakdown?.[p.key] ?? 0) }));
	const sum = parts.reduce((a, p) => a + p.tokens, 0);
	const gap = stats.contextEstimated ? 0 : Math.max(used - sum, 0);
	const shown = parts.map((p) => (p.key === "unattributed" ? { ...p, tokens: gap } : p)).filter((p) => p.tokens > 0);
	const total = used;
	const compacting = starting || session.banner?.kind === "compaction";
	const width = (tokens: number) => (window_ > 0 ? Math.min(100, (tokens / window_) * 100) : 0);

	const compact = async () => {
		if (starting || session.banner?.kind === "compaction") return;
		setStarting(true);
		const ok = await call((c) => c.rpc("chat.compact", { sessionId: session.id })).finally(() => setStarting(false));
		if (ok === undefined) return;
		toast(t("compacting"));
		setOpen(false);
		void refreshStats();
	};

	return (
		<div ref={ref} className="shrink-0 md:relative">
			<button
				type="button"
				onClick={() => {
					if (!open) void refreshStats();
					setOpen(!open);
				}}
				className="flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-[11px] text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
				title={t("title")}
			>
				<Ring percent={stats.contextPercent} />
				<span className="hidden whitespace-nowrap sm:inline">
					{stats.contextEstimated ? "~" : ""}{fmt(used)} / {fmt(window_)}
				</span>
				<span className="whitespace-nowrap sm:hidden">{stats.contextPercent != null ? `${Math.round(stats.contextPercent)}%` : fmt(used)}</span>
			</button>
			{open && (
				<div className="absolute right-3 left-3 bottom-full z-40 mb-2 md:left-auto md:right-0 md:w-80 animate-rise rounded-xl border border-ink-700 bg-ink-900/97 p-3.5 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="flex items-baseline justify-between">
						<span className="text-sm font-medium text-ink-100">{t("title")}</span>
						<span className="font-mono text-xs text-ink-300">{stats.contextPercent != null ? `${stats.contextPercent.toFixed(1)}%` : "—"}</span>
					</div>

					<div className="mt-3 flex h-2 overflow-hidden rounded-full bg-ink-800">
						{shown.map((p) => (
							<div key={p.key} className={p.color} style={{ width: `${width(p.tokens)}%` }} title={`${t(p.key)} · ${fmt(p.tokens)}`} />
						))}
					</div>

					<ul className="mt-3 space-y-1.5 text-xs">
						{shown.map((p) => (
							<li key={p.key} className="flex items-center gap-2">
								<span className={clsx("size-2 shrink-0 rounded-full", p.color)} />
								<span className="flex-1 text-ink-300">{t(p.key)}</span>
								<span className="font-mono text-ink-400">{fmt(p.tokens)}</span>
							</li>
						))}
						<li className="flex items-center gap-2">
							<span className="size-2 shrink-0 rounded-full border border-ink-600" />
							<span className="flex-1 text-ink-300">{t("free")}</span>
							<span className="font-mono text-ink-400">{fmt(Math.max(window_ - total, 0))}</span>
						</li>
					</ul>

					<div className="mt-3 border-t border-ink-800 pt-2.5">
						<div className="text-xs font-medium text-ink-200">{t("speed")}</div>
						<ul className="mt-1.5 space-y-1 font-mono text-[11px] text-ink-400">
							{live?.tps != null && <li className="text-ember-300">{t("speedNow", { v: fmtRate(live.tps) })}</li>}
							{summary.last ? (
								<>
									<li>{t("speedLast", { v: fmtRate(summary.last.tps), n: fmt(summary.last.outputTokens) })}</li>
									<li>{t("speedTtft", { v: fmtMs(summary.last.ttftMs) })}</li>
									{summary.avgTps != null && summary.replies > 1 && <li>{t("speedAvg", { v: fmtRate(summary.avgTps), n: summary.replies })}</li>}
								</>
							) : (
								!live?.tps && <li className="text-ink-500">{t("speedNone")}</li>
							)}
						</ul>
						<p className="mt-1.5 text-[10.5px] leading-snug text-ink-500">{t("speedNote")}</p>
					</div>

					<p className="mt-3 text-[11px] leading-snug text-ink-500">{stats.contextEstimated ? t("unknown") : t("estimate")}</p>
					<p className="mt-1 font-mono text-[11px] text-ink-500">
						{t("io", { i: fmt(stats.inputTokens), o: fmt(stats.outputTokens) })}
						{stats.totalCost > 0 && ` · $${stats.totalCost.toFixed(4)}`}
					</p>
					<p className="mt-1 font-mono text-[11px] text-ink-500">
						{t("cacheHit", {
							r: fmtPercent(cacheRate({ input: stats.inputTokens, cacheRead: stats.cacheReadTokens, cacheWrite: stats.cacheWriteTokens })),
							c: fmt(stats.cacheReadTokens),
							w: fmt(stats.cacheWriteTokens),
						})}
					</p>

					<Button variant="outline" className="mt-3 w-full" disabled={session.isStreaming || compacting} title={session.isStreaming ? t("busy") : compacting ? t("compacting") : undefined} onClick={() => void compact()}>
						<Minimize2 className="size-4" /> {t("compact")}
					</Button>
				</div>
			)}
		</div>
	);
}
