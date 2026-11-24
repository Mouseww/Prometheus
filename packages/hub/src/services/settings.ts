import type { Queryable } from "../db/db.ts";
import type { ServiceDeps } from "./common.ts";

export interface SettingsService {
	get<T = unknown>(key: string, q?: Queryable): Promise<T | undefined>;
	set(q: Queryable, key: string, value: unknown): Promise<void>;
	/** Effective value: the stored boolean, or the mode default (public true, private false) while unset. */
	allowPersonalTeams(q?: Queryable): Promise<boolean>;
	defaultOrgId(q?: Queryable): Promise<string | undefined>;
	/** Public mode: may any verified user create an organization? Defaults to true when unset. */
	allowSelfCreateOrg(q?: Queryable): Promise<boolean>;
	/** Name shown in invitation mails; empty until the operator sets one. */
	siteName(q?: Queryable): Promise<string>;
	/** How many days an invitation link stays valid. */
	invitationTtlDays(q?: Queryable): Promise<number>;
}

export const DEFAULT_INVITATION_TTL_DAYS = 7;
export const MIN_INVITATION_TTL_DAYS = 1;
export const MAX_INVITATION_TTL_DAYS = 30;

/** Platform wide settings (`platform_settings`): allow_personal_teams, default_org_id. */
export function createSettingsService(deps: ServiceDeps, opts: { mode?: "private" | "public" } = {}): SettingsService {
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
			// Unset (null) means the mode default: individuals create their own teams on the public service, not in a private deployment.
			const v = await get<boolean | null>("allow_personal_teams", q);
			return typeof v === "boolean" ? v : opts.mode === "public";
		},
		async allowSelfCreateOrg(q) {
			return (await get<boolean>("allow_self_create_org", q)) !== false;
		},
		async siteName(q) {
			const v = await get<string | null>("site_name", q);
			return typeof v === "string" ? v : "";
		},
		async invitationTtlDays(q) {
			const v = await get<number | null>("invitation_ttl_days", q);
			return typeof v === "number" && v >= MIN_INVITATION_TTL_DAYS && v <= MAX_INVITATION_TTL_DAYS ? Math.floor(v) : DEFAULT_INVITATION_TTL_DAYS;
		},
		async defaultOrgId(q) {
			const v = await get<string | null>("default_org_id", q);
			return typeof v === "string" ? v : undefined;
		},
	};
}
