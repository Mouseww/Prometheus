import type { GatewayConfig, GatewayFormat, GatewayModel, ModelPricing } from "@prometheus/protocol";
import { GATEWAY_FORMATS } from "@prometheus/protocol";

export const DEFAULT_CATALOG_URL = "https://models.opencode.ai/api.json";

/** Defaults a catalogue can supply for one model id; every field is optional. */
export type ModelDefaults = Pick<GatewayModel, "name" | "contextWindow" | "maxTokens" | "reasoning" | "vision" | "cost">;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

const normId = (id: string) => id.toLowerCase().replace(/^.*\//, "").replace(/[\s_.:]+/g, "-");

export interface ModelCatalog {
	exact: Map<string, ModelDefaults>;
	loose: Map<string, ModelDefaults>;
	count: number;
}

/**
 * Parses a models.dev style catalogue (`{ provider: { models: { id: { limit, cost, reasoning, modalities } } } }`),
 * as served by https://models.opencode.ai/api.json. The first entry for an id wins.
 */
export function parseModelCatalog(json: unknown): ModelCatalog {
	const catalog: ModelCatalog = { exact: new Map(), loose: new Map(), count: 0 };
	if (!isRecord(json)) throw new Error("模型目录格式不正确");
	for (const provider of Object.values(json)) {
		if (!isRecord(provider) || !isRecord(provider.models)) continue;
		for (const [key, raw] of Object.entries(provider.models)) {
			if (!isRecord(raw)) continue;
			const id = typeof raw.id === "string" && raw.id ? raw.id : key;
			const d: ModelDefaults = {};
			if (typeof raw.name === "string" && raw.name) d.name = raw.name;
			if (isRecord(raw.limit)) {
				const context = num(raw.limit.context);
				const output = num(raw.limit.output);
				if (context) d.contextWindow = context;
				if (output) d.maxTokens = output;
			}
			if (typeof raw.reasoning === "boolean") d.reasoning = raw.reasoning;
			const input = isRecord(raw.modalities) && Array.isArray(raw.modalities.input) ? raw.modalities.input : undefined;
			if (input) d.vision = input.includes("image");
			else if (typeof raw.attachment === "boolean") d.vision = raw.attachment;
			if (isRecord(raw.cost)) {
				const cost: ModelPricing = {
					input: num(raw.cost.input) ?? 0,
					output: num(raw.cost.output) ?? 0,
					cacheRead: num(raw.cost.cache_read) ?? 0,
					cacheWrite: num(raw.cost.cache_write) ?? 0,
				};
				if (cost.input || cost.output) d.cost = cost;
			}
			if (!Object.keys(d).length) continue;
			catalog.count++;
			if (!catalog.exact.has(id.toLowerCase())) catalog.exact.set(id.toLowerCase(), d);
			if (!catalog.loose.has(normId(id))) catalog.loose.set(normId(id), d);
		}
	}
	return catalog;
}

/** Looks up defaults per requested id (exact first, then ignoring vendor prefix, case and separators). */
export function matchModelDefaults(catalog: ModelCatalog, ids: string[]): Record<string, ModelDefaults> {
	const out: Record<string, ModelDefaults> = {};
	for (const id of ids) {
		const hit = catalog.exact.get(id.toLowerCase()) ?? catalog.loose.get(normId(id));
		if (hit) out[id] = hit;
	}
	return out;
}

// ---------- PI agent's own models.json ----------

export interface PiGatewayCandidate {
	gateway: GatewayConfig;
	/** The key could not be resolved (shell command or unset variable), so the gateway cannot be saved yet. */
	missingKey: boolean;
}

/**
 * Turns the `providers` of PI's `models.json` into gateways. `$NAME`, `${NAME}` and bare environment variable names
 * are resolved from `env`; `auth.json` api_key credentials fill in missing keys; `!command` values are never executed here and leave the key missing.
 */
export function parsePiModels(json: unknown, env: NodeJS.ProcessEnv = process.env, auth?: unknown): PiGatewayCandidate[] {
	if (!isRecord(json) || !isRecord(json.providers)) return [];
	const out: PiGatewayCandidate[] = [];
	const resolve = (value: unknown): string | undefined => {
		if (typeof value !== "string" || !value.trim()) return undefined;
		const v = value.trim();
		if (v.startsWith("!")) return undefined;
		const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(v)?.[1] ?? (/^[A-Z][A-Z0-9_]{2,}$/.test(v) ? v : undefined);
		return ref ? env[ref] || undefined : v;
	};
	for (const [name, raw] of Object.entries(json.providers)) {
		if (!isRecord(raw)) continue;
		const format = raw.api as GatewayFormat;
		if (!GATEWAY_FORMATS.includes(format) || typeof raw.baseUrl !== "string" || !Array.isArray(raw.models)) continue;
		const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").slice(0, 48);
		if (!id) continue;
		const models: GatewayModel[] = [];
		for (const m of raw.models) {
			if (!isRecord(m) || typeof m.id !== "string" || !m.id.trim()) continue;
			const model: GatewayModel = { id: m.id.trim() };
			if (typeof m.name === "string" && m.name) model.name = m.name;
			if (typeof m.reasoning === "boolean") model.reasoning = m.reasoning;
			if (Array.isArray(m.input)) model.vision = m.input.includes("image");
			const cw = num(m.contextWindow);
			const mt = num(m.maxTokens);
			if (cw) model.contextWindow = cw;
			if (mt) model.maxTokens = mt;
			if (isRecord(m.cost)) {
				const cost = { input: num(m.cost.input) ?? 0, output: num(m.cost.output) ?? 0, cacheRead: num(m.cost.cacheRead) ?? 0, cacheWrite: num(m.cost.cacheWrite) ?? 0 };
				if (cost.input || cost.output) model.cost = cost;
			}
			models.push(model);
		}
		if (!models.length) continue;
		const headers: Record<string, string> = {};
		if (isRecord(raw.headers)) {
			for (const [k, v] of Object.entries(raw.headers)) {
				const val = resolve(v);
				if (val) headers[k] = val;
			}
		}
		// models.json may omit the key because `/login` stored it in auth.json (api_key credentials only; OAuth tokens are PI's to refresh).
		let apiKey = resolve(raw.apiKey);
		if (!apiKey && isRecord(auth)) {
			const cred = auth[name] ?? auth[id];
			if (isRecord(cred) && cred.type === "api_key") apiKey = resolve(cred.key);
		}
		out.push({
			gateway: {
				id,
				name: typeof raw.name === "string" && raw.name ? raw.name : name,
				format,
				baseUrl: raw.baseUrl.trim(),
				auth: raw.authHeader === true ? { type: "bearer" } : { type: "native" },
				apiKey: apiKey ?? "",
				headers,
				models,
				enabled: true,
			},
			missingKey: !apiKey,
		});
	}
	return out;
}
