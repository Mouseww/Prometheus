import { BarChart3 } from "lucide-react";
import { useEffect, useState } from "react";
import type { UsageStats, UsageTotals } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call } from "../lib/store.ts";
import { Empty, PageHeader } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "用量统计",
		subtitle: "汇总本机全部会话中模型返回的 token 用量与费用",
		d7: "近 7 天",
		d30: "近 30 天",
		all: "全部",
		sessions: "会话数",
		requests: "请求数",
		input: "输入",
		output: "输出",
		cache: "缓存读取",
		cost: "费用",
		byModel: "按模型",
		byDay: "按日期",
		model: "模型",
		date: "日期",
		empty: "还没有用量记录",
		emptyBody: "开始对话后，这里会显示 token 与费用。未返回用量的网关不会被统计。",
		costNote: "费用按模型单价估算；自定义网关未配置单价时为 0。",
	},
	en: {
		title: "Usage",
		subtitle: "Token usage and cost reported by models across all local sessions",
		d7: "Last 7 days",
		d30: "Last 30 days",
		all: "All time",
		sessions: "Sessions",
		requests: "Requests",
		input: "Input",
		output: "Output",
		cache: "Cache read",
		cost: "Cost",
		byModel: "By model",
		byDay: "By day",
		model: "Model",
		date: "Date",
		empty: "No usage yet",
		emptyBody: "Token counts and cost show up here once you chat. Gateways that report no usage are not counted.",
		costNote: "Cost is estimated from model pricing; custom gateways without pricing show 0.",
	},
});

const RANGES = [
	{ days: 7, label: "d7" },
	{ days: 30, label: "d30" },
	{ days: 0, label: "all" },
] as const;

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fmt = (n: number) => (n < 10_000 ? n.toLocaleString() : compact.format(n));
const money = (n: number) => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(n < 100 ? 2 : 0)}`);

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
			<div className="text-xs text-ink-400">{label}</div>
			<div className="mt-1.5 font-display text-2xl font-semibold text-ink-100">{value}</div>
		</div>
	);
}

function Table({ head, rows }: { head: string[]; rows: { key: string; label: string; totals: UsageTotals }[] }) {
	const t = useT(M);
	return (
		<div className="overflow-x-auto rounded-xl border border-ink-800">
			<table className="w-full text-left text-sm">
				<thead className="bg-ink-900/60 text-xs text-ink-400">
					<tr>
						<th className="px-4 py-2 font-medium">{head[0]}</th>
						{(["requests", "input", "output", "cache", "cost"] as const).map((k) => (
							<th key={k} className="px-4 py-2 text-right font-medium">
								{t(k)}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="divide-y divide-ink-800 font-mono text-[13px] text-ink-200">
					{rows.map((r) => (
						<tr key={r.key}>
							<td className="max-w-64 truncate px-4 py-2 text-ink-100">{r.label}</td>
							<td className="px-4 py-2 text-right">{fmt(r.totals.requests)}</td>
							<td className="px-4 py-2 text-right">{fmt(r.totals.input)}</td>
							<td className="px-4 py-2 text-right">{fmt(r.totals.output)}</td>
							<td className="px-4 py-2 text-right">{fmt(r.totals.cacheRead)}</td>
							<td className="px-4 py-2 text-right">{money(r.totals.cost)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function UsageView() {
	const t = useT(M);
	const [days, setDays] = useState<number>(30);
	const [stats, setStats] = useState<UsageStats | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let stale = false;
		setLoading(true);
		void call((c) => c.rpc("usage.stats", { days })).then((s) => {
			if (stale) return;
			if (s) setStats(s);
			setLoading(false);
		});
		return () => {
			stale = true;
		};
	}, [days]);

	const empty = !loading && (stats?.totals.requests ?? 0) === 0;
	const peak = Math.max(1, ...(stats?.byDay.map((d) => d.input + d.output) ?? []));

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<div className="flex rounded-lg border border-ink-700 bg-ink-950/60 p-0.5">
						{RANGES.map((r) => (
							<button
								key={r.days}
								type="button"
								onClick={() => setDays(r.days)}
								className={`rounded-md px-3 py-1.5 text-xs transition-colors ${days === r.days ? "bg-ink-800 text-ink-100 shadow-sm" : "text-ink-400 hover:text-ink-200"}`}
							>
								{t(r.label)}
							</button>
						))}
					</div>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{empty ? (
					<Empty icon={<BarChart3 className="size-5" />} title={t("empty")}>
						{t("emptyBody")}
					</Empty>
				) : (
					stats && (
						<div className={`mx-auto max-w-4xl space-y-8 p-8 transition-opacity ${loading ? "opacity-50" : ""}`}>
							<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
								<Stat label={t("requests")} value={fmt(stats.totals.requests)} />
								<Stat label={t("input")} value={fmt(stats.totals.input)} />
								<Stat label={t("output")} value={fmt(stats.totals.output)} />
								<Stat label={t("cost")} value={money(stats.totals.cost)} />
							</div>
							<p className="-mt-4 text-xs text-ink-500">
								{t("sessions")}: {stats.sessions} · {t("cache")}: {fmt(stats.totals.cacheRead)} · {t("costNote")}
							</p>

							<section className="space-y-3">
								<h2 className="font-mono text-[10.5px] tracking-[0.18em] text-ink-500 uppercase">{t("byDay")}</h2>
								<div className="flex h-32 items-end gap-1 rounded-xl border border-ink-800 bg-ink-900/40 p-3">
									{stats.byDay.map((d) => (
										<div key={d.date} className="group relative flex h-full min-w-1 flex-1 items-end" title={`${d.date}: ${fmt(d.input + d.output)} tokens · ${money(d.cost)}`}>
											<div className="w-full rounded-t bg-ember-500/70 transition-colors group-hover:bg-ember-400" style={{ height: `${Math.max(2, ((d.input + d.output) / peak) * 100)}%` }} />
										</div>
									))}
								</div>
								<Table head={[t("date")]} rows={[...stats.byDay].reverse().map((d) => ({ key: d.date, label: d.date, totals: d }))} />
							</section>

							<section className="space-y-3">
								<h2 className="font-mono text-[10.5px] tracking-[0.18em] text-ink-500 uppercase">{t("byModel")}</h2>
								<Table head={[t("model")]} rows={stats.byModel.map((m) => ({ key: `${m.provider}/${m.model}`, label: `${m.provider}/${m.model}`, totals: m }))} />
							</section>
						</div>
					)
				)}
			</div>
		</div>
	);
}
