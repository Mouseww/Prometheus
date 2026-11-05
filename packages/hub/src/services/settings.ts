import type { Queryable } from "../db/db.ts";
import type { ServiceDeps } from "./common.ts";

export interface SettingsService {
	get<T = unknown>(key: string, q?: Queryable): Promise<T | undefined>;
	set(q: Queryable, key: string, value: unknown): Promise<void>;
	allowPersonalTeams(q?: Queryable): Promise<boolean>;
	defaultOrgId(q?: Queryable): Promise<string | undefined>;
	/** Public mode: may any verified user create an organization? Defaults to true when unset. */
	allowSelfCreateOrg(q?: Queryable): Promise<boolean>;
}

/** Platform wide settings (`platform_settings`): allow_personal_teams, default_org_id. */
export function createSettingsService(deps: ServiceDeps): SettingsService {
	const get = async <T>(key: string, q?: Queryable): Promise<T | undefined> => {
		const rows = await (q ?? deps.db).query<{ value: T }>("SELECT value FROM platform_settings WHERE key = $1", [key]);
		return rows[0]?.value;
	};
	return {
		get,
		async set(q, key, value) {
			await q.query(
				"INSERT INTO platform_settings (key, value) VALUES ($1, $2::text::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
				[key, JSON.stringify(value)],
			);
		},
		async allowPersonalTeams(q) {
			return (await get<boolean>("allow_personal_teams", q)) === true;
		},
		async allowSelfCreateOrg(q) {
			return (await get<boolean>("allow_self_create_org", q)) !== false;
		},
		async defaultOrgId(q) {
			const v = await get<string | null>("default_org_id", q);
			return typeof v === "string" ? v : undefined;
		},
	};
}
