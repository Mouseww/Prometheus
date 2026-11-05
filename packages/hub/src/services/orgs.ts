import { isUniqueViolation, toIso } from "../db/db.ts";
import { conflict, forbidden, notFound } from "../errors.ts";
import { ulid } from "../ids.ts";
import type { Actor, OrgRole } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { AuditService } from "./audit.ts";
import { type ServiceDeps, scopeOf, slugify } from "./common.ts";

export interface OrgSummary {
	id: string;
	name: string;
	slug: string;
	status: "active" | "disabled";
	/** The actor's own role, null for an operator who is not a member. */
	role: OrgRole | null;
	createdAt: string;
}

export interface OrgMemberView {
	userId: string;
	email: string;
	displayName: string;
	role: OrgRole;
	status: "active" | "pending";
}

export interface CreateOrgInput {
	name: string;
	slug?: string;
	ownerUserId?: string;
}

export interface OrgsService {
	list(actor: Actor): Promise<OrgSummary[]>;
	/** `selfService` skips the operator-only check; the caller (orgs-public) has already applied the self-create rules. */
	create(actor: Actor, input: CreateOrgInput, opts?: { selfService?: boolean }): Promise<OrgSummary>;
	listMembers(actor: Actor, orgId: string): Promise<OrgMemberView[]>;
	/** Changes the role of a member, or adds an active user to the organization. */
	setMember(actor: Actor, orgId: string, userId: string, role: OrgRole): Promise<OrgMemberView>;
	removeMember(actor: Actor, orgId: string, userId: string): Promise<void>;
}

interface OrgRow {
	id: string;
	name: string;
	slug: string;
	status: "active" | "disabled";
	created_at: Date | string;
}

const toSummary = (r: OrgRow, actor: Actor): OrgSummary => ({
	id: r.id,
	name: r.name,
	slug: r.slug,
	status: r.status,
	role: actor.orgRoles[r.id] ?? null,
	createdAt: toIso(r.created_at) as string,
});

