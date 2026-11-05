import { unauthorized } from "../errors.ts";
import type { Actor, OrgRole, TeamRole } from "../permissions.ts";
import type { ServiceDeps } from "./common.ts";

export interface ActorService {
	/** Loads roles for an authenticated user. Throws 401 when the account is gone or not active, so disabling takes effect before the token expires. */
	load(userId: string): Promise<Actor>;
}

export function createActorService(deps: ServiceDeps): ActorService {
	return {
		async load(userId) {
			return deps.db.tx({ system: true }, async (q) => {
				const users = await q.query<{ status: string; platform_role: string | null }>("SELECT status, platform_role FROM users WHERE id = $1", [userId]);
				const user = users[0];
				if (!user || user.status !== "active") throw unauthorized("账号不可用", "accountUnavailable");
				const orgs = await q.query<{ org_id: string; role: OrgRole }>(
					`SELECT m.org_id, m.role FROM org_members m JOIN organizations o ON o.id = m.org_id
					 WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'`,
					[userId],
				);
				const teams = await q.query<{ team_id: string; role: TeamRole }>("SELECT team_id, role FROM team_members WHERE user_id = $1", [userId]);
				return {
					userId,
					operator: user.platform_role === "operator",
					orgRoles: Object.fromEntries(orgs.map((o) => [o.org_id, o.role])),
					teamRoles: Object.fromEntries(teams.map((t) => [t.team_id, t.role])),
				};
			});
		},
	};
}
