import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
	AgentRunOptions,
	AgentRunResult,
	ContextProvider,
	ContextRequest,
	ExtensionFactory,
	HostKind,
	HttpMethod,
	KnowledgeStoreFactory,
	PluginContext,
	PluginTool,
	PluginToolContext,
	PrometheusPlugin,
	RouteHandler,
	RpcHandler,
	WorkspaceRef,
} from "@prometheus/plugin-sdk";
import { AppError, encodeError, type GatewayConfig, type PanelInfo, type PluginFile, type PluginInfo, type PluginInstallResult } from "@prometheus/protocol";
import { type Captured, type CapturedCommand, captureExtension, type Handler, HOOK_NAMES, type HookName } from "./agent/facade/pi-facade.ts";

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
	isDisabled?: (id: string) => boolean;
	setDisabled?: (id: string, disabled: boolean) => Promise<void>;
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-_.]{0,63}$/;
/** Windows drops trailing dots and spaces from folder names and refuses these outright. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/;

/** Names that are safe as a folder on every OS, not just valid by pattern. */
export function folderNameProblem(name: string): string | undefined {
	if (!NAME_PATTERN.test(name)) return encodeError(new AppError("pluginNameInvalid", { name, detail: "lowercase letters, digits, - _ . — at most 64 characters" }));
	if (name.endsWith(".")) return encodeError(new AppError("pluginNameEndsWithDot"));
	if (WINDOWS_RESERVED.test(name)) return encodeError(new AppError("pluginNameReserved", { name }));
	return undefined;
}
const METHOD_PATTERN = /^[a-zA-Z][\w.]{0,63}$/;
const MAX_FILES = 40;
const MAX_FILE_BYTES = 400_000;
const MAX_TOTAL_BYTES = 1_000_000;

/** Everything one active plugin contributed, so unloading removes exactly that. */
interface Registration {
	factories: ExtensionFactory[];
	tools: PluginTool[];
	providers: ContextProvider[];
	storeIds: string[];
	rpcKeys: string[];
	routes: PluginRoute[];
	disposers: (() => void | Promise<void>)[];
	/** PiFacade result for `factories`; lives and dies with this registration, so teardown/reload/install drop it. */
	captured?: Promise<Captured>;
}

/** What non-PI runtimes see of the active plugins: neutral registrations plus translated legacy `extension` factories. */
export interface ExternalView {
	tools: { plugin: string; tool: PluginTool }[];
	contextProviders: { plugin: string; provider: ContextProvider }[];
	commands: ({ plugin: string } & CapturedCommand)[];
	mcpServers: { plugin: string; name: string; config: Captured["mcpServers"][number]["config"] }[];
	hooks: Record<HookName, { plugin: string; handler: Handler }[]>;
	/** Only plugins that have something to report. */
	warnings: { plugin: string; messages: string[] }[];
}

