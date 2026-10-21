import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type {
	AgentRunOptions,
	AgentRunResult,
	ExtensionFactory,
	HostKind,
	HttpMethod,
	KnowledgeStoreFactory,
	PluginContext,
	PrometheusPlugin,
	RouteHandler,
	RpcHandler,
	WorkspaceRef,
} from "@prometheus/plugin-sdk";
import type { GatewayConfig, PanelInfo, PluginFile, PluginInfo, PluginInstallResult } from "@prometheus/protocol";

export interface PluginRoute {
	method: HttpMethod;
	/** Full path, e.g. /plugins/foo/status */
	path: string;
	handler: RouteHandler;
}

export interface PluginHostOptions {
	host: HostKind;
	/** Live permission mode per session, so a plugin's prompt follows the mode the gate enforces. */
	permissionMode?: (sessionId: string | undefined) => string | undefined;
	dataDir: string;
	agentDir: string;
	cwd: string;
	settings: (name: string) => Record<string, unknown>;
	gateways: () => GatewayConfig[];
	isDisabled?: (id: string) => boolean;
	setDisabled?: (id: string, disabled: boolean) => Promise<void>;
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]{0,63}$/;
/** Windows drops trailing dots and spaces from folder names and refuses these outright. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/;

/** Names that are safe as a folder on every OS, not just valid by pattern. */
export function folderNameProblem(name: string): string | undefined {
	if (!NAME_PATTERN.test(name)) return `插件名不合法：${name}（小写字母、数字、- _ .，不超过 64 位）`;
	if (name.endsWith(".")) return "插件名不能以 . 结尾";
	if (WINDOWS_RESERVED.test(name)) return `“${name}”是系统保留名称，请换一个`;
	return undefined;
}
const METHOD_PATTERN = /^[a-zA-Z][\w.]{0,63}$/;
const MAX_FILES = 40;
const MAX_FILE_BYTES = 400_000;
const MAX_TOTAL_BYTES = 1_000_000;

/** Everything one active plugin contributed, so unloading removes exactly that. */
interface Registration {
	factories: ExtensionFactory[];
	storeIds: string[];
	rpcKeys: string[];
	routes: PluginRoute[];
	disposers: (() => void | Promise<void>)[];
}

interface Entry {
	id: string;
	key: string;
	source: PluginInfo["source"];
	info: PluginInfo;
	optional: boolean;
	/** Yields the plugin object; folder and config plugins are imported afresh on every call. */
	fetch: () => Promise<PrometheusPlugin>;
	reg?: Registration;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Loads, unloads and re-loads plugins while the app runs. Nothing a plugin registers outlives its
 * `Registration`; live chats pick changes up through `reloadSessions()` and `dynamicExtension()`.
 */
export class PluginHost {
	readonly stores = new Map<string, KnowledgeStoreFactory>();
	/** Keyed by `<plugin>/<method>`. */
	readonly rpcs = new Map<string, RpcHandler>();
	/** Wired by the session host; no-ops in the TUI where PI owns the session. */
	reloadSessions: () => Promise<void> = async () => {};
	workspaces: () => Promise<WorkspaceRef[]> = async () => [];
	runAgent: (options: AgentRunOptions) => Promise<AgentRunResult> = async () => {
		throw new Error("当前宿主不支持在后台运行 Agent");
	};
	onChanged: () => void = () => {};
	/** Wired by the server: pushes a `plugin.notify` frame for one plugin. */
	notifyPlugin: (plugin: string) => void = () => {};

	private entries: Entry[] = [];
	private importSeq = 0;
	private readonly options: PluginHostOptions;

	constructor(options: PluginHostOptions) {
		this.options = options;
	}

	private get pluginsDir(): string {
		return join(this.options.dataDir, "plugins");
	}

	list(): PluginInfo[] {
		return this.entries.map((e) => e.info);
	}

	panels(): PanelInfo[] {
		return this.entries.flatMap((e) => e.info.panels);
	}

	get routes(): PluginRoute[] {
		return this.entries.flatMap((e) => e.reg?.routes ?? []);
	}

