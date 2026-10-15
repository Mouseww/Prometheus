import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { HostKind, HttpMethod, KnowledgeStoreFactory, PluginContext, PrometheusPlugin, RouteHandler, RpcHandler } from "@prometheus/plugin-sdk";
import type { GatewayConfig, PanelInfo, PluginInfo } from "@prometheus/protocol";

export interface PluginRoute {
	method: HttpMethod;
	/** Full path, e.g. /plugins/foo/status */
	path: string;
	handler: RouteHandler;
}

export interface PluginHostOptions {
	host: HostKind;
	dataDir: string;
	agentDir: string;
	cwd: string;
	settings: (name: string) => Record<string, unknown>;
	gateways: () => GatewayConfig[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]{0,63}$/;
const METHOD_PATTERN = /^[a-zA-Z][\w.]{0,63}$/;

export class PluginHost {
	readonly extensions: InlineExtension[] = [];
	readonly stores = new Map<string, KnowledgeStoreFactory>();
	readonly routes: PluginRoute[] = [];
	/** Keyed by `<plugin>/<method>`. */
	readonly rpcs = new Map<string, RpcHandler>();
	/** Set by the session host; a no-op in the TUI where PI owns the session. */
	reloadSessions: () => Promise<void> = async () => {};
	private readonly infos: PluginInfo[] = [];
	private readonly disposers: (() => void | Promise<void>)[] = [];
	private readonly options: PluginHostOptions;

	constructor(options: PluginHostOptions) {
		this.options = options;
	}

	list(): PluginInfo[] {
		return this.infos;
	}

	panels(): PanelInfo[] {
		return this.infos.flatMap((p) => p.panels);
	}

	async load(plugin: PrometheusPlugin, source: PluginInfo["source"]): Promise<void> {
		const info: PluginInfo = { name: plugin?.name ?? "unknown", version: plugin?.version, source, status: "loaded", panels: [] };
		this.infos.push(info);
		try {
			if (!plugin || typeof plugin.setup !== "function") throw new Error("插件必须默认导出 definePlugin({...})");
			if (!NAME_PATTERN.test(plugin.name)) throw new Error(`插件名不合法：${plugin.name}`);
			if (this.infos.filter((p) => p.name === plugin.name).length > 1) throw new Error(`插件名重复：${plugin.name}`);
			await plugin.setup(this.context(plugin.name, info));
		} catch (err) {
			info.status = "error";
			info.error = err instanceof Error ? err.message : String(err);
		}
	}

	/** Load from an npm package name or a path (relative paths resolve against dataDir). */
	async loadSpecifier(spec: string, source: PluginInfo["source"]): Promise<void> {
		try {
			const entry = await resolveEntry(spec, this.options.dataDir);
			const mod = (await import(pathToFileURL(entry).href)) as { default?: PrometheusPlugin };
			await this.load(mod.default as PrometheusPlugin, source);
		} catch (err) {
			this.infos.push({ name: spec, source, status: "error", error: err instanceof Error ? err.message : String(err), panels: [] });
		}
	}

	/** Every sub-directory of <dataDir>/plugins containing a package.json is a plugin. */
	async loadDirectory(dir: string): Promise<void> {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		for (const name of names.sort()) {
			const full = join(dir, name);
			if (!(await stat(join(full, "package.json")).catch(() => undefined))) continue;
			await this.loadSpecifier(full, "directory");
		}
	}

	async dispose(): Promise<void> {
		for (const fn of this.disposers.reverse()) {
			try {
				await fn();
			} catch {
				// Shutdown continues even if one plugin fails to clean up.
			}
		}
	}

	private context(name: string, info: PluginInfo): PluginContext {
		const prefix = (msg: string) => `[plugin:${name}] ${msg}`;
		return {
			host: this.options.host,
			dataDir: join(this.options.dataDir, "plugin-data", name),
			agentDir: this.options.agentDir,
			cwd: this.options.cwd,
			log: {
				info: (m) => console.log(prefix(m)),
				warn: (m) => console.warn(prefix(m)),
				error: (m) => console.error(prefix(m)),
			},
			settings: this.options.settings(name),
			gateways: () => this.options.gateways(),
			extension: (factory) => {
				this.extensions.push({ name: `prometheus:${name}`, factory });
			},
			knowledgeStore: (id, factory) => {
				if (this.stores.has(id)) throw new Error(`知识库存储 id 已被注册：${id}`);
				this.stores.set(id, factory);
			},
			route: (method, path, handler) => {
				if (!path.startsWith("/")) throw new Error("路由 path 必须以 / 开头");
				this.routes.push({ method, path: `/plugins/${name}${path}`, handler });
			},
			panel: (panel) => {
				info.panels.push({ plugin: name, id: panel.id, title: panel.title, icon: panel.icon, url: `/plugins/${name}${panel.path}` });
			},
			rpc: (method, handler) => {
				if (!METHOD_PATTERN.test(method)) throw new Error(`RPC 方法名不合法：${method}`);
				this.rpcs.set(`${name}/${method}`, handler);
			},
			reloadSessions: () => this.reloadSessions(),
			onDispose: (fn) => {
				this.disposers.push(fn);
			},
		};
	}
}

async function resolveEntry(spec: string, dataDir: string): Promise<string> {
	const isPath = spec.startsWith(".") || isAbsolute(spec);
	if (!isPath) {
		return createRequire(join(dataDir, "package.json")).resolve(spec);
	}
	const dir = resolve(dataDir, spec);
	const info = await stat(dir);
	if (info.isFile()) return dir;
	const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
		main?: string;
		exports?: string | Record<string, unknown>;
	};
	const exp = typeof pkg.exports === "string" ? pkg.exports : (pkg.exports?.["."] as string | undefined);
	const rel = typeof exp === "string" ? exp : pkg.main ?? "index.js";
	const entry = resolve(dir, rel);
	if (!entry.startsWith(dir)) throw new Error("插件入口不能指向插件目录之外");
	return entry;
}
