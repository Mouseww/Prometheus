import { UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, Button, Empty, Field, Input, PageHeader, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { statusLabel, useCommonT } from "../../i18n.ts";
import { AsyncView, Body, Card, ConfirmButton, Notice, shortDate, Table, Td, useAction, useAsync } from "../../kit.tsx";
import { isPublicMode } from "../../logic/publicMode.ts";
import type { AdminUserView, UserStatus } from "../../types.ts";
import { MailWarning } from "./MailWarning.tsx";
import { useAdminOrgs } from "./shared.tsx";

const M = defineMessages({
	zh: {
		title: "用户",
		subtitle: "审批、停用和创建账号",
		filter: "状态",
		all: "全部",
		search: "搜索邮箱或姓名",
		name: "姓名",
		email: "邮箱",
		status: "状态",
		joined: "注册时间",
		approve: "批准",
		disable: "停用",
		enable: "启用",
		ban: "封禁",
		banConfirm: "确认封禁",
		unverified: "未验证邮箱",
		actionsFor: "对 {name} 的操作",
		none: "没有符合条件的用户",
		createUser: "创建用户",
		password: "初始密码（至少 8 位）",
		org: "加入企业",
		noOrg: "不加入企业",
		count: "共 {n} 位",
	},
	en: {
		title: "Users",
		subtitle: "Approve, disable and create accounts",
		filter: "Status",
		all: "All",
		search: "Search email or name",
		name: "Name",
		email: "Email",
		status: "Status",
		joined: "Joined",
		approve: "Approve",
		disable: "Disable",
		enable: "Enable",
		ban: "Ban",
		banConfirm: "Confirm ban",
		unverified: "Email unverified",
		actionsFor: "Actions for {name}",
		none: "No users match",
		createUser: "Create user",
		password: "Initial password (8+ characters)",
		org: "Add to organization",
		noOrg: "No organization",
		count: "{n} users",
	},
});

const STATUSES: readonly UserStatus[] = ["pending", "active", "disabled"];
const tone = (s: UserStatus) => (s === "active" ? "moss" : s === "pending" ? "ember" : "rose");

function CreateUser({ onCreated }: { onCreated: () => void }) {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const orgs = useAdminOrgs();
	const [email, setEmail] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [password, setPassword] = useState("");
	const [orgId, setOrgId] = useState("");
	const [done, setDone] = useState(false);
	const { busy, error, run } = useAction();
	const org = orgId || orgs.data?.[0]?.id || "";

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setDone(false);
		const user = await run(() => api.createUser({ email: email.trim(), displayName: displayName.trim(), password, ...(org ? { orgId: org } : {}) }));
		if (user) {
			setEmail("");
			setDisplayName("");
			setPassword("");
			setDone(true);
			onCreated();
		}
	};
	return (
		<form onSubmit={submit} className="grid gap-3 @2xl:grid-cols-2">
			<Field label={t("email")}>
				<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
			</Field>
			<Field label={t("name")}>
				<Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={100} />
			</Field>
			<Field label={t("password")}>
				<Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
			</Field>
			<Field label={t("org")}>
				<Select value={org} onChange={(e) => setOrgId(e.target.value)}>
					{(orgs.data ?? []).map((o) => (
						<option key={o.id} value={o.id}>
							{o.name}
						</option>
					))}
					<option value="">{t("noOrg")}</option>
				</Select>
			</Field>
			<div className="flex items-center gap-3 @2xl:col-span-2">
				<Button type="submit" variant="primary" disabled={busy}>
					<UserPlus className="size-4" aria-hidden /> {c("create")}
				</Button>
				{done && <Notice kind="ok">{c("saved")}</Notice>}
				{error && <Notice kind="error">{error}</Notice>}
			</div>
		</form>
	);
}

export function UsersPage() {
	const { api, me, meta } = useTeam();
	const operator = isOperator(me);
	const t = useT(M);
	const c = useCommonT();
	const lang = usePrefs((s) => s.lang);
	const [status, setStatus] = useState<UserStatus | "">("");
	const [q, setQ] = useState("");
	const [creating, setCreating] = useState(false);
	const users = useAsync(() => api.listUsers({ ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}), limit: 200 }), [api, status, q]);
	const { busy, error, run } = useAction();

	const change = (fn: (u: AdminUserView) => Promise<unknown>, u: AdminUserView) => void run(async () => (await fn(u), true)).then((ok) => ok && users.reload());

	return (
		<>
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<Button variant="outline" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
						<UserPlus className="size-4" aria-hidden /> {t("createUser")}
					</Button>
				}
			/>
			<Body>
				<MailWarning />
				{creating && (
					<Card className="mb-4">
						<CreateUser onCreated={users.reload} />
					</Card>
				)}
				<div className="mb-4 flex flex-wrap items-center gap-2">
					<Select aria-label={t("filter")} value={status} onChange={(e) => setStatus(e.target.value as UserStatus | "")} className="w-40 py-1.5">
						<option value="">{t("all")}</option>
						{STATUSES.map((s) => (
							<option key={s} value={s}>
								{statusLabel(c, s)}
							</option>
						))}
					</Select>
					<Input aria-label={t("search")} placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)} className="w-64 py-1.5" />
					{users.data && <span className="text-xs text-ink-500">{t("count", { n: users.data.length })}</span>}
				</div>
				{error && (
					<div className="mb-3">
						<Notice kind="error">{error}</Notice>
					</div>
				)}
				<AsyncView state={users}>
					{(rows) =>
						rows.length === 0 ? (
							<Empty icon={<UserPlus className="size-5" />} title={t("none")} />
						) : (
							<Table label={t("title")} head={[t("name"), t("email"), t("status"), t("joined"), ""]}>
								{rows.map((u) => (
									<tr key={u.id}>
										<Td className="font-medium">
											{u.displayName} {u.platformRole === "operator" && <Badge tone="ember">{c("operator")}</Badge>}
										</Td>
										<Td className="text-ink-400">{u.email}</Td>
										<Td>
											<Badge tone={tone(u.status)}>{statusLabel(c, u.status)}</Badge>
											{isPublicMode(meta) && u.emailVerifiedAt === null && (
												<span className="ml-1.5">
													<Badge tone="muted">{t("unverified")}</Badge>
												</span>
											)}
										</Td>
										<Td className="text-xs text-ink-400">{shortDate(u.createdAt, lang)}</Td>
										<Td className="text-right">
											<div role="group" aria-label={t("actionsFor", { name: u.displayName })} className="flex justify-end gap-1">
												{u.status === "pending" && (
													<Button variant="outline" disabled={busy} onClick={() => change((x) => api.approveUser(x.id), u)}>
														{t("approve")}
													</Button>
												)}
												{u.status === "active" && u.platformRole !== "operator" && (
													<Button variant="danger" disabled={busy} onClick={() => change((x) => api.disableUser(x.id), u)}>
														{t("disable")}
													</Button>
												)}
												{operator && u.platformRole !== "operator" && u.status !== "disabled" && (
													<ConfirmButton label={t("ban")} confirmLabel={t("banConfirm")} disabled={busy} onConfirm={() => change((x) => api.banUser(x.id), u)} />
												)}
												{u.status === "disabled" && (
													<Button variant="outline" disabled={busy} onClick={() => change((x) => api.enableUser(x.id), u)}>
														{t("enable")}
													</Button>
												)}
											</div>
										</Td>
									</tr>
								))}
							</Table>
						)
					}
				</AsyncView>
			</Body>
		</>
	);
}
