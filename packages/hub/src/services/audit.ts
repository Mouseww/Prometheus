import { toIso } from "../db/db.ts";
import type { Queryable } from "../db/db.ts";
import { ulid } from "../ids.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import { forbidden } from "../errors.ts";
import { type ServiceDeps, scopeOf } from "./common.ts";

export interface AuditEntry {
	actorId: string | null;
	orgId?: string | null;
	action: string;
	targetType?: string;
	targetId?: string;
	detail?: Record<string, unknown>;
}

export interface AuditRecord {
	id: string;
	actorId: string | null;
	orgId: string | null;
	action: string;
	targetType: string | null;
	targetId: string | null;
	detail: Record<string, unknown>;
	createdAt: string;
}

export interface AuditQuery {
	orgId?: string;
	actor?: string;
	action?: string;
	/** Cursor: only records with an id below this one (ids sort by creation time). */
	before?: string;
	limit?: number;
}

export interface AuditService {
	/** Writes inside the caller's transaction so the record commits or rolls back with the change. */
	write(q: Queryable, entry: AuditEntry): Promise<void>;
	list(actor: Actor, query: AuditQuery): Promise<{ items: AuditRecord[]; nextBefore: string | null }>;
}

interface AuditRow {
	id: string;
	actor_id: string | null;
	org_id: string | null;
	action: string;
	target_type: string | null;
	target_id: string | null;
	detail: Record<string, unknown>;
	created_at: Date | string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function createAuditService(deps: ServiceDeps): AuditService {
	return {
		async write(q, e) {
			await q.query("INSERT INTO audit_log (id, actor_id, org_id, action, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7::text::jsonb)", [
				ulid(deps.now()),
				e.actorId,
				e.orgId ?? null,
				e.action,
				e.targetType ?? null,
				e.targetId ?? null,
				JSON.stringify(e.detail ?? {}),
			]);
		},

		async list(actor, query) {
			const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
			const where: string[] = [];
			const params: unknown[] = [];
			const add = (sql: string, value: unknown): void => {
				params.push(value);
				where.push(sql.replace("?", `$${params.length}`));
			};

			if (query.orgId) {
				if (!can(actor, "audit.read", { orgId: query.orgId })) throw forbidden();
				add("org_id = ?", query.orgId);
			} else if (!actor.operator) {
				// No org given: everything in the organizations this actor administers.
				const orgs = Object.keys(actor.orgRoles).filter((id) => can(actor, "audit.read", { orgId: id }));
				if (orgs.length === 0) throw forbidden();
				add("org_id = ANY(?::text[])", orgs);
			}
			if (query.actor) add("actor_id = ?", query.actor);
			if (query.action) add("action = ?", query.action);
			if (query.before) add("id < ?", query.before);
			params.push(limit + 1);

			const rows = await deps.db.tx(scopeOf(actor), (q) =>
				q.query<AuditRow>(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT $${params.length}`, params),
			);
			const page = rows.slice(0, limit);
			return {
				items: page.map((r) => ({
					id: r.id,
					actorId: r.actor_id,
					orgId: r.org_id,
					action: r.action,
					targetType: r.target_type,
					targetId: r.target_id,
					detail: r.detail,
					createdAt: toIso(r.created_at) as string,
				})),
				nextBefore: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
			};
		},
	};
}
