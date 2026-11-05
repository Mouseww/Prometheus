import { isUniqueViolation, type Queryable, toIso } from "../db/db.ts";
import { conflict, forbidden, notFound } from "../errors.ts";
import { ulid } from "../ids.ts";
import { type Actor, can } from "../permissions.ts";
import type { AuditService } from "./audit.ts";
import { type ServiceDeps, scopeOf } from "./common.ts";

export type TransferStatus = "pending" | "accepted" | "rejected" | "canceled";

export interface TransferView {
	id: string;
	teamId: string;
	teamName: string;
	fromUserId: string;
	toOrgId: string;
	toOrgName: string;
	status: TransferStatus;
	decidedBy: string | null;
	createdAt: string;
	decidedAt: string | null;
	/** Set on accept: users who were not organization members and were added as `member`. */
	addedMembers?: string[];
}

interface TransferRow {
	id: string;
	team_id: string;
	team_name: string;
	from_user_id: string;
	to_org_id: string;
	to_org_name: string;
	status: TransferStatus;
	decided_by: string | null;
	created_at: Date | string;
	decided_at: Date | string | null;
}

const SELECT = `SELECT t.id, t.team_id, tm.name AS team_name, t.from_user_id, t.to_org_id, o.name AS to_org_name, t.status, t.decided_by, t.created_at, t.decided_at
	FROM team_transfers t JOIN teams tm ON tm.id = t.team_id JOIN organizations o ON o.id = t.to_org_id`;

const toView = (r: TransferRow, addedMembers?: string[]): TransferView => ({
	id: r.id,
	teamId: r.team_id,
	teamName: r.team_name,
	fromUserId: r.from_user_id,
	toOrgId: r.to_org_id,
	toOrgName: r.to_org_name,
	status: r.status,
	decidedBy: r.decided_by,
	createdAt: toIso(r.created_at) as string,
	decidedAt: toIso(r.decided_at),
	...(addedMembers ? { addedMembers } : {}),
});

export interface TransfersService {
	/** Personal team admin asks to move the team into an organization they belong to. */
	request(actor: Actor, teamId: string, orgId: string): Promise<TransferView>;
	/** Requests the actor made, plus pending and past requests for organizations they administer (operators see all). */
	list(actor: Actor): Promise<TransferView[]>;
	accept(actor: Actor, transferId: string): Promise<TransferView>;
	reject(actor: Actor, transferId: string): Promise<TransferView>;
	/** Only the requester may cancel. */
	cancel(actor: Actor, transferId: string): Promise<TransferView>;
}

