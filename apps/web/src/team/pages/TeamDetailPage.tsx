import { FolderGit2, Link2, Plus, UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, Button, Empty, Field, Input, PageHeader, Select } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { usePrefs } from "../../lib/prefs.ts";
import { isTeamAdmin, useTeam } from "../context.tsx";
import { roleLabel, useCommonT } from "../i18n.ts";
import { AsyncView, Body, Card, ConfirmButton, ErrorBox, Notice, shortDate, Table, Tabs, Td, useAction, useAsync } from "../kit.tsx";
import { canAddDirectly, isIneligibleMember } from "../logic/members.ts";
import type { TeamRole, TeamView, WorkspaceView } from "../types.ts";
import { TeamInviteForm } from "./TeamInviteForm.tsx";
import { TransferCard } from "./TransferCard.tsx";

const M = defineMessages({
	zh: {
		members: "成员",
		workspaces: "工作区",
		tabs: "团队内容",
		addMember: "添加成员",
		inviteMember: "邀请成员",
		personalInviteOnly: "个人团队只能通过邀请链接添加成员。生成链接后发给对方，对方注册或登录后即可加入。",
		noEligible: "这个企业里没有该邮箱对应的可添加用户，请改为发送邀请。",
		sendInvitation: "改为发送邀请",
		email: "邮箱",
		role: "角色",
		add: "添加",
		user: "用户",
		noMembers: "没有成员",
		changeRole: "修改 {name} 的角色",
		removeMember: "移除 {name}",
		newWorkspace: "新建工作区",
		wsName: "工作区名称",
		importUrl: "导入仓库地址（可选）",
		importHint: "从已有 git 仓库导入初始内容",
		upstreamUrl: "上游仓库地址（可选，仅 HTTPS）",
		upstreamToken: "上游访问令牌（可选）",
		noWorkspaces: "还没有工作区",
		noWorkspacesHint: "团队管理员可以创建工作区。",
		created: "创建于 {date}",
		upstream: "有上游",
		back: "团队",
		teamNotFound: "找不到这个团队",
		backToTeams: "返回团队列表",
	},
	en: {
		members: "Members",
		workspaces: "Workspaces",
		tabs: "Team content",
		addMember: "Add member",
		inviteMember: "Invite a member",
		personalInviteOnly: "Personal teams add members by invitation only. Create a link and send it; the invitee joins after signing up or signing in.",
		noEligible: "No eligible user with that email in this organization. Send an invitation instead.",
		sendInvitation: "Send an invitation instead",
		email: "Email",
		role: "Role",
		add: "Add",
		user: "User",
		noMembers: "No members",
		changeRole: "Change role of {name}",
		removeMember: "Remove {name}",
		newWorkspace: "New workspace",
		wsName: "Workspace name",
		importUrl: "Import from repository URL (optional)",
		importHint: "Seed the workspace from an existing git repository",
		upstreamUrl: "Upstream repository URL (optional, HTTPS only)",
		upstreamToken: "Upstream access token (optional)",
		noWorkspaces: "No workspaces yet",
		noWorkspacesHint: "Team admins can create workspaces.",
		created: "Created {date}",
		upstream: "Upstream",
		back: "Teams",
		teamNotFound: "This team does not exist",
		backToTeams: "Back to teams",
	},
});

const TEAM_ROLES: readonly TeamRole[] = ["admin", "reviewer", "member"];

function RoleSelect({ value, onChange, label, disabled }: { value: TeamRole; onChange: (r: TeamRole) => void; label: string; disabled?: boolean }) {
	const c = useCommonT();
	return (
		<Select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as TeamRole)} className="w-36 py-1">
			{TEAM_ROLES.map((r) => (
				<option key={r} value={r}>
					{roleLabel(c, r)}
				</option>
			))}
		</Select>
	);
}

