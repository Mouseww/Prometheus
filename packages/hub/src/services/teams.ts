import { isUniqueViolation, toIso } from "../db/db.ts";
import type { Queryable } from "../db/db.ts";
import { conflict, forbidden, notFound } from "../errors.ts";
import { ulid } from "../ids.ts";
import type { Actor, TeamRole } from "../permissions.ts";
import { can, effectiveTeamRole } from "../permissions.ts";
import type { AuditService } from "./audit.ts";
import { normalizeEmail, type ServiceDeps, scopeOf } from "./common.ts";
import type { SettingsService } from "./settings.ts";

export interface TeamView {
	id: string;
	name: string;
	orgId: string | null;
	ownerUserId: string | null;
	/** The actor's effective role (implicit admin for operators and org owners/admins). */
	role: TeamRole;
	createdAt: string;
}

export interface TeamMemberView {
	userId: string;
	email: string;
	displayName: string;
	role: TeamRole;
}

export interface TeamRecord {
	id: string;
	orgId: string | null;
	ownerUserId: string | null;
	name: string;
}

export interface TeamsService {
	listFor(actor: Actor): Promise<TeamView[]>;
	create(actor: Actor, input: { name: string; orgId?: string | null }): Promise<TeamView>;
	/** Loads a team the actor can see; 404 for outsiders so existence is not leaked. Reusable by blocks 2B/2C. */
	require(q: Queryable, actor: Actor, teamId: string): Promise<TeamRecord>;
	listMembers(actor: Actor, teamId: string): Promise<TeamMemberView[]>;
	addMember(actor: Actor, teamId: string, input: { userId?: string; email?: string; role: TeamRole }): Promise<TeamMemberView>;
	setMemberRole(actor: Actor, teamId: string, userId: string, role: TeamRole): Promise<TeamMemberView>;
	removeMember(actor: Actor, teamId: string, userId: string): Promise<void>;
}

interface TeamRow {
	id: string;
	org_id: string | null;
	owner_user_id: string | null;
	name: string;
	created_at: Date | string;
}

const toRecord = (r: TeamRow): TeamRecord => ({ id: r.id, orgId: r.org_id, ownerUserId: r.owner_user_id, name: r.name });

