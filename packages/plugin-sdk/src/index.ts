import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { GatewayConfig } from "@prometheus/protocol";

export type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
export { createJsonStore, type JsonStore } from "./json-store.ts";

// ---------- Knowledge store contract ----------

export interface KnowledgeChunk {
	id: string;
	documentId: string;
	title: string;
	text: string;
	vector: number[];
}

export interface KnowledgeSearchResult {
	documentId: string;
	title: string;
	text: string;
	/** Higher is more relevant, normalised to roughly 0..1. */
	score: number;
}

export interface KnowledgeStore {
	upsert(chunks: KnowledgeChunk[]): Promise<void>;
	search(vector: number[], topK: number): Promise<KnowledgeSearchResult[]>;
	deleteDocument(documentId: string): Promise<void>;
	count(): Promise<number>;
	drop(): Promise<void>;
}

export interface KnowledgeStoreOptions {
	/** Knowledge base id; stores use it as their table/collection name. */
	baseId: string;
	/** Directory reserved for this store's on-disk data. */
	dataDir: string;
	dimensions: number;
	/** Free-form options from the knowledge base config. */
	settings: Record<string, unknown>;
}

export type KnowledgeStoreFactory = (options: KnowledgeStoreOptions) => Promise<KnowledgeStore>;

// ---------- Plugin contract ----------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
/** Params arrive straight from clients: validate before use. */
export type RpcHandler = (params: Record<string, unknown>) => unknown;

export interface PanelContribution {
	id: string;
	title: string;
	/** lucide icon name, e.g. "gauge". */
	icon?: string;
	/** Path under the plugin's route prefix that the panel iframe loads. */
	path: string;
}

export interface PluginLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export type HostKind = "server" | "tui";

export interface PluginContext {
	readonly host: HostKind;
	/** Directory owned by this plugin for persistent data. */
	readonly dataDir: string;
	/** PI agent directory (~/.pi/agent): auth.json, mcp.json, skills/. */
	readonly agentDir: string;
	/** Default working directory of the host. */
	readonly cwd: string;
	readonly log: PluginLogger;
	/** Plugin-specific settings from config.json → pluginSettings[name]. */
	readonly settings: Record<string, unknown>;
	/** Read-only view of configured AI gateways (API keys included; never log them). */
	gateways(): GatewayConfig[];

	/** Contribute a PI extension: tools, commands, providers, lifecycle hooks. */
	extension(factory: ExtensionFactory): void;
	/** Register a knowledge store backend under an id (e.g. "qdrant"). */
	knowledgeStore(id: string, factory: KnowledgeStoreFactory): void;
	/** Mount an HTTP route at /plugins/<name><path>. Server host only. */
	route(method: HttpMethod, path: string, handler: RouteHandler): void;
	/** Add a sidebar panel rendered in an iframe. Server host only. */
	panel(panel: PanelContribution): void;
	/** Expose a method to clients as `plugin.call({ plugin: <name>, method })`. */
	rpc(method: string, handler: RpcHandler): void;
	/** Reload resources (skills, MCP, extensions) of live sessions; idle ones now, busy ones when they settle. */
	reloadSessions(): Promise<void>;
	/** Run on host shutdown. */
	onDispose(fn: () => void | Promise<void>): void;
}

export interface PrometheusPlugin {
	name: string;
	version?: string;
	setup(ctx: PluginContext): void | Promise<void>;
}

export function definePlugin(plugin: PrometheusPlugin): PrometheusPlugin {
	return plugin;
}
