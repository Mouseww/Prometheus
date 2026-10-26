import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { GatewayConfig, ModelRef, RunAccess } from "@prometheus/protocol";

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

/** A project folder the user has added to the app. */
export interface WorkspaceRef {
	id: string;
	path: string;
	name: string;
}

export interface AgentRunOptions {
	/** Working directory; must exist. It is added to the workspace list. */
	cwd: string;
	prompt: string;
	/** Session title shown in the sidebar. */
	name?: string;
	/** What the run may do. Nobody is there to answer questions, so anything beyond this is refused. */
	access: RunAccess;
	model?: ModelRef;
	/** Default 30 minutes. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface AgentRunResult {
	/** The saved session, openable from the sidebar. */
	sessionId: string;
	status: "success" | "error" | "aborted";
	/** The agent's final reply. */
	text: string;
	error?: string;
}

// ---------- Runtime-neutral tools and context ----------

/** A JSON Schema object. TypeBox schemas (`Type.Object(...)`) are JSON Schema and are accepted as-is. */
export type PluginJsonSchema = { [key: string]: any };

export interface PluginUiDialogOptions {
	signal?: AbortSignal;
	/** Milliseconds before the dialog dismisses itself. */
	timeout?: number;
}

/** What a tool gets when it runs, the same whichever agent runtime is driving the session. */
export interface PluginToolContext {
	cwd: string;
	/** Undefined before the session has an id (e.g. a fresh in-memory session). */
	sessionId: string | undefined;
	/** False when nobody can answer a dialog (unattended runs). */
	hasUI: boolean;
	ui: {
		confirm(title: string, message: string, opts?: PluginUiDialogOptions): Promise<boolean>;
		select(title: string, options: string[], opts?: PluginUiDialogOptions): Promise<string | undefined>;
		input(title: string, placeholder?: string, opts?: PluginUiDialogOptions): Promise<string | undefined>;
		notify(message: string, level?: "info" | "warning" | "error"): void;
	};
}

export type PluginToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface PluginToolResult {
	content: PluginToolContent[];
	/** Structured data for UIs (e.g. a todo list); not shown to the model. */
	details?: unknown;
	/** Report the call as failed. Throwing has the same effect. */
	isError?: boolean;
}

/** A tool the model can call, independent of the agent runtime. */
export interface PluginTool {
	/** Unique within the plugin. */
	name: string;
	/** Human-readable name for UIs; defaults to `name`. */
	label?: string;
	description: string;
	parameters: PluginJsonSchema;
	/** One line for the tool list in the system prompt. */
	promptSnippet?: string;
	/** Bullets added to the system prompt guidelines while the tool is active. */
	promptGuidelines?: string[];
	annotations?: { readOnlyHint?: boolean };
	/** Whether the tool is active when registered. Default true. */
	defaultActive?: boolean;
	execute(
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: PluginToolResult) => void) | undefined,
		ctx: PluginToolContext,
	): Promise<PluginToolResult>;
}

export interface ContextRequest {
	/** The user's message for this turn; empty when the turn was not started by the user. */
	prompt: string;
	cwd: string;
	sessionId?: string;
	runtime: "pi" | "claude-code" | "codex";
	messageType?: string;
}

/**
 * `static` is stable for a session and goes into the system prompt (sections are keyed so a later
 * contribution with the same key overrides an earlier one). `turn` changes with each user message
 * (memory hits, mode reminders) and is delivered alongside it.
 */
export interface ContextContribution {
	static?: { sections?: Record<string, string>; guidelines?: string[] };
	turn?: string;
}

export type ContextProvider = (req: ContextRequest) => ContextContribution | undefined | Promise<ContextContribution | undefined>;

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
	/** Project folders known to the app, newest first. */
	workspaces(): Promise<WorkspaceRef[]>;
	/** Run the agent to completion without a user present, in a new saved session. Server host only. */
	runAgent(options: AgentRunOptions): Promise<AgentRunResult>;

	/** Contribute a PI extension: tools, commands, providers, lifecycle hooks. */
	extension(factory: ExtensionFactory): void;
	/** Runtime-neutral tools; they work under every agent runtime, unlike `extension`. */
	tools: { register(tool: PluginTool): void };
	/** Runtime-neutral prompt contributions, asked before each run. */
	context: { provide(provider: ContextProvider): void };
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
	/** Tell connected clients this plugin's data changed, so open views refetch. Server host only. */
	notifyChanged(): void;
	/** Run on host shutdown. */
	onDispose(fn: () => void | Promise<void>): void;
}

export interface PrometheusPlugin {
	name: string;
	version?: string;
	/** Built-in plugins only: the user may switch it off in Settings. Without this a built-in cannot be disabled, because the app UI relies on it. */
	optional?: boolean;
	setup(ctx: PluginContext): void | Promise<void>;
}

export function definePlugin(plugin: PrometheusPlugin): PrometheusPlugin {
	return plugin;
}
