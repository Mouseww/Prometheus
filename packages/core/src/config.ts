import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mergeGatewayUpdate, validateGateway } from "@prometheus/gateway";
import type { GatewayConfig } from "@prometheus/protocol";

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
	/** npm package names or paths (relative to dataDir) of extra plugins. */
	plugins: string[];
	/** Plugin ids the user switched off. */
	disabledPlugins: string[];
	pluginSettings: Record<string, Record<string, unknown>>;
	network: NetworkConfig;
	/** Default parent directory for workspaces: the folder picker opens here and new workspaces are created inside it. */
	workspaceRoot: string;
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

const EMPTY: PrometheusConfig = { gateways: [], plugins: [], disabledPlugins: [], pluginSettings: {}, network: normalizeNetwork(undefined), workspaceRoot: "" };

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
				plugins: Array.isArray(raw.plugins) ? raw.plugins : [],
				disabledPlugins: Array.isArray(raw.disabledPlugins) ? raw.disabledPlugins : [],
				pluginSettings: raw.pluginSettings ?? {},
				network: normalizeNetwork(raw.network),
				workspaceRoot: typeof raw.workspaceRoot === "string" ? raw.workspaceRoot : "",
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

	async saveGateway(incoming: GatewayConfig): Promise<GatewayConfig> {
		const existing = this.config.gateways.find((g) => g.id === incoming.id);
		const merged = mergeGatewayUpdate(incoming, existing);
		const errors = validateGateway(merged);
		if (errors.length) throw new Error(errors.join("；"));
		this.config.gateways = existing
			? this.config.gateways.map((g) => (g.id === merged.id ? merged : g))
			: [...this.config.gateways, merged];
		await this.persist();
		return merged;
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
