// Wire protocol shared by the Prometheus host and every client (web, desktop, android).
// Zero runtime dependencies: types mirror the subset of PI shapes that cross the wire.

export const PROTOCOL_VERSION = 1;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type GatewayFormat = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export const GATEWAY_FORMATS: readonly GatewayFormat[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

// ---------- Content & messages (mirrors pi-ai) ----------

export interface TextContent { type: "text"; text: string }
export interface ThinkingContent { type: "thinking"; thinking: string; redacted?: boolean }
export interface ImageContent { type: "image"; data: string; mimeType: string }
export interface ToolCallContent { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface UserMessage { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number }
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCallContent)[];
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}
export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	isError: boolean;
	timestamp: number;
}
export interface OtherMessage { role: "bashExecution" | "custom" | "branchSummary" | "compactionSummary"; timestamp: number; [key: string]: unknown }
export type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage | OtherMessage;

// ---------- Session events (PI AgentSessionEvent, with heavy `partial` stripped) ----------

export type AssistantDelta =
	| { type: "start" }
	| { type: "text_start" | "thinking_start"; contentIndex: number }
	| { type: "toolcall_start"; contentIndex: number; id?: string; name?: string }
	| { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "text_end" | "thinking_end"; contentIndex: number }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent }
	| { type: "done"; reason: string }
	| { type: "error"; reason: "aborted" | "error" };

export type SessionEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; willRetry: boolean }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: ChatMessage }
	| { type: "message_update"; delta: AssistantDelta }
	| { type: "message_end"; message: ChatMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; parentToolCallId?: string }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown; parentToolCallId?: string }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean; durationMs?: number; parentToolCallId?: string }
	| { type: "queue_update"; steering: string[]; followUp: string[] }
	| { type: "compaction_start"; reason: string }
	| { type: "compaction_end"; reason: string; aborted: boolean; errorMessage?: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "session_info_changed"; name?: string }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "model_changed"; model: ModelRef | null }
	| { type: "permission_mode_changed"; mode: PermissionMode }
	/** History rewritten (delete / retry / tree navigation): replace the client's message list. */
	| { type: "messages_reset"; messages: ChatMessage[] }
	| { type: "bash_execution_update"; delta: string };

// ---------- Extension UI bridge (mirrors PI ExtensionUIContext) ----------

export type UIRequest =
	| { id: string; method: "select"; title: string; options: string[] }
	/** Tool-permission or plan approval; answered with `{ value }` (see PermissionPrompt for the values). */
	| ({ id: string; method: "permission" } & PermissionPrompt)
	| { id: string; method: "confirm"; title: string; message: string }
	| { id: string; method: "input"; title: string; placeholder?: string }
	| { id: string; method: "editor"; title: string; prefill?: string }
	| { id: string; method: "notify"; message: string; level: "info" | "warning" | "error" }
	| { id: string; method: "setStatus"; key: string; text?: string }
	| { id: string; method: "setWidget"; key: string; lines?: string[]; placement?: "aboveEditor" | "belowEditor" }
	| { id: string; method: "setTitle"; title: string }
	| { id: string; method: "setEditorText"; text: string };

export type UIResponse = { value: string } | { confirmed: boolean } | { cancelled: true };
export const BLOCKING_UI_METHODS = new Set<UIRequest["method"]>(["select", "confirm", "input", "editor", "permission"]);

/**
 * How tool calls are gated, after Claude Code:
 * default (ask before edits and commands), acceptEdits (file edits pass, commands still ask),
 * plan (read-only until the plan is approved), bypassPermissions (nothing is asked).
 */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

/**
 * Asked of the user before a tool runs (`kind: "tool"`) or when the model proposes a plan (`kind: "plan"`).
 * Answers: tool -> "allow" | "always" | "deny"; plan -> "acceptEdits" | "default" | "keep".
 * `always` is only offered when `alwaysLabel` is set (the remembered rule, e.g. "git").
 */
export type PermissionPrompt =
	| { kind: "tool"; toolName: string; summary: string; detail?: string; alwaysLabel?: string }
	| { kind: "plan"; plan: string };

// ---------- Domain DTOs ----------

export interface ModelRef { provider: string; id: string }
export interface ModelInfo extends ModelRef {
	name: string;
	reasoning: boolean;
	vision: boolean;
	contextWindow: number;
	thinkingLevels?: ThinkingLevel[];
}