export function createTeamsService(deps: ServiceDeps, audit: AuditService, settings: SettingsService): TeamsService {
	const requireTeam = async (q: Queryable, actor: Actor, teamId: string): Promise<TeamRecord> => {
		const rows = await q.query<TeamRow>("SELECT id, org_id, owner_user_id, name, created_at FROM teams WHERE id = $1", [teamId]);
		const team = rows[0] ? toRecord(rows[0]) : undefined;
		if (!team || effectiveTeamRole(actor, { teamId, orgId: team.orgId }) === undefined) throw notFound("团队不存在");
		return team;
	};

	const memberView = async (q: Queryable, teamId: string, userId: string): Promise<TeamMemberView> => {
		const rows = await q.query<{ user_id: string; email: string; display_name: string; role: TeamRole }>(
			"SELECT m.user_id, u.email, u.display_name, m.role FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 AND m.user_id = $2",
			[teamId, userId],
		);
		const r = rows[0];
		if (!r) throw notFound("成员不存在");
		return { userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role };
	};

	return {
		async listFor(actor) {
			const rows = await deps.db.tx(scopeOf(actor), (q) => q.query<TeamRow>("SELECT id, org_id, owner_user_id, name, created_at FROM teams ORDER BY created_at, id"));
			const out: TeamView[] = [];
			for (const r of rows) {
				// RLS already limits organization teams to the actor's organizations; personal teams are filtered by membership here.
				const role = effectiveTeamRole(actor, { teamId: r.id, orgId: r.org_id });
				if (role) out.push({ id: r.id, name: r.name, orgId: r.org_id, ownerUserId: r.owner_user_id, role, createdAt: toIso(r.created_at) as string });
			}
			return out;
		},

		async create(actor, input) {
			const orgId = input.orgId ?? null;
			const allowPersonalTeams = await settings.allowPersonalTeams();
			if (!can(actor, "team.create", { orgId, allowPersonalTeams })) {
				throw orgId === null && !allowPersonalTeams ? forbidden("当前部署不允许创建个人团队", "personalTeamsDisabled") : forbidden();
			}
			const id = ulid(deps.now());
			const row = await deps.db.tx(scopeOf(actor), async (q) => {
				if (orgId) {
					const org = await q.query<{ status: string }>("SELECT status FROM organizations WHERE id = $1", [orgId]);
					if (org.length === 0) throw notFound("企业不存在");
				}
				const inserted = await q.query<TeamRow>(
					"INSERT INTO teams (id, org_id, owner_user_id, name) VALUES ($1,$2,$3,$4) RETURNING id, org_id, owner_user_id, name, created_at",
					[id, orgId, orgId ? null : actor.userId, input.name],
				);
				await q.query("INSERT INTO team_members (team_id, user_id, role, org_id) VALUES ($1,$2,'admin',$3)", [id, actor.userId, orgId]);
				await audit.write(q, { actorId: actor.userId, orgId, action: "team.create", targetType: "team", targetId: id, detail: { name: input.name } });
				return inserted[0] as TeamRow;
			});
			return { id, name: row.name, orgId, ownerUserId: row.owner_user_id, role: "admin", createdAt: toIso(row.created_at) as string };
		},

		require: requireTeam,

		async listMembers(actor, teamId) {
			return deps.db.tx(scopeOf(actor), async (q) => {
				const team = await requireTeam(q, actor, teamId);
				if (!can(actor, "team.view", { teamId, orgId: team.orgId })) throw forbidden();
				const rows = await q.query<{ user_id: string; email: string; display_name: string; role: TeamRole }>(
					"SELECT m.user_id, u.email, u.display_name, m.role FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY m.created_at, m.user_id",
					[teamId],
				);
				return rows.map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role }));
			});
		},

		async addMember(actor, teamId, input) {
			return deps.db
				.tx(scopeOf(actor), async (q) => {
					const team = await requireTeam(q, actor, teamId);
					if (!can(actor, "team.manage", { teamId, orgId: team.orgId })) throw forbidden();
					const users = input.userId
						? await q.query<{ id: string; status: string }>("SELECT id, status FROM users WHERE id = $1", [input.userId])
						: await q.query<{ id: string; status: string }>("SELECT id, status FROM users WHERE email = $1", [normalizeEmail(input.email ?? "")]);
					const user = users[0];
					// Direct add is only for active members of the team's own organization. Everyone else (unknown, inactive, outside the org,
					// or any user for a personal team) goes through the invitation flow, and all of those cases answer identically so the
					// endpoint cannot be used to probe which emails are registered.
					const ineligible = (): never => {
						throw notFound("用户不存在，或无法直接添加；请改用邀请");
					};
					if (!user || user.status !== "active" || !team.orgId) return ineligible();
					const m = await q.query("SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'", [team.orgId, user.id]);
					if (m.length === 0) return ineligible();
					await q.query("INSERT INTO team_members (team_id, user_id, role, org_id) VALUES ($1,$2,$3,$4)", [teamId, user.id, input.role, team.orgId]);
					await audit.write(q, { actorId: actor.userId, orgId: team.orgId, action: "team.member.add", targetType: "user", targetId: user.id, detail: { teamId, role: input.role } });
					return memberView(q, teamId, user.id);
				})
				.catch((err: unknown) => {
					if (isUniqueViolation(err)) throw conflict("该用户已在团队中", "alreadyMember");
					throw err;
				});
		},

		async setMemberRole(actor, teamId, userId, role) {
			return deps.db.tx(scopeOf(actor), async (q) => {
				const team = await requireTeam(q, actor, teamId);
				if (!can(actor, "team.manage", { teamId, orgId: team.orgId })) throw forbidden();
				if (team.ownerUserId === userId && role !== "admin") throw conflict("个人团队的所有者必须是管理员", "ownerImmutable");
				const updated = await q.query("UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2 RETURNING user_id", [teamId, userId, role]);
				if (updated.length === 0) throw notFound("成员不存在");
				await audit.write(q, { actorId: actor.userId, orgId: team.orgId, action: "team.member.role", targetType: "user", targetId: userId, detail: { teamId, role } });
				return memberView(q, teamId, userId);
			});
		},

		async removeMember(actor, teamId, userId) {
			await deps.db.tx(scopeOf(actor), async (q) => {
				const team = await requireTeam(q, actor, teamId);
				if (!can(actor, "team.manage", { teamId, orgId: team.orgId })) throw forbidden();
				if (team.ownerUserId === userId) throw conflict("不能移除个人团队的所有者", "ownerImmutable");
				const removed = await q.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2 RETURNING user_id", [teamId, userId]);
				if (removed.length === 0) throw notFound("成员不存在");
				await audit.write(q, { actorId: actor.userId, orgId: team.orgId, action: "team.member.remove", targetType: "user", targetId: userId, detail: { teamId } });
			});
		},
	};
}
