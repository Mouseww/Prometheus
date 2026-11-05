import { hashPassword } from "../crypto.ts";
import type { Queryable } from "../db/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import type { Actor, OrgRole } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { AccountsService } from "./accounts.ts";
import type { AuditService } from "./audit.ts";
import { type PublicUser, type ServiceDeps, scopeOf, toPublicUser, USER_COLUMNS, type UserRow } from "./common.ts";
import { normalizeEmail } from "./common.ts";
import type { SettingsService } from "./settings.ts";

export interface AdminUserView extends PublicUser {
	/** Memberships in the organizations this admin manages. */
	memberships: { orgId: string; role: OrgRole; status: "active" | "pending" }[];
}

export interface ListUsersQuery {
	status?: "pending" | "active" | "disabled";
	q?: string;
	limit?: number;
	offset?: number;
}

export interface AdminUsersService {
	list(actor: Actor, query: ListUsersQuery): Promise<AdminUserView[]>;
	approve(actor: Actor, userId: string): Promise<PublicUser>;
	disable(actor: Actor, userId: string): Promise<PublicUser>;
	enable(actor: Actor, userId: string): Promise<PublicUser>;
	create(actor: Actor, input: { email: string; displayName: string; password: string; orgId?: string }): Promise<PublicUser>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const managedOrgIds = (actor: Actor): string[] => Object.keys(actor.orgRoles).filter((id) => can(actor, "org.users.manage", { orgId: id }));

export function createAdminUsersService(deps: ServiceDeps, audit: AuditService, accounts: AccountsService, settings: SettingsService): AdminUsersService {
	/**
	 * Which organizations let this actor act on the target user. Operators act everywhere;
	 * org admins only through shared organizations, and otherwise the user does not exist for them.
	 */
	const authority = async (q: Queryable, actor: Actor, userId: string): Promise<{ user: UserRow; orgIds: string[] }> => {
		const users = await q.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
		const user = users[0];
		if (!user) throw notFound("用户不存在");
		const memberships = await q.query<{ org_id: string }>("SELECT org_id FROM org_members WHERE user_id = $1", [userId]);
		const shared = memberships.map((m) => m.org_id).filter((id) => can(actor, "org.users.manage", { orgId: id }));
		if (!actor.operator && shared.length === 0) throw notFound("用户不存在");
		return { user, orgIds: actor.operator ? memberships.map((m) => m.org_id) : shared };
	};

	const setStatus = async (actor: Actor, userId: string, action: "approve" | "disable" | "enable"): Promise<PublicUser> => {
		return deps.db.tx(scopeOf(actor), async (q) => {
			const { user, orgIds } = await authority(q, actor, userId);
			if (action !== "approve" && user.id === actor.userId) throw badRequest("不能对自己执行此操作", "cannotActOnSelf");
			if (user.platform_role === "operator" && !actor.operator) throw forbidden("只有平台管理员可以操作平台管理员账号");
			let next: UserRow["status"];
			if (action === "approve") {
				if (user.status !== "pending") throw conflict("该账号不在待审批状态", "notPending");
				next = "active";
				if (orgIds.length > 0) await q.query("UPDATE org_members SET status = 'active' WHERE user_id = $1 AND status = 'pending' AND org_id = ANY($2::text[])", [userId, orgIds]);
			} else if (action === "disable") {
				if (user.status === "disabled") return toPublicUser(user);
				next = "disabled";
				await q.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
			} else {
				if (user.status !== "disabled") throw conflict("该账号未被禁用", "notDisabled");
				next = "active";
			}
			const updated = await q.query<UserRow>(`UPDATE users SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${USER_COLUMNS}`, [userId, next]);
			const detail = { from: user.status, to: next };
			if (orgIds.length === 0) await audit.write(q, { actorId: actor.userId, action: `user.${action}`, targetType: "user", targetId: userId, detail });
			for (const orgId of orgIds) await audit.write(q, { actorId: actor.userId, orgId, action: `user.${action}`, targetType: "user", targetId: userId, detail });
			return toPublicUser(updated[0] as UserRow);
		});
	};

	return {
		async list(actor, query) {
			const orgIds = actor.operator ? undefined : managedOrgIds(actor);
			if (orgIds && orgIds.length === 0) throw forbidden();
			const where: string[] = [];
			const params: unknown[] = [];
			const add = (sql: string, v: unknown): void => {
				params.push(v);
				where.push(sql.replace("?", `$${params.length}`));
			};
			if (orgIds) add("u.id IN (SELECT user_id FROM org_members WHERE org_id = ANY(?::text[]))", orgIds);
			if (query.status) add("u.status = ?", query.status);
			if (query.q) {
				params.push(`%${query.q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
				where.push(`(u.email LIKE $${params.length} OR lower(u.display_name) LIKE $${params.length})`);
			}
			const sqlWhere = where.join(" AND ");
			const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
			params.push(limit, Math.max(query.offset ?? 0, 0));
			const sql = `SELECT ${USER_COLUMNS} FROM users u ${sqlWhere ? `WHERE ${sqlWhere}` : ""} ORDER BY u.created_at, u.id LIMIT $${params.length - 1} OFFSET $${params.length}`;
			return deps.db.tx(scopeOf(actor), async (q) => {
				const rows = await q.query<UserRow>(sql, params);
				if (rows.length === 0) return [];
				const memberships = await q.query<{ user_id: string; org_id: string; role: OrgRole; status: "active" | "pending" }>(
					"SELECT user_id, org_id, role, status FROM org_members WHERE user_id = ANY($1::text[])",
					[rows.map((r) => r.id)],
				);
				return rows.map((r) => ({
					...toPublicUser(r),
					memberships: memberships
						.filter((m) => m.user_id === r.id && (orgIds === undefined || orgIds.includes(m.org_id)))
						.map((m) => ({ orgId: m.org_id, role: m.role, status: m.status })),
				}));
			});
		},

		approve: (actor, userId) => setStatus(actor, userId, "approve"),
		disable: (actor, userId) => setStatus(actor, userId, "disable"),
		enable: (actor, userId) => setStatus(actor, userId, "enable"),

		async create(actor, input) {
			let orgId = input.orgId;
			if (!orgId) {
				const managed = actor.operator ? [await settings.defaultOrgId()].filter((x): x is string => x !== undefined) : managedOrgIds(actor);
				if (managed.length !== 1) throw badRequest("请指定 orgId", "orgRequired");
				orgId = managed[0] as string;
			}
			if (!can(actor, "org.users.manage", { orgId })) throw forbidden();
			const email = normalizeEmail(input.email);
			const passwordHash = await hashPassword(input.password);
			return deps.db.tx(scopeOf(actor), async (q) => {
				const org = await q.query("SELECT 1 FROM organizations WHERE id = $1", [orgId]);
				if (org.length === 0) throw notFound("企业不存在");
				const user = await accounts.insertUser(q, { email, displayName: input.displayName, passwordHash, status: "active" });
				await q.query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1,$2,'member','active')", [orgId, user.id]);
				await audit.write(q, { actorId: actor.userId, orgId, action: "user.create", targetType: "user", targetId: user.id, detail: { email } });
				return toPublicUser(user);
			});
		},
	};
}