/** Folds one provider's output into a merged context; shared by the PI and external paths. */
function mergeContribution(out: { static: { sections: Record<string, string>; guidelines: string[] }; turn: string[] }, part: Awaited<ReturnType<ContextProvider>>): void {
	if (!part) return;
	for (const [key, text] of Object.entries(part.static?.sections ?? {})) {
		if (key !== "__proto__" && typeof text === "string") out.static.sections[key] = text;
	}
	for (const line of part.static?.guidelines ?? []) if (typeof line === "string" && line.trim()) out.static.guidelines.push(line);
	if (typeof part.turn === "string" && part.turn.trim()) out.turn.push(part.turn);
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
		throw new AppError("pluginBackgroundUnsupported");
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

	/** Runtime-neutral tools of every active plugin, in plugin order. */
	get tools(): { plugin: string; tool: PluginTool }[] {
		return this.entries.flatMap((e) => (e.reg?.tools ?? []).map((tool) => ({ plugin: e.info.name, tool })));
	}

	/**
	 * Runs every active plugin's context providers. A provider that throws is skipped; when two
	 * contribute the same section the later plugin wins.
	 */
	async collectContext(req: ContextRequest): Promise<{ static: { sections: Record<string, string>; guidelines: string[] }; turn: string[] }> {
		const out = { static: { sections: {} as Record<string, string>, guidelines: [] as string[] }, turn: [] as string[] };
		for (const entry of [...this.entries]) {
			for (const provider of [...(entry.reg?.providers ?? [])]) {
				try {
					mergeContribution(out, await provider(req));
				} catch (err) {
					console.warn(`[plugin:${entry.info.name}] 上下文提供者失败：${errorText(err)}`);
				}
			}
		}
		return out;
	}

	/** The facade result for one active plugin, computed once per registration. */
	private captureFor(entry: Entry, reg: Registration): Promise<Captured> {
		const plugin = entry.info.name;
		const prefix = (msg: string) => `[plugin:${plugin}] ${msg}`;
		reg.captured ??= captureExtension(reg.factories, {
			pluginName: plugin,
			cwd: this.options.cwd,
			log: { info: (m) => console.log(prefix(m)), warn: (m) => console.warn(prefix(m)), error: (m) => console.error(prefix(m)) },
		});
		return reg.captured;
	}

	/**
	 * Tools, context providers, commands, MCP servers and hooks of every active plugin as a non-PI
	 * runtime sees them: neutral registrations plus legacy `extension` factories replayed on the
	 * PiFacade. Legacy entries come first, as in PI; a neutral tool replaces a legacy one of the same name.
	 */
	async externalView(): Promise<ExternalView> {
		const view: ExternalView = {
			tools: [],
			contextProviders: [],
			commands: [],
			mcpServers: [],
			hooks: Object.fromEntries(HOOK_NAMES.map((name) => [name, []])) as unknown as ExternalView["hooks"],
			warnings: [],
		};
		for (const entry of [...this.entries]) {
			const reg = entry.reg;
			if (!reg) continue;
			const plugin = entry.info.name;
			const cap = reg.factories.length ? await this.captureFor(entry, reg) : undefined;
			const messages = [...(cap?.warnings ?? [])];
			const neutralNames = new Set(reg.tools.map((t) => t.name));
			for (const tool of cap?.tools ?? []) {
				if (neutralNames.has(tool.name)) messages.push(`${plugin}: legacy tool ${tool.name} is shadowed by a runtime-neutral tool of the same name`);
				else view.tools.push({ plugin, tool });
			}
			for (const tool of reg.tools) view.tools.push({ plugin, tool });
			for (const provider of cap?.contextProviders ?? []) view.contextProviders.push({ plugin, provider });
			for (const provider of reg.providers) view.contextProviders.push({ plugin, provider });
			for (const command of cap?.commands ?? []) view.commands.push({ plugin, ...command });
			for (const server of cap?.mcpServers ?? []) view.mcpServers.push({ plugin, ...server });
			for (const name of HOOK_NAMES) for (const handler of cap?.hooks[name] ?? []) view.hooks[name].push({ plugin, handler });
			if (messages.length) view.warnings.push({ plugin, messages });
		}
		return view;
	}

	/** Like `collectContext`, but also runs the context providers captured from legacy `extension` factories (their output arrives as `turn`). */
	async collectContextExternal(req: ContextRequest): Promise<{ static: { sections: Record<string, string>; guidelines: string[] }; turn: string[] }> {
		const out = { static: { sections: {} as Record<string, string>, guidelines: [] as string[] }, turn: [] as string[] };
		for (const { plugin, provider } of (await this.externalView()).contextProviders) {
			try {
				mergeContribution(out, await provider(req));
			} catch (err) {
				console.warn(`[plugin:${plugin}] 上下文提供者失败：${errorText(err)}`);
			}
		}
		return out;
	}

	/** What does not work outside PI, per plugin; plugins without findings are left out. */
	async compatibility(): Promise<{ plugin: string; warnings: string[] }[]> {
		return (await this.externalView()).warnings.map(({ plugin, messages }) => ({ plugin, warnings: messages }));
	}

	/** One entry per active plugin, for hosts that cannot hot-reload (the TUI). */
	get extensions(): InlineExtension[] {
		const list: InlineExtension[] = this.entries.flatMap((e) => {
			const name = `prometheus:${e.info.name}`;
			const items: InlineExtension[] = (e.reg?.factories ?? []).map((factory) => ({ name, factory }));
			if (e.reg?.tools.length) items.push({ name, factory: (pi) => registerNeutralTools(pi, e.info.name, e.reg?.tools ?? []) });
			return items;
		});
		if (this.entries.some((e) => e.reg?.providers.length)) list.push({ name: "prometheus:context", factory: (pi) => this.registerContextBridge(pi) });
		return list;
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
					registerNeutralTools(pi, entry.info.name, entry.reg?.tools ?? []);
				}
				if (this.entries.some((e) => e.reg?.providers.length)) this.registerContextBridge(pi);
			},
		};
	}

	/** One `before_agent_start` handler per session, however many plugins contribute context. */
	private registerContextBridge(pi: ExtensionAPI): void {
		pi.on("before_agent_start", async (event, ctx) => {
			const found = await this.collectContext({
				prompt: event.messageType === "user" ? event.prompt : "",
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager?.getSessionId?.(),
				runtime: "pi",
				messageType: event.messageType,
			});
			// Mutate in place and never return `systemPrompt`: that would freeze the prompt and hide later sections.
			const opts = event.systemPromptOptions;
			Object.assign(opts.sections, found.static.sections);
			opts.promptGuidelines.push(...found.static.guidelines);
			const turn = found.turn.join("\n\n");
			if (turn) opts.sections.turn_context = turn;
		});
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
		const reg: Registration = { factories: [], tools: [], providers: [], storeIds: [], rpcKeys: [], routes: [], disposers: [] };
		entry.reg = reg;
		try {
			const plugin = await entry.fetch();
			if (!plugin || typeof plugin.setup !== "function") throw new AppError("pluginSetupShape");
			if (!NAME_PATTERN.test(plugin.name)) throw new AppError("pluginNameInvalid", { name: plugin.name, detail: "lowercase letters, digits, - _ . — at most 64 characters" });
			if (this.entries.some((e) => e !== entry && e.reg && e.info.name === plugin.name)) throw new AppError("pluginNameDuplicate", { name: plugin.name });
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
		if (!entry) throw new AppError("pluginNotFound", { id });
		return entry;
	}

	private async applied(): Promise<void> {
		await this.reloadSessions().catch((err: unknown) => console.warn(`[plugins] 重新加载会话失败：${errorText(err)}`));
		this.onChanged();
	}

	async setEnabled(id: string, enabled: boolean): Promise<PluginInfo> {
		const entry = this.find(id);
		if (!entry.info.toggleable) throw new AppError("pluginBuiltinLocked");
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
		if (entry.source !== "directory") throw new AppError("pluginDirectoryOnly");
		const dir = resolve(this.pluginsDir, entry.key);
		if (!dir.startsWith(resolve(this.pluginsDir) + sep)) throw new AppError("pluginDirInvalid");
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
		if (clash) throw new AppError("pluginNameClash", { kind: clash.source === "builtin" ? "built-in" : "config", name });

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
			if (entry.info.status !== "loaded") throw new Error(entry.info.error ?? encodeError(new AppError("pluginNotLoaded")));
			if (entry.info.name !== name) throw new AppError("pluginNameMismatch", { declared: entry.info.name, installed: name });
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
			throw new AppError("pluginLoadError", { error: errorText(err) });
		}
		if (backup) await rm(backup, { recursive: true, force: true });

		const restartReasons: string[] = [];
		if (this.options.host !== "server") restartReasons.push(encodeError(new AppError("pluginHotReloadTui")));
		// Only the entry file is re-read on update; modules it imports stay cached by Node until restart.
		if (prior && files.length > 1) restartReasons.push(encodeError(new AppError("pluginMultiFileReload")));
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
			tools: {
				register: (tool) => {
					const toolName = typeof tool?.name === "string" ? tool.name.trim() : "";
					if (!toolName) throw new AppError("pluginToolNameEmpty");
					if (reg.tools.some((t) => t.name === tool.name)) throw new AppError("pluginToolDuplicate", { name: tool.name });
					reg.tools.push(tool);
				},
			},
			context: {
				provide: (provider) => {
					reg.providers.push(provider);
				},
			},
			knowledgeStore: (id, factory) => {
				if (this.stores.has(id)) throw new AppError("pluginStoreDuplicate", { id });
				this.stores.set(id, factory);
				reg.storeIds.push(id);
			},
			route: (method, path, handler) => {
				if (!path.startsWith("/")) throw new AppError("pluginRoutePath");
				reg.routes.push({ method, path: `/plugins/${name}${path}`, handler });
			},
			panel: (panel) => {
				entry.info.panels.push({ plugin: name, id: panel.id, title: panel.title, icon: panel.icon, url: `/plugins/${name}${panel.path}` });
			},
			rpc: (method, handler) => {
				if (!METHOD_PATTERN.test(method)) throw new AppError("pluginMethodInvalid", { method });
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

/** Adapts a runtime-neutral tool to PI's tool definition. The parameter schema is passed through untouched. */
export function adaptTool(tool: PluginTool): ToolDefinition {
	return {
		name: tool.name,
		label: tool.label ?? tool.name,
		description: tool.description,
		parameters: tool.parameters as ToolDefinition["parameters"],
		...(tool.promptSnippet !== undefined && { promptSnippet: tool.promptSnippet }),
		...(tool.promptGuidelines !== undefined && { promptGuidelines: tool.promptGuidelines }),
		...(tool.annotations !== undefined && { annotations: tool.annotations }),
		...(tool.defaultActive !== undefined && { defaultActive: tool.defaultActive }),
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const toolCtx: PluginToolContext = {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager?.getSessionId?.(),
				hasUI: ctx.hasUI,
				ui: {
					confirm: (title, message, opts) => ctx.ui.confirm(title, message, opts),
					select: (title, options, opts) => ctx.ui.select(title, options, opts),
					input: (title, placeholder, opts) => ctx.ui.input(title, placeholder, opts),
					notify: (message, level) => ctx.ui.notify(message, level),
				},
			};
			const result = await tool.execute(
				toolCallId,
				params,
				signal,
				onUpdate && ((partial) => onUpdate({ content: partial.content, details: partial.details })),
				toolCtx,
			);
			// PI reports a failed tool by throwing, so `isError` becomes an error carrying the text.
			if (result.isError) throw new Error(result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n").trim() || tool.name);
			return { content: result.content, details: result.details };
		},
	};
}

function registerNeutralTools(pi: ExtensionAPI, plugin: string, tools: PluginTool[]): void {
	for (const tool of tools) {
		try {
			pi.registerTool(adaptTool(tool));
		} catch (err) {
			console.warn(`[plugin:${plugin}] 工具注册失败（${tool.name}）：${errorText(err)}`);
		}
	}
}

/** Relative, forward-slash paths only; nothing may escape the plugin folder. */
export function validateFiles(input: PluginFile[]): PluginFile[] {
	if (!Array.isArray(input) || input.length === 0) throw new AppError("pluginFilesRequired");
	if (input.length > MAX_FILES) throw new AppError("pluginTooManyFiles", { max: MAX_FILES });
	const seen = new Set<string>();
	let total = 0;
	const out: PluginFile[] = [];
	for (const file of input) {
		const path = typeof file?.path === "string" ? file.path.trim() : "";
		const content = typeof file?.content === "string" ? file.content : "";
		if (!path || path.includes("\\") || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new AppError("pluginFilePathInvalid", { path: path || "(empty)" });
		const clean = normalize(path).split(sep).join("/");
		if (clean.startsWith("../") || clean === ".." || clean.split("/").some((s) => s === ".." || s === "node_modules" || s.startsWith(".git"))) throw new AppError("pluginFilePathInvalid", { path });
		if (clean === "package.json") throw new AppError("pluginFilePackageJson");
		if (seen.has(clean)) throw new AppError("pluginFileDuplicate", { path: clean });
		seen.add(clean);
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > MAX_FILE_BYTES) throw new AppError("pluginFileTooLarge", { path: clean, max: MAX_FILE_BYTES / 1000 });
		total += bytes;
		out.push({ path: clean, content });
	}
	if (total > MAX_TOTAL_BYTES) throw new AppError("pluginTotalTooLarge");
	if (!seen.has("index.js")) throw new AppError("pluginEntryMissing");
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
	if (!entry.startsWith(dir)) throw new AppError("pluginEntryOutside");
	return entry;
}
