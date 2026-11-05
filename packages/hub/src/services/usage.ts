import { forbidden } from "../errors.ts";
import { ulid } from "../ids.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import { type ServiceDeps, scopeOf } from "./common.ts";

export type UsageGroup = "user" | "org" | "day" | "model";

export interface UsageEntry {
	/** A user id, or `system` for Hub-initiated calls such as daily reports. */
	userId: string;
	orgId: string | null;
	gatewayId: string | null;
	model: string;
	inputTokens: number;
	outputTokens: number;
	source: "platform" | "org" | "byok";
}

export interface UsageRow {
	key: string;
	label: string | null;
	inputTokens: number;
	outputTokens: number;
	requests: number;
}

export interface UsageService {
	record(entry: UsageEntry): Promise<void>;
	report(actor: Actor, query: { groupBy: UsageGroup; from?: string; to?: string }): Promise<UsageRow[]>;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `from` is inclusive; a date-only `to` includes that whole day. */
export function parseRange(from: string | undefined, to: string | undefined): { from?: string; to?: string } {
	const out: { from?: string; to?: string } = {};
	if (from) {
		const t = Date.parse(from);
		if (Number.isNaN(t)) throw new RangeError("from 不是有效的日期");
		out.from = new Date(t).toISOString();
	}
	if (to) {
		const t = Date.parse(to);
		if (Number.isNaN(t)) throw new RangeError("to 不是有效的日期");
		out.to = new Date(DATE_ONLY.test(to) ? t + 24 * 60 * 60 * 1000 : t).toISOString();
	}
	return out;
}

const KEY_SQL: Record<UsageGroup, { key: string; join: string; label: string }> = {
	user: { key: "l.user_id", join: "LEFT JOIN users u ON u.id = l.user_id", label: "max(u.display_name)" },
	org: { key: "coalesce(l.org_id, '')", join: "LEFT JOIN organizations o ON o.id = l.org_id", label: "max(o.name)" },
	day: { key: "to_char(l.at AT TIME ZONE 'UTC', 'YYYY-MM-DD')", join: "", label: "NULL" },
	model: { key: "l.model", join: "", label: "NULL" },
};

export function createUsageService(deps: ServiceDeps): UsageService {
	return {
		async record(e) {
			await deps.db.tx({ system: true }, (q) =>
				q.query("INSERT INTO usage_ledger (id, user_id, org_id, gateway_id, model, input_tokens, output_tokens, source, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)", [
					ulid(deps.now()),
					e.userId,
					e.orgId,
					e.gatewayId,
					e.model,
					Math.max(0, Math.round(e.inputTokens)),
					Math.max(0, Math.round(e.outputTokens)),
					e.source,
					new Date(deps.now()).toISOString(),
				]),
			);
		},

		async report(actor, query) {
			const where: string[] = [];
			const params: unknown[] = [];
			const add = (sql: string, value: unknown): void => {
				params.push(value);
				where.push(sql.replace("?", `$${params.length}`));
			};
			if (!actor.operator) {
				const orgs = Object.keys(actor.orgRoles).filter((id) => can(actor, "org.manage", { orgId: id }));
				if (orgs.length === 0) throw forbidden();
				add("l.org_id = ANY(?::text[])", orgs);
			}
			if (query.from) add("l.at >= ?::timestamptz", query.from);
			if (query.to) add("l.at < ?::timestamptz", query.to);
			const g = KEY_SQL[query.groupBy];
			const rows = await deps.db.tx(scopeOf(actor), (q) =>
				q.query<{ key: string; label: string | null; input_tokens: string | number; output_tokens: string | number; requests: string | number }>(
					`SELECT ${g.key} AS key, ${g.label} AS label, sum(l.input_tokens) AS input_tokens, sum(l.output_tokens) AS output_tokens, count(*) AS requests
					 FROM usage_ledger l ${g.join} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} GROUP BY 1 ORDER BY ${query.groupBy === "day" ? "1 DESC" : "sum(l.input_tokens + l.output_tokens) DESC, 1"}`,
					params,
				),
			);
			return rows.map((r) => ({
				key: r.key,
				label: query.groupBy === "user" && r.key === "system" ? "system" : r.label,
				inputTokens: Number(r.input_tokens),
				outputTokens: Number(r.output_tokens),
				requests: Number(r.requests),
			}));
		},
	};
}
