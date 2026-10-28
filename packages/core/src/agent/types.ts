// Runtime-neutral agent interfaces (docs/agent-runtime.md §3). Types only.
// PiRuntime (./pi/pi-runtime.ts) is the first implementation; the host keeps the session index and RPC.
import type {
	CanonicalToolKind,
	ChatMessage,
	GatewayChoice,
	RuntimeCapabilities,
	RuntimeHealth,
	RuntimeKind,
	CommandInfo,
	ImageContent,
	MessageRef,
	ModelInfo,
	ModelRef,
	PermissionMode,
	PromptDisposition,
	SessionEvent,
	SessionSnapshot,
	SessionStats,
	ThinkingLevel,
	ToolInfo,
	UsageStats,
} from "@prometheus/protocol";
import type { GatewayConfig } from "@prometheus/protocol";
import type { SubagentRuntime } from "@prometheus/subagents";
import type { PermissionGate } from "../permission-gate.ts";
import type { UIBridge } from "../ui-bridge.ts";

export type { CanonicalToolKind, GatewayChoice, RuntimeCapabilities, RuntimeHealth, RuntimeKind };

/** Identifies a persisted session of a given runtime. */
export interface SessionRef {
	runtime: RuntimeKind;
	/** Prometheus session id. */
	id: string;
	/** The runtime's own session / thread id (equal to `id` for PI). */
	nativeId: string;
	/** Native transcript file, when the runtime keeps one (PI's session .jsonl). */
	path?: string;
	/** Working directory and name from the Prometheus session index, for runtimes that cannot look them up themselves. */
	cwd?: string;
	name?: string;
}

/** A session found in a runtime's native storage, before Prometheus opens it. */
export interface NativeSessionInfo {
	ref: SessionRef;
	name?: string;
	cwd: string;
	/** ISO timestamps. */
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

/** Prometheus services an external runtime plugs into (docs §4, §5, §7). PI does not need them: it runs in-process. */
export interface RuntimeServices {
	bus: import("./bus/tool-bus.ts").ToolBus;
	relay: import("./relay/gateway-relay.ts").GatewayRelay;
	/** Plugin tools and context providers, seen through the neutral model (PiFacade for legacy plugins). */
	plugins: import("../plugin-host.ts").PluginHost;
	/** A configured gateway by id (read per request by the relay, so edits apply to running sessions). */
	gateway(id: string): import("@prometheus/protocol").GatewayConfig | undefined;
	/** Prometheus data directory. */
	dataDir: string;
	log: { info(m: string): void; warn(m: string): void };
}

/** How a session reports back to the host. The host builds one per session and passes it in `SessionInit`. */
export interface SessionHooks {
	/** The session exists and has its id, but its extensions are not bound yet (so UI requests may already name it). */
	created?(session: RuntimeSession): void;
	/** Every wire event in order, including `permission_mode_changed` emitted before the session returned (no `subscribe` caller exists yet). The same events also reach `subscribe` listeners. */
	event?(event: SessionEvent): void;
	/** Something that shows in the session list changed: a run started or settled, or the name changed. */
	sessionsChanged?(): void;
	/** Compaction replaced the context, so clients must rebuild their message list. */
	contextReplaced?(): void;
	/** A run settled (the session is idle again). */
	settled?(): void;
}

/** Everything a runtime needs to start or resume a session. Prometheus-owned services are shared, never duplicated. */
export interface SessionInit {
	/** Working directory of a new session; a resumed session takes it from its transcript (see `ResumeInit`). */
	cwd: string;
	/** Defaults to the runtime's native gateway. */
	gateway?: GatewayChoice;
	/** The single permission gate (§6). */
	permission: PermissionGate;
	/** The session's UI bridge for dialogs, statuses and widgets. */
	ui: UIBridge;
	/** The session's subagent runtime (a Prometheus service the runtime wires in as a tool and restores from the transcript). */
	subagents?: SubagentRuntime;
	hooks?: SessionHooks;
	/** Messages shown before the session's own (a conversation continued from another runtime). */
	history?: ChatMessage[];
	// Not yet modelled: the tool bus endpoint (§4) and the context composer (§5).
}

/** What `AgentRuntime.resume` needs: the working directory comes from the stored session. */
export type ResumeInit = Omit<SessionInit, "cwd">;

/** A user turn: text plus optional pictures. */
export interface UserInput {
	text: string;
	images?: ImageContent[];
	/** Model-facing context that is not shown as part of the user's message (e.g. a handoff from another runtime). */
	context?: string;
}

/** How a prompt is delivered: as a new turn, injected into the running turn, or queued after it. */
export type PromptDelivery = "send" | "steer" | "followUp";

/** The part of `SessionSnapshot` a runtime owns; the host adds permission mode, pending UI, statuses, widgets and subagents. */
export type RuntimeSnapshot = Pick<SessionSnapshot, "id" | "name" | "cwd" | "messages" | "model" | "thinkingLevel" | "availableThinkingLevels" | "isStreaming" | "queue">;

/** One agent runtime (PI in-process, Claude Code via its SDK, Codex via app-server). */
export interface AgentRuntime {
	readonly kind: RuntimeKind;
	/** Installed? Which version? Logged in? */
	probe(): Promise<RuntimeHealth>;
	listModels(gateway: GatewayChoice): Promise<ModelInfo[]>;
	/** Every model the runtime can use: its own login's plus those of each gateway it can talk to (provider = gateway id). */
	listAllModels?(gateways: GatewayConfig[]): Promise<ModelInfo[]>;
	create(init: SessionInit): Promise<RuntimeSession>;
	resume(ref: SessionRef, init: ResumeInit): Promise<RuntimeSession>;
	/** Sessions in the runtime's native storage. */
	listNative(): Promise<NativeSessionInfo[]>;
	/** Removes a session's native transcript. */
	deleteNative(ref: SessionRef): Promise<void>;
	/** Token and cost totals across native sessions; `days` of 0 means all time. */
	collectUsage(days: number): Promise<UsageStats>;
}

/** A live session of some runtime, speaking the wire protocol's events and message shapes. */
export interface RuntimeSession {
	/** Prometheus session id. */
	readonly id: string;
	/** The runtime's own session / thread id. */
	readonly nativeId: string;
	readonly capabilities: RuntimeCapabilities;
	/** A turn is in progress. */
	readonly isStreaming: boolean;
	/** Working directory of the session (cheap; unlike `snapshotState()` it copies nothing). */
	readonly cwd: string;
	/** Where the session is stored right now (the path appears once the runtime has one). */
	ref(): SessionRef;

