import type { Queryable } from "../db/db.ts";
import { toIso } from "../db/db.ts";
import { randomToken, sha256Hex } from "../crypto.ts";
import { badRequest, forbidden, notFound, tooManyRequests } from "../errors.ts";
import { ulid } from "../ids.ts";
import type { Actor, OrgRole, TeamRole } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { AuditService } from "./audit.ts";
import { normalizeEmail, type ServiceDeps, scopeOf } from "./common.ts";
import type { TeamsService } from "./teams.ts";

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationScope = "org" | "team";

export interface InvitationInput {
	scope: InvitationScope;
	scopeId: string;
	email: string;
	role: string;
}

export interface InvitationView {
	id: string;
	scope: InvitationScope;
	scopeId: string;
	scopeName: string;
	email: string;
	role: string;
	expiresAt: string;
}

export interface InvitationRow {
	id: string;
	scope: InvitationScope;
	scope_id: string;
	email: string;
	role: string;
	expires_at: Date | string;
}

export interface InvitationsService {
	/** `dailyLimit` caps how many invitations this actor may create per rolling 24 hours (429 beyond it). */
	create(actor: Actor, input: InvitationInput, dailyLimit?: number): Promise<{ link: string; token: string; invitation: InvitationView }>;
	/** Public lookup by token; 404 when unknown, expired or already used. */
	lookup(token: string): Promise<InvitationView>;
	/** Used by registration inside its transaction. Returns undefined when invalid. */
	find(q: Queryable, token: string): Promise<InvitationRow | undefined>;
	/** Adds the user to the invited organization/team and marks the invitation used. */
	apply(q: Queryable, invitation: InvitationRow, userId: string): Promise<{ orgId: string | null }>;
	/** A signed-in user redeems an invitation link for the current account (same checks as registration). */
	accept(actor: Actor, token: string): Promise<AcceptedInvitation>;
}

export interface AcceptedInvitation {
	scope: InvitationScope;
	scopeId: string;
	scopeName: string;
	role: string;
	orgId: string | null;
}

const ORG_ROLES: readonly string[] = ["admin", "member"];
const TEAM_ROLES: readonly string[] = ["admin", "reviewer", "member"];

/** Invitations one inviter may create per rolling 24 hours. Public mode is tight because an invite can name any address. */
export const INVITES_PER_DAY_PUBLIC = 20;
export const INVITES_PER_DAY_PRIVATE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The per-inviter daily cap for a Hub mode; routes pass it to `create`. */
export const invitesPerDay = (mode: "private" | "public"): number => (mode === "public" ? INVITES_PER_DAY_PUBLIC : INVITES_PER_DAY_PRIVATE);