	/** One entry per active plugin, for hosts that cannot hot-reload (the TUI). */
	get extensions(): InlineExtension[] {
		return this.entries.flatMap((e) => (e.reg?.factories ?? []).map((factory) => ({ name: `prometheus:${e.info.name}`, factory })));
	}

	/**
	 * A single extension that replays whichever plugins are active at the moment a session loads or
	 * reloads. Sessions use this instead of a frozen list so installs and removals reach them.
	 */
	dynamicExtension(): InlineExtension {
		return {
			name: "prometheus:plugins",
			factory: async (pi) => {
				for (const entry of [...this.entries]) {
					for (const factory of entry.reg?.factories ?? []) {
						try {
							await factory(pi);
						} catch (err) {
							console.warn(`[plugin:${entry.info.name}] 扩展加载失败：${errorText(err)}`);
						}
					}
				}
			},
		};
	}

	// ---------- loading ----------

	private newEntry(source: PluginInfo["source"], key: string, fetch: () => Promise<PrometheusPlugin>, optional: boolean): Entry {
		const id = `${source}:${key}`;
		const entry: Entry = {
			id,
			key,
			source,
			optional,
			fetch,
			info: { id, name: key, source, status: "loaded", panels: [], toggleable: source !== "builtin" || optional, removable: source === "directory", notes: [] },
		};
		this.entries.push(entry);
		return entry;
	}

	private async startEntry(entry: Entry): Promise<void> {
		if (this.options.isDisabled?.(entry.id) && entry.info.toggleable) {
			entry.info.status = "disabled";
			return;
		}
		await this.activate(entry);
	}

	private async activate(entry: Entry): Promise<void> {
		const { info } = entry;
		info.status = "loaded";
		info.error = undefined;
		info.panels = [];
		const reg: Registration = { factories: [], storeIds: [], rpcKeys: [], routes: [], disposers: [] };
		entry.reg = reg;
		try {
			const plugin = await entry.fetch();
			if (!plugin || typeof plugin.setup !== "function") throw new Error("插件必须默认导出 { name, setup(ctx) }（可用 definePlugin 包装）");
			if (!NAME_PATTERN.test(plugin.name)) throw new Error(`插件名不合法：${plugin.name}`);
			if (this.entries.some((e) => e !== entry && e.reg && e.info.name === plugin.name)) throw new Error(`插件名重复：${plugin.name}`);
			info.name = plugin.name;
			info.version = plugin.version;
			if (entry.source === "builtin") {
				entry.optional = plugin.optional === true;
				info.toggleable = entry.optional;
			}
			await plugin.setup(this.context(plugin.name, entry, reg));
		} catch (err) {
			await this.teardown(entry);
			info.status = "error";
			info.error = errorText(err);
		}
	}

	/** Removes everything the plugin registered and runs its cleanup hooks. */
	private async teardown(entry: Entry): Promise<void> {
		const reg = entry.reg;
		entry.reg = undefined;
		entry.info.panels = [];
		if (!reg) return;
		for (const id of reg.storeIds) this.stores.delete(id);
		for (const key of reg.rpcKeys) this.rpcs.delete(key);
		for (const fn of [...reg.disposers].reverse()) {
			try {
				await fn();
			} catch {
				// One plugin failing to clean up must not block the others.
			}
		}
	}

	async load(plugin: PrometheusPlugin, source: PluginInfo["source"]): Promise<void> {
		const entry = this.newEntry(source, plugin?.name ?? "unknown", async () => plugin, plugin?.optional === true);
		await this.startEntry(entry);
	}

	/** Load from an npm package name or a path (relative paths resolve against dataDir). */
	async loadSpecifier(spec: string, source: PluginInfo["source"]): Promise<void> {
		const entry = this.newEntry(source, spec, async () => this.importPlugin(await resolveEntry(spec, this.options.dataDir)), false);
		await this.startEntry(entry);
	}

	/** Every sub-directory of <dataDir>/plugins containing a package.json is a plugin. Returns how many were new. */
	async loadDirectory(): Promise<number> {
		let names: string[];
		try {
			names = await readdir(this.pluginsDir);
		} catch {
			return 0;
		}
		let added = 0;
		for (const name of names.sort()) {
			if (name.startsWith(".") || this.entries.some((e) => e.id === `directory:${name}`)) continue;
			if (!(await stat(join(this.pluginsDir, name, "package.json")).catch(() => undefined))) continue;
			await this.startEntry(this.directoryEntry(name));
			added++;
		}
		return added;
	}

