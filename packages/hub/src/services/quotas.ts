import { HubError, forbidden, notFound } from "../errors.ts";
import { ulid } from "../ids.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { AuditService } from "./audit.ts";
import { type ServiceDeps, scopeOf } from "./common.ts";

export type QuotaSubject = "user" | "org";
export type QuotaPeriod = "day" | "month";

export interface QuotaView {
	id: string;
	subjectType: QuotaSubject;
	subjectId: string;
	period: QuotaPeriod;
	limitTokens: number;
	orgId: string | null;
}

export interface QuotasService {
	list(actor: Actor, filter: { subjectType?: QuotaSubject; subjectId?: string }): Promise<QuotaView[]>;
	/** Upserts a limit; `limitTokens: null` removes it. */
	set(actor: Actor, input: { subjectType: QuotaSubject; subjectId: string; period: QuotaPeriod; limitTokens: number | null }): Promise<QuotaView | null>;
	/** Throws 429 `quotaExceeded` when the strictest applicable limit (user or organization, day or month) is used up. */
	check(userId: string, orgIds: readonly string[]): Promise<void>;
}

interface QuotaRow {
	id: string;
	subject_type: QuotaSubject;
	subject_id: string;
	period: QuotaPeriod;
	limit_tokens: string | number;
	org_id: string | null;
}

const toView = (r: QuotaRow): QuotaView => ({
	id: r.id,
	subjectType: r.subject_type,
	subjectId: r.subject_id,
	period: r.period,
	limitTokens: Number(r.limit_tokens),
	orgId: r.org_id,
});

/** Natural day or month in UTC: `[start, end)`. */
export function quotaWindow(period: QuotaPeriod, nowMs: number): { start: Date; end: Date } {
	const d = new Date(nowMs);
	if (period === "day") {
		const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
		return { start: new Date(start), end: new Date(start + 24 * 60 * 60 * 1000) };
	}
	return { start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) };
}

export function createQuotasService(deps: ServiceDeps, audit: AuditService): QuotasService {
	return {
		async list(actor, filter) {
			const where: string[] = [];
			const params: unknown[] = [];
			const add = (sql: string, value: unknown): void => {
				params.push(value);
				where.push(sql.replace("?", `$${params.length}`));
			};
			if (filter.subjectType) add("subject_type = ?", filter.subjectType);
			if (filter.subjectId) add("subject_id = ?", filter.subjectId);
			if (!actor.operator) {
				const orgs = Object.keys(actor.orgRoles).filter((id) => can(actor, "org.manage", { orgId: id }));
				if (orgs.length === 0) throw forbidden();
				add("org_id = ANY(?::text[])", orgs);
			}
			const rows = await deps.db.tx(scopeOf(actor), (q) =>
				q.query<QuotaRow>(`SELECT id, subject_type, subject_id, period, limit_tokens, org_id FROM quotas ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY subject_type, subject_id, period`, params),
			);
			return rows.map(toView);
		},

		async set(actor, input) {
			return deps.db.tx(scopeOf(actor), async (q) => {
				let orgId: string | null;
				if (input.subjectType === "org") {
					if (!can(actor, "platform.manage")) throw forbidden("只有平台管理员可以设置企业配额", "forbidden");
					const org = await q.query("SELECT 1 FROM organizations WHERE id = $1", [input.subjectId]);
					if (org.length === 0) throw notFound("企业不存在");
					orgId = input.subjectId;
				} else {
					const memberships = await q.query<{ org_id: string }>("SELECT org_id FROM org_members WHERE user_id = $1 AND status = 'active'", [input.subjectId]);
					const user = await q.query("SELECT 1 FROM users WHERE id = $1", [input.subjectId]);
					if (user.length === 0) throw notFound("用户不存在");
					const manageable = memberships.find((m) => can(actor, "org.manage", { orgId: m.org_id }));
					if (!actor.operator && !manageable) throw forbidden();
					orgId = manageable?.org_id ?? memberships[0]?.org_id ?? null;
				}

				if (input.limitTokens === null) {
					await q.query("DELETE FROM quotas WHERE subject_type = $1 AND subject_id = $2 AND period = $3", [input.subjectType, input.subjectId, input.period]);
					await audit.write(q, { actorId: actor.userId, orgId, action: "quota.delete", targetType: input.subjectType, targetId: input.subjectId, detail: { period: input.period } });
					return null;
				}
				const rows = await q.query<QuotaRow>(
					`INSERT INTO quotas (id, subject_type, subject_id, period, limit_tokens, org_id) VALUES ($1,$2,$3,$4,$5,$6)
					 ON CONFLICT (subject_type, subject_id, period) DO UPDATE SET limit_tokens = EXCLUDED.limit_tokens, org_id = EXCLUDED.org_id, updated_at = now()
					 RETURNING id, subject_type, subject_id, period, limit_tokens, org_id`,
					[ulid(deps.now()), input.subjectType, input.subjectId, input.period, input.limitTokens, orgId],
				);
				await audit.write(q, {
					actorId: actor.userId,
					orgId,
					action: "quota.set",
					targetType: input.subjectType,
					targetId: input.subjectId,
					detail: { period: input.period, limitTokens: input.limitTokens },
				});
				return toView(rows[0] as QuotaRow);
			});
		},

		async check(userId, orgIds) {
			const nowMs = deps.now();
			await deps.db.tx({ system: true }, async (q) => {
				const quotas = await q.query<QuotaRow>(
					"SELECT id, subject_type, subject_id, period, limit_tokens, org_id FROM quotas WHERE (subject_type = 'user' AND subject_id = $1) OR (subject_type = 'org' AND subject_id = ANY($2::text[]))",
					[userId, [...orgIds]],
				);
				for (const quota of quotas) {
					const { start, end } = quotaWindow(quota.period, nowMs);
					const used = await q.query<{ total: string | number | null }>(
						quota.subject_type === "user"
							? "SELECT coalesce(sum(input_tokens + output_tokens), 0) AS total FROM usage_ledger WHERE user_id = $1 AND at >= $2::timestamptz AND at < $3::timestamptz"
							: "SELECT coalesce(sum(input_tokens + output_tokens), 0) AS total FROM usage_ledger WHERE org_id = $1 AND at >= $2::timestamptz AND at < $3::timestamptz",
						[quota.subject_id, start.toISOString(), end.toISOString()],
					);
					if (Number(used[0]?.total ?? 0) >= Number(quota.limit_tokens)) {
						const who = quota.subject_type === "user" ? "个人" : "企业";
						const when = quota.period === "day" ? "今日" : "本月";
						throw new HubError(429, "quotaExceeded", `${who}${when}的模型用量额度已用完`, { "retry-after": String(Math.max(1, Math.ceil((end.getTime() - nowMs) / 1000))) });
					}
				}
			});
		},
	};
}
