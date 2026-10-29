import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mergeGatewayUpdate, validateGateway } from "@prometheus/gateway";
import { type AgentProfile, type AgentServer, AppError, BUILTIN_AGENTS, type GatewayConfig } from "@prometheus/protocol";

export interface NetworkConfig {
	/** Also listen on all network interfaces. */
	lan: boolean;
	port: number;
	/** Hostnames the network listener answers to (IP literals always pass). */
	allowedHosts: string[];
	/** scrypt hash of the login password; network access cannot be on without it. */
	passwordHash?: string;
	/** Signs session tokens; replacing it signs every device out. */
	secret?: string;
}

export const DEFAULT_LAN_PORT = 7421;

export interface PrometheusConfig {
	gateways: GatewayConfig[];
	/** Custom agents, plus overrides (executable, env) of the built-in ones, keyed by id. */
	agents: AgentProfile[];
	/** npm package names or paths (relative to dataDir) of extra plugins. */
	plugins: string[];
	/** Plugin ids the user switched off. */
	disabledPlugins: string[];
	pluginSettings: Record<string, Record<string, unknown>>;
	network: NetworkConfig;
	/** Default parent directory for workspaces: the folder picker opens here and new workspaces are created inside it. */
	workspaceRoot: string;
	/** Agent id new chats start with; empty means PI. */
	defaultAgent: string;
}

function normalizeNetwork(raw: Partial<NetworkConfig> | undefined): NetworkConfig {
	const port = typeof raw?.port === "number" && Number.isInteger(raw.port) && raw.port >= 1024 && raw.port <= 65535 ? raw.port : DEFAULT_LAN_PORT;
	return {
		lan: raw?.lan === true,
		port,
		allowedHosts: Array.isArray(raw?.allowedHosts) ? raw.allowedHosts.filter((h): h is string => typeof h === "string") : [],
		...(typeof raw?.passwordHash === "string" && raw.passwordHash ? { passwordHash: raw.passwordHash } : {}),
		...(typeof raw?.secret === "string" && raw.secret ? { secret: raw.secret } : {}),
	};
}

export function defaultDataDir(): string {
	return process.env.PROMETHEUS_HOME || join(homedir(), ".prometheus");
}

const EMPTY: PrometheusConfig = { gateways: [], agents: [], plugins: [], disabledPlugins: [], pluginSettings: {}, network: normalizeNetwork(undefined), workspaceRoot: "", defaultAgent: "" };