	/** Resolves once the runtime accepts the prompt; the run itself streams through `subscribe`. */
	prompt(input: UserInput, delivery: PromptDelivery): Promise<PromptDisposition>;
	abort(): Promise<void>;
	/** Resolves when the current run (if any) has settled. */
	waitForIdle(): Promise<void>;
	/** Runs a turn to completion (unattended runs): resolves when settled, rejects if the prompt fails. */
	run(input: UserInput): Promise<void>;
	/** Text of the last assistant reply. */
	lastReply(): string;

	setModel(model: ModelRef): Promise<void>;
	setThinking(level: ThinkingLevel): Promise<void>;
	setPermissionMode(mode: PermissionMode): Promise<void>;
	setName(name: string): void;
	setAutoCompaction?(enabled: boolean): void;
	/** Re-read tools and extensions after a plugin install or mode change. */
	refreshTools(): Promise<void>;

	/** Normalized transcript of the current context. */
	messages(): ChatMessage[];
	snapshotState(): RuntimeSnapshot;
	commands(): CommandInfo[] | Promise<CommandInfo[]>;
	/** Tools available to the model, with whether each is currently active. */
	tools(): ToolInfo[];
	usage(): SessionStats;

	compact?(instructions?: string): Promise<void>;
	/** Branch back to the user message at or before `ref`; returns its content for resubmission. `text` replaces the message text (edit). */
	rewind?(ref: MessageRef, text?: string): Promise<UserInput>;
	/** Drop a message (and the tool results tied to it) from the context. */
	deleteMessages?(ref: MessageRef): Promise<void>;
	/** Take a waiting message out of the steer / follow-up queue; `text` guards against a stale index. */
	unqueue?(kind: "steer" | "followUp", index: number, text: string): UserInput;
	/** Start a new session from `ref`; forking at a user message returns its text for the editor. */
	fork?(ref: MessageRef): Promise<SessionRef & { editorText?: string }>;

	subscribe(listener: (event: SessionEvent) => void): () => void;
	dispose(): Promise<void>;
}
