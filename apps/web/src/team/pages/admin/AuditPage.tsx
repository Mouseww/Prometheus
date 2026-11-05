import { ScrollText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Field, Input, PageHeader, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { errorText } from "../../i18n.ts";
import { Body, ErrorBox, shortDate, Table, Td } from "../../kit.tsx";
import type { AuditRecord } from "../../types.ts";
import { useAdminOrgs, useOrgNames } from "./shared.tsx";

const M = defineMessages({
	zh: {
		title: "审计日志",
		subtitle: "管理操作的记录",
		scope: "范围",
		platform: "平台",
		action: "操作（如 user.approve）",
		actor: "操作人 ID",
		time: "时间",
		target: "对象",
		detail: "详情",
		empty: "没有符合条件的记录",
		more: "加载更多",
		loading: "加载中",
		system: "系统",
	},
	en: {
		title: "Audit log",
		subtitle: "A record of administrative actions",
		scope: "Scope",
		platform: "Platform",
		action: "Action (e.g. user.approve)",
		actor: "Actor ID",
		time: "Time",
		target: "Target",
		detail: "Detail",
		empty: "No records match",
		more: "Load more",
		loading: "Loading",
		system: "System",
	},
});

const PAGE = 50;

export function AuditPage() {
	const { api, me } = useTeam();
	const t = useT(M);
	const lang = usePrefs((s) => s.lang);
	const operator = isOperator(me);
	const orgs = useAdminOrgs();
	const orgName = useOrgNames(orgs.data);
	const [scope, setScope] = useState("");
	const [action, setAction] = useState("");
	const [actor, setActor] = useState("");
	const [rows, setRows] = useState<AuditRecord[]>([]);
	const [next, setNext] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>(undefined);

	// Org admins always query one organization; the operator may also read the platform scope.
	const orgId = scope || (operator ? "" : (orgs.data?.[0]?.id ?? ""));
	const ready = operator || orgs.data !== undefined;

	const load = useCallback(
		async (before: string | undefined, append: boolean) => {
			setLoading(true);
			try {
				const page = await api.listAudit({
					...(orgId ? { orgId } : {}),
					...(action.trim() ? { action: action.trim() } : {}),
					...(actor.trim() ? { actor: actor.trim() } : {}),
					...(before ? { before } : {}),
					limit: PAGE,
				});
				setRows((cur) => (append ? [...cur, ...page.items] : page.items));
				setNext(page.nextBefore);
				setError(undefined);
			} catch (e) {
				setError(errorText(e));
			} finally {
				setLoading(false);
			}
		},
		[api, orgId, action, actor],
	);

	useEffect(() => {
		if (!ready) return;
		const id = window.setTimeout(() => void load(undefined, false), 250);
		return () => window.clearTimeout(id);
	}, [load, ready]);

	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body>
				<div className="mb-4 grid gap-3 @2xl:grid-cols-3">
					<Field label={t("scope")}>
						<Select value={orgId} onChange={(e) => setScope(e.target.value)}>
							{operator && <option value="">{t("platform")}</option>}
							{(orgs.data ?? []).map((o) => (
								<option key={o.id} value={o.id}>
									{o.name}
								</option>
							))}
						</Select>
					</Field>
					<Field label={t("action")}>
						<Input value={action} onChange={(e) => setAction(e.target.value)} />
					</Field>
					<Field label={t("actor")}>
						<Input value={actor} onChange={(e) => setActor(e.target.value)} className="font-mono" />
					</Field>
				</div>
				{error && <ErrorBox message={error} onRetry={() => void load(undefined, false)} compact />}
				{rows.length === 0 && !loading && !error ? (
					<Empty icon={<ScrollText className="size-5" />} title={t("empty")} />
				) : (
					rows.length > 0 && (
						<Table label={t("title")} head={[t("time"), t("action"), t("actor"), t("target"), t("detail")]}>
							{rows.map((r) => (
								<tr key={r.id} className="align-top">
									<Td className="whitespace-nowrap text-xs text-ink-400">{shortDate(r.createdAt, lang)}</Td>
									<Td className="font-mono text-xs">{r.action}</Td>
									<Td className="break-all font-mono text-xs text-ink-400">{r.actorId ?? t("system")}</Td>
									<Td className="break-all text-xs text-ink-300">
										{r.targetType ? `${r.targetType}${r.targetId ? `:${r.targetId}` : ""}` : ""}
										{r.orgId && <span className="block text-ink-500">{orgName(r.orgId)}</span>}
									</Td>
									<Td className="max-w-xs break-all font-mono text-[11px] text-ink-400">{Object.keys(r.detail).length ? JSON.stringify(r.detail) : ""}</Td>
								</tr>
							))}
						</Table>
					)
				)}
				<div className="mt-4 flex justify-center">
					{loading && <span role="status" className="text-sm text-ink-400">{t("loading")}</span>}
					{!loading && next && (
						<Button variant="outline" onClick={() => void load(next, true)}>
							{t("more")}
						</Button>
					)}
				</div>
			</Body>
		</>
	);
}
