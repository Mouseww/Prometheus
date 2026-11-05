import { Gauge, Pencil } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { Badge, Button, Empty, Field, Input, PageHeader, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Body, Card, ConfirmButton, Notice, Table, Td, useAction, useAsync } from "../../kit.tsx";
import type { QuotaPeriod, QuotaSubject, QuotaView } from "../../types.ts";
import { useAdminOrgs } from "./shared.tsx";

const M = defineMessages({
	zh: {
		title: "配额",
		subtitle: "按人或按企业限制每天、每月可用的 token 数。超出后模型调用会被拒绝。",
		formTitle: "设置配额",
		subjectType: "对象类型",
		user: "用户",
		org: "企业",
		subject: "对象",
		subjectUser: "用户（邮箱或 ID）",
		pickOrg: "选择企业",
		period: "周期",
		day: "每天",
		month: "每月",
		limit: "token 上限",
		limitHint: "整数，0 表示不允许使用",
		save: "保存配额",
		saved: "已保存",
		removed: "已删除",
		tableLabel: "配额列表",
		unlimited: "无",
		empty: "还没有配额",
		emptyHint: "没有配额的对象不受限制。",
		edit: "编辑 {name} 的配额",
		actions: "操作",
		invalid: "上限需要是不小于 0 的整数",
		noSubject: "请选择对象",
	},
	en: {
		title: "Quotas",
		subtitle: "Limit the tokens a user or an organization may use per day or month. Calls beyond the limit are refused.",
		formTitle: "Set a quota",
		subjectType: "Applies to",
		user: "User",
		org: "Organization",
		subject: "Subject",
		subjectUser: "User (email or id)",
		pickOrg: "Pick an organization",
		period: "Period",
		day: "Per day",
		month: "Per month",
		limit: "Token limit",
		limitHint: "Whole number. 0 blocks usage.",
		save: "Save quota",
		saved: "Saved",
		removed: "Removed",
		tableLabel: "Quotas",
		unlimited: "none",
		empty: "No quotas yet",
		emptyHint: "Subjects without a quota are not limited.",
		edit: "Edit the quota of {name}",
		actions: "Actions",
		invalid: "The limit must be a whole number, zero or more",
		noSubject: "Pick a subject",
	},
});

/** The limit as typed: a non-negative integer, or undefined when it is not one. */
const parseLimit = (text: string): number | undefined => (/^\d{1,15}$/.test(text.trim()) ? Number(text.trim()) : undefined);

