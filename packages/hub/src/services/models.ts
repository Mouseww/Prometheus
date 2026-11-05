import { toIso } from "../db/db.ts";
import type { Queryable } from "../db/db.ts";
import type { SecretBox } from "../crypto.ts";
import { badRequest, forbidden, notFound } from "../errors.ts";
import { ulid } from "../ids.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { AuditService } from "./audit.ts";
import { type ServiceDeps, scopeOf } from "./common.ts";

export type GatewayFormat = "openai" | "anthropic" | "gemini";
export type GatewayScope = "platform" | "org";

export interface GatewayModel {
	id: string;
	name?: string;
}

export interface GatewayView {
	id: string;
	scope: GatewayScope;
	scopeId: string;
	name: string;
	format: GatewayFormat;
	baseUrl: string;
	/** Never the key itself: only the last four characters. */
	apiKeyMasked: string;
	models: GatewayModel[];
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface CreateGatewayInput {
	scope: GatewayScope;
	/** Organization id for `org` scope; ignored for `platform`. */
	scopeId?: string;
	name: string;
	format: GatewayFormat;
	baseUrl: string;
	apiKey: string;
	models?: readonly (GatewayModel | string)[];
	enabled?: boolean;
}

export interface UpdateGatewayInput {
	name?: string;
	format?: GatewayFormat;
	baseUrl?: string;
	/** Omit to keep the stored key. */
	apiKey?: string;
	models?: readonly (GatewayModel | string)[];
	enabled?: boolean;
}

export interface VisibleModel {
	id: string;
	name: string;
	format: GatewayFormat;
	gatewayId: string;
	gatewayName: string;
	source: "user" | "org" | "platform";
}

export interface ModelsService {
	list(actor: Actor, filter: { scope?: GatewayScope; orgId?: string }): Promise<GatewayView[]>;
	create(actor: Actor, input: CreateGatewayInput): Promise<GatewayView>;
	update(actor: Actor, id: string, input: UpdateGatewayInput): Promise<GatewayView>;
	remove(actor: Actor, id: string): Promise<void>;
	/** Models the user can call: their own gateways (when `includeOwn`), enabled gateways of their organizations, then platform gateways. */
	visibleModels(actor: Actor, opts?: { includeOwn?: boolean }): Promise<VisibleModel[]>;
}

export interface GatewayRow {
	id: string;
	/** `user` rows are personal (BYOK) gateways, managed by the byok service. */
	scope: GatewayScope | "user";
	scope_id: string;
	org_id: string | null;
	name: string;
	format: GatewayFormat;
	base_url: string;
	api_key_enc: string;
	models: unknown;
	enabled: boolean;
	created_at: Date | string;
	updated_at: Date | string;
}

export const GATEWAY_COLUMNS = "id, scope, scope_id, org_id, name, format, base_url, api_key_enc, models, enabled, created_at, updated_at";

export function normalizeModels(raw: unknown): GatewayModel[] {
	if (!Array.isArray(raw)) return [];
	const out: GatewayModel[] = [];
	for (const m of raw) {
		if (typeof m === "string" && m) out.push({ id: m });
		else if (typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string" && (m as { id: string }).id) {
			const { id, name } = m as { id: string; name?: unknown };
			out.push(typeof name === "string" && name ? { id, name } : { id });
		}
	}
	return out;
}

/** http(s) URL without credentials, trailing slashes removed. */
export function validateBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw badRequest("baseUrl 不是有效的 URL", "validationError");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("baseUrl 只支持 http 或 https", "validationError");
	if (url.username || url.password) throw badRequest("baseUrl 不能包含用户名或密码", "validationError");
	url.hash = "";
	url.search = "";
	return url.toString().replace(/\/+$/, "");
}

export function maskKey(key: string): string {
	return key.length > 8 ? `****${key.slice(-4)}` : "****";
}

