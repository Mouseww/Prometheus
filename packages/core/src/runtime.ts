import { join } from "node:path";
import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { toProviderConfig } from "@prometheus/gateway";
import { KnowledgeService, knowledgeExtension } from "@prometheus/knowledge";
import type { HostKind, PrometheusPlugin } from "@prometheus/plugin-sdk";
import { ConfigStore, defaultDataDir } from "./config.ts";
import { PluginHost } from "./plugin-host.ts";

export interface BootstrapOptions {
	host: HostKind;
	dataDir?: string;
	cwd?: string;
	/** Plugins bundled by the app (e.g. knowledge-lancedb), loaded before user plugins. */
	builtinPlugins?: PrometheusPlugin[];
}

export interface Runtime {
	dataDir: string;
	config: ConfigStore;
	plugins: PluginHost;
	knowledge: KnowledgeService;
	/** PI extensions contributed by built-ins and plugins, ready for DefaultResourceLoader or main(). */
	extensions(): InlineExtension[];
	dispose(): Promise<void>;
}

/** Shared by the server and the TUI so both hosts see the same plugins, gateways and knowledge bases. */
export async function bootstrap(options: BootstrapOptions): Promise<Runtime> {
	const dataDir = options.dataDir ?? defaultDataDir();
	const config = new ConfigStore(dataDir);
	await config.load();

	const plugins = new PluginHost({
		host: options.host,
		dataDir,
		agentDir: getAgentDir(),
		cwd: options.cwd ?? process.cwd(),
		settings: (name) => config.get().pluginSettings[name] ?? {},
		gateways: () => config.gateways(),
	});

	const knowledge = new KnowledgeService({
		dataDir: join(dataDir, "knowledge"),
		stores: () => plugins.stores,
		gateways: () => config.gateways(),
	});
	await knowledge.load();

	await plugins.load(
		{ name: "knowledge", version: "0.1.0", setup: (ctx) => ctx.extension(knowledgeExtension(knowledge)) },
		"builtin",
	);
	for (const plugin of options.builtinPlugins ?? []) await plugins.load(plugin, "builtin");
	for (const spec of config.get().plugins) await plugins.loadSpecifier(spec, "config");
	await plugins.loadDirectory(join(dataDir, "plugins"));

	for (const p of plugins.list()) {
		if (p.status === "error") console.warn(`[prometheus] 插件加载失败 ${p.name}: ${p.error}`);
	}

	return {
		dataDir,
		config,
		plugins,
		knowledge,
		extensions: () => [...plugins.extensions],
		dispose: () => plugins.dispose(),
	};
}

/** TUI path: gateways are injected through a PI extension because main() owns its ModelRuntime. */
export function gatewayExtension(config: ConfigStore): ExtensionFactory {
	return (pi) => {
		for (const g of config.gateways()) {
			if (g.enabled === false) continue;
			pi.registerProvider(g.id, toProviderConfig(g) as Parameters<typeof pi.registerProvider>[1]);
		}
	};
}