	private directoryEntry(name: string): Entry {
		const dir = join(this.pluginsDir, name);
		return this.newEntry("directory", name, async () => this.importPlugin(await resolveEntry(dir, this.options.dataDir)), false);
	}

	/** A fresh URL per import defeats Node's module cache, so an edited entry file really is re-read. */
	private async importPlugin(file: string): Promise<PrometheusPlugin> {
		const mod = (await import(`${pathToFileURL(file).href}?v=${++this.importSeq}`)) as { default?: PrometheusPlugin };
		return mod.default as PrometheusPlugin;
	}

	// ---------- hot management ----------

	private find(id: string): Entry {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) throw new Error(`插件不存在：${id}`);
		return entry;
	}

	private async applied(): Promise<void> {
		await this.reloadSessions().catch((err: unknown) => console.warn(`[plugins] 重新加载会话失败：${errorText(err)}`));
		this.onChanged();
	}

	async setEnabled(id: string, enabled: boolean): Promise<PluginInfo> {
		const entry = this.find(id);
		if (!entry.info.toggleable) throw new Error("该插件是应用的组成部分，不能停用");
		await this.options.setDisabled?.(id, !enabled);
		await this.teardown(entry);
		if (enabled) await this.activate(entry);
		else entry.info.status = "disabled";
		await this.applied();
		return entry.info;
	}

	async reload(id: string): Promise<PluginInfo> {
		const entry = this.find(id);
		await this.teardown(entry);
		await this.startEntry(entry);
		await this.applied();
		return entry.info;
	}

	async scan(): Promise<PluginInfo[]> {
		if ((await this.loadDirectory()) > 0) await this.applied();
		return this.list();
	}

	async remove(id: string): Promise<void> {
		const entry = this.find(id);
		if (entry.source !== "directory") throw new Error("只能删除用户安装的文件夹插件");
		const dir = resolve(this.pluginsDir, entry.key);
		if (!dir.startsWith(resolve(this.pluginsDir) + sep)) throw new Error("插件目录不合法");
		await this.teardown(entry);
		await rm(dir, { recursive: true, force: true });
		this.entries = this.entries.filter((e) => e !== entry);
		await this.options.setDisabled?.(id, false);
		await this.applied();
	}

