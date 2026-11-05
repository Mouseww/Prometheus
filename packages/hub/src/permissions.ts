/**
 * Pure permission matrix (spec 12.5 item 4). No I/O: callers load an Actor once and ask `can`.
 * Block 2B/2C check their own actions (`workspace.*`, `mr.*`, `session.*`) through the same function.
 */
export type OrgRole = "owner" | "admin" | "member";
export type TeamRole = "admin" | "reviewer" | "member";

export interface Actor {
	userId: string;
	/** platform_role = 'operator' */
	operator: boolean;
	/** Active org memberships only. */
	orgRoles: Readonly<Record<string, OrgRole>>;
	/** Explicit team memberships only; implicit admin rights are derived in `effectiveTeamRole`. */
	teamRoles: Readonly<Record<string, TeamRole>>;
}

export type Action =
	| "platform.manage"
	| "org.create"
	| "org.view"
	| "org.manage"
	| "org.members.view"
	| "org.members.manage"
	| "org.owner.manage"
	| "org.registration.manage"
	| "org.users.manage"
	| "audit.read"
	| "team.create"
	| "team.view"
	| "team.manage"
	| "workspace.create"
	| "workspace.manage"
	| "mr.review"
	| "mr.skipReview"
	| "mr.create"
	| "session.start"
	| "session.spectate"
	| "session.fork"
	| "session.grant";

export interface Resource {
	/** Organization the resource belongs to; null or absent for personal (owner-held) resources and platform scope. */
	orgId?: string | null;
	teamId?: string;
	/** session.grant: the session owner. */
	ownerUserId?: string;
	/** team.create: current value of the platform setting. */
	allowPersonalTeams?: boolean;
}

export const ALL_ACTIONS: readonly Action[] = [
	"platform.manage",
	"org.create",
	"org.view",
	"org.manage",
	"org.members.view",
	"org.members.manage",
	"org.owner.manage",
	"org.registration.manage",
	"org.users.manage",
	"audit.read",
	"team.create",
	"team.view",
	"team.manage",
	"workspace.create",
	"workspace.manage",
	"mr.review",
	"mr.skipReview",
	"mr.create",
	"session.start",
	"session.spectate",
	"session.fork",
	"session.grant",
];

const orgRoleOf = (actor: Actor, orgId: string | null | undefined): OrgRole | undefined => (orgId ? actor.orgRoles[orgId] : undefined);
const isOrgAdmin = (actor: Actor, orgId: string | null | undefined): boolean => {
	const r = orgRoleOf(actor, orgId);
	return r === "owner" || r === "admin";
};

/** operator: admin everywhere; org owner/admin: admin of every team in that org; otherwise the explicit team role. */
export function effectiveTeamRole(actor: Actor, team: { teamId?: string; orgId?: string | null }): TeamRole | undefined {
	if (actor.operator) return "admin";
	if (isOrgAdmin(actor, team.orgId)) return "admin";
	return team.teamId ? actor.teamRoles[team.teamId] : undefined;
}

export function can(actor: Actor, action: Action, resource: Resource = {}): boolean {
	const teamRole = (): TeamRole | undefined => effectiveTeamRole(actor, resource);
	switch (action) {
		case "session.grant":
			// Only the session owner, whatever the platform role.
			return resource.ownerUserId !== undefined && resource.ownerUserId === actor.userId;
		case "platform.manage":
		case "org.create":
			return actor.operator;
		case "org.view":
		case "org.members.view":
			return actor.operator || orgRoleOf(actor, resource.orgId) !== undefined;
		case "org.manage":
		case "org.members.manage":
		case "org.registration.manage":
		case "org.users.manage":
			return actor.operator || isOrgAdmin(actor, resource.orgId);
		case "org.owner.manage":
			return actor.operator || orgRoleOf(actor, resource.orgId) === "owner";
		case "audit.read":
			// Platform scope (no org) is operator only.
			return resource.orgId ? actor.operator || isOrgAdmin(actor, resource.orgId) : actor.operator;
		case "team.create":
			if (resource.orgId) return actor.operator || isOrgAdmin(actor, resource.orgId);
			return actor.operator || resource.allowPersonalTeams === true;
		case "team.manage":
		case "workspace.create":
		case "workspace.manage":
			return teamRole() === "admin";
		case "mr.review":
		case "mr.skipReview": {
			const r = teamRole();
			return r === "admin" || r === "reviewer";
		}
		case "team.view":
		case "mr.create":
		case "session.start":
		case "session.spectate":
		case "session.fork":
			return teamRole() !== undefined;
	}
}
