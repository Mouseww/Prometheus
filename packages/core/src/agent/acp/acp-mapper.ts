// Translates ACP `session/update` notifications into Prometheus wire events and ChatMessages.
// Text and thought chunks stream into one assistant message each (a new one whenever the kind changes or a tool call
// comes in between); every tool call becomes its own assistant message followed by a tool result, which is the shape
// the existing renderers expect (docs/agent-runtime.md §3, §4.3, §4.4).
import type { AssistantMessage, ChatMessage, SessionEvent, ToolResultMessage, Usage } from "@prometheus/protocol";
import type { BusToolEvent } from "../bus/tool-bus.ts";
import { HANDOFF_TAG } from "../handoff.ts";

export const CONTEXT_TAG = "prometheus-context";
const HIDDEN_RE = new RegExp(`<(${CONTEXT_TAG}|${HANDOFF_TAG})>[\\s\\S]*?</\\1>\\s*`, "g");

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const drop = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const hasInput = (v: unknown): boolean => v !== undefined && v !== null && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

/** ACP tool kinds that are never one of our MCP tools. */
const NATIVE_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute"]);

export interface AcpMapperOptions {
	provider: string;
	model: () => string;
	emit(event: SessionEvent): void;
	/** Names of the Prometheus tools the bus serves, to recognise them among the agent's tool calls. */
	busTools(): string[];
	now?: () => number;
}

/** What the agent told us about one tool call so far (`tool_call` and its `tool_call_update`s merged). */
export interface AcpToolCall {
	toolCallId: string;
	title?: string;
	kind?: string;
	status?: string;
	rawInput?: unknown;
	rawOutput?: unknown;
	content?: any[];
	locations?: { path?: string; line?: number }[];
	/** The agent's internal tool name, when it reports one in `_meta` (Qwen Code). */
	metaName?: string;
}

interface Item extends AcpToolCall {
	started: number;
	shown: boolean;
	ended: boolean;
	name?: string;
	args?: Record<string, unknown>;
	/** Prometheus tool name when this is a call of the tool bus; null once known not to be. */
	bus?: string | null;
	busId?: string;
}

/** The diff blocks of a tool call's content. */
function diffs(content: any[] | undefined): { path: string; oldText: string; newText: string }[] {
	return (content ?? []).filter((c) => c?.type === "diff").map((c) => ({ path: String(c.path ?? ""), oldText: typeof c.oldText === "string" ? c.oldText : "", newText: String(c.newText ?? "") }));
}

/** The text a tool call's content and output carry. */
function contentText(call: AcpToolCall): string {
	const parts: string[] = [];
	for (const c of call.content ?? []) {
		if (c?.type === "content") {
			const b = obj(c.content);
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
			else if (b.type === "resource_link") parts.push(String(b.uri ?? b.name ?? ""));
			else if (b.type === "resource") parts.push(String(obj(b.resource).text ?? obj(b.resource).uri ?? ""));
			else if (b.type === "image") parts.push("[image]");
		} else if (c?.type === "diff") {
			parts.push(`${c.oldText ? "Edited" : "Wrote"} ${c.path}`);
		} else if (c?.type === "terminal") {
			parts.push(`[terminal ${c.terminalId}]`);
		}
	}
	if (!parts.length && call.rawOutput !== undefined) {
		const out = call.rawOutput;
		const o = obj(out);
		parts.push(typeof out === "string" ? out : (str(o.output) ?? str(o.stdout) ?? str(o.content) ?? JSON.stringify(out)));
	}
	return parts.filter(Boolean).join("\n");
}

