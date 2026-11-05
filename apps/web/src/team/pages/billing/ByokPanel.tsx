// Operator: the "bring your own model" switch, for the whole platform and as a per-organization override.
import { useState } from "react";
import { Badge, Button, Field, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useTeam } from "../../context.tsx";
import { AsyncView, Card, Notice, useAction, useAsync } from "../../kit.tsx";
import type { ByokSettingsView } from "../../types.ts";
import { useAdminOrgs } from "../admin/shared.tsx";
import { ConfirmDialog } from "./parts.tsx";

const M = defineMessages({
	zh: {
		intro: "控制用户能否接入自己的模型密钥。企业可以覆盖平台设置，企业设置为「禁用」优先于平台「允许」。",
		platformTitle: "平台开关",
		platformState: "平台当前：{state}",
		allow: "允许",
		deny: "禁用",
		turnOn: "允许自带模型",
		turnOff: "禁用自带模型",
		offTitle: "禁用自带模型",
		offBody: "禁用后，用户无法再添加或使用自己的模型网关（企业另有允许设置的除外）。确定吗？",
		orgTitle: "企业覆盖",
		pickOrg: "选择企业",
		noOrgs: "没有可管理的企业",
		follow: "跟随平台",
		orgState: "企业当前：{state}",
		save: "保存",
		saved: "已保存",
	},
	en: {
		intro: "Controls whether users may connect their own model keys. An organization can override the platform setting, and an organization's deny beats the platform's allow.",
		platformTitle: "Platform switch",
		platformState: "Platform now: {state}",
		allow: "Allowed",
		deny: "Denied",
		turnOn: "Allow bring your own models",
		turnOff: "Deny bring your own models",
		offTitle: "Deny bring your own models",
		offBody: "After this users cannot add or use their own model gateways (except in organizations that explicitly allow it). Continue?",
		orgTitle: "Organization override",
		pickOrg: "Pick an organization",
		noOrgs: "No organization to manage",
		follow: "Follow the platform",
		orgState: "Organization now: {state}",
		save: "Save",
		saved: "Saved",
	},
});

function PlatformCard() {
	const { api } = useTeam();
	const t = useT(M);
	const state = useAsync(() => api.getByokSettings(), [api]);
	const act = useAction();
	const [confirming, setConfirming] = useState(false);
	const [note, setNote] = useState<string | undefined>(undefined);

	const apply = async (allowed: boolean) => {
		const ok = await act.run(async () => {
			await api.setByokSettings({ scope: "platform", allowed });
			return true;
		});
		if (ok) {
			setConfirming(false);
			setNote(t("saved"));
			state.reload();
		}
	};

	return (
		<Card title={t("platformTitle")}>
			<AsyncView state={state}>
				{(s: ByokSettingsView) => (
					<div className="space-y-3">
						<p className="flex items-center gap-2 text-sm">
							{t("platformState", { state: "" })}
							<Badge tone={s.platform ? "moss" : "rose"}>{s.platform ? t("allow") : t("deny")}</Badge>
						</p>
						<div className="flex flex-wrap items-center gap-2">
							{s.platform ? (
								<Button
									variant="danger"
									onClick={() => {
										act.clearError();
										setConfirming(true);
									}}
								>
									{t("turnOff")}
								</Button>
							) : (
								<Button variant="primary" disabled={act.busy} onClick={() => void apply(true)}>
									{t("turnOn")}
								</Button>
							)}
							{note && <Notice kind="ok">{note}</Notice>}
							{!confirming && act.error && <Notice kind="error">{act.error}</Notice>}
						</div>
					</div>
				)}
			</AsyncView>
			{confirming && <ConfirmDialog title={t("offTitle")} body={<p>{t("offBody")}</p>} confirmLabel={t("turnOff")} busy={act.busy} error={act.error} onConfirm={() => void apply(false)} onClose={() => setConfirming(false)} />}
		</Card>
	);
}

type Choice = "follow" | "allow" | "deny";
const toChoice = (v: boolean | null): Choice => (v === null ? "follow" : v ? "allow" : "deny");
const fromChoice = (c: Choice): boolean | null => (c === "follow" ? null : c === "allow");

function OrgOverride({ orgId }: { orgId: string }) {
	const { api } = useTeam();
	const t = useT(M);
	const state = useAsync(() => api.getByokSettings(orgId), [api, orgId]);
	const act = useAction();
	const [choice, setChoice] = useState<Choice | undefined>(undefined);
	const [note, setNote] = useState<string | undefined>(undefined);

	return (
		<AsyncView state={state}>
			{(s: ByokSettingsView) => {
				const current = choice ?? toChoice(s.org);
				return (
					<div className="space-y-3">
						<div className="max-w-xs">
							<Field label={t("orgTitle")}>
								<Select
									value={current}
									onChange={(e) => {
										setChoice(e.target.value as Choice);
										setNote(undefined);
									}}
								>
									<option value="follow">{t("follow")}</option>
									<option value="allow">{t("allow")}</option>
									<option value="deny">{t("deny")}</option>
								</Select>
							</Field>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								variant="primary"
								disabled={act.busy || current === toChoice(s.org)}
								onClick={() =>
									void act
										.run(async () => {
											await api.setByokSettings({ scope: "org", orgId, allowed: fromChoice(current) });
											return true;
										})
										.then((ok) => {
											if (ok) {
												setNote(t("saved"));
												setChoice(undefined);
												state.reload();
											}
										})
								}
							>
								{t("save")}
							</Button>
							{note && <Notice kind="ok">{note}</Notice>}
							{act.error && <Notice kind="error">{act.error}</Notice>}
						</div>
					</div>
				);
			}}
		</AsyncView>
	);
}

function OrgCard() {
	const t = useT(M);
	const orgs = useAdminOrgs();
	const [orgId, setOrgId] = useState("");
	return (
		<Card title={t("orgTitle")}>
			<AsyncView state={orgs}>
				{(list) =>
					list.length === 0 ? (
						<p className="text-sm text-ink-500">{t("noOrgs")}</p>
					) : (
						<div className="space-y-4">
							<div className="max-w-xs">
								<Field label={t("pickOrg")}>
									<Select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
										<option value="">{t("pickOrg")}</option>
										{list.map((o) => (
											<option key={o.id} value={o.id}>
												{o.name}
											</option>
										))}
									</Select>
								</Field>
							</div>
							{orgId && <OrgOverride key={orgId} orgId={orgId} />}
						</div>
					)
				}
			</AsyncView>
		</Card>
	);
}

export function ByokPanel() {
	const t = useT(M);
	return (
		<div className="space-y-4">
			<p className="max-w-3xl text-sm text-ink-400">{t("intro")}</p>
			<PlatformCard />
			<OrgCard />
		</div>
	);
}
