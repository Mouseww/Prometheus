import { BarChart3 } from "lucide-react";
import { useState } from "react";
import { Button, Empty, Field, Input, PageHeader, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Body, Table, Td, useAsync } from "../../kit.tsx";
import { barPercent, usageTotals } from "../../logic/gateway.ts";
import type { UsageGroup } from "../../types.ts";

const M = defineMessages({
	zh: {
		title: "用量统计",
		subtitle: "按人、企业、日期或模型汇总 token 用量。",
		groupBy: "分组",
		user: "按用户",
		org: "按企业",
		day: "按日期",
		model: "按模型",
		from: "开始日期",
		to: "结束日期",
		clear: "清除日期",
		tableLabel: "用量",
		key: "对象",
		input: "输入 token",
		output: "输出 token",
		total: "合计",
		requests: "请求数",
		share: "占比",
		totals: "总计",
		empty: "这段时间没有用量",
		emptyHint: "调整分组或日期范围再试。",
		system: "系统（日报等）",
	},
	en: {
		title: "Usage",
		subtitle: "Token usage summed by user, organization, day or model.",
		groupBy: "Group by",
		user: "By user",
		org: "By organization",
		day: "By day",
		model: "By model",
		from: "From",
		to: "To",
		clear: "Clear dates",
		tableLabel: "Usage",
		key: "Subject",
		input: "Input tokens",
		output: "Output tokens",
		total: "Total",
		requests: "Requests",
		share: "Share",
		totals: "Totals",
		empty: "No usage in this range",
		emptyHint: "Change the grouping or the date range.",
		system: "System (daily reports etc.)",
	},
});

const fmt = (n: number) => n.toLocaleString();

export function UsagePage() {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const [groupBy, setGroupBy] = useState<UsageGroup>("day");
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const usage = useAsync(() => api.getUsage({ groupBy, from: from || undefined, to: to || undefined }), [api, groupBy, from, to]);

	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} actions={<Button variant="ghost" onClick={usage.reload}>{c("refresh")}</Button>} />
			<Body className="space-y-4">
				<div className="flex flex-wrap items-end gap-3">
					<Field label={t("groupBy")}>
						<Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as UsageGroup)} className="w-40">
							<option value="day">{t("day")}</option>
							<option value="user">{t("user")}</option>
							<option value="org">{t("org")}</option>
							<option value="model">{t("model")}</option>
						</Select>
					</Field>
					<Field label={t("from")}>
						<Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-44" />
					</Field>
					<Field label={t("to")}>
						<Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-44" />
					</Field>
					{(from || to) && (
						<Button
							variant="ghost"
							onClick={() => {
								setFrom("");
								setTo("");
							}}
						>
							{t("clear")}
						</Button>
					)}
				</div>
				<AsyncView state={usage}>
					{(rows) => {
						if (rows.length === 0)
							return (
								<Empty icon={<BarChart3 className="size-5" />} title={t("empty")}>
									{t("emptyHint")}
								</Empty>
							);
						const totals = usageTotals(rows);
						const max = rows.reduce((m, r) => Math.max(m, r.inputTokens + r.outputTokens), 0);
						return (
							<Table label={t("tableLabel")} head={[t("key"), t("input"), t("output"), t("total"), t("requests"), t("share")]}>
								{rows.map((r) => {
									const total = r.inputTokens + r.outputTokens;
									const pct = barPercent(total, max);
									return (
										<tr key={r.key}>
											<Td className="max-w-64 truncate">{r.label ?? (r.key === "system" ? t("system") : r.key)}</Td>
											<Td className="tabular-nums">{fmt(r.inputTokens)}</Td>
											<Td className="tabular-nums">{fmt(r.outputTokens)}</Td>
											<Td className="font-medium tabular-nums">{fmt(total)}</Td>
											<Td className="tabular-nums">{fmt(r.requests)}</Td>
											<Td className="w-48">
												<div role="img" aria-label={`${pct}%`} className="h-2 w-full overflow-hidden rounded-full bg-ink-800">
													<div className="h-full rounded-full bg-ember-500" style={{ width: `${pct}%` }} />
												</div>
											</Td>
										</tr>
									);
								})}
								<tr className="bg-ink-850 font-medium">
									<Td>{t("totals")}</Td>
									<Td className="tabular-nums">{fmt(totals.inputTokens)}</Td>
									<Td className="tabular-nums">{fmt(totals.outputTokens)}</Td>
									<Td className="tabular-nums">{fmt(totals.inputTokens + totals.outputTokens)}</Td>
									<Td className="tabular-nums">{fmt(totals.requests)}</Td>
									<Td />
								</tr>
							</Table>
						);
					}}
				</AsyncView>
			</Body>
		</>
	);
}