export function createOrgsService(deps: ServiceDeps, audit: AuditService): OrgsService {
	const memberView = async (actor: Actor, orgId: string, userId: string): Promise<OrgMemberView> => {
		const rows = await deps.db.tx(scopeOf(actor), (q) =>
			q.query<{ user_id: string; email: string; display_name: string; role: OrgRole; status: "active" | "pending" }>(
				`SELECT m.user_id, u.email, u.display_name, m.role, m.status FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND m.user_id = $2`,
				[orgId, userId],
			),
		);
		const r = rows[0];
		if (!r) throw notFound("成员不存在");
		return { userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role, status: r.status };
	};

	return {
		async list(actor) {
			const rows = await deps.db.tx(scopeOf(actor), (q) => q.query<OrgRow>("SELECT id, name, slug, status, created_at FROM organizations ORDER BY created_at, id"));
			return rows.map((r) => toSummary(r, actor));
		},

		async create(actor, input, opts) {
			if (!opts?.selfService && !can(actor, "org.create")) throw forbidden();
			const ownerId = input.ownerUserId ?? actor.userId;
			const id = ulid(deps.now());
			const base = input.slug ?? slugify(input.name);
			try {
				// A self-service creator is not a member yet, so RLS would reject the new organization row.
				const row = await deps.db.tx(opts?.selfService ? { system: true } : scopeOf(actor), async (q) => {
					const owner = await q.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [ownerId]);
					if (owner.length === 0) throw notFound("所有者用户不存在");
					if (owner[0]?.status !== "active") throw conflict("所有者账号未启用", "userNotActive");
					// An explicit slug must be free; a derived one gets a numeric suffix.
					let slug = base;
					if (!input.slug) {
						for (let n = 2; (await q.query("SELECT 1 FROM organizations WHERE slug = $1", [slug])).length > 0; n++) slug = `${base}-${n}`;
					}
					const inserted = await q.query<OrgRow>("INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3) RETURNING id, name, slug, status, created_at", [id, input.name, slug]);
					await q.query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1,$2,'owner','active')", [id, ownerId]);
					await audit.write(q, { actorId: actor.userId, orgId: id, action: "org.create", targetType: "organization", targetId: id, detail: { name: input.name, ownerUserId: ownerId } });
					return inserted[0] as OrgRow;
				});
				return { ...toSummary(row, actor), role: ownerId === actor.userId ? "owner" : null };
			} catch (err) {
				if (isUniqueViolation(err)) throw conflict("企业标识已被占用", "slugTaken");
				throw err;
			}
		},

		async listMembers(actor, orgId) {
			if (!can(actor, "org.members.view", { orgId })) throw forbidden();
			const rows = await deps.db.tx(scopeOf(actor), (q) =>
				q.query<{ user_id: string; email: string; display_name: string; role: OrgRole; status: "active" | "pending" }>(
					`SELECT m.user_id, u.email, u.display_name, m.role, m.status FROM org_members m JOIN users u ON u.id = m.user_id
					 WHERE m.org_id = $1 ORDER BY m.created_at, m.user_id`,
					[orgId],
				),
			);
			return rows.map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role, status: r.status }));
		},

		async setMember(actor, orgId, userId, role) {
			if (!can(actor, "org.members.manage", { orgId })) throw forbidden();
			await deps.db.tx(scopeOf(actor), async (q) => {
				const org = await q.query("SELECT 1 FROM organizations WHERE id = $1", [orgId]);
				if (org.length === 0) throw notFound("企业不存在");
				const current = await q.query<{ role: OrgRole; status: string }>("SELECT role, status FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
				const existing = current[0];
				// Only an owner (or operator) may hand out or take away ownership.
				if ((role === "owner" || existing?.role === "owner") && !can(actor, "org.owner.manage", { orgId })) throw forbidden("只有企业所有者可以变更所有者角色");
				if (existing?.role === "owner" && role !== "owner") {
					const owners = await q.query("SELECT 1 FROM org_members WHERE org_id = $1 AND role = 'owner' AND status = 'active'", [orgId]);
					if (owners.length <= 1) throw conflict("企业至少需要一名所有者", "lastOwner");
				}
				if (existing) {
					await q.query("UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2", [orgId, userId, role]);
				} else {
					const user = await q.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [userId]);
					if (user.length === 0) throw notFound("用户不存在");
					if (user[0]?.status === "disabled") throw conflict("账号已被禁用", "userNotActive");
					await q.query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1,$2,$3,$4)", [orgId, userId, role, user[0]?.status === "active" ? "active" : "pending"]);
				}
				await audit.write(q, { actorId: actor.userId, orgId, action: "org.member.set", targetType: "user", targetId: userId, detail: { role, previousRole: existing?.role ?? null } });
			});
			return memberView(actor, orgId, userId);
		},

		async removeMember(actor, orgId, userId) {
			if (!can(actor, "org.members.manage", { orgId })) throw forbidden();
			await deps.db.tx(scopeOf(actor), async (q) => {
				const current = await q.query<{ role: OrgRole }>("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
				const existing = current[0];
				if (!existing) throw notFound("成员不存在");
				if (existing.role === "owner") {
					if (!can(actor, "org.owner.manage", { orgId })) throw forbidden("只有企业所有者可以移除所有者");
					const owners = await q.query("SELECT 1 FROM org_members WHERE org_id = $1 AND role = 'owner' AND status = 'active'", [orgId]);
					if (owners.length <= 1) throw conflict("企业至少需要一名所有者", "lastOwner");
				}
				await q.query("DELETE FROM team_members WHERE user_id = $2 AND org_id = $1", [orgId, userId]);
				await q.query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
				await audit.write(q, { actorId: actor.userId, orgId, action: "org.member.remove", targetType: "user", targetId: userId, detail: { role: existing.role } });
			});
		},
	};
}