export interface SessionSummary {
	id: string;
	name?: string;
	cwd: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	live: boolean;
	/** A run is in progress right now. */
	running: boolean;
	archived: boolean;
	/** Workspace (project directory) this session belongs to. */
	workspaceId: string;
}

/** A project directory; every session whose cwd resolves to `path` is grouped under it. */
export interface WorkspaceInfo {
	id: string;
	path: string;
	name: string;
	createdAt: string;
	lastUsedAt: string;
}

export interface DirListing {
	path: string;
	parent: string | null;
	dirs: { name: string; path: string }[];
	/** Filesystem roots (drive letters on Windows). */
	roots: string[];
	home: string;
}

/** Identifies a message by its position in the session snapshot; role + timestamp guard against stale lists. */
export interface MessageRef {
	index: number;
	role: string;
	timestamp: number;
}

/** What PI did with a submitted prompt: ran it, queued it behind the current run, or consumed it (e.g. an extension command). */
export type PromptDisposition = "started" | "queued" | "handled";

export interface HostSettings {
	/** PI auto-compaction (shared with the TUI through PI's settings.json). */
	autoCompaction: boolean;
}

export interface SessionSnapshot {
	id: string;
	name?: string;
	cwd: string;
	workspaceId: string;
	messages: ChatMessage[];
	model: ModelRef | null;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	permissionMode: PermissionMode;
	isStreaming: boolean;
	queue: { steering: string[]; followUp: string[] };
	pendingUI: UIRequest[];
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement: string }>;
}

/** Estimated tokens (chars/4) per context component; the sum approximates, not equals, `contextTokens`. */
export interface ContextBreakdown {
	system: number;
	tools: number;
	user: number;
	assistant: number;
	toolResults: number;
	other: number;
}

export interface SessionStats {
	/** Provider-reported when available, otherwise a local estimate (see `contextEstimated`). */
	contextTokens: number;
	contextEstimated: boolean;
	contextWindow: number;
	contextPercent: number | null;
	breakdown: ContextBreakdown;
	totalCost: number;
	inputTokens: number;
	outputTokens: number;
}

export interface CommandInfo { name: string; description?: string; source: "extension" | "prompt" | "skill" }
export interface ToolInfo { name: string; description: string; active: boolean }

export type GatewayAuth =
	| { type: "native" }
	| { type: "bearer" }
	| { type: "header"; header: string; prefix?: string }
	| { type: "none" };

export interface GatewayModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	vision?: boolean;
}

export interface GatewayConfig {
	id: string;
	name: string;
	format: GatewayFormat;
	baseUrl: string;
	auth: GatewayAuth;
	/** Write-only. Returned to clients masked (e.g. "sk-…a1b2") or empty. */
	apiKey?: string;
	headers?: Record<string, string>;
	models: GatewayModel[];
	enabled?: boolean;
}

export interface KnowledgeBaseInfo {
	id: string;
	name: string;
	description?: string;
	store: string;
	embedding: { gatewayId: string; model: string };
	documentCount: number;
	chunkCount: number;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	requests: number;
}

/** Token and cost totals across all sessions on disk. `days` of 0 means all time. */
export interface UsageStats {
	days: number;
	sessions: number;
	totals: UsageTotals;
	byModel: (UsageTotals & { provider: string; model: string })[];
	/** Local-time calendar days, ascending. */
	byDay: (UsageTotals & { date: string })[];
}

export interface KnowledgeDocumentInfo { id: string; title: string; chunks: number; addedAt: string }
export interface KnowledgeHit { documentId: string; title: string; text: string; score: number }

export interface PluginInfo {
	/** Stable key: the name for built-ins, the folder name for folder plugins, the specifier for config ones. */
	id: string;
	name: string;
	version?: string;
	source: "builtin" | "config" | "directory";
	status: "loaded" | "error" | "disabled";
	error?: string;
	panels: PanelInfo[];
	/** Can be switched off and on without a restart. */
	toggleable: boolean;
	/** Folder plugins can be deleted from inside the app. */
	removable: boolean;
	/** Manual steps still needed for this plugin to be fully in effect (e.g. restart the app); empty when none. */
	notes: string[];
}
export interface PanelInfo { plugin: string; id: string; title: string; icon?: string; url: string }

export interface HostInfo {
	version: string;
	piVersion: string;
	protocol: number;
	cwd: string;
	platform: string;
}

// ---------- Built-in management plugins (called through plugin.call) ----------

