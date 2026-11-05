import type { SecretBox } from "../crypto.ts";
import type { Db } from "../db/db.ts";
import { LOG_PREFIX, type HubLog } from "../log.ts";
import { GATEWAY_COLUMNS, type GatewayFormat, type GatewayModel, type GatewayRow, normalizeModels } from "../services/models.ts";

export interface SelectedGateway {
	id: string;
	scope: "platform" | "org" | "user";
	orgId: string | null;
	name: string;
	format: GatewayFormat;
	baseUrl: string;
	apiKey: string;
	models: GatewayModel[];
}

export interface Selection {
	chosen: SelectedGateway | undefined;
	/** Gateways that matched the format; when `chosen` is missing and this is > 0 the requested model is the problem. */
	candidates: number;
}

/**
 * Enabled gateways usable by someone belonging to `orgIds`: the user's own gateways first (only when `userId` is given,
 * i.e. BYOK is allowed for them), then organization gateways, then platform ones.
 * A gateway with an empty model list serves any model.
 */
export async function selectGateway(
	db: Db,
	secretBox: SecretBox,
	log: HubLog,
	query: {
		orgIds: readonly string[];
		format?: GatewayFormat;
		model?: string;
		/** Hub-initiated calls need a concrete model to name. */
		requireModels?: boolean;
		/** Include this user's personal gateways. Leave out when BYOK is disabled for them. */
		userId?: string;
	},
): Promise<Selection> {
	const rows = await db.tx({ system: true }, (q) =>
		q.query<GatewayRow>(
			`SELECT ${GATEWAY_COLUMNS} FROM model_gateways
			 WHERE enabled AND ($2::text IS NULL OR format = $2)
			   AND ((scope = 'org' AND org_id = ANY($1::text[])) OR scope = 'platform' OR (scope = 'user' AND scope_id = $3::text))
			 ORDER BY CASE scope WHEN 'user' THEN 0 WHEN 'org' THEN 1 ELSE 2 END, created_at, id`,
			[[...query.orgIds], query.format ?? null, query.userId ?? null],
		),
	);
	let candidates = 0;
	for (const row of rows) {
		const models = normalizeModels(row.models);
		candidates++;
		if (query.model !== undefined && models.length > 0 && !models.some((m) => m.id === query.model)) continue;
		if (query.requireModels && models.length === 0) continue;
		let apiKey: string;
		try {
			apiKey = secretBox.open(row.api_key_enc);
		} catch {
			log.warn(`${LOG_PREFIX} 网关 ${row.id} 的密钥无法解密，已跳过`);
			continue;
		}
		return { candidates, chosen: { id: row.id, scope: row.scope === "org" || row.scope === "user" ? row.scope : "platform", orgId: row.org_id, name: row.name, format: row.format, baseUrl: row.base_url, apiKey, models } };
	}
	return { chosen: undefined, candidates };
}