/** The agent's tool call in the names and argument shapes Prometheus already renders. */
export function canonicalAcpTool(call: AcpToolCall): { name: string; args: Record<string, unknown> } {
	const input = obj(call.rawInput);
	const path = str(input.path) ?? str(input.file_path) ?? str(input.filePath) ?? str(input.absolute_path) ?? str(input.absolutePath) ?? call.locations?.[0]?.path;
	const title = (call.title ?? "").trim();
	switch (call.kind) {
		case "execute":
			return { name: "bash", args: drop({ command: str(input.command) ?? str(input.cmd) ?? (Array.isArray(input.command) ? input.command.join(" ") : undefined) ?? title, description: str(input.description) }) };
		case "read":
			return { name: "read", args: drop({ path: path ?? title, offset: input.offset, limit: input.limit }) };
		case "edit": {
			const d = diffs(call.content);
			if (d.length === 1 && !d[0]!.oldText && !str(input.old_string) && !str(input.oldString)) return { name: "write", args: { path: d[0]!.path || path || "", content: d[0]!.newText } };
			if (d.length) return { name: "edit", args: { path: d[0]!.path || path || "", edits: d.map((x) => ({ oldText: x.oldText, newText: x.newText })) } };
			const oldText = str(input.old_string) ?? str(input.oldString);
			const newText = str(input.new_string) ?? str(input.newString);
			if (oldText !== undefined || newText !== undefined) return { name: "edit", args: { path: path ?? "", edits: [{ oldText: oldText ?? "", newText: newText ?? "" }] } };
			if (typeof input.content === "string") return { name: "write", args: { path: path ?? "", content: input.content } };
			return { name: "edit", args: { path: path ?? title, edits: [] } };
		}
		case "delete":
			return { name: "delete", args: drop({ path: path ?? title }) };
		case "move":
			return { name: "move", args: drop({ path: path ?? title, to: str(input.destination) ?? str(input.to) ?? call.locations?.[1]?.path }) };
		case "search":
			return { name: "grep", args: drop({ pattern: str(input.pattern) ?? str(input.query) ?? title, path, glob: str(input.glob) ?? str(input.include) }) };
		case "fetch": {
			const url = str(input.url);
			if (url) return { name: "web_fetch", args: { ...input, url } };
			return { name: "web_search", args: { query: str(input.query) ?? title, ...input } };
		}
		case "think":
			return { name: "think", args: input };
		case "switch_mode":
			return { name: "switch_mode", args: input };
		default:
			return { name: title ? title.slice(0, 80) : "tool", args: input };
	}
}

/** Text of a prompt as the user wrote it, without the context Prometheus put beside it. */
export function stripHidden(text: string): string {
	return text.replace(HIDDEN_RE, "");
}

export class AcpMapper {
	readonly messages: ChatMessage[] = [];
	readonly total = zeroUsage();
	contextTokens = 0;
	contextWindow = 0;
	totalCost = 0;
	/** The agent's slash commands (`available_commands_update`). */
	commands: { name: string; description?: string }[] = [];
	/** Events are not emitted (rebuilding the transcript from `session/load`). */
	silent = false;
	private inRun = false;
	private turnOpen = false;
	private current: { message: AssistantMessage; kind: "text" | "thinking" } | undefined;
	private replayUser: string | undefined;
	private readonly items = new Map<string, Item>();
	private waitingBus: Extract<BusToolEvent, { type: "start" }>[] = [];
	private readonly busToItem = new Map<string, string>();
	private readonly busEnded = new Set<string>();
	private readonly busResults = new Map<string, Extract<BusToolEvent, { type: "end" }>>();
	private readonly lateEnds = new Map<string, Extract<BusToolEvent, { type: "end" }>>();
	private readonly opts: AcpMapperOptions;

	constructor(opts: AcpMapperOptions) {
		this.opts = opts;
	}

	private now(): number {
		return this.opts.now?.() ?? Date.now();
	}
	private emit(e: SessionEvent): void {
		if (!this.silent) this.opts.emit(e);
	}
	get running(): boolean {
		return this.inRun;
	}
	setMessages(messages: ChatMessage[]): void {
		this.messages.length = 0;
		this.messages.push(...messages);
	}

