// Operator: every organization on the Hub with its size. Self-service organizations show up here as they are created.
import { Building2 } from "lucide-react";
import { Badge, Empty } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { useTeam } from "../../context.tsx";
import { statusLabel, useCommonT } from "../../i18n.ts";
import { AsyncView, Card, shortDate, Table, Td, useAsync } from "../../kit.tsx";

const M = defineMessages({
	zh: {
		title: "全部企业（运营者视图）",
		name: "企业",
		slug: "标识",
		status: "状态",
		members: "成员",
		teams: "团队",
		created: "创建时间",
		none: "还没有企业",
		noneHint: "企业创建后会出现在这里。",
	},
	en: {
		title: "All organizations (operator view)",
		name: "Organization",
		slug: "Slug",
		status: "Status",
		members: "Members",
		teams: "Teams",
		created: "Created",
		none: "No organizations yet",
		noneHint: "Organizations appear here as soon as they are created.",
	},
});

export function OperatorOrgs() {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const lang = usePrefs((s) => s.lang);
	const orgs = useAsync(() => api.listAdminOrgs(), [api]);
	return (
		<Card title={t("title")} className="mb-4">
			<AsyncView state={orgs}>
				{(rows) =>
					rows.length === 0 ? (
						<Empty icon={<Building2 className="size-5" />} title={t("none")}>
							{t("noneHint")}
						</Empty>
					) : (
						<Table label={t("title")} head={[t("name"), t("slug"), t("status"), t("members"), t("teams"), t("created")]}>
							{rows.map((o) => (
								<tr key={o.id}>
									<Td className="font-medium">{o.name}</Td>
									<Td className="font-mono text-xs text-ink-400">{o.slug}</Td>
									<Td>
										<Badge tone={o.status === "active" ? "moss" : "rose"}>{statusLabel(c, o.status)}</Badge>
									</Td>
									<Td>{o.memberCount}</Td>
									<Td>{o.teamCount}</Td>
									<Td className="text-xs text-ink-400">{shortDate(o.createdAt, lang)}</Td>
								</tr>
							))}
						</Table>
					)
				}
			</AsyncView>
		</Card>
	);
}
