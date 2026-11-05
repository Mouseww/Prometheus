import type { HubConfig } from "../config.ts";
import { toIso } from "../db/db.ts";
import { conflict, forbidden } from "../errors.ts";
import { LOG_PREFIX } from "../log.ts";
import { type Actor, can } from "../permissions.ts";
import type { ServiceRegistry } from "../deps.ts";
import type { AdminUsersService } from "./admin-users.ts";
import type { AuditService } from "./audit.ts";
import type { PublicUser, ServiceDeps } from "./common.ts";
import type { CreateOrgInput, OrgSummary, OrgsService } from "./orgs.ts";
import type { SettingsService } from "./settings.ts";

export interface AdminOrgView {
	id: string;
	name: string;
	slug: string;
	status: "active" | "disabled";
	memberCount: number;
	teamCount: number;
	createdAt: string;
}

/** Whatever the runtime manager registers; looked up lazily because block 3 may be absent. */
interface TenantStopper {
	stop?: (userId: string, reason?: string) => Promise<void>;
}

export interface OrgsPublicService {
	/** Operators create for anyone; in public mode any active, verified user may create when the platform allows it. */
	create(actor: Actor, input: CreateOrgInput): Promise<OrgSummary>;
	/** Operator: every organization with member and team counts. */
	listAll(actor: Actor): Promise<AdminOrgView[]>;
	/** Operator: disable the account, revoke refresh tokens and stop the tenant runtime when there is one. */
	ban(actor: Actor, userId: string): Promise<PublicUser>;
}

export function createOrgsPublicService(
	deps: ServiceDeps,
	o: { config: HubConfig; orgs: OrgsService; settings: SettingsService; audit: AuditService; adminUsers: AdminUsersService; registry: ServiceRegistry },
): OrgsPublicService {
	return {
		async create(actor, input) {
			if (can(actor, "org.create")) return o.orgs.create(actor, input);
			if (o.config.mode !== "public") throw forbidden();
			if (input.ownerUserId && input.ownerUserId !== actor.userId) throw forbidden();
			if (!(await o.settings.allowSelfCreateOrg())) throw forbidden("运营方已关闭自助创建企业", "selfCreateOrgDisabled");
			const rows = await deps.db.query<{ status: string; email_verified_at: unknown }>("SELECT status, email_verified_at FROM users WHERE id = $1", [actor.userId]);
			const me = rows[0];
			if (!me || me.status !== "active") throw conflict("账号未启用", "userNotActive");
			if (me.email_verified_at === null) throw forbidden("请先验证邮箱后再创建企业", "emailNotVerified");
			return o.orgs.create(actor, { name: input.name, ...(input.slug ? { slug: input.slug } : {}) }, { selfService: true });
		},

		async listAll(actor) {
			if (!can(actor, "platform.manage")) throw forbidden();
			const rows = await deps.db.tx({ system: true }, (q) =>
				q.query<{ id: string; name: string; slug: string; status: "active" | "disabled"; created_at: Date | string; members: string | number; teams: string | number }>(
					`SELECT o.id, o.name, o.slug, o.status, o.created_at,
					   (SELECT count(*) FROM org_members m WHERE m.org_id = o.id AND m.status = 'active') AS members,
					   (SELECT count(*) FROM teams t WHERE t.org_id = o.id) AS teams
					 FROM organizations o ORDER BY o.created_at, o.id`,
				),
			);
			return rows.map((r) => ({
				id: r.id,
				name: r.name,
				slug: r.slug,
				status: r.status,
				memberCount: Number(r.members),
				teamCount: Number(r.teams),
				createdAt: toIso(r.created_at) as string,
			}));
		},

		async ban(actor, userId) {
			if (!can(actor, "platform.manage")) throw forbidden();
			const user = await o.adminUsers.disable(actor, userId);
			await deps.db.tx({ system: true }, (q) => o.audit.write(q, { actorId: actor.userId, action: "user.ban", targetType: "user", targetId: userId }));
			// Block 3 registers `runtime` as `{ manager, nodes, proxy }`; an explicit `tenants` service wins.
			const runtime = o.registry.get<TenantStopper & { manager?: TenantStopper }>("runtime");
			const stopper = o.registry.get<TenantStopper>("tenants") ?? runtime?.manager ?? runtime;
			if (typeof stopper?.stop === "function") {
				try {
					await stopper.stop(userId, "banned");
				} catch (err) {
					deps.log.warn(`${LOG_PREFIX} 封禁用户 ${userId} 时停止租户实例失败: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			return user;
		},
	};
}