	/** The user's message of a new run. */
	user(content: string | any[]): void {
		this.startRun();
		const message = { role: "user", content, timestamp: this.now() } as ChatMessage;
		this.messages.push(message);
		this.emit({ type: "message_start", message });
		this.emit({ type: "message_end", message });
	}

	private startRun(): void {
		if (this.inRun) return;
		this.inRun = true;
		this.emit({ type: "agent_start" });
	}
	private openTurn(): void {
		if (this.turnOpen) return;
		this.turnOpen = true;
		this.emit({ type: "turn_start" });
	}

	private assistant(): AssistantMessage {
		return { role: "assistant", content: [], provider: this.opts.provider, model: this.opts.model(), usage: zeroUsage(), stopReason: "pending", timestamp: this.now() };
	}

	// ---------- session/update ----------

	update(u: any): void {
		const kind = String(u?.sessionUpdate ?? "");
		if (kind !== "user_message_chunk") this.flushReplayUser();
		switch (kind) {
			case "user_message_chunk":
				return this.userChunk(u.content);
			case "agent_message_chunk":
				return this.chunk("text", u.content);
			case "agent_thought_chunk":
				return this.chunk("thinking", u.content);
			case "tool_call":
				return this.toolCall(u, true);
			case "tool_call_update":
				return this.toolCall(u, false);
			case "plan":
				return this.plan(u);
			case "available_commands_update":
				this.commands = (Array.isArray(u.availableCommands) ? u.availableCommands : []).filter((c: any) => c?.name).map((c: any) => ({ name: String(c.name), ...(c.description ? { description: String(c.description) } : {}) }));
				return;
			case "usage_update": {
				if (typeof u.used === "number") this.contextTokens = u.used;
				if (typeof u.size === "number") this.contextWindow = u.size;
				const cost = obj(u.cost);
				if (typeof cost.amount === "number") this.totalCost = cost.amount;
				return;
			}
			default:
				return;
		}
	}

	/** Replay only: the user's messages of a stored session arrive as chunks. */
	private userChunk(content: any): void {
		if (!this.silent) return;
		const b = obj(content);
		if (b.type !== "text" || typeof b.text !== "string") return;
		if (this.replayUser === undefined) {
			if (this.inRun) this.finish(false);
			this.replayUser = "";
		}
		this.replayUser += b.text;
	}

	private flushReplayUser(): void {
		if (this.replayUser === undefined) return;
		const text = stripHidden(this.replayUser).trim();
		this.replayUser = undefined;
		if (text) this.user(text);
		else this.startRun();
	}

	private chunk(kind: "text" | "thinking", content: any): void {
		const b = obj(content);
		if (b.type !== "text" || typeof b.text !== "string" || !b.text) return;
		if (this.current?.kind !== kind) {
			this.closeCurrent();
			this.startRun();
			this.openTurn();
			const message = this.assistant();
			message.content[0] = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
			this.current = { message, kind };
			this.emit({ type: "message_start", message });
			this.emit({ type: "message_update", delta: { type: "start" } });
			this.emit({ type: "message_update", delta: { type: kind === "text" ? "text_start" : "thinking_start", contentIndex: 0 } });
		}
		const c = this.current!.message.content[0]!;
		if (c.type === "text") {
			c.text += b.text;
			this.emit({ type: "message_update", delta: { type: "text_delta", contentIndex: 0, delta: b.text } });
		} else if (c.type === "thinking") {
			c.thinking += b.text;
			this.emit({ type: "message_update", delta: { type: "thinking_delta", contentIndex: 0, delta: b.text } });
		}
	}

	private closeCurrent(): void {
		const cur = this.current;
		if (!cur) return;
		this.current = undefined;
		this.emit({ type: "message_update", delta: { type: cur.kind === "text" ? "text_end" : "thinking_end", contentIndex: 0 } });
		cur.message.stopReason = "stop";
		this.emit({ type: "message_update", delta: { type: "done", reason: "stop" } });
		this.messages.push(cur.message);
		this.emit({ type: "message_end", message: cur.message });
	}