export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

export interface McpServerSpec {
	type: "stdio" | "http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	description?: string;
	exposure?: McpExposure;
	enabled?: boolean;
	timeout?: number;
}

export interface McpServerInfo {
	name: string;
	spec: McpServerSpec;
	/** "prometheus" entries are editable here; "pi" ones come from PI's own mcp.json (read-only). */
	source: "prometheus" | "pi";
}

export interface McpProbeResult {
	ok: boolean;
	latencyMs: number;
	server?: string;
	tools: { name: string; description?: string }[];
	error?: string;
}

export interface SkillInfo {
	name: string;
	description: string;
	path: string;
	scope: "builtin" | "prometheus" | "user" | "project";
	enabled: boolean;
	editable: boolean;
	modelInvocation: boolean;
}

export interface SkillDocument {
	name: string;
	content: string;
}

export type PackageKind = "extensions" | "skills" | "prompts" | "themes";

/** A PI package declared in settings.json (`pi install` equivalent). */
export interface PackageInfo {
	/** Settings source string, e.g. `npm:pkg@1.0.0` or `git:github.com/o/r`. */
	source: string;
	scope: "user" | "project";
	name: string;
	version?: string;
	description?: string;
	kinds: PackageKind[];
	/** False when declared but not present on disk yet. */
	installed: boolean;
	/** The settings entry narrows which resources load. */
	filtered: boolean;
}

/** One marketplace search hit (npm packages tagged `pi-package`). */
export interface PackageListing {
	name: string;
	version: string;
	description?: string;
	author?: string;
	date?: string;
	keywords: string[];
	source: string;
	links: { npm?: string; homepage?: string; repository?: string };
}

export interface PackageSearchPage {
	total: number;
	items: PackageListing[];
	page: number;
	size: number;
}

export interface PackageUpdateInfo {
	source: string;
	name: string;
	scope: "user" | "project";
	type: "npm" | "git";
}

/** A background install/remove/update; finished jobs stay listed (with the npm output) until dismissed. */
export interface PackageJob {
	id: string;
	action: "install" | "remove" | "update";
	/** Normalised package source; `*` for "update everything". */
	source: string;
	label: string;
	status: "queued" | "running" | "success" | "error";
	startedAt: number;
	finishedAt?: number;
	/** Human-readable reason when `status` is `error`. */
	error?: string;
	/** Captured npm/git output, most recent lines last. */
	log: string[];
}

export type MemoryScope = "user" | "project";
export interface MemoryEntry {
	id: string;
	content: string;
	tags: string[];
	scope: MemoryScope;
	/** Absolute project path for project-scoped entries. */
	project?: string;
	pinned: boolean;
	source: "user" | "agent";
	createdAt: string;
	updatedAt: string;
}

// ---------- RPC surface ----------

/** What an unattended run (automation) may do; anything beyond it is refused rather than asked. */
export type RunAccess = "readonly" | "edits" | "full";

export interface PluginFile {
	/** Relative path inside the plugin folder, forward slashes. */
	path: string;
	content: string;
}

export interface PluginInstallResult {
	plugin: PluginInfo;
	/** An older version was replaced. */
	updated: boolean;
	/** Live in the running app: open chats pick up its tools once they finish the current turn. */
	hot: boolean;
	/** Why part of the change still needs an app restart; empty when none. */
	restartReasons: string[];
}

// ---------- Task tracking (todos plugin) ----------

export const TODO_TOOL = "todo_write";
export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** Present-tense wording shown while the item is in progress. */
	activeForm?: string;
}

/** Lenient reader for `todo_write` arguments, shared by the tool and the chat panel. */
export function parseTodos(input: unknown): TodoItem[] {
	const list = Array.isArray(input) ? input : input && typeof input === "object" ? (input as { todos?: unknown }).todos : undefined;
	if (!Array.isArray(list)) return [];
	const out: TodoItem[] = [];
	for (const raw of list) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		const content = typeof r.content === "string" ? r.content.trim() : "";
		if (!content) continue;
		const status: TodoStatus = r.status === "in_progress" || r.status === "completed" ? r.status : "pending";
		const active = typeof r.activeForm === "string" ? r.activeForm.trim() : "";
		out.push({ content: content.slice(0, 300), status, ...(active ? { activeForm: active.slice(0, 300) } : {}) });
		if (out.length >= 50) break;
	}
	return out;
}