function Members({ team }: { team: TeamView }) {
	const { api, me } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const admin = isTeamAdmin(team.role);
	const members = useAsync(() => api.listTeamMembers(team.id), [api, team.id]);
	const { busy, error, run } = useAction();
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<TeamRole>("member");
	const [ineligible, setIneligible] = useState(false);
	const [inviting, setInviting] = useState(false);
	const direct = canAddDirectly(team);

	const add = async (e: FormEvent) => {
		e.preventDefault();
		setIneligible(false);
		const added = await run(async () => {
			try {
				return await api.addTeamMember(team.id, { email: email.trim(), role });
			} catch (err) {
				// One uniform 404 for every ineligible user: say nothing about which case it is.
				if (isIneligibleMember(err)) {
					setIneligible(true);
					return undefined;
				}
				throw err;
			}
		});
		if (added) {
			setEmail("");
			members.reload();
		}
	};

	return (
		<div className="space-y-4">
			{admin && !direct && (
				<Card title={t("inviteMember")}>
					<p className="mb-3 text-sm text-ink-300">{t("personalInviteOnly")}</p>
					<TeamInviteForm team={team} />
				</Card>
			)}
			{admin && direct && (
				<Card title={t("addMember")}>
					<form onSubmit={add} className="grid gap-3 @xl:grid-cols-[1fr_12rem_auto] @xl:items-end">
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
							<UserPlus className="size-4" aria-hidden /> {t("add")}
						</Button>
					</form>
					{error && (
						<div className="mt-3">
							<Notice kind="error">{error}</Notice>
						</div>
					)}
					{ineligible && (
						<div className="mt-3 space-y-3">
							<p role="status" className="rounded-lg bg-ink-800/60 px-3 py-2 text-sm text-ink-200">
								{t("noEligible")}
							</p>
							{!inviting && (
								<Button variant="outline" onClick={() => setInviting(true)} aria-expanded={inviting}>
									<Link2 className="size-4" aria-hidden /> {t("sendInvitation")}
								</Button>
							)}
						</div>
					)}
					{inviting && (
						<div className="mt-3 border-t hairline pt-3">
							<TeamInviteForm team={team} initialEmail={email.trim()} initialRole={role} />
						</div>
					)}
				</Card>
			)}
			<AsyncView state={members}>
				{(list) =>
					list.length === 0 ? (
						<p className="py-8 text-center text-sm text-ink-400">{t("noMembers")}</p>
					) : (
						<Table label={t("members")} head={[t("user"), t("email"), t("role"), ""]}>
							{list.map((m) => (
								<tr key={m.userId}>
									<Td className="font-medium">{m.displayName}</Td>
									<Td className="text-ink-400">{m.email}</Td>
									<Td>
										{admin ? (
											<RoleSelect
												value={m.role}
												label={t("changeRole", { name: m.displayName })}
												disabled={busy}
												onChange={(r) => void run(() => api.setTeamMemberRole(team.id, m.userId, r)).then((ok) => ok && members.reload())}
											/>
										) : (
											<Badge>{roleLabel(c, m.role)}</Badge>
										)}
									</Td>
									<Td className="text-right">
										{admin && m.userId !== me.user.id && (
											<ConfirmButton label={c("remove")} disabled={busy} onConfirm={() => void run(async () => (await api.removeTeamMember(team.id, m.userId), true)).then((ok) => ok && members.reload())} />
										)}
									</Td>
								</tr>
							))}
						</Table>
					)
				}
			</AsyncView>
		</div>
	);
}

function CreateWorkspace({ teamId, onCreated }: { teamId: string; onCreated: (ws: WorkspaceView) => void }) {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const [name, setName] = useState("");
	const [importUrl, setImportUrl] = useState("");
	const [upstreamUrl, setUpstreamUrl] = useState("");
	const [upstreamToken, setUpstreamToken] = useState("");
	const { busy, error, run } = useAction();

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const ws = await run(() =>
			api.createWorkspace(teamId, {
				name: name.trim(),
				...(importUrl.trim() ? { importUrl: importUrl.trim() } : {}),
				...(upstreamUrl.trim() ? { upstreamUrl: upstreamUrl.trim() } : {}),
				...(upstreamToken.trim() ? { upstreamToken: upstreamToken.trim() } : {}),
			}),
		);
		if (ws) onCreated(ws);
	};
	return (
		<form onSubmit={submit} className="grid gap-3 @2xl:grid-cols-2">
			<Field label={t("wsName")}>
				<Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
			</Field>
			<Field label={t("importUrl")} hint={t("importHint")}>
				<Input type="url" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="https://" />
			</Field>
			<Field label={t("upstreamUrl")}>
				<Input type="url" value={upstreamUrl} onChange={(e) => setUpstreamUrl(e.target.value)} placeholder="https://" />
			</Field>
			<Field label={t("upstreamToken")}>
				<Input type="password" value={upstreamToken} onChange={(e) => setUpstreamToken(e.target.value)} autoComplete="off" />
			</Field>
			<div className="flex items-center gap-3 @2xl:col-span-2">
				<Button type="submit" variant="primary" disabled={busy || !name.trim()}>
					{c("create")}
				</Button>
				{error && <Notice kind="error">{error}</Notice>}
			</div>
		</form>
	);
}