export function createModelsService(deps: ServiceDeps, secretBox: SecretBox, audit: AuditService): ModelsService {
	const view = (r: GatewayRow): GatewayView => {
		let masked = "****";
		try {
			masked = maskKey(secretBox.open(r.api_key_enc));
		} catch {
			// A key sealed with another master key stays unusable; the mask still tells the admin one is stored.
		}
		return {
			id: r.id,
			scope: r.scope as GatewayScope,
			scopeId: r.scope_id,
			name: r.name,
			format: r.format,
			baseUrl: r.base_url,
			apiKeyMasked: masked,
			models: normalizeModels(r.models),
			enabled: r.enabled,
			createdAt: toIso(r.created_at) as string,
			updatedAt: toIso(r.updated_at) as string,
		};
	};

	const authorize = (actor: Actor, row: { scope: string; org_id: string | null }): void => {
		const ok = row.scope === "platform" ? can(actor, "platform.manage") : can(actor, "org.manage", { orgId: row.org_id });
		if (!ok) throw forbidden();
	};

	const load = async (q: Queryable, id: string): Promise<GatewayRow> => {
		const rows = await q.query<GatewayRow>(`SELECT ${GATEWAY_COLUMNS} FROM model_gateways WHERE id = $1`, [id]);
		if (!rows[0]) throw notFound("网关不存在");
		return rows[0];
	};

	return {
		async list(actor, filter) {
			const where: string[] = [];
			const params: unknown[] = [];
			const add = (sql: string, value: unknown): void => {
				params.push(value);
				where.push(sql.replace("?", `$${params.length}`));
			};
			if (filter.scope === "platform" && !can(actor, "platform.manage")) throw forbidden();
			if (filter.orgId && !can(actor, "org.manage", { orgId: filter.orgId })) throw forbidden();
			// Personal gateways belong to their owners and never show up in the admin list.
			where.push("scope <> 'user'");
			if (filter.scope) add("scope = ?", filter.scope);
			if (filter.orgId) add("org_id = ?", filter.orgId);
			if (!actor.operator) {
				// Organization admins see their own organizations' gateways only.
				const orgs = Object.keys(actor.orgRoles).filter((id) => can(actor, "org.manage", { orgId: id }));
				if (orgs.length === 0) throw forbidden();
				add("org_id = ANY(?::text[])", orgs);
			}
			const rows = await deps.db.tx(scopeOf(actor), (q) =>
				q.query<GatewayRow>(`SELECT ${GATEWAY_COLUMNS} FROM model_gateways ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`, params),
			);
			return rows.map(view);
		},

		async create(actor, input) {
			const orgId = input.scope === "org" ? (input.scopeId ?? null) : null;
			if (input.scope === "org" && !orgId) throw badRequest("组织网关需要 scopeId", "validationError");
			authorize(actor, { scope: input.scope, org_id: orgId });
			const baseUrl = validateBaseUrl(input.baseUrl);
			const id = ulid(deps.now());
			const row = await deps.db.tx(scopeOf(actor), async (q) => {
				if (orgId) {
					const org = await q.query("SELECT 1 FROM organizations WHERE id = $1", [orgId]);
					if (org.length === 0) throw notFound("企业不存在");
				}
				const rows = await q.query<GatewayRow>(
					`INSERT INTO model_gateways (id, scope, scope_id, org_id, name, format, base_url, api_key_enc, models, enabled)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text::jsonb,$10) RETURNING ${GATEWAY_COLUMNS}`,
					[id, input.scope, orgId ?? "platform", orgId, input.name, input.format, baseUrl, secretBox.seal(input.apiKey), JSON.stringify(normalizeModels(input.models ?? [])), input.enabled ?? true],
				);
				await audit.write(q, { actorId: actor.userId, orgId, action: "gateway.create", targetType: "gateway", targetId: id, detail: { name: input.name, scope: input.scope, format: input.format } });
				return rows[0] as GatewayRow;
			});
			return view(row);
		},

		async update(actor, id, input) {
			const row = await deps.db.tx(scopeOf(actor), async (q) => {
				const current = await load(q, id);
				authorize(actor, current);
				const sets: string[] = [];
				const params: unknown[] = [id];
				const set = (column: string, value: unknown, cast = ""): void => {
					params.push(value);
					sets.push(`${column} = $${params.length}${cast}`);
				};
				if (input.name !== undefined) set("name", input.name);
				if (input.format !== undefined) set("format", input.format);
				if (input.baseUrl !== undefined) set("base_url", validateBaseUrl(input.baseUrl));
				if (input.apiKey !== undefined) set("api_key_enc", secretBox.seal(input.apiKey));
				if (input.models !== undefined) set("models", JSON.stringify(normalizeModels(input.models)), "::text::jsonb");
				if (input.enabled !== undefined) set("enabled", input.enabled);
				if (sets.length === 0) return current;
				const rows = await q.query<GatewayRow>(`UPDATE model_gateways SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${GATEWAY_COLUMNS}`, params);
				await audit.write(q, {
					actorId: actor.userId,
					orgId: current.org_id,
					action: "gateway.update",
					targetType: "gateway",
					targetId: id,
					detail: { fields: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined), keyChanged: input.apiKey !== undefined },
				});
				return rows[0] as GatewayRow;
			});
			return view(row);
		},

		async remove(actor, id) {
			await deps.db.tx(scopeOf(actor), async (q) => {
				const current = await load(q, id);
				authorize(actor, current);
				await q.query("DELETE FROM model_gateways WHERE id = $1", [id]);
				await audit.write(q, { actorId: actor.userId, orgId: current.org_id, action: "gateway.delete", targetType: "gateway", targetId: id, detail: { name: current.name } });
			});
		},

		async visibleModels(actor, opts = {}) {
			const orgs = Object.keys(actor.orgRoles);
			const rows = await deps.db.tx({ system: true }, (q) =>
				q.query<GatewayRow>(
					`SELECT ${GATEWAY_COLUMNS} FROM model_gateways
					 WHERE enabled AND ((scope = 'org' AND org_id = ANY($1::text[])) OR scope = 'platform' OR (scope = 'user' AND scope_id = $2::text))
					 ORDER BY CASE scope WHEN 'user' THEN 0 WHEN 'org' THEN 1 ELSE 2 END, created_at, id`,
					[orgs, opts.includeOwn ? actor.userId : null],
				),
			);
			return rows.flatMap((r) =>
				normalizeModels(r.models).map((m) => ({ id: m.id, name: m.name ?? m.id, format: r.format, gatewayId: r.id, gatewayName: r.name, source: r.scope === "org" || r.scope === "user" ? r.scope : ("platform" as const) })),
			);
		},
	};
}
