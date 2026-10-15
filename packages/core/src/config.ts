import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mergeGatewayUpdate, validateGateway } from "@prometheus/gateway";
import type { GatewayConfig } from "@prometheus/protocol";

export interface PrometheusConfig {
	gateways: GatewayConfig[];
	/** npm package names or paths (relative to dataDir) of extra plugins. */
	plugins: string[];
	pluginSettings: Record<string, Record<string, unknown>>;
}

export function defaultDataDir(): string {
	return process.env.PROMETHEUS_HOME || join(homedir(), ".prometheus");
}

const EMPTY: PrometheusConfig = { gateways: [], plugins: [], pluginSettings: {} };

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
				pluginSettings: raw.pluginSettings ?? {},
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