export function createTransfersService(deps: ServiceDeps, audit: AuditService): TransfersService {
	const load = async (q: Queryable, id: string, lock = false): Promise<TransferRow | undefined> =>
		(await q.query<TransferRow>(`${SELECT} WHERE t.id = $1${lock ? " FOR UPDATE OF t" : ""}`, [id]))[0];

	/** Transfers are invisible (404) unless the actor is the requester, an admin of the target organization, or an operator. */
	const requireVisible = async (q: Queryable, actor: Actor, id: string, lock = false): Promise<TransferRow> => {
		const row = await load(q, id, lock);
		if (!row || !(actor.operator || row.from_user_id === actor.userId || can(actor, "org.members.manage", { orgId: row.to_org_id }))) throw notFound("转入请求不存在");
		return row;
	};

	const finish = async (q: Queryable, actor: Actor, row: TransferRow, status: Exclude<TransferStatus, "pending">, action: string): Promise<TransferView> => {
		if (row.status !== "pending") throw conflict("该转入请求已处理", "transferNotPending");
		await q.query("UPDATE team_transfers SET status = $2, decided_by = $3, decided_at = $4 WHERE id = $1", [row.id, status, actor.userId, new Date(deps.now())]);
		await audit.write(q, { actorId: actor.userId, orgId: row.to_org_id, action, targetType: "team", targetId: row.team_id, detail: { transferId: row.id } });
		return toView({ ...row, status, decided_by: actor.userId, decided_at: new Date(deps.now()) });
	};

	return {
		async request(actor, teamId, orgId) {
			try {
				return await deps.db.tx(scopeOf(actor), async (q) => {
					const teams = await q.query<{ id: string; org_id: string | null; owner_user_id: string | null }>("SELECT id, org_id, owner_user_id FROM teams WHERE id = $1", [teamId]);
					const team = teams[0];
					if (!team || !(actor.operator || actor.teamRoles[teamId] !== undefined)) throw notFound("团队不存在");
					if (team.org_id !== null) throw conflict("只有个人团队可以转入企业", "notPersonalTeam");
					if (!can(actor, "team.manage", { teamId, orgId: null })) throw forbidden("只有团队管理员可以发起转入");
					const org = await q.query<{ status: string }>("SELECT status FROM organizations WHERE id = $1", [orgId]);
					if (org.length === 0) throw notFound("企业不存在");
					if (org[0]?.status !== "active") throw conflict("企业已停用", "orgDisabled");
					if (!actor.operator && actor.orgRoles[orgId] === undefined) throw notFound("企业不存在");
					const id = ulid(deps.now());
					await q.query("INSERT INTO team_transfers (id, team_id, from_user_id, to_org_id, created_at) VALUES ($1,$2,$3,$4,$5)", [id, teamId, actor.userId, orgId, new Date(deps.now())]);
					await audit.write(q, { actorId: actor.userId, orgId, action: "team.transfer.request", targetType: "team", targetId: teamId, detail: { transferId: id } });
					return toView((await load(q, id)) as TransferRow);
				});
			} catch (err) {
				if (isUniqueViolation(err)) throw conflict("该团队已有待处理的转入请求", "transferPending");
				throw err;
			}
		},

		async list(actor) {
			const rows = await deps.db.tx({ system: true }, (q) => q.query<TransferRow>(`${SELECT} ORDER BY t.created_at DESC, t.id DESC`));
			return rows
				.filter((r) => actor.operator || r.from_user_id === actor.userId || can(actor, "org.members.manage", { orgId: r.to_org_id }))
				.map((r) => toView(r));
		},

		async accept(actor, transferId) {
			return deps.db.tx({ system: true }, async (q) => {
				const row = await requireVisible(q, actor, transferId, true);
				if (!actor.operator && !can(actor, "org.members.manage", { orgId: row.to_org_id })) throw forbidden("只有目标企业的管理员可以接受转入");
				if (row.status !== "pending") throw conflict("该转入请求已处理", "transferNotPending");
				const teams = await q.query<{ org_id: string | null }>("SELECT org_id FROM teams WHERE id = $1 FOR UPDATE", [row.team_id]);
				if (teams[0]?.org_id !== null) throw conflict("团队已不是个人团队", "notPersonalTeam");
				const orgId = row.to_org_id;

				// Every team member must belong to the organization: missing ones are added as `member` and audited.
				const nonMembers = await q.query<{ user_id: string }>(
					`SELECT tm.user_id FROM team_members tm
					 WHERE tm.team_id = $1 AND NOT EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = $2 AND om.user_id = tm.user_id AND om.status = 'active')
					 ORDER BY tm.user_id`,
					[row.team_id, orgId],
				);
				const added = nonMembers.map((m) => m.user_id);
				for (const userId of added) {
					await q.query(
						`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1,$2,'member','active')
						 ON CONFLICT (org_id, user_id) DO UPDATE SET status = 'active'`,
						[orgId, userId],
					);
				}
				if (added.length > 0) {
					await audit.write(q, { actorId: actor.userId, orgId, action: "org.member.autoAdd", targetType: "team", targetId: row.team_id, detail: { transferId, userIds: added } });
				}

				await q.query("UPDATE teams SET org_id = $2, owner_user_id = NULL, updated_at = now() WHERE id = $1", [row.team_id, orgId]);
				await q.query("UPDATE team_members SET org_id = $2 WHERE team_id = $1", [row.team_id, orgId]);
				const byWorkspace = "workspace_id IN (SELECT id FROM workspaces WHERE team_id = $1)";
				const bySession = `session_id IN (SELECT s.id FROM sessions s WHERE s.${byWorkspace})`;
				await q.query("UPDATE workspaces SET org_id = $2 WHERE team_id = $1", [row.team_id, orgId]);
				await q.query(`UPDATE merge_requests SET org_id = $2 WHERE ${byWorkspace}`, [row.team_id, orgId]);
				await q.query(`UPDATE daily_reports SET org_id = $2 WHERE ${byWorkspace}`, [row.team_id, orgId]);
				await q.query(`UPDATE sessions SET org_id = $2 WHERE ${byWorkspace}`, [row.team_id, orgId]);
				for (const table of ["session_events", "session_transcripts", "session_grants"]) {
					await q.query(`UPDATE ${table} SET org_id = $2 WHERE ${bySession}`, [row.team_id, orgId]);
				}
				// Notifications carry no team column: those about this team's workspaces (or naming the team) move with it.
				await q.query(
					`UPDATE notifications SET org_id = $2 WHERE org_id IS NULL AND (payload->>'teamId' = $1 OR payload->>'workspaceId' IN (SELECT id FROM workspaces WHERE team_id = $1))`,
					[row.team_id, orgId],
				);

				const view = await finish(q, actor, row, "accepted", "team.transfer.accept");
				return { ...view, addedMembers: added };
			});
		},

		async reject(actor, transferId) {
			return deps.db.tx({ system: true }, async (q) => {
				const row = await requireVisible(q, actor, transferId, true);
				if (!actor.operator && !can(actor, "org.members.manage", { orgId: row.to_org_id })) throw forbidden("只有目标企业的管理员可以拒绝转入");
				return finish(q, actor, row, "rejected", "team.transfer.reject");
			});
		},

		async cancel(actor, transferId) {
			return deps.db.tx({ system: true }, async (q) => {
				const row = await requireVisible(q, actor, transferId, true);
				if (row.from_user_id !== actor.userId) throw forbidden("只有发起人可以取消转入请求");
				return finish(q, actor, row, "canceled", "team.transfer.cancel");
			});
		},
	};
}
