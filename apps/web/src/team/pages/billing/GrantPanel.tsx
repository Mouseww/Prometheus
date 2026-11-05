// Operator: grant credits to a user or organization (top-up or compensation). Irreversible, so it asks first.
import { type FormEvent, useState } from "react";
import { Button, Field, Input, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { useTeam } from "../../context.tsx";
import { Card, Notice, useAction, useAsync } from "../../kit.tsx";
import { formatCredits, localInputToIso, parseCreditsInput } from "../../logic/billing.ts";
import type { BillingSubjectType } from "../../types.ts";
import { useAdminOrgs } from "../admin/shared.tsx";
import { ConfirmDialog } from "./parts.tsx";

const M = defineMessages({
	zh: {
		intro: "直接给用户或企业发放额度，用于线下充值或补偿。发放后不能撤回。",
		subjectType: "发放对象",
		user: "用户",
		org: "企业",
		subjectUser: "用户（邮箱或 ID）",
		subjectOrg: "企业",
		pickOrg: "选择企业",
		credits: "额度",
		creditsHint: "整数，1 到 1,000,000,000 credits",
		expires: "过期时间",
		expiresHint: "可留空，表示不过期",
		grant: "发放额度",
		invalid: "请检查输入：选择对象，额度为 1 到 1,000,000,000 的整数",
		confirmTitle: "确认发放额度",
		confirmBody: "确定向{type}「{who}」发放 {credits} credits 吗？发放后不能撤回。",
		done: "已发放 {credits} credits",
	},
	en: {
		intro: "Grant credits straight to a user or organization, for offline top-ups or compensation. A grant cannot be taken back.",
		subjectType: "Grant to",
		user: "User",
		org: "Organization",
		subjectUser: "User (email or id)",
		subjectOrg: "Organization",
		pickOrg: "Pick an organization",
		credits: "Credits",
		creditsHint: "Whole number, 1 to 1,000,000,000 credits",
		expires: "Expires at",
		expiresHint: "Leave empty for no expiry",
		grant: "Grant credits",
		invalid: "Check the input: pick a subject, and credits as a whole number from 1 to 1,000,000,000",
		confirmTitle: "Confirm credit grant",
		confirmBody: "Grant {credits} credits to the {type} \"{who}\"? A grant cannot be taken back.",
		done: "Granted {credits} credits",
	},
});

export function GrantPanel() {
	const { api } = useTeam();
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const orgs = useAdminOrgs();
	const users = useAsync(() => api.listUsers().catch(() => []), [api]);
	const act = useAction();
	const [type, setType] = useState<BillingSubjectType>("user");
	const [subject, setSubject] = useState("");
	const [credits, setCredits] = useState("");
	const [expires, setExpires] = useState("");
	const [formError, setFormError] = useState<string | undefined>(undefined);
	const [note, setNote] = useState<string | undefined>(undefined);
	const [confirm, setConfirm] = useState<{ id: string; who: string; credits: number } | undefined>(undefined);

	const resolve = (): { id: string; who: string } | undefined => {
		const v = subject.trim();
		if (!v) return undefined;
		if (type === "org") return { id: v, who: (orgs.data ?? []).find((o) => o.id === v)?.name ?? v };
		const byEmail = (users.data ?? []).find((u) => u.email.toLowerCase() === v.toLowerCase());
		return { id: byEmail?.id ?? v, who: byEmail?.email ?? v };
	};

	const submit = (e: FormEvent) => {
		e.preventDefault();
		setNote(undefined);
		const target = resolve();
		const n = parseCreditsInput(credits);
		if (!target || n === undefined) return setFormError(t("invalid"));
		setFormError(undefined);
		act.clearError();
		setConfirm({ ...target, credits: n });
	};

	const grant = async () => {
		if (!confirm) return;
		const r = await act.run(() => api.grantCredits({ subjectType: type, subjectId: confirm.id, credits: confirm.credits, expiresAt: localInputToIso(expires) }));
		if (r) {
			setNote(t("done", { credits: formatCredits(confirm.credits, lang) }));
			setConfirm(undefined);
			setCredits("");
		}
	};

	return (
		<div className="space-y-4">
			<p className="max-w-3xl text-sm text-ink-400">{t("intro")}</p>
			<Card>
				<form onSubmit={submit} className="space-y-3">
					<div className="grid gap-3 @2xl:grid-cols-4">
						<Field label={t("subjectType")}>
							<Select
								value={type}
								onChange={(e) => {
									setType(e.target.value as BillingSubjectType);
									setSubject("");
								}}
							>
								<option value="user">{t("user")}</option>
								<option value="org">{t("org")}</option>
							</Select>
						</Field>
						{type === "org" ? (
							<Field label={t("subjectOrg")}>
								<Select value={subject} onChange={(e) => setSubject(e.target.value)} required>
									<option value="">{t("pickOrg")}</option>
									{(orgs.data ?? []).map((o) => (
										<option key={o.id} value={o.id}>
											{o.name}
										</option>
									))}
								</Select>
							</Field>
						) : (
							<Field label={t("subjectUser")}>
								<Input value={subject} onChange={(e) => setSubject(e.target.value)} list="team-grant-users" required autoComplete="off" />
								<datalist id="team-grant-users">
									{(users.data ?? []).map((u) => (
										<option key={u.id} value={u.email}>
											{u.displayName}
										</option>
									))}
								</datalist>
							</Field>
						)}
						<Field label={t("credits")} hint={t("creditsHint")}>
							<Input inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value)} required />
						</Field>
						<Field label={t("expires")} hint={t("expiresHint")}>
							<Input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
						</Field>
					</div>
					{formError && <Notice kind="error">{formError}</Notice>}
					{note && <Notice kind="ok">{note}</Notice>}
					<Button type="submit" variant="primary">
						{t("grant")}
					</Button>
				</form>
			</Card>
			{confirm && (
				<ConfirmDialog
					title={t("confirmTitle")}
					body={<p>{t("confirmBody", { type: type === "org" ? t("org") : t("user"), who: confirm.who, credits: formatCredits(confirm.credits, lang) })}</p>}
					confirmLabel={t("grant")}
					busy={act.busy}
					error={act.error}
					onConfirm={() => void grant()}
					onClose={() => setConfirm(undefined)}
				/>
			)}
		</div>
	);
}