	// ---------- tool calls ----------

	/** Merges what a `tool_call`, `tool_call_update` or permission request says about a call; returns the call so far. */
	merge(u: any): AcpToolCall | undefined {
		const id = str(u?.toolCallId);
		if (!id) return undefined;
		let item = this.items.get(id);
		if (!item) {
			item = { toolCallId: id, started: this.now(), shown: false, ended: false };
			this.items.set(id, item);
		}
		if (typeof u.title === "string" && u.title) item.title = u.title;
		if (typeof u.kind === "string") item.kind = u.kind;
		if (typeof u.status === "string") item.status = u.status;
		// Some agents send `{}` while the call is still being prepared: that says nothing about the input.
		if (hasInput(u.rawInput)) item.rawInput = u.rawInput;
		if (u.rawOutput !== undefined) item.rawOutput = u.rawOutput;
		if (Array.isArray(u.content)) item.content = u.content;
		if (Array.isArray(u.locations)) item.locations = u.locations;
		const metaName = str(obj(u._meta).toolName);
		if (metaName) item.metaName = metaName;
		if (item.bus === undefined || (item.bus === null && !item.shown)) item.bus = this.matchBus(item);
		return item;
	}

	/** The Prometheus tool a call is, judging by its title (`memory_search (prometheus MCP Server)`, `mcp__prometheus__memory_search`, ...). */
	private matchBus(call: AcpToolCall): string | null {
		if (call.kind && NATIVE_KINDS.has(call.kind)) return null;
		const words = (call.title ?? "").split(/[^A-Za-z0-9_.-]+/).filter(Boolean);
		// The tool's own name leads the title (`echo_tool (prometheus MCP Server)`); later words may just mention a
		// tool (`ToolSearch: echo_tool`). A proxy that runs another tool by name (Qwen Code's `tool_call` for deferred
		// tools) names it in its input; some agents put the real name in `_meta`.
		const named = [str(obj(call.rawInput).name), str(obj(call.rawInput).tool_name), str(obj(call.rawInput).toolName), call.metaName].filter((v): v is string => Boolean(v));
		const exact = [...(words[0] ? [words[0]] : []), ...named];
		const qualified = words.filter((t) => t.includes("__") || /^prometheus[_.-]/i.test(t));
		if (!exact.length && !qualified.length) return null;
		let best: string | null = null;
		for (const name of this.opts.busTools()) {
			const hit = exact.includes(name) || [...exact, ...qualified].some((t) => t.endsWith(`__${name}`) || (/^prometheus/i.test(t) && (t.endsWith(`_${name}`) || t.endsWith(`-${name}`) || t.endsWith(`.${name}`))));
			if (hit && (!best || name.length > best.length)) best = name;
		}
		return best;
	}

	/** Whether a call is one of our tools (its permission is decided by the bus, not asked twice). */
	isBusCall(id: string): boolean {
		return Boolean(this.items.get(id)?.bus);
	}

	private toolCall(u: any, isNew: boolean): void {
		const before = this.items.get(String(u?.toolCallId ?? ""));
		if (isNew || !before?.shown) this.closeCurrent();
		const item = this.merge(u) as Item | undefined;
		if (!item || item.ended) return;
		this.startRun();
		this.openTurn();
		if (item.bus) {
			if (!item.busId) this.bindFromItem(item);
		} else if (!item.shown && this.ready(item)) {
			this.show(item);
		}
		if (item.shown && item.status === "in_progress" && !item.bus) {
			const text = contentText(item);
			if (text) this.emit({ type: "tool_execution_update", toolCallId: item.toolCallId, toolName: item.name ?? "tool", partialResult: { content: [{ type: "text", text }] } });
		}
		if (item.status === "completed" || item.status === "failed") this.done(item, item.status === "failed");
	}