function Workspaces({ team }: { team: TeamView }) {
	const { api, navigate } = useTeam();
	const t = useT(M);
	const lang = usePrefs((s) => s.lang);
	const list = useAsync(() => api.listWorkspaces(team.id), [api, team.id]);
	const [creating, setCreating] = useState(false);

	return (
		<div className="space-y-4">
			{isTeamAdmin(team.role) && (
				<div>
					<Button variant="outline" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
						<Plus className="size-4" aria-hidden /> {t("newWorkspace")}
					</Button>
					{creating && (
						<Card className="mt-3">
							<CreateWorkspace
								teamId={team.id}
								onCreated={(ws) => {
									setCreating(false);
									list.reload();
									navigate({ page: "workspace", params: { teamId: team.id, workspaceId: ws.id } });
								}}
							/>
						</Card>
					)}
				</div>
			)}
			<AsyncView state={list}>
				{(rows) =>
					rows.length === 0 ? (
						<Empty icon={<FolderGit2 className="size-5" />} title={t("noWorkspaces")}>
							{t("noWorkspacesHint")}
						</Empty>
					) : (
						<ul className="grid gap-3 @2xl:grid-cols-2">
							{rows.map((ws) => (
								<li key={ws.id}>
									<button
										type="button"
										onClick={() => navigate({ page: "workspace", params: { teamId: team.id, workspaceId: ws.id } })}
										className="flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-900/60 px-4 py-3 text-left transition-colors hover:border-ember-500/50 hover:bg-ink-850 focus-visible:outline-2 focus-visible:outline-ember-400"
									>
										<FolderGit2 className="size-5 shrink-0 text-ember-400" aria-hidden />
										<span className="min-w-0 flex-1">
											<span className="block truncate font-medium">{ws.name}</span>
											<span className="block truncate text-xs text-ink-400">{t("created", { date: shortDate(ws.createdAt, lang) })}</span>
										</span>
										{ws.upstreamUrl && <Badge tone={ws.upstreamStatus && ws.upstreamStatus !== "ok" ? "rose" : "moss"}>{t("upstream")}</Badge>}
									</button>
								</li>
							))}
						</ul>
					)
				}
			</AsyncView>
		</div>
	);
}

export function TeamDetailPage() {
	const { api, me, route, navigate } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const teamId = route.params?.teamId ?? "";
	const teams = useAsync(() => api.listTeams(), [api]);
	const [tab, setTab] = useState<"members" | "workspaces">("workspaces");
	const team = teams.data?.find((x) => x.id === teamId);

	return (
		<>
			<PageHeader
				title={team?.name ?? "..."}
				subtitle={team ? roleLabel(c, team.role) : undefined}
				actions={
					<Button variant="ghost" onClick={() => navigate({ page: "teams" })}>
						{t("back")}
					</Button>
				}
			/>
			<Body>
				<AsyncView state={teams}>
					{() =>
						team ? (
							<>
								{team.orgId === null && isTeamAdmin(team.role) && me.orgs.length > 0 && <TransferCard team={team} />}
								<Tabs
									label={t("tabs")}
									value={tab}
									onChange={setTab}
									tabs={[
										{ id: "workspaces", label: t("workspaces") },
										{ id: "members", label: t("members") },
									]}
								/>
								{tab === "members" ? <Members team={team} /> : <Workspaces team={team} />}
							</>
						) : (
							<div className="space-y-3">
								<ErrorBox message={t("teamNotFound")} />
								<div className="text-center">
									<Button variant="outline" onClick={() => navigate({ page: "teams" })}>
										{t("backToTeams")}
									</Button>
								</div>
							</div>
						)
					}
				</AsyncView>
			</Body>
		</>
	);
}
