import { useState } from "react";
import { PageHeader } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Body, Card, Notice, useAction, useAsync } from "../../kit.tsx";
import { Checkbox } from "./shared.tsx";

const M = defineMessages({
	zh: {
		title: "平台设置",
		subtitle: "只有运营者可以修改",
		personal: "允许用户创建个人团队",
		personalHint: "关闭后，只有企业管理员可以建团队，团队归属于企业。",
		operatorOnly: "只有运营者可以查看和修改平台设置。",
	},
	en: {
		title: "Platform settings",
		subtitle: "Only the operator can change these",
		personal: "Allow users to create personal teams",
		personalHint: "When off, only organization admins create teams and every team belongs to an organization.",
		operatorOnly: "Only the operator can view and change platform settings.",
	},
});

function Form({ initial }: { initial: boolean }) {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const [value, setValue] = useState(initial);
	const [saved, setSaved] = useState(false);
	const { busy, error, run } = useAction();
	const change = async (next: boolean) => {
		setValue(next);
		setSaved(false);
		const res = await run(() => api.putSettings({ allowPersonalTeams: next }));
		if (res) {
			setValue(res.allowPersonalTeams);
			setSaved(true);
		} else setValue(!next);
	};
	return (
		<div className="space-y-3">
			<Checkbox label={t("personal")} checked={value} disabled={busy} onChange={(v) => void change(v)} />
			<p className="text-xs text-ink-400">{t("personalHint")}</p>
			{saved && <Notice kind="ok">{c("saved")}</Notice>}
			{error && <Notice kind="error">{error}</Notice>}
		</div>
	);
}

export function SettingsPage() {
	const { api, me } = useTeam();
	const t = useT(M);
	const operator = isOperator(me);
	const settings = useAsync(() => (operator ? api.getSettings() : Promise.resolve({ allowPersonalTeams: false })), [api, operator]);
	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body>
				<Card>
					{operator ? <AsyncView state={settings}>{(s) => <Form initial={s.allowPersonalTeams} />}</AsyncView> : <Notice kind="error">{t("operatorOnly")}</Notice>}
				</Card>
			</Body>
		</>
	);
}
