import { Building2, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, Button, Empty, Field, Input, PageHeader, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { roleLabel, statusLabel, useCommonT } from "../../i18n.ts";
import { AsyncView, Body, Card, ConfirmButton, Notice, Table, Td, useAction, useAsync } from "../../kit.tsx";
import type { OrgRole } from "../../types.ts";
import { useAdminOrgs } from "./shared.tsx";

const M = defineMessages({
	zh: {
		title: "企业与成员",
		subtitle: "企业列表和各企业的成员角色",
		newOrg: "新建企业",
		orgName: "企业名称",
		slug: "标识（小写字母、数字和连字符，可选）",
		orgs: "企业",
		members: "成员",
		pick: "选择企业",
		none: "没有企业",
		noneHint: "运营者可以创建企业。",
		name: "姓名",
		email: "邮箱",
		role: "角色",
		status: "状态",
		addMember: "添加成员",
		user: "用户",
		noCandidates: "没有可添加的用户",
		add: "添加",
		changeRole: "修改 {name} 的角色",
		noMembers: "没有成员",
	},
	en: {
		title: "Organizations and members",
		subtitle: "Organizations and the roles of their members",
		newOrg: "New organization",
		orgName: "Organization name",
		slug: "Slug (lowercase letters, digits, hyphens; optional)",
		orgs: "Organizations",
		members: "Members",
		pick: "Organization",
		none: "No organizations",
		noneHint: "The operator can create organizations.",
		name: "Name",
		email: "Email",
		role: "Role",
		status: "Status",
		addMember: "Add member",
		user: "User",
		noCandidates: "No users to add",
		add: "Add",
		changeRole: "Change role of {name}",
		noMembers: "No members",
	},
});

const ORG_ROLES: readonly OrgRole[] = ["owner", "admin", "member"];

function Members({ orgId }: { orgId: string }) {
	const { api, me } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const members = useAsync(() => api.listOrgMembers(orgId), [api, orgId]);
	const users = useAsync(() => api.listUsers({ status: "active", limit: 200 }), [api]);
	const [userId, setUserId] = useState("");
	const [role, setRole] = useState<OrgRole>("member");
	const { busy, error, run } = useAction();
	const taken = new Set((members.data ?? []).map((m) => m.userId));
	const candidates = (users.data ?? []).filter((u) => !taken.has(u.id));
	const chosen = candidates.some((u) => u.id === userId) ? userId : (candidates[0]?.id ?? "");

	const add = async (e: FormEvent) => {
		e.preventDefault();
		if (await run(() => api.setOrgMember(orgId, chosen, role))) members.reload();
	};

	return (
		<div className="space-y-4">
			<Card title={t("addMember")}>
				<form onSubmit={add} className="grid gap-3 @xl:grid-cols-[1fr_12rem_auto] @xl:items-end">
					<Field label={t("user")}>
						<Select value={chosen} onChange={(e) => setUserId(e.target.value)} disabled={candidates.length === 0}>
							{candidates.length === 0 && <option value="">{t("noCandidates")}</option>}
							{candidates.map((u) => (
								<option key={u.id} value={u.id}>
									{u.displayName} ({u.email})
								</option>
							))}
						</Select>
					</Field>
					<Field label={t("role")}>
						<Select value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
							{ORG_ROLES.map((r) => (
								<option key={r} value={r}>
									{roleLabel(c, r)}
								</option>
							))}
						</Select>
					</Field>
					<Button type="submit" variant="primary" disabled={busy || !chosen}>
						<Plus className="size-4" aria-hidden /> {t("add")}
					</Button>
				</form>
				{error && (
					<div className="mt-3">
						<Notice kind="error">{error}</Notice>
					</div>
				)}
			</Card>
			<AsyncView state={members}>
				{(rows) =>
					rows.length === 0 ? (
						<p className="py-6 text-center text-sm text-ink-400">{t("noMembers")}</p>
					) : (
						<Table label={t("members")} head={[t("name"), t("email"), t("role"), t("status"), ""]}>
							{rows.map((m) => (
								<tr key={m.userId}>
									<Td className="font-medium">{m.displayName}</Td>
									<Td className="text-ink-400">{m.email}</Td>
									<Td>
										<Select
											aria-label={t("changeRole", { name: m.displayName })}
											value={m.role}
											disabled={busy}
											className="w-36 py-1"
											onChange={(e) => void run(() => api.setOrgMember(orgId, m.userId, e.target.value as OrgRole)).then((ok) => ok && members.reload())}
										>
											{ORG_ROLES.map((r) => (
												<option key={r} value={r}>
													{roleLabel(c, r)}
												</option>
											))}
										</Select>
									</Td>
									<Td>
										<Badge tone={m.status === "active" ? "moss" : "ember"}>{statusLabel(c, m.status)}</Badge>
									</Td>
									<Td className="text-right">
										{m.userId !== me.user.id && (
											<ConfirmButton label={c("remove")} disabled={busy} onConfirm={() => void run(async () => (await api.removeOrgMember(orgId, m.userId), true)).then((ok) => ok && members.reload())} />
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

function CreateOrg({ onCreated }: { onCreated: (id: string) => void }) {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const { busy, error, run } = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const org = await run(() => api.createOrg({ name: name.trim(), ...(slug.trim() ? { slug: slug.trim() } : {}) }));
		if (org) {
			setName("");
			setSlug("");
			onCreated(org.id);
		}
	};
	return (
		<form onSubmit={submit} className="grid gap-3 @xl:grid-cols-[1fr_1fr_auto] @xl:items-end">
			<Field label={t("orgName")}>
				<Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
			</Field>
			<Field label={t("slug")}>
				<Input value={slug} onChange={(e) => setSlug(e.target.value)} pattern="[a-z0-9][a-z0-9\-]{0,39}" />
			</Field>
			<Button type="submit" variant="primary" disabled={busy || !name.trim()}>
				{c("create")}
			</Button>
			{error && (
				<div className="@xl:col-span-3">
					<Notice kind="error">{error}</Notice>
				</div>
			)}
		</form>
	);
}

export function OrgsPage() {
	const { me } = useTeam();
	const t = useT(M);
	const orgs = useAdminOrgs();
	const [picked, setPicked] = useState("");
	const [creating, setCreating] = useState(false);

	return (
		<>
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					isOperator(me) ? (
						<Button variant="outline" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
							<Plus className="size-4" aria-hidden /> {t("newOrg")}
						</Button>
					) : undefined
				}
			/>
			<Body>
				{creating && (
					<Card className="mb-4">
						<CreateOrg
							onCreated={(id) => {
								setCreating(false);
								setPicked(id);
								orgs.reload();
							}}
						/>
					</Card>
				)}
				<AsyncView state={orgs}>
					{(list) => {
						if (list.length === 0)
							return (
								<Empty icon={<Building2 className="size-5" />} title={t("none")}>
									{t("noneHint")}
								</Empty>
							);
						const orgId = list.some((o) => o.id === picked) ? picked : (list[0]?.id ?? "");
						return (
							<div className="space-y-4">
								<Field label={t("pick")}>
									<Select value={orgId} onChange={(e) => setPicked(e.target.value)} className="max-w-xs">
										{list.map((o) => (
											<option key={o.id} value={o.id}>
												{o.name}
											</option>
										))}
									</Select>
								</Field>
								<Members key={orgId} orgId={orgId} />
							</div>
						);
					}}
				</AsyncView>
			</Body>
		</>
	);
}
