/**
 * Plugin configuration, persisted as JSON in the plugin's data dir.
 *
 * Kept separate from Prometheus' `pluginSettings` so the panel can change everything at runtime
 * without a host restart, and so the file can hold proxy credentials at mode 0600.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { builtinRules, DEFAULT_ALLOWLIST, type Rule } from "./engine/rules.ts";
import type { ProxySettings } from "./proxy/transport.ts";

export interface VeilConfig {
	/** Replace secrets with placeholders on the way out, restore them on the way back. */
	redaction: boolean;
	/** Route requests through the local relay so the exit proxy applies. */
	relay: boolean;
	/** Bind port of the local relay. */
	relayPort: number;
	/** Upstream the relay forwards to when a request arrives with a bare path. */
	upstream: string;
	/** gateway id -> real upstream base URL, captured when the relay is switched on. */
	routes: Record<string, string>;
	/** Rewrite region-bearing headers to the neutral values below. */
	regionNeutral: boolean;
	acceptLanguage: string;
	proxy: ProxySettings;
	rules: Rule[];
	allowlist: string[];
	/** Built-in packs, so the user can hide a whole category without deleting rules. */
	packs: { secrets: boolean; region: boolean };
	/** Drop mappings untouched for this many days; 0 keeps them forever. */
	mappingTtlDays: number;
}

export const DEFAULT_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

export function defaultConfig(): VeilConfig {
	return {
		redaction: true,
		relay: false,
		relayPort: 18787,
		upstream: "",
		routes: {},
		regionNeutral: true,
		acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
		proxy: { kind: "none", server: "" },
		rules: builtinRules(),
		allowlist: [...DEFAULT_ALLOWLIST],
		packs: { secrets: true, region: true },
		mappingTtlDays: 90,
	};
}

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Merges a stored file over the defaults; unknown or malformed fields fall back instead of throwing. */
export function normalizeConfig(raw: Partial<VeilConfig> | undefined): VeilConfig {
	const base = defaultConfig();
	if (!raw || typeof raw !== "object") return base;
	const packs = {
		secrets: bool(raw.packs?.secrets, base.packs.secrets),
		region: bool(raw.packs?.region, base.packs.region),
	};
	const builtin = builtinRules(packs);
	const storedRules = Array.isArray(raw.rules) ? raw.rules.filter(isRule) : [];
	// Built-in rules always exist (so a new app version can ship new ones); the stored file only
	// carries their enabled flag and the user's own custom rules.
	const rules = mergeRules(builtin, storedRules);
	const proxyRaw = raw.proxy ?? base.proxy;
	const kind = proxyRaw.kind === "http" || proxyRaw.kind === "socks5" || proxyRaw.kind === "none" ? proxyRaw.kind : "none";
	return {
		redaction: bool(raw.redaction, base.redaction),
		relay: bool(raw.relay, base.relay),
		relayPort: clampPort(num(raw.relayPort, base.relayPort), base.relayPort),
		upstream: str(raw.upstream, base.upstream).trim(),
		routes: isStringRecord(raw.routes) ? raw.routes : {},
		regionNeutral: bool(raw.regionNeutral, base.regionNeutral),
		acceptLanguage: str(raw.acceptLanguage, base.acceptLanguage).trim() || base.acceptLanguage,
		proxy: {
			kind,
			server: str(proxyRaw.server, "").trim(),
			...(proxyRaw.username ? { username: String(proxyRaw.username) } : {}),
			...(proxyRaw.password ? { password: String(proxyRaw.password) } : {}),
		},
		rules,
		allowlist: Array.isArray(raw.allowlist) ? raw.allowlist.filter((x): x is string => typeof x === "string") : [...base.allowlist],
		packs,
		mappingTtlDays: Math.max(0, num(raw.mappingTtlDays, base.mappingTtlDays)),
	};
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every((v) => typeof v === "string");
}

function clampPort(value: number, fallback: number): number {
	const port = Math.round(value);
	return port >= 1024 && port <= 65535 ? port : fallback;
}

function isRule(value: unknown): value is Rule {
	if (!value || typeof value !== "object") return false;
	const r = value as Partial<Rule>;
	return typeof r.id === "string" && r.id.length > 0 && typeof r.typePrefix === "string";
}

/** Built-in rules keep their shipped definition but honour a stored `enabled` flag; custom rules pass through. */
function mergeRules(builtin: Rule[], stored: Rule[]): Rule[] {
	const byId = new Map(stored.map((r) => [r.id, r]));
	const out: Rule[] = [];
	for (const rule of builtin) {
		const saved = byId.get(rule.id);
		if (saved?.kind === rule.kind) {
			out.push({ ...rule, enabled: saved.enabled !== false, priority: typeof saved.priority === "number" ? saved.priority : rule.priority });
			byId.delete(rule.id);
		} else {
			out.push(rule);
		}
	}
	// Whatever is left was added by the user.
	for (const rule of byId.values()) out.push(rule);
	return out;
}

export class ConfigFile {
	private config: VeilConfig = defaultConfig();
	private writing: Promise<void> = Promise.resolve();

	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	static in(dataDir: string): ConfigFile {
		return new ConfigFile(join(dataDir, "config.json"));
	}

	get(): VeilConfig {
		return this.config;
	}

	async load(): Promise<VeilConfig> {
		try {
			this.config = normalizeConfig(JSON.parse(await readFile(this.path, "utf8")) as Partial<VeilConfig>);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.config = defaultConfig();
		}
		return this.config;
	}

	async save(next: VeilConfig): Promise<VeilConfig> {
		this.config = normalizeConfig(next);
		const body = JSON.stringify(this.config, null, 2);
		const target = this.path;
		const run = async () => {
			await mkdir(dirname(target), { recursive: true });
			const tmp = `${target}.tmp`;
			// Owner-only: the file may hold proxy credentials.
			await writeFile(tmp, body, { mode: 0o600 });
			await rename(tmp, target);
		};
		this.writing = this.writing.then(run, run);
		await this.writing;
		return this.config;
	}

	flush(): Promise<void> {
		return this.writing;
	}
}
