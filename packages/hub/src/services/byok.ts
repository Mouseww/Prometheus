import type { HubConfig } from "../config.ts";
import { toIso } from "../db/db.ts";
import type { Queryable } from "../db/db.ts";
import type { SecretBox } from "../crypto.ts";
import { badRequest, forbidden, HubError, notFound } from "../errors.ts";
import { ulid } from "../ids.ts";
import { resolveSafeTarget, type SafeUrlPolicy } from "../net/safe-url.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { AuditService } from "./audit.ts";
import { type ServiceDeps, scopeOf } from "./common.ts";
import { GATEWAY_COLUMNS, type GatewayFormat, type GatewayModel, type GatewayRow, maskKey, normalizeModels, validateBaseUrl } from "./models.ts";
import type { SettingsService } from "./settings.ts";

/** Platform setting key; an organization can override it with the same key in `organizations.settings`. */
export const ALLOW_BYOK_KEY = "allow_byok";
export const MAX_USER_GATEWAYS = 10;

/** The SSRF policy user gateways are held to, from the Hub configuration. */
export const safeUrlPolicyOf = (config: HubConfig): SafeUrlPolicy => ({ mode: config.mode, allowedPorts: config.byokAllowedPorts, blockPrivate: config.byokBlockPrivate });

export interface UserGatewayView {
	id: string;
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

export interface CreateUserGatewayInput {
	name: string;
	format: GatewayFormat;
	baseUrl: string;
	apiKey: string;
	models?: readonly (GatewayModel | string)[];
	enabled?: boolean;
}

export type UpdateUserGatewayInput = Partial<CreateUserGatewayInput>;

export interface ByokSettingsView {
	/** Effective switch for the platform setting alone. */
	platform: boolean;
	/** The organization override, null when it follows the platform. */
	org: boolean | null;
}

export interface ByokService {
	list(actor: Actor): Promise<UserGatewayView[]>;
	create(actor: Actor, input: CreateUserGatewayInput): Promise<UserGatewayView>;
	update(actor: Actor, id: string, input: UpdateUserGatewayInput): Promise<UserGatewayView>;
	remove(actor: Actor, id: string): Promise<void>;
	/** Whether a user belonging to `orgIds` may add and use personal gateways: any organization override wins over the platform setting, `false` beating `true`. */
	isAllowed(orgIds: readonly string[]): Promise<boolean>;
	getSettings(actor: Actor, orgId?: string): Promise<ByokSettingsView>;
	/** Operators set either scope; organization admins may only restrict their own organization. `null` clears the setting. */
	setAllowed(actor: Actor, input: { scope: "platform" | "org"; orgId?: string; allowed: boolean | null }): Promise<ByokSettingsView>;
}

export function createByokService(deps: ServiceDeps, secretBox: SecretBox, audit: AuditService, settings: SettingsService, policy: SafeUrlPolicy): ByokService {
	const view = (r: GatewayRow): UserGatewayView => {
		let masked = "****";
		try {
			masked = maskKey(secretBox.open(r.api_key_enc));
		} catch {
			// Sealed with another master key: unusable, but the mask still shows that a key is stored.
		}
		return {
			id: r.id,
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

	const load = async (q: Queryable, actor: Actor, id: string): Promise<GatewayRow> => {
		const rows = await q.query<GatewayRow>(`SELECT ${GATEWAY_COLUMNS} FROM model_gateways WHERE id = $1 AND scope = 'user' AND scope_id = $2`, [id, actor.userId]);
		if (!rows[0]) throw notFound("网关不存在");
		return rows[0];
	};

	const checkUrl = async (raw: string): Promise<string> => {
		const normalized = validateBaseUrl(raw);
		await resolveSafeTarget(normalized, policy);
		return normalized;
	};

	const allowedFor = async (orgIds: readonly string[], q?: Queryable): Promise<boolean> => {
		const platform = (await settings.get<boolean>(ALLOW_BYOK_KEY, q)) !== false;
		if (orgIds.length === 0) return platform;
		const rows = await (q ?? deps.db).query<{ v: unknown }>("SELECT settings -> 'allow_byok' AS v FROM organizations WHERE id = ANY($1::text[])", [[...orgIds]]);
		const explicit = rows.map((r) => r.v).filter((v): v is boolean => typeof v === "boolean");
		if (explicit.includes(false)) return false;
		if (explicit.includes(true)) return true;
		return platform;
	};

	const settingsView = async (orgId: string | undefined, q?: Queryable): Promise<ByokSettingsView> => {
		const platform = (await settings.get<boolean>(ALLOW_BYOK_KEY, q)) !== false;
		let org: boolean | null = null;
		if (orgId) {
			const rows = await (q ?? deps.db).query<{ v: unknown }>("SELECT settings -> 'allow_byok' AS v FROM organizations WHERE id = $1", [orgId]);
			if (rows.length === 0) throw notFound("企业不存在");
			org = typeof rows[0]?.v === "boolean" ? rows[0].v : null;
		}
		return { platform, org };
	};

	return {
		async list(actor) {
			const rows = await deps.db.tx(scopeOf(actor), (q) =>
				q.query<GatewayRow>(`SELECT ${GATEWAY_COLUMNS} FROM model_gateways WHERE scope = 'user' AND scope_id = $1 ORDER BY created_at, id`, [actor.userId]),
			);
			return rows.map(view);
		},

		async create(actor, input) {
			if (!(await allowedFor(Object.keys(actor.orgRoles)))) throw new HubError(403, "byokDisabled", "当前已禁用自带模型");
			const baseUrl = await checkUrl(input.baseUrl);
			const id = ulid(deps.now());
			const row = await deps.db.tx(scopeOf(actor), async (q) => {
				const count = await q.query<{ n: string | number }>("SELECT count(*) AS n FROM model_gateways WHERE scope = 'user' AND scope_id = $1", [actor.userId]);
				if (Number(count[0]?.n ?? 0) >= MAX_USER_GATEWAYS) throw badRequest(`最多可添加 ${MAX_USER_GATEWAYS} 个个人网关`, "limitReached");
				const rows = await q.query<GatewayRow>(
					`INSERT INTO model_gateways (id, scope, scope_id, org_id, name, format, base_url, api_key_enc, models, enabled)
					 VALUES ($1,'user',$2,NULL,$3,$4,$5,$6,$7::text::jsonb,$8) RETURNING ${GATEWAY_COLUMNS}`,
					[id, actor.userId, input.name, input.format, baseUrl, secretBox.seal(input.apiKey), JSON.stringify(normalizeModels(input.models ?? [])), input.enabled ?? true],
				);
				await audit.write(q, { actorId: actor.userId, action: "byok.create", targetType: "gateway", targetId: id, detail: { name: input.name, format: input.format } });
				return rows[0] as GatewayRow;
			});
			return view(row);
		},

		async update(actor, id, input) {
			const baseUrl = input.baseUrl !== undefined ? await checkUrl(input.baseUrl) : undefined;
			const row = await deps.db.tx(scopeOf(actor), async (q) => {
				const current = await load(q, actor, id);
				const sets: string[] = [];
				const params: unknown[] = [id];
				const set = (column: string, value: unknown, cast = ""): void => {
					params.push(value);
					sets.push(`${column} = $${params.length}${cast}`);
				};
				if (input.name !== undefined) set("name", input.name);
				if (input.format !== undefined) set("format", input.format);
				if (baseUrl !== undefined) set("base_url", baseUrl);
				if (input.apiKey !== undefined) set("api_key_enc", secretBox.seal(input.apiKey));
				if (input.models !== undefined) set("models", JSON.stringify(normalizeModels(input.models)), "::text::jsonb");
				if (input.enabled !== undefined) set("enabled", input.enabled);
				if (sets.length === 0) return current;
				const rows = await q.query<GatewayRow>(`UPDATE model_gateways SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${GATEWAY_COLUMNS}`, params);
				await audit.write(q, {
					actorId: actor.userId,
					action: "byok.update",
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
				const current = await load(q, actor, id);
				await q.query("DELETE FROM model_gateways WHERE id = $1", [id]);
				await audit.write(q, { actorId: actor.userId, action: "byok.delete", targetType: "gateway", targetId: id, detail: { name: current.name } });
			});
		},

		isAllowed: (orgIds) => allowedFor(orgIds),

		async getSettings(actor, orgId) {
			if (orgId) {
				if (!can(actor, "org.manage", { orgId })) throw forbidden();
			} else if (!can(actor, "platform.manage")) {
				throw forbidden();
			}
			return settingsView(orgId);
		},

		async setAllowed(actor, input) {
			return deps.db.tx(scopeOf(actor), async (q) => {
				if (input.scope === "platform") {
					if (!can(actor, "platform.manage")) throw forbidden();
					if (input.allowed === null) await q.query("DELETE FROM platform_settings WHERE key = $1", [ALLOW_BYOK_KEY]);
					else await settings.set(q, ALLOW_BYOK_KEY, input.allowed);
					await audit.write(q, { actorId: actor.userId, action: "byok.setting", targetType: "platform", detail: { allowed: input.allowed } });
					return settingsView(undefined, q);
				}
				const orgId = input.orgId;
				if (!orgId) throw badRequest("企业范围需要 orgId", "validationError");
				if (!can(actor, "org.manage", { orgId })) throw forbidden();
				if (!actor.operator && input.allowed === true) throw forbidden("企业管理员只能限制自带模型，不能放开", "forbidden");
				const updated = await q.query(
					`UPDATE organizations SET settings = CASE WHEN $2::text IS NULL THEN settings - 'allow_byok' ELSE jsonb_set(settings, '{allow_byok}', $2::text::jsonb) END, updated_at = now()
					 WHERE id = $1 RETURNING id`,
					[orgId, input.allowed === null ? null : JSON.stringify(input.allowed)],
				);
				if (updated.length === 0) throw notFound("企业不存在");
				await audit.write(q, { actorId: actor.userId, orgId, action: "byok.setting", targetType: "org", targetId: orgId, detail: { allowed: input.allowed } });
				return settingsView(orgId, q);
			});
		},
	};
}