export function createInvitationsService(deps: ServiceDeps, audit: AuditService, teams: TeamsService, publicUrl: string): InvitationsService {
	const scopeName = async (q: Queryable, scope: InvitationScope, id: string): Promise<string | undefined> => {
		const rows = await q.query<{ name: string }>(scope === "org" ? "SELECT name FROM organizations WHERE id = $1" : "SELECT name FROM teams WHERE id = $1", [id]);
		return rows[0]?.name;
	};
	const find = async (q: Queryable, token: string): Promise<InvitationRow | undefined> => {
		const rows = await q.query<InvitationRow>(
			"SELECT id, scope, scope_id, email, role, expires_at FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > $2",
			[sha256Hex(token), new Date(deps.now())],
		);
		return rows[0];
	};

	const service: InvitationsService = {
		find,

		async create(actor, input, dailyLimit = INVITES_PER_DAY_PRIVATE) {
			const email = normalizeEmail(input.email);
			const allowed = input.scope === "org" ? ORG_ROLES : TEAM_ROLES;
			if (!allowed.includes(input.role)) throw badRequest(`${input.scope === "org" ? "企业" : "团队"}邀请的角色无效`, "invalidRole");
			const token = randomToken();
			const id = ulid(deps.now());
			const expiresAt = new Date(deps.now() + INVITATION_TTL_MS);
			const view = await deps.db.tx(scopeOf(actor), async (q) => {
				let orgId: string | null;
				if (input.scope === "org") {
					if (!can(actor, "org.members.manage", { orgId: input.scopeId })) throw forbidden();
					orgId = input.scopeId;
				} else {
					const team = await teams.require(q, actor, input.scopeId);
					if (!can(actor, "team.manage", { teamId: team.id, orgId: team.orgId })) throw forbidden();
					orgId = team.orgId;
				}
				const name = await scopeName(q, input.scope, input.scopeId);
				if (!name) throw notFound(input.scope === "org" ? "企业不存在" : "团队不存在");
				const recent = await q.query<{ n: string | number }>("SELECT count(*) AS n FROM invitations WHERE created_by = $1 AND created_at > $2", [
					actor.userId,
					new Date(deps.now() - DAY_MS),
				]);
				if (Number(recent[0]?.n ?? 0) >= dailyLimit) throw tooManyRequests(60 * 60);
				await q.query(
					"INSERT INTO invitations (id, scope, scope_id, email, role, token_hash, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
					[id, input.scope, input.scopeId, email, input.role, sha256Hex(token), expiresAt, actor.userId],
				);
				await audit.write(q, { actorId: actor.userId, orgId, action: "invitation.create", targetType: input.scope, targetId: input.scopeId, detail: { email, role: input.role } });
				return { id, scope: input.scope, scopeId: input.scopeId, scopeName: name, email, role: input.role, expiresAt: expiresAt.toISOString() };
			});
			return { link: `${publicUrl}/invite/${token}`, token, invitation: view };
		},

		async lookup(token) {
			return deps.db.tx({ system: true }, async (q) => {
				const inv = await find(q, token);
				if (!inv) throw notFound("邀请无效或已过期");
				const name = (await scopeName(q, inv.scope, inv.scope_id)) ?? "";
				return { id: inv.id, scope: inv.scope, scopeId: inv.scope_id, scopeName: name, email: inv.email, role: inv.role, expiresAt: toIso(inv.expires_at) as string };
			});
		},

		async apply(q, inv, userId) {
			let orgId: string | null = null;
			if (inv.scope === "org") {
				orgId = inv.scope_id;
				await q.query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1,$2,$3,'active') ON CONFLICT DO NOTHING", [orgId, userId, inv.role as OrgRole]);
			} else {
				const team = await q.query<{ org_id: string | null }>("SELECT org_id FROM teams WHERE id = $1", [inv.scope_id]);
				if (team.length === 0) throw notFound("邀请所指的团队已不存在");
				orgId = team[0]?.org_id ?? null;
				if (orgId) await q.query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1,$2,'member','active') ON CONFLICT DO NOTHING", [orgId, userId]);
				await q.query("INSERT INTO team_members (team_id, user_id, role, org_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [inv.scope_id, userId, inv.role as TeamRole, orgId]);
			}
			await q.query("UPDATE invitations SET accepted_at = $2 WHERE id = $1", [inv.id, new Date(deps.now())]);
			return { orgId };
		},

		async accept(actor, token) {
			// System scope like registration: the invitation is the authority for the membership rows, the actor is already authenticated.
			return deps.db.tx({ system: true }, async (q) => {
				const inv = await find(q, token);
				if (!inv) throw badRequest("邀请无效或已过期", "invalidInvite");
				const users = await q.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [actor.userId]);
				const email = users[0]?.email;
				if (!email) throw notFound("用户不存在");
				if (normalizeEmail(inv.email) !== normalizeEmail(email)) throw badRequest("邀请对应的邮箱与当前账号邮箱不一致", "inviteEmailMismatch");
				const name = (await scopeName(q, inv.scope, inv.scope_id)) ?? "";
				const { orgId } = await service.apply(q, inv, actor.userId);
				await audit.write(q, { actorId: actor.userId, orgId, action: "invitation.accept", targetType: inv.scope, targetId: inv.scope_id, detail: { invitationId: inv.id, role: inv.role } });
				return { scope: inv.scope, scopeId: inv.scope_id, scopeName: name, role: inv.role, orgId };
			});
		},
	};
	return service;
}