	/** Enough is known to draw the card: a pending command needs its command line, others a path, diff or input. */
	private ready(item: Item): boolean {
		if (item.status && item.status !== "pending") return true;
		if (item.kind === "execute") return hasInput(item.rawInput);
		return hasInput(item.rawInput) || Boolean(item.content?.length) || Boolean(item.locations?.length);
	}

	/** Shows the tool card for a call that a permission request is about (it may not have been shown yet). */
	reveal(id: string): void {
		const item = this.items.get(id);
		if (item && !item.shown && !item.bus && !item.ended) {
			this.closeCurrent();
			this.startRun();
			this.openTurn();
			this.show(item);
		}
	}

	private show(item: Item, name?: string, args?: Record<string, unknown>): void {
		const call = name ? { name, args: args ?? {} } : canonicalAcpTool(item);
		item.shown = true;
		item.name = call.name;
		item.args = call.args;
		const message = this.assistant();
		message.content[0] = { type: "toolCall", id: item.toolCallId, name: call.name, arguments: call.args };
		this.emit({ type: "message_start", message });
		this.emit({ type: "message_update", delta: { type: "start" } });
		this.emit({ type: "message_update", delta: { type: "toolcall_start", contentIndex: 0, id: item.toolCallId, name: call.name } });
		this.emit({ type: "message_update", delta: { type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as never } });
		message.stopReason = "toolUse";
		this.emit({ type: "message_update", delta: { type: "done", reason: "toolUse" } });
		this.messages.push(message);
		this.emit({ type: "message_end", message });
		this.emit({ type: "tool_execution_start", toolCallId: item.toolCallId, toolName: call.name, args: call.args });
	}

	private done(item: Item, failed: boolean): void {
		if (!item.shown) this.show(item, item.bus ?? undefined, item.bus ? obj(item.rawInput) : undefined);
		item.ended = true;
		const name = item.name ?? "tool";
		let parts: { type: "text"; text: string }[] = [{ type: "text", text: contentText(item) || (failed ? "failed" : "") }];
		let isError = failed;
		let details: Record<string, unknown> = {};
		const d = diffs(item.content);
		if (d.length) details = { diffs: d.map((x) => ({ path: x.path })) };
		const bus = this.busResults.get(item.toolCallId);
		if (bus) {
			parts = (bus.result.content ?? []).map((c: any) => ({ type: "text" as const, text: c.type === "text" ? String(c.text) : "[image]" }));
			isError = bus.isError;
			details = (bus.result.details ?? {}) as Record<string, unknown>;
		}
		if (!this.busEnded.has(item.toolCallId)) this.emit({ type: "tool_execution_end", toolCallId: item.toolCallId, toolName: name, result: { content: parts, details }, isError, durationMs: this.now() - item.started });
		const message: ToolResultMessage = { role: "toolResult", toolCallId: item.toolCallId, toolName: name, content: parts, isError, timestamp: this.now() };
		this.messages.push(message);
		this.emit({ type: "message_start", message });
		this.emit({ type: "message_end", message });
	}

	/** The agent's plan feeds the todo panel the way `todo_write` does. */
	private plan(u: any): void {
		const entries: any[] = Array.isArray(u?.entries) ? u.entries : [];
		this.closeCurrent();
		const todos = entries.map((e) => ({ content: String(e?.content ?? ""), status: e?.status === "in_progress" ? "in_progress" : e?.status === "completed" ? "completed" : "pending", activeForm: String(e?.content ?? "") }));
		const id = `plan-${this.now()}-${Math.random().toString(36).slice(2, 6)}`;
		this.emit({ type: "tool_execution_start", toolCallId: id, toolName: "todo_write", args: { todos } });
		this.emit({ type: "tool_execution_end", toolCallId: id, toolName: "todo_write", result: { content: [{ type: "text", text: "Plan updated." }], details: { todos } }, isError: false });
	}