	/**
	 * Writes a plugin folder and loads it, replacing a previous version of the same name. If the new
	 * code does not load, the old version is put back and the error is thrown, so a bad edit never
	 * leaves the app worse off.
	 */
	async install(input: { name: string; files: PluginFile[]; version?: string }): Promise<PluginInstallResult> {
		const { name } = input;
		const problem = folderNameProblem(name);
		if (problem) throw new Error(problem);
		const files = validateFiles(input.files);
		const clash = this.entries.find((e) => e.info.name === name && e.source !== "directory");
		if (clash) throw new Error(`已有同名的${clash.source === "builtin" ? "内置" : "配置"}插件：${name}`);

		const dir = join(this.pluginsDir, name);
		const prior = this.entries.find((e) => e.id === `directory:${name}`);
		const wasActive = Boolean(prior?.reg);
		const existed = await stat(dir).then(() => true, () => false);
		const backup = existed ? `${dir}.bak-${Date.now()}` : undefined;

		if (prior) await this.teardown(prior);
		if (backup) await rename(dir, backup);

		const entry = prior ?? this.directoryEntry(name);
		try {
			await mkdir(dir, { recursive: true });
			for (const file of files) {
				const target = join(dir, ...file.path.split("/"));
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, file.content, "utf8");
			}
			await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: input.version ?? "0.1.0", private: true, type: "module", main: "index.js" }, null, 2));
			await this.options.setDisabled?.(entry.id, false);
			await this.activate(entry);
			if (entry.info.status !== "loaded") throw new Error(entry.info.error ?? "插件加载失败");
			if (entry.info.name !== name) throw new Error(`插件声明的 name（${entry.info.name}）必须与安装名（${name}）一致`);
		} catch (err) {
			await this.teardown(entry);
			await rm(dir, { recursive: true, force: true });
			if (backup) {
				await rename(backup, dir);
				if (prior) {
					if (wasActive) await this.activate(prior);
					else prior.info.status = "disabled";
				}
			} else if (!prior) {
				this.entries = this.entries.filter((e) => e !== entry);
			}
			throw new Error(`插件未能加载，已保持原状：${errorText(err)}`);
		}
		if (backup) await rm(backup, { recursive: true, force: true });

		const restartReasons: string[] = [];
		if (this.options.host !== "server") restartReasons.push("当前是终端（TUI）模式，不支持热加载，请重启后生效");
		// Only the entry file is re-read on update; modules it imports stay cached by Node until restart.
		if (prior && files.length > 1) restartReasons.push("这是多文件插件的更新：入口文件已重新加载，但被它引用的其他文件会沿用旧缓存，请重启应用后完全生效");
		entry.info.notes = restartReasons;
		await this.applied();
		return { plugin: entry.info, updated: Boolean(prior), hot: this.options.host === "server", restartReasons };
	}

	async dispose(): Promise<void> {
		for (const entry of [...this.entries].reverse()) await this.teardown(entry);
	}

	// ---------- plugin context ----------

	private context(name: string, entry: Entry, reg: Registration): PluginContext {
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
			workspaces: () => this.workspaces(),
			runAgent: (options) => this.runAgent(options),
			extension: (factory) => {
				reg.factories.push(factory);
			},
			permissionMode: (sessionId) => this.options.permissionMode?.(sessionId),
			knowledgeStore: (id, factory) => {
				if (this.stores.has(id)) throw new Error(`知识库存储 id 已被注册：${id}`);
				this.stores.set(id, factory);
				reg.storeIds.push(id);
			},
			route: (method, path, handler) => {
				if (!path.startsWith("/")) throw new Error("路由 path 必须以 / 开头");
				reg.routes.push({ method, path: `/plugins/${name}${path}`, handler });
			},
			panel: (panel) => {
				entry.info.panels.push({ plugin: name, id: panel.id, title: panel.title, icon: panel.icon, url: `/plugins/${name}${panel.path}` });
			},
			rpc: (method, handler) => {
				if (!METHOD_PATTERN.test(method)) throw new Error(`RPC 方法名不合法：${method}`);
				const key = `${name}/${method}`;
				this.rpcs.set(key, handler);
				reg.rpcKeys.push(key);
			},
			reloadSessions: () => this.reloadSessions(),
			notifyChanged: () => this.notifyPlugin(name),
			onDispose: (fn) => {
				reg.disposers.push(fn);
			},
		};
	}
}

/** Relative, forward-slash paths only; nothing may escape the plugin folder. */
export function validateFiles(input: PluginFile[]): PluginFile[] {
	if (!Array.isArray(input) || input.length === 0) throw new Error("至少需要一个文件（入口为 index.js）");
	if (input.length > MAX_FILES) throw new Error(`文件过多（上限 ${MAX_FILES} 个）`);
	const seen = new Set<string>();
	let total = 0;
	const out: PluginFile[] = [];
	for (const file of input) {
		const path = typeof file?.path === "string" ? file.path.trim() : "";
		const content = typeof file?.content === "string" ? file.content : "";
		if (!path || path.includes("\\") || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new Error(`文件路径不合法：${path || "(空)"}，请使用相对路径和 /`);
		const clean = normalize(path).split(sep).join("/");
		if (clean.startsWith("../") || clean === ".." || clean.split("/").some((s) => s === ".." || s === "node_modules" || s.startsWith(".git"))) throw new Error(`文件路径不合法：${path}`);
		if (clean === "package.json") throw new Error("package.json 由系统生成，请勿提供");
		if (seen.has(clean)) throw new Error(`文件重复：${clean}`);
		seen.add(clean);
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > MAX_FILE_BYTES) throw new Error(`文件过大：${clean}（上限 ${MAX_FILE_BYTES / 1000} KB）`);
		total += bytes;
		out.push({ path: clean, content });
	}
	if (total > MAX_TOTAL_BYTES) throw new Error("插件总体积过大");
	if (!seen.has("index.js")) throw new Error("缺少入口文件 index.js");
	return out;
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
