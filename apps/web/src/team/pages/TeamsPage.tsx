import { Plus, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, Button, Empty, Field, Input, PageHeader, Select } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { isOperator, managedOrgs, useTeam } from "../context.tsx";
import { roleLabel, useCommonT } from "../i18n.ts";
import { AsyncView, Body, Card, Notice, useAction, useAsync } from "../kit.tsx";
import type { OrgSummary, TeamView } from "../types.ts";

const M = defineMessages({
	zh: {
		title: "团队",
		subtitle: "你所在的团队和工作区",
		newTeam: "新建团队",
		name: "团队名称",
		owner: "归属",
		personal: "个人团队",
		empty: "你还没有加入任何团队",
		emptyHint: "新建一个团队，或让管理员邀请你加入。",
		personalTag: "个人",
		open: "打开团队 {name}",
	},
	en: {
		title: "Teams",
		subtitle: "The teams and workspaces you belong to",
		newTeam: "New team",
		name: "Team name",
		owner: "Belongs to",
		personal: "Personal team",
		empty: "You are not in any team yet",
		emptyHint: "Create a team, or ask an administrator to invite you.",
		personalTag: "Personal",
		open: "Open team {name}",
	},
});

function CreateTeamForm({ orgs, onCreated }: { orgs: OrgSummary[]; onCreated: (team: TeamView) => void }) {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const [name, setName] = useState("");
	const [orgId, setOrgId] = useState(orgs[0]?.id ?? "");
	const { busy, error, run } = useAction();

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const team = await run(() => api.createTeam({ name: name.trim(), orgId: orgId || null }));
		if (team) {
			setName("");
			onCreated(team);
		}
	};
	return (
		<form onSubmit={submit} className="grid gap-3 @xl:grid-cols-[1fr_14rem_auto] @xl:items-end">
			<Field label={t("name")}>
				<Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
			</Field>
			<Field label={t("owner")}>
				<Select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
					<option value="">{t("personal")}</option>
					{orgs.map((o) => (
						<option key={o.id} value={o.id}>
							{o.name}
						</option>
					))}
				</Select>
			</Field>
			<Button type="submit" variant="primary" disabled={busy || !name.trim()}>
				<Plus className="size-4" aria-hidden /> {c("create")}
			</Button>
			{error && (
				<div className="@xl:col-span-3">
					<Notice kind="error">{error}</Notice>
				</div>
			)}
		</form>
	);
}

export function TeamsPage() {
	const { api, me, navigate } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const teams = useAsync(() => api.listTeams(), [api]);
	const [creating, setCreating] = useState(false);
	// Teams in an organization are created by its owners/admins; the operator may use any organization.
	const orgs = useAsync(async () => (isOperator(me) ? await api.listOrgs() : managedOrgs(me).map((o) => ({ ...o, slug: "", status: "active" as const, createdAt: "" }))), [api, me]);
	const orgName = (id: string | null) => (id ? (me.orgs.find((o) => o.id === id)?.name ?? orgs.data?.find((o) => o.id === id)?.name ?? "") : t("personalTag"));

	return (
		<>
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<Button variant="outline" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
						<Plus className="size-4" aria-hidden /> {t("newTeam")}
					</Button>
				}
			/>
			<Body>
				{creating && (
					<Card className="mb-4">
						<CreateTeamForm
							orgs={orgs.data ?? []}
							onCreated={(team) => {
								setCreating(false);
								teams.reload();
								navigate({ page: "team", params: { teamId: team.id } });
							}}
						/>
					</Card>
				)}
				<AsyncView state={teams}>
					{(list) =>
						list.length === 0 ? (
							<Empty icon={<Users className="size-5" />} title={t("empty")}>
								{t("emptyHint")}
							</Empty>
						) : (
							<ul className="grid gap-3 @2xl:grid-cols-2">
								{list.map((team) => (
									<li key={team.id}>
										<button
											type="button"
											aria-label={t("open", { name: team.name })}
											onClick={() => navigate({ page: "team", params: { teamId: team.id } })}
											className="flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-900/60 px-4 py-3 text-left transition-colors hover:border-ember-500/50 hover:bg-ink-850 focus-visible:outline-2 focus-visible:outline-ember-400"
										>
											<span className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink-800 text-ember-400">
												<Users className="size-4" aria-hidden />
											</span>
											<span className="min-w-0 flex-1">
												<span className="block truncate font-medium">{team.name}</span>
												<span className="block truncate text-xs text-ink-400">{orgName(team.orgId)}</span>
											</span>
											<Badge tone={team.role === "admin" ? "ember" : team.role === "reviewer" ? "sky" : "muted"}>{roleLabel(c, team.role)}</Badge>
										</button>
									</li>
								))}
							</ul>
						)
					}
				</AsyncView>
			</Body>
		</>
	);
}