	// ---------- tool bus correlation: ACP gives no call id to the MCP server, so match by tool name in order ----------

	private bindFromItem(item: Item): void {
		const i = this.waitingBus.findIndex((w) => w.name === item.bus);
		if (i < 0) return;
		const [start] = this.waitingBus.splice(i, 1);
		this.bind(item, start!);
	}

	private bind(item: Item, start: Extract<BusToolEvent, { type: "start" }>): void {
		item.busId = start.toolCallId;
		this.busToItem.set(start.toolCallId, item.toolCallId);
		if (!item.shown) this.show(item, start.name, obj(start.args));
		const late = this.lateEnds.get(start.toolCallId);
		if (late) {
			this.lateEnds.delete(start.toolCallId);
			this.bus(late);
		}
	}

	bus(e: BusToolEvent): void {
		if (e.type === "start") {
			const item = [...this.items.values()].find((it) => it.bus === e.name && !it.busId && !it.ended);
			if (item) {
				this.closeCurrent();
				this.bind(item, e);
			} else this.waitingBus.push(e);
			return;
		}
		const itemId = this.busToItem.get(e.toolCallId);
		if (!itemId) {
			if (e.type === "end") this.lateEnds.set(e.toolCallId, e);
			return;
		}
		if (e.type === "update") {
			this.emit({ type: "tool_execution_update", toolCallId: itemId, toolName: e.name, partialResult: e.partial });
			return;
		}
		this.busResults.set(itemId, e);
		if (!this.busEnded.has(itemId)) {
			this.busEnded.add(itemId);
			this.emit({ type: "tool_execution_end", toolCallId: itemId, toolName: e.name, result: { content: e.result.content ?? [], details: e.result.details ?? {} }, isError: e.isError, durationMs: e.durationMs });
		}
	}

	/** Bus calls the agent never reported as tool calls still get a card. */
	private flushOrphans(): void {
		for (const start of this.waitingBus.splice(0)) {
			const end = this.lateEnds.get(start.toolCallId);
			if (!end) continue;
			this.lateEnds.delete(start.toolCallId);
			const item: Item = { toolCallId: start.toolCallId, started: this.now() - end.durationMs, shown: false, ended: false, bus: start.name };
			this.items.set(item.toolCallId, item);
			this.show(item, start.name, obj(start.args));
			this.busResults.set(item.toolCallId, end);
			this.done(item, end.isError);
		}
		this.lateEnds.clear();
	}

	// ---------- run end ----------

	finish(aborted: boolean, error?: string): void {
		this.flushReplayUser();
		this.closeCurrent();
		this.flushOrphans();
		for (const item of this.items.values()) {
			if (!item.shown || item.ended) continue;
			item.status = "failed";
			if (!item.content?.length && item.rawOutput === undefined) item.rawOutput = aborted ? "Cancelled." : "The agent ended the turn before this tool finished.";
			this.done(item, true);
		}
		if (error && !aborted) {
			const message: AssistantMessage = { ...this.assistant(), content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: error };
			this.messages.push(message);
			this.emit({ type: "message_start", message });
			this.emit({ type: "message_end", message });
		}
		this.items.clear();
		this.waitingBus = [];
		this.busToItem.clear();
		this.busEnded.clear();
		this.busResults.clear();
		if (this.turnOpen) {
			this.turnOpen = false;
			this.emit({ type: "turn_end" });
		}
		const was = this.inRun;
		this.inRun = false;
		if (was) this.emit({ type: "agent_end", willRetry: false });
		this.emit({ type: "agent_settled", aborted });
	}

	lastReply(): string {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i]!;
			if (m.role === "assistant") {
				const text = (m as AssistantMessage).content.map((c) => (c.type === "text" ? c.text : "")).join("");
				if (text) return text;
			}
		}
		return "";
	}
}
