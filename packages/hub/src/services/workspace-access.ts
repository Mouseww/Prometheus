import type { Queryable } from "../db/db.ts";
import { forbidden, notFound } from "../errors.ts";
import type { Action, Actor } from "../permissions.ts";
import { can, effectiveTeamRole } from "../permissions.ts";

/** The slice of a workspace row that block 2C needs (the table itself is owned by block 2B). */
export interface WorkspaceRef {
	id: string;
	teamId: string;
	orgId: string | null;
	name: string;
	defaultBranch: string;
}

interface WorkspaceRow {
	id: string;
	team_id: string;
	org_id: string | null;
	name: string;
	default_branch: string;
}

export const toWorkspaceRef = (r: WorkspaceRow): WorkspaceRef => ({ id: r.id, teamId: r.team_id, orgId: r.org_id, name: r.name, defaultBranch: r.default_branch });

/**
 * Loads a workspace the actor may see and checks `action` on its team.
 * Outsiders get 404 so the workspace's existence is not leaked; members lacking the action get 403.
 */
export async function requireWorkspace(q: Queryable, actor: Actor, workspaceId: string, action: Action): Promise<WorkspaceRef> {
	const rows = await q.query<WorkspaceRow>("SELECT id, team_id, org_id, name, default_branch FROM workspaces WHERE id = $1", [workspaceId]);
	const row = rows[0];
	if (!row) throw notFound("工作区不存在");
	const ref = toWorkspaceRef(row);
	if (effectiveTeamRole(actor, { teamId: ref.teamId, orgId: ref.orgId }) === undefined) throw notFound("工作区不存在");
	if (!can(actor, action, { teamId: ref.teamId, orgId: ref.orgId })) throw forbidden();
	return ref;
}