/** config.json holds API keys, so it is always written owner-only. */
export class ConfigStore {
	private config: PrometheusConfig = structuredClone(EMPTY);
	private writing: Promise<void> = Promise.resolve();
	readonly path: string;
	readonly dataDir: string;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
		this.path = join(dataDir, "config.json");
	}

	async load(): Promise<void> {
		await mkdir(this.dataDir, { recursive: true });
		try {
			const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<PrometheusConfig>;
			this.config = {
				gateways: Array.isArray(raw.gateways) ? raw.gateways : [],
				agents: Array.isArray(raw.agents) ? raw.agents : [],
				plugins: Array.isArray(raw.plugins) ? raw.plugins : [],
				disabledPlugins: Array.isArray(raw.disabledPlugins) ? raw.disabledPlugins : [],
				pluginSettings: raw.pluginSettings ?? {},
				network: normalizeNetwork(raw.network),
				workspaceRoot: typeof raw.workspaceRoot === "string" ? raw.workspaceRoot : "",
				defaultAgent: typeof raw.defaultAgent === "string" ? raw.defaultAgent : "",
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			await this.persist();
		}
	}

	get(): Readonly<PrometheusConfig> {
		return this.config;
	}

	gateways(): GatewayConfig[] {
		return this.config.gateways;
	}

	network(): Readonly<NetworkConfig> {
		return this.config.network;
	}

	async setNetwork(next: NetworkConfig): Promise<void> {
		this.config.network = normalizeNetwork(next);
		await this.persist();
	}

	/** Empty string clears the setting, falling back to the server's home directory. */
	async setWorkspaceRoot(path: string): Promise<void> {
		this.config.workspaceRoot = path.trim();
		await this.persist();
	}

	/** Empty string (or "pi") goes back to PI. */
	async setDefaultAgent(id: string): Promise<void> {
		const next = id.trim();
		this.config.defaultAgent = next === "pi" ? "" : next;
		await this.persist();
	}

	async saveGateway(incoming: GatewayConfig): Promise<GatewayConfig> {
		const existing = this.config.gateways.find((g) => g.id === incoming.id);
		const merged = mergeGatewayUpdate(incoming, existing);
		const errors = validateGateway(merged);
		if (errors.length) throw new AppError("gatewayInvalid", { errors: errors.join("\n") });
		this.config.gateways = existing
			? this.config.gateways.map((g) => (g.id === merged.id ? merged : g))
			: [...this.config.gateways, merged];
		await this.persist();
		return merged;
	}

	agents(): AgentProfile[] {
		return this.config.agents;
	}

	async saveAgent(incoming: AgentProfile): Promise<AgentProfile> {
		const id = incoming.id.trim();
		if (!/^[a-z0-9][a-z0-9-_]{0,47}$/.test(id)) throw new AppError("generic");
		if (incoming.kind !== "claude-code" && incoming.kind !== "codex" && incoming.kind !== "opencode" && incoming.kind !== "acp") throw new AppError("generic");
		const preset = BUILTIN_AGENTS.find((a) => a.id === id);
		const builtin = preset !== undefined;
		if (preset && incoming.kind !== preset.kind) throw new AppError("generic");
		const env = Object.fromEntries(Object.entries(incoming.env ?? {}).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)));
		const args = Array.isArray(incoming.args) ? incoming.args.filter((a): a is string => typeof a === "string" && a.length > 0).slice(0, 64) : undefined;
		const server = incoming.kind === "opencode" ? normalizeServer(incoming.server) : undefined;
		const saved: AgentProfile = {
			id,
			name: incoming.name?.trim() || id,
			kind: incoming.kind,
			...(incoming.executable?.trim() ? { executable: incoming.executable.trim() } : {}),
			...(args && (args.length || incoming.kind === "acp") ? { args } : {}),
			...(server ? { server } : {}),
			...(Object.keys(env).length ? { env } : {}),
			enabled: incoming.enabled !== false,
			...(builtin ? { builtin: true } : {}),
		};
		const exists = this.config.agents.some((a) => a.id === id);
		this.config.agents = exists ? this.config.agents.map((a) => (a.id === id ? saved : a)) : [...this.config.agents, saved];
		await this.persist();
		return saved;
	}

	async deleteAgent(id: string): Promise<void> {
		this.config.agents = this.config.agents.filter((a) => a.id !== id);
		await this.persist();
	}

	async deleteGateway(id: string): Promise<void> {
		this.config.gateways = this.config.gateways.filter((g) => g.id !== id);
		await this.persist();
	}

	async setPluginDisabled(id: string, disabled: boolean): Promise<void> {
		const rest = this.config.disabledPlugins.filter((p) => p !== id);
		this.config.disabledPlugins = disabled ? [...rest, id] : rest;
		await this.persist();
	}

	private persist(): Promise<void> {
		const run = async () => {
			const tmp = `${this.path}.tmp`;
			await writeFile(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
			await rename(tmp, this.path);
			await chmod(this.path, 0o600).catch(() => {});
		};
		this.writing = this.writing.then(run, run);
		return this.writing;
	}
}

/** Keeps a usable server setting: an http(s) URL, or a TCP port Prometheus can listen on. Empty means none. */
export function normalizeServer(raw: AgentServer | undefined): AgentServer | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const out: AgentServer = {};
	const url = typeof raw.url === "string" ? raw.url.trim().replace(/\/+$/, "") : "";
	if (url) {
		let parsed: URL;
		try {
			parsed = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`);
		} catch {
			throw new AppError("generic");
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new AppError("generic");
		out.url = parsed.toString().replace(/\/+$/, "");
	}
	const port = Number(raw.port);
	if (!out.url && raw.port !== undefined && raw.port !== null && String(raw.port) !== "") {
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError("generic");
		out.port = port;
	}
	if (typeof raw.username === "string" && raw.username.trim()) out.username = raw.username.trim();
	if (typeof raw.password === "string" && raw.password) out.password = raw.password;
	return out.url || out.port ? out : undefined;
}