/**
 * The current task list of a conversation: the newest `todo_write` call that the tool accepted.
 * A call still waiting for its result counts, so a new list shows the moment the model sends it.
 */
export function latestTodos(messages: readonly ChatMessage[]): TodoItem[] {
	const failed = new Set<string>();
	for (const m of messages) if (m.role === "toolResult" && m.isError) failed.add(m.toolCallId);
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		for (let j = m.content.length - 1; j >= 0; j--) {
			const block = m.content[j];
			if (block?.type !== "toolCall" || block.name !== TODO_TOOL || failed.has(block.id)) continue;
			const todos = parseTodos(block.arguments);
			if (todos.length) return todos;
		}
	}
	return [];
}

// ---------- Git plugin ----------

/** One-letter porcelain codes: M modified, A added, D deleted, R renamed, C copied, U unmerged, ? untracked, space unchanged. */
export interface GitFileChange {
	path: string;
	origPath?: string;
	index: string;
	worktree: string;
}

export interface GitStatus {
	isRepo: boolean;
	root?: string;
	branch?: string;
	detached?: boolean;
	upstream?: string;
	ahead: number;
	behind: number;
	files: GitFileChange[];
}

export interface GitCommit {
	hash: string;
	short: string;
	author: string;
	date: string;
	refs: string;
	subject: string;
}

export interface GitBranch {
	name: string;
	current: boolean;
	remote: boolean;
	upstream?: string;
}

export interface GitDiff {
	text: string;
	truncated: boolean;
}

// ---------- Automations plugin ----------

export type AutomationSchedule =
	| { type: "interval"; minutes: number }
	/** `time` is local "HH:MM"; `days` are weekdays 0 (Sunday) to 6, every day when omitted. */
	| { type: "daily"; time: string; days?: number[] }
	| { type: "once"; at: string };

export interface AutomationTask {
	id: string;
	name: string;
	prompt: string;
	workspaceId: string;
	schedule: AutomationSchedule;
	access: RunAccess;
	enabled: boolean;
	model?: ModelRef;
	createdAt: string;
	nextRunAt?: string;
	lastRunAt?: string;
}

export type AutomationInput = Pick<AutomationTask, "name" | "prompt" | "workspaceId" | "schedule" | "access" | "enabled" | "model">;

export interface AutomationRun {
	id: string;
	taskId: string;
	taskName: string;
	startedAt: string;
	finishedAt?: string;
	status: "running" | "success" | "error" | "skipped";
	sessionId?: string;
	summary?: string;
	error?: string;
}

// ---------- Voice plugin ----------

export interface VoiceSettings {
	gatewayId: string;
	model: string;
	/** ISO-639-1 hint such as "zh" or "en"; empty lets the model detect it. */
	language: string;
}

export interface VoiceState extends VoiceSettings {
	configured: boolean;
}

export interface RpcMethods {
	"host.info": { params: Record<string, never>; result: HostInfo };

	"session.list": { params: Record<string, never>; result: SessionSummary[] };
	"session.create": { params: { cwd?: string; name?: string }; result: SessionSnapshot };
	"session.open": { params: { sessionId: string }; result: SessionSnapshot };
	"session.rename": { params: { sessionId: string; name: string }; result: null };
	"session.close": { params: { sessionId: string }; result: null };
	"session.archive": { params: { sessionId: string; archived: boolean }; result: null };
	"session.delete": { params: { sessionId: string }; result: null };
	"session.stats": { params: { sessionId: string }; result: SessionStats };
	"usage.stats": { params: { days?: number }; result: UsageStats };

	"message.delete": { params: { sessionId: string; ref: MessageRef }; result: null };
	"message.retry": { params: { sessionId: string; ref: MessageRef }; result: null };
	"message.fork": { params: { sessionId: string; ref: MessageRef }; result: { snapshot: SessionSnapshot; editorText?: string } };

	"workspace.list": { params: Record<string, never>; result: WorkspaceInfo[] };
	"workspace.add": { params: { path: string; name?: string }; result: WorkspaceInfo };
	"workspace.rename": { params: { id: string; name: string }; result: WorkspaceInfo };
	"workspace.remove": { params: { id: string }; result: null };
	/** Reveal the workspace folder in the OS file manager of the machine running the server. */
	"workspace.open": { params: { id: string }; result: null };
	"fs.dirs": { params: { path?: string }; result: DirListing };

	"settings.get": { params: Record<string, never>; result: HostSettings };
	"settings.set": { params: Partial<HostSettings>; result: HostSettings };

