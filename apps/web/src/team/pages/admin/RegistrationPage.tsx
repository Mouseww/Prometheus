import { type FormEvent, useState } from "react";
import { Button, Field, PageHeader, Select, Textarea } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Body, Card, Notice, useAction, useAsync } from "../../kit.tsx";
import type { RegistrationPolicy } from "../../types.ts";
import { Checkbox, useAdminOrgs } from "./shared.tsx";

const M = defineMessages({
	zh: {
		title: "注册策略",
		subtitle: "控制谁可以注册，以及是否需要审批",
		platform: "平台策略",
		org: "企业策略",
		pickOrg: "选择企业",
		allowOpen: "允许开放注册",
		domains: "允许的邮箱域名（每行一个，留空表示不限制）",
		requireApproval: "新账号需要管理员审批",
		allowInvite: "允许通过邀请链接注册",
		closed: "关闭注册（仅管理员创建账号）",
		noOrgs: "你没有可管理的企业",
	},
	en: {
		title: "Registration policy",
		subtitle: "Who may sign up and whether approval is needed",
		platform: "Platform policy",
		org: "Organization policy",
		pickOrg: "Organization",
		allowOpen: "Allow open registration",
		domains: "Allowed email domains (one per line, empty for any)",
		requireApproval: "New accounts need administrator approval",
		allowInvite: "Allow registration through invitation links",
		closed: "Registration closed (administrators create accounts)",
		noOrgs: "You manage no organizations",
	},
});

const parseDomains = (text: string): string[] =>
	[...new Set(text.split(/[\s,;]+/).map((d) => d.trim().replace(/^@/, "")).filter(Boolean))];

function PolicyForm({ initial, onSave }: { initial: RegistrationPolicy; onSave: (p: RegistrationPolicy) => Promise<RegistrationPolicy> }) {
	const t = useT(M);
	const c = useCommonT();
	const [p, setP] = useState(initial);
	const [domains, setDomains] = useState(initial.allowedDomains.join("\n"));
	const [saved, setSaved] = useState(false);
	const { busy, error, run } = useAction();
	const patch = (next: Partial<RegistrationPolicy>) => {
		setSaved(false);
		setP((cur) => ({ ...cur, ...next }));
	};
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const next = await run(() => onSave({ ...p, allowedDomains: parseDomains(domains) }));
		if (next) {
			setP(next);
			setDomains(next.allowedDomains.join("\n"));
			setSaved(true);
		}
	};
	return (
		<form onSubmit={submit} className="space-y-3">
			<Checkbox label={t("allowOpen")} checked={p.allowOpen} onChange={(v) => patch({ allowOpen: v })} />
			<Checkbox label={t("requireApproval")} checked={p.requireApproval} onChange={(v) => patch({ requireApproval: v })} />
			<Checkbox label={t("allowInvite")} checked={p.allowInvite} onChange={(v) => patch({ allowInvite: v })} />
			<Checkbox label={t("closed")} checked={p.closed} onChange={(v) => patch({ closed: v })} />
			<Field label={t("domains")}>
				<Textarea
					value={domains}
					rows={3}
					onChange={(e) => {
						setSaved(false);
						setDomains(e.target.value);
					}}
					className="font-mono"
				/>
			</Field>
			<div className="flex items-center gap-3">
				<Button type="submit" variant="primary" disabled={busy}>
					{c("save")}
				</Button>
				{saved && <Notice kind="ok">{c("saved")}</Notice>}
				{error && <Notice kind="error">{error}</Notice>}
			</div>
		</form>
	);
}

function PlatformPolicy() {
	const { api } = useTeam();
	const t = useT(M);
	const policy = useAsync(() => api.getPlatformRegistration(), [api]);
	return (
		<Card title={t("platform")}>
			<AsyncView state={policy}>{(p) => <PolicyForm initial={p} onSave={(next) => api.putPlatformRegistration(next)} />}</AsyncView>
		</Card>
	);
}

function OrgPolicy() {
	const { api } = useTeam();
	const t = useT(M);
	const orgs = useAdminOrgs();
	const [picked, setPicked] = useState("");
	const orgId = picked || orgs.data?.[0]?.id || "";
	const policy = useAsync(() => (orgId ? api.getOrgRegistration(orgId) : Promise.resolve(undefined)), [api, orgId]);
	return (
		<Card title={t("org")}>
			<AsyncView state={orgs}>
				{(list) =>
					list.length === 0 ? (
						<p className="text-sm text-ink-400">{t("noOrgs")}</p>
					) : (
						<div className="space-y-4">
							<Field label={t("pickOrg")}>
								<Select value={orgId} onChange={(e) => setPicked(e.target.value)} className="max-w-xs">
									{list.map((o) => (
										<option key={o.id} value={o.id}>
											{o.name}
										</option>
									))}
								</Select>
							</Field>
							<AsyncView state={policy}>{(p) => (p ? <PolicyForm key={orgId} initial={p} onSave={(next) => api.putOrgRegistration(orgId, next)} /> : null)}</AsyncView>
						</div>
					)
				}
			</AsyncView>
		</Card>
	);
}

export function RegistrationPage() {
	const { me } = useTeam();
	const t = useT(M);
	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body className="space-y-4">
				{isOperator(me) && <PlatformPolicy />}
				<OrgPolicy />
			</Body>
		</>
	);
}
