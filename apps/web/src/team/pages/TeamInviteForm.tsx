import { Link2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, Field, Input, Select } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { useTeam } from "../context.tsx";
import { roleLabel, useCommonT } from "../i18n.ts";
import { Notice, useAction } from "../kit.tsx";
import type { CreatedInvitation, TeamRole, TeamView } from "../types.ts";
import { InvitationLinkBox } from "./admin/InvitationsPage.tsx";

const M = defineMessages({
	zh: {
		email: "被邀请人邮箱",
		role: "角色",
		create: "生成邀请链接",
	},
	en: {
		email: "Invitee email",
		role: "Role",
		create: "Create invitation link",
	},
});

const TEAM_ROLES: readonly TeamRole[] = ["member", "reviewer", "admin"];

interface TeamInviteFormProps {
	team: TeamView;
	initialEmail?: string;
	initialRole?: TeamRole;
}

/** Creates an invitation link into one team and shows it with a copy button. */
export function TeamInviteForm({ team, initialEmail = "", initialRole = "member" }: TeamInviteFormProps) {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const [email, setEmail] = useState(initialEmail);
	const [role, setRole] = useState<TeamRole>(initialRole);
	const [created, setCreated] = useState<CreatedInvitation | undefined>(undefined);
	const { busy, error, run } = useAction();

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setCreated(undefined);
		const r = await run(() => api.createInvitation({ scope: "team", scopeId: team.id, email: email.trim(), role }));
		if (r) {
			setCreated(r);
			setEmail("");
		}
	};

	return (
		<div className="space-y-3">
			<form onSubmit={submit} className="grid gap-3 @xl:grid-cols-[1fr_12rem_auto] @xl:items-end">
				<Field label={t("email")}>
					<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
				</Field>
				<Field label={t("role")}>
					<Select value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
						{TEAM_ROLES.map((r) => (
							<option key={r} value={r}>
								{roleLabel(c, r)}
							</option>
						))}
					</Select>
				</Field>
				<Button type="submit" variant="primary" disabled={busy || !email.trim()}>
					<Link2 className="size-4" aria-hidden /> {t("create")}
				</Button>
			</form>
			{error && <Notice kind="error">{error}</Notice>}
			{created && <InvitationLinkBox created={created} />}
		</div>
	);
}
