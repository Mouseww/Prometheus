import { FileText, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Empty, Field, Input } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { useTeam } from "../../context.tsx";
import { AsyncView, Card, Notice, shortDate, useAction, useAsync } from "../../kit.tsx";
import type { ReportContent } from "../../types.ts";

const M = defineMessages({
	zh: {
		date: "日期",
		latest: "留空查看最新一份",
		generate: "立即生成",
		generating: "生成中",
		generatedHint: "没有选日期时生成昨天的日报，已有的会被替换。",
		byModel: "模型生成",
		byDigest: "规则摘要",
		generatedAt: "生成于 {date}",
		overall: "整体进展",
		risks: "风险",
		members: "成员",
		noItems: "没有内容",
		emptyTitle: "还没有日报",
		emptyBody: "日报会在工作区设置的时间自动生成。",
		emptyDate: "{date} 没有日报",
		emptyAdmin: "团队管理员可以点击「立即生成」。",
		generated: "已生成 {date} 的日报",
	},
	en: {
		date: "Date",
		latest: "Leave empty for the latest",
		generate: "Generate now",
		generating: "Generating",
		generatedHint: "Without a date it generates yesterday's report and replaces an existing one.",
		byModel: "Model summary",
		byDigest: "Rule-based digest",
		generatedAt: "Generated {date}",
		overall: "Overall progress",
		risks: "Risks",
		members: "Members",
		noItems: "Nothing to show",
		emptyTitle: "No report yet",
		emptyBody: "Reports are generated automatically at the time set in the workspace settings.",
		emptyDate: "No report for {date}",
		emptyAdmin: "Team admins can press Generate now.",
		generated: "Generated the report for {date}",
	},
});

function Bullets({ items, empty }: { items: string[]; empty: string }) {
	if (items.length === 0) return <p className="text-sm text-ink-500">{empty}</p>;
	return (
		<ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-200 marker:text-ink-500">
			{items.map((item, i) => (
				<li key={`${i}-${item}`} className="break-words">
					{item}
				</li>
			))}
		</ul>
	);
}

function Sections({ content }: { content: ReportContent }) {
	const t = useT(M);
	return (
		<div className="space-y-4">
			<Card title={t("overall")}>
				<Bullets items={content.overall} empty={t("noItems")} />
			</Card>
			<Card title={t("risks")} className={content.risks.length > 0 ? "border-ember-500/40" : undefined}>
				<Bullets items={content.risks} empty={t("noItems")} />
			</Card>
			<Card title={t("members")}>
				{content.members.length === 0 ? (
					<p className="text-sm text-ink-500">{t("noItems")}</p>
				) : (
					<div className="space-y-4">
						{content.members.map((m) => (
							<section key={m.userId} aria-label={m.name}>
								<h3 className="mb-1.5 text-sm font-medium text-ink-100">{m.name}</h3>
								<Bullets items={m.items} empty={t("noItems")} />
							</section>
						))}
					</div>
				)}
			</Card>
		</div>
	);
}

export function ReportTab({ workspaceId, canGenerate }: { workspaceId: string; canGenerate: boolean }) {
	const { api } = useTeam();
	const t = useT(M);
	const lang = usePrefs((s) => s.lang);
	const [date, setDate] = useState("");
	const report = useAsync(() => api.getReport(workspaceId, date || undefined), [api, workspaceId, date]);
	const { reload, setData } = report;
	const gen = useAction();
	const [done, setDone] = useState<string | undefined>(undefined);

	useEffect(
		() =>
			api.subscribe(`workspace:${workspaceId}`, (ev) => {
				if (typeof ev === "object" && ev !== null && (ev as { kind?: unknown }).kind === "report.generated") reload();
			}),
		[api, workspaceId, reload],
	);

	const generate = async () => {
		setDone(undefined);
		const next = await gen.run(() => api.generateReport(workspaceId, date || undefined));
		if (next) {
			setData(next);
			setDone(next.date);
		}
	};

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-end gap-3">
				<Field label={t("date")} hint={t("latest")}>
					<Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
				</Field>
				{canGenerate && (
					<Button variant="outline" onClick={() => void generate()} disabled={gen.busy} title={t("generatedHint")}>
						<Sparkles className="size-4" aria-hidden /> {gen.busy ? t("generating") : t("generate")}
					</Button>
				)}
			</div>
			{gen.error && <Notice kind="error">{gen.error}</Notice>}
			{done && <Notice kind="ok">{t("generated", { date: done })}</Notice>}
			<AsyncView state={report}>
				{(r) =>
					r === null ? (
						<Empty icon={<FileText className="size-5" />} title={date ? t("emptyDate", { date }) : t("emptyTitle")}>
							{t("emptyBody")} {canGenerate && t("emptyAdmin")}
						</Empty>
					) : (
						<div className="space-y-4">
							<div className="flex flex-wrap items-center gap-2">
								<h2 className="font-display text-base font-semibold">{r.date}</h2>
								<Badge tone={r.generatedBy === "model" ? "sky" : "muted"}>{r.generatedBy === "model" ? t("byModel") : t("byDigest")}</Badge>
								<span className="text-xs text-ink-500">{t("generatedAt", { date: shortDate(r.createdAt, lang) })}</span>
							</div>
							<Sections content={r.content} />
						</div>
					)
				}
			</AsyncView>
		</div>
	);
}