export function QuotasPage() {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const orgs = useAdminOrgs();
	const quotas = useAsync(() => api.listQuotas(), [api]);
	const users = useAsync(() => api.listUsers().catch(() => []), [api]);
	const save = useAction();
	const remove = useAction();
	const [subjectType, setSubjectType] = useState<QuotaSubject>("org");
	const [subjectId, setSubjectId] = useState("");
	const [period, setPeriod] = useState<QuotaPeriod>("month");
	const [limit, setLimit] = useState("");
	const [note, setNote] = useState<string | undefined>(undefined);
	const [formError, setFormError] = useState<string | undefined>(undefined);

	const names = useMemo(() => {
		const map = new Map<string, string>();
		for (const o of orgs.data ?? []) map.set(o.id, o.name);
		for (const u of users.data ?? []) map.set(u.id, u.email);
		return map;
	}, [orgs.data, users.data]);
	const nameOf = (id: string) => names.get(id) ?? id;

	const resolveUser = (text: string): string => {
		const v = text.trim();
		const byEmail = (users.data ?? []).find((u) => u.email.toLowerCase() === v.toLowerCase());
		return byEmail?.id ?? v;
	};

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setNote(undefined);
		setFormError(undefined);
		const limitTokens = parseLimit(limit);
		if (limitTokens === undefined) return setFormError(t("invalid"));
		const id = subjectType === "user" ? resolveUser(subjectId) : subjectId;
		if (!id) return setFormError(t("noSubject"));
		const r = await save.run(async () => {
			await api.setQuota({ subjectType, subjectId: id, period, limitTokens });
			return true;
		});
		if (r) {
			setNote(t("saved"));
			setLimit("");
			quotas.reload();
		}
	};

	const edit = (q: QuotaView) => {
		setNote(undefined);
		setFormError(undefined);
		setSubjectType(q.subjectType);
		setSubjectId(q.subjectId);
		setPeriod(q.period);
		setLimit(String(q.limitTokens));
	};

	const orgList = orgs.data ?? [];

	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body className="space-y-4">
				<Card title={t("formTitle")}>
					<form onSubmit={(e) => void submit(e)} className="grid gap-3 @2xl:grid-cols-4 @2xl:items-end">
						<Field label={t("subjectType")}>
							<Select
								value={subjectType}
								onChange={(e) => {
									setSubjectType(e.target.value as QuotaSubject);
									setSubjectId("");
								}}
							>
								<option value="org">{t("org")}</option>
								<option value="user">{t("user")}</option>
							</Select>
						</Field>
						{subjectType === "org" ? (
							<Field label={t("subject")}>
								<Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} required>
									<option value="">{t("pickOrg")}</option>
									{orgList.map((o) => (
										<option key={o.id} value={o.id}>
											{o.name}
										</option>
									))}
								</Select>
							</Field>
						) : (
							<Field label={t("subjectUser")}>
								<Input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} list="team-quota-users" required autoComplete="off" />
								<datalist id="team-quota-users">
									{(users.data ?? []).map((u) => (
										<option key={u.id} value={u.email}>
											{u.displayName}
										</option>
									))}
								</datalist>
							</Field>
						)}
						<Field label={t("period")}>
							<Select value={period} onChange={(e) => setPeriod(e.target.value as QuotaPeriod)}>
								<option value="day">{t("day")}</option>
								<option value="month">{t("month")}</option>
							</Select>
						</Field>
						<Field label={t("limit")} hint={t("limitHint")}>
							<Input inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} required />
						</Field>
						<div className="flex flex-wrap items-center gap-3 @2xl:col-span-4">
							<Button type="submit" variant="primary" disabled={save.busy}>
								{t("save")}
							</Button>
							{note && <Notice kind="ok">{note}</Notice>}
							{(formError ?? save.error) && <Notice kind="error">{formError ?? save.error}</Notice>}
						</div>
					</form>
				</Card>
				{remove.error && <Notice kind="error">{remove.error}</Notice>}
				<AsyncView state={quotas}>
					{(rows) =>
						rows.length === 0 ? (
							<Empty icon={<Gauge className="size-5" />} title={t("empty")}>
								{t("emptyHint")}
							</Empty>
						) : (
							<Table label={t("tableLabel")} head={[t("subjectType"), t("subject"), t("period"), t("limit"), t("actions")]}>
								{rows.map((q) => (
									<tr key={q.id}>
										<Td>
											<Badge tone={q.subjectType === "org" ? "sky" : "muted"}>{q.subjectType === "org" ? t("org") : t("user")}</Badge>
										</Td>
										<Td className="max-w-64 truncate">{nameOf(q.subjectId)}</Td>
										<Td>{q.period === "day" ? t("day") : t("month")}</Td>
										<Td className="tabular-nums">{q.limitTokens.toLocaleString()}</Td>
										<Td>
											<div className="flex items-center gap-1.5">
												<Button variant="ghost" aria-label={t("edit", { name: nameOf(q.subjectId) })} onClick={() => edit(q)}>
													<Pencil className="size-4" aria-hidden />
												</Button>
												<ConfirmButton
													label={c("delete")}
													disabled={remove.busy}
													onConfirm={() =>
														void remove
															.run(async () => {
																await api.setQuota({ subjectType: q.subjectType, subjectId: q.subjectId, period: q.period, limitTokens: null });
																return true;
															})
															.then((ok) => {
																if (ok) {
																	setNote(t("removed"));
																	quotas.reload();
																}
															})
													}
												/>
											</div>
										</Td>
									</tr>
								))}
							</Table>
						)
					}
				</AsyncView>
			</Body>
		</>
	);
}
