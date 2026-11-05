import { Check, Copy } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, Field, Input, PageHeader, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { useTeam } from "../../context.tsx";
import { roleLabel, useCommonT } from "../../i18n.ts";
import { Body, Card, Notice, shortDate, useAction, useAsync } from "../../kit.tsx";
import type { CreatedInvitation, InvitationScope } from "../../types.ts";
import { useAdminOrgs } from "./shared.tsx";

const M = defineMessages({
	zh: {
		title: "邀请",
		subtitle: "生成邀请链接，被邀请人注册后自动加入",
		scope: "邀请加入",
		org: "企业",
		team: "团队",
		target: "目标",
		email: "被邀请人邮箱",
		role: "角色",
		create: "生成邀请链接",
		result: "邀请链接",
		expires: "有效期至 {date}",
		forWho: "发给 {email}，加入 {name}（{role}）",
		none: "没有可邀请的目标",
	},
	en: {
		title: "Invitations",
		subtitle: "Create an invitation link. The invitee joins on sign-up.",
		scope: "Invite to",
		org: "Organization",
		team: "Team",
		target: "Target",
		email: "Invitee email",
		role: "Role",
		create: "Create invitation link",
		result: "Invitation link",
		expires: "Valid until {date}",
		forWho: "For {email}, joining {name} ({role})",
		none: "Nothing to invite to",
	},
});

const ORG_ROLES = ["member", "admin", "owner"] as const;
const TEAM_ROLES = ["member", "reviewer", "admin"] as const;

/** The Hub may return a path (`/invite/<token>`) or an absolute URL. */
export const absoluteLink = (link: string): string => (link.startsWith("/") ? `${location.origin}${link}` : link);

export function InvitationLinkBox({ created }: { created: CreatedInvitation }) {
	const t = useT(M);
	const c = useCommonT();
	const lang = usePrefs((s) => s.lang);
	const [copied, setCopied] = useState(false);
	const link = absoluteLink(created.link);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(link);
			setCopied(true);
		} catch {
			/* clipboard blocked: the field below is still selectable */
		}
	};
	return (
		<Card title={t("result")} className="border-moss-400/40">
			<div className="flex gap-2">
				<Input readOnly value={link} aria-label={t("result")} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
				<Button variant="outline" onClick={() => void copy()}>
					{copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />} {copied ? c("copied") : c("copy")}
				</Button>
			</div>
			<p className="mt-2 text-xs text-ink-400">
				{t("forWho", { email: created.invitation.email, name: created.invitation.scopeName, role: roleLabel(c, created.invitation.role) })} · {t("expires", { date: shortDate(created.invitation.expiresAt, lang) })}
			</p>
		</Card>
	);
}

export function InvitationsPage() {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const orgs = useAdminOrgs();
	const teams = useAsync(() => api.listTeams(), [api]);
	const [scope, setScope] = useState<InvitationScope>("org");
	const [target, setTarget] = useState("");
	const [email, setEmail] = useState("");
	const [role, setRole] = useState("member");
	const [created, setCreated] = useState<CreatedInvitation | undefined>(undefined);
	const { busy, error, run } = useAction();

	const options = scope === "org" ? (orgs.data ?? []).map((o) => ({ id: o.id, name: o.name })) : (teams.data ?? []).filter((x) => x.role === "admin").map((x) => ({ id: x.id, name: x.name }));
	const scopeId = options.some((o) => o.id === target) ? target : (options[0]?.id ?? "");
	const roles = scope === "org" ? ORG_ROLES : TEAM_ROLES;

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setCreated(undefined);
		const r = await run(() => api.createInvitation({ scope, scopeId, email: email.trim(), role }));
		if (r) {
			setCreated(r);
			setEmail("");
		}
	};

	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body className="space-y-4">
				<Card>
					<form onSubmit={submit} className="grid gap-3 @2xl:grid-cols-2">
						<Field label={t("scope")}>
							<Select
								value={scope}
								onChange={(e) => {
									setScope(e.target.value as InvitationScope);
									setRole("member");
									setTarget("");
								}}
							>
								<option value="org">{t("org")}</option>
								<option value="team">{t("team")}</option>
							</Select>
						</Field>
						<Field label={t("target")}>
							<Select value={scopeId} onChange={(e) => setTarget(e.target.value)} disabled={options.length === 0}>
								{options.length === 0 && <option value="">{t("none")}</option>}
								{options.map((o) => (
									<option key={o.id} value={o.id}>
										{o.name}
									</option>
								))}
							</Select>
						</Field>
						<Field label={t("email")}>
							<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
						</Field>
						<Field label={t("role")}>
							<Select value={role} onChange={(e) => setRole(e.target.value)}>
								{roles.map((r) => (
									<option key={r} value={r}>
										{roleLabel(c, r)}
									</option>
								))}
							</Select>
						</Field>
						<div className="flex items-center gap-3 @2xl:col-span-2">
							<Button type="submit" variant="primary" disabled={busy || !scopeId || !email.trim()}>
								{t("create")}
							</Button>
							{error && <Notice kind="error">{error}</Notice>}
						</div>
					</form>
				</Card>
				{created && <InvitationLinkBox created={created} />}
			</Body>
		</>
	);
}