	"chat.prompt": { params: { sessionId: string; text: string; images?: ImageContent[]; delivery?: "steer" | "followUp" }; result: { disposition: PromptDisposition } };
	"chat.abort": { params: { sessionId: string }; result: null };
	"chat.compact": { params: { sessionId: string; instructions?: string }; result: null };

	"model.list": { params: Record<string, never>; result: ModelInfo[] };
	"model.set": { params: { sessionId: string; model: ModelRef }; result: null };
	"thinking.set": { params: { sessionId: string; level: ThinkingLevel }; result: null };
	"permission.set": { params: { sessionId: string; mode: PermissionMode }; result: null };

	"commands.list": { params: { sessionId: string }; result: CommandInfo[] };
	"tools.list": { params: { sessionId: string }; result: ToolInfo[] };
	"tools.set": { params: { sessionId: string; active: string[] }; result: null };

	"ui.respond": { params: { sessionId: string; requestId: string; response: UIResponse }; result: null };

	"gateway.list": { params: Record<string, never>; result: GatewayConfig[] };
	"gateway.save": { params: { gateway: GatewayConfig }; result: GatewayConfig };
	"gateway.delete": { params: { id: string }; result: null };
	"gateway.test": { params: { id: string; model?: string }; result: { ok: boolean; latencyMs: number; message: string } };
	/** Fetch the provider's model catalogue using an (unsaved) draft; a masked apiKey falls back to the stored one. */
	"gateway.models": { params: { gateway: GatewayConfig }; result: GatewayModel[] };

	"kb.list": { params: Record<string, never>; result: KnowledgeBaseInfo[] };
	"kb.create": { params: { name: string; description?: string; store?: string; embedding: { gatewayId: string; model: string } }; result: KnowledgeBaseInfo };
	/** Only allowed while the base has no documents, since vectors from different models are incompatible. */
	"kb.update": { params: { id: string; name?: string; description?: string; embedding?: { gatewayId: string; model: string } }; result: KnowledgeBaseInfo };
	"kb.delete": { params: { id: string }; result: null };
	"kb.documents": { params: { id: string }; result: KnowledgeDocumentInfo[] };
	"kb.ingest": { params: { id: string; title: string; text: string }; result: KnowledgeDocumentInfo };
	"kb.removeDocument": { params: { id: string; documentId: string }; result: null };
	"kb.search": { params: { id: string; query: string; topK?: number }; result: KnowledgeHit[] };
	"kb.stores": { params: Record<string, never>; result: string[] };

	"plugin.list": { params: Record<string, never>; result: PluginInfo[] };
	"plugin.call": { params: { plugin: string; method: string; params?: Record<string, unknown> }; result: unknown };
	/** Write a folder plugin (single-file ESM, no imports needed) under the data dir and load it without a restart. */
	"plugin.install": { params: { name: string; files: PluginFile[]; version?: string }; result: PluginInstallResult };
	/** Pick up plugin folders that appeared under the data dir since startup. */
	"plugin.scan": { params: Record<string, never>; result: PluginInfo[] };
	"plugin.setEnabled": { params: { id: string; enabled: boolean }; result: PluginInfo };
	"plugin.reload": { params: { id: string }; result: PluginInfo };
	"plugin.remove": { params: { id: string }; result: null };
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]["result"];

// ---------- Frames ----------

export type ClientFrame =
	| { type: "auth"; token: string }
	| { type: "subscribe"; sessionId: string }
	| { type: "unsubscribe"; sessionId: string }
	| { [M in RpcMethod]: { type: "rpc"; id: string; method: M; params: RpcParams<M> } }[RpcMethod];

export type ServerFrame =
	| { type: "hello"; protocol: number; authRequired: boolean }
	| { type: "auth_ok" }
	| { type: "response"; id: string; ok: true; data: unknown }
	| { type: "response"; id: string; ok: false; error: string }
	| { type: "event"; sessionId: string; event: SessionEvent }
	| { type: "ui.request"; sessionId: string; request: UIRequest }
	| { type: "ui.resolved"; sessionId: string; requestId: string }
	| { type: "sessions.changed" }
	| { type: "plugins.changed" }
	/** One plugin's data changed (see PluginContext.notifyChanged). */
	| { type: "plugin.notify"; plugin: string }
	| { type: "gateways.changed" }
	| { type: "error"; message: string };
