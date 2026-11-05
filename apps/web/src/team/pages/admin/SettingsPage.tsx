import { useState } from "react";
import { PageHeader } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Body, Card, Notice, useAction, useAsync } from "../../kit.tsx";
import { isPublicMode } from "../../logic/publicMode.ts";
import type { PlatformSettings } from "../../types.ts";
import { MailWarning } from "./MailWarning.tsx";
import { Checkbox } from "./shared.tsx";

const M = defineMessages({
	zh: {
		title: "平台设置",
		subtitle: "只有运营者可以修改",
		personal: "允许用户创建个人团队",
		personalHint: "关闭后，只有企业管理员可以建团队，团队归属于企业。",
		operatorOnly: "只有运营者可以查看和修改平台设置。",
		selfOrg: "允许用户自助创建企业",
		selfOrgHint: "开启后，任何已验证邮箱的用户都可以创建企业并成为所有者。关闭后只有运营者能创建。",
		selfOrgPrivate: "只在公开服务模式（HUB_MODE=public）下生效；当前 Hub 是私有模式，运营者之外的人始终不能自助创建企业。",
	},
	en: {
		title: "Platform settings",
		subtitle: "Only the operator can change these",
		personal: "Allow users to create personal teams",
		personalHint: "When off, only organization admins create teams and every team belongs to an organization.",
		operatorOnly: "Only the operator can view and change platform settings.",
		selfOrg: "Allow users to create organizations themselves",
		selfOrgHint: "When on, any user with a verified email can create an organization and becomes its owner. When off, only the operator can.",
		selfOrgPrivate: "Only applies in public service mode (HUB_MODE=public). This Hub is in private mode, so only the operator can ever create organizations.",
	},
});

function Form({ initial }: { initial: PlatformSettings }) {
	const { api, meta } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const [value, setValue] = useState(initial);
	const [saved, setSaved] = useState(false);
	const { busy, error, run } = useAction();
	// Each switch sends only its own field, so one save never overwrites the other setting.
	const change = async (patch: Partial<PlatformSettings>) => {
		const before = value;
		setValue({ ...value, ...patch });
		setSaved(false);
		const res = await run(() => api.putSettings(patch));
		if (res) {
			setValue(res);
			setSaved(true);
		} else setValue(before);
	};
	return (
		<div className="space-y-3">
			<Checkbox label={t("personal")} checked={value.allowPersonalTeams} disabled={busy} onChange={(v) => void change({ allowPersonalTeams: v })} />
			<p className="text-xs text-ink-400">{t("personalHint")}</p>
			<Checkbox label={t("selfOrg")} checked={value.allowSelfCreateOrg === true}disabled={busy} onChange={(v) => void change({ allowSelfCreateOrg: v })} />
			<p className="text-xs text-ink-400">{isPublicMode(meta) ? t("selfOrgHint") : t("selfOrgPrivate")}</p>
			{saved && <Notice kind="ok">{c("saved")}</Notice>}
			{error && <Notice kind="error">{error}</Notice>}
		</div>
	);
}

export function SettingsPage() {
	const { api, me } = useTeam();
	const t = useT(M);
	const operator = isOperator(me);
	const settings = useAsync(() => (operator ? api.getSettings() : Promise.resolve({ allowPersonalTeams: false, allowSelfCreateOrg: false })), [api, operator]);
	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body>
				<MailWarning />
				<Card>
					{operator ? <AsyncView state={settings}>{(s) => <Form initial={s} />}</AsyncView> : <Notice kind="error">{t("operatorOnly")}</Notice>}
				</Card>
			</Body>
		</>
	);
}
