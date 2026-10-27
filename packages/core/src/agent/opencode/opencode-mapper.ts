// Translates opencode server events into Prometheus wire events and ChatMessages (docs/agent-runtime.md §12.3).
// opencode reports an assistant message as a list of parts (text, reasoning, tool, step-finish, ...) that are
// created and then updated; each text, reasoning and tool part becomes one assistant message here, so tool calls and
// results line up the way the existing renderers expect (§3, §4.3, §4.4).
import type { AssistantMessage, ChatMessage, SessionEvent, ToolResultMessage, Usage } from "@prometheus/protocol";
import type { BusToolEvent } from "../bus/tool-bus.ts";

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** opencode shows tools of an MCP server as `<server>_<tool>`. */
export const PROMETHEUS_MCP_SERVER = "prometheus";
const MCP_PREFIX = `${PROMETHEUS_MCP_SERVER}_`;

export interface OpenCodeMapperOptions {
	provider: string;
	model: () => string;
	emit(event: SessionEvent): void;
	now?: () => number;
}

interface Live {
	message: AssistantMessage;
	kind: "text" | "thinking" | "tool";
	toolName?: string;
	args?: unknown;
	started?: number;
	/** Name opencode used, to tell our own MCP tools from the rest. */
	native?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const drop = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const stable = (v: unknown): string => JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val));

export interface CanonicalCall {
	name: string;
	args: Record<string, unknown>;
	/** One of our own tools, served by the tool bus. */
	prometheus: boolean;
}

/** opencode's tool names and argument shapes -> the ones Prometheus already renders. */
export function canonicalTool(native: string, rawInput: unknown): CanonicalCall {
	const input = obj(rawInput);
	if (native.startsWith(MCP_PREFIX)) return { name: native.slice(MCP_PREFIX.length), args: input, prometheus: true };
	switch (native) {
		case "bash":
			return { name: "bash", args: drop({ command: str(input.command), timeout: input.timeout, description: str(input.description) }), prometheus: false };
		case "read":
			return { name: "read", args: drop({ path: str(input.filePath) ?? str(input.path), offset: input.offset, limit: input.limit }), prometheus: false };
		case "edit":
			return {
				name: "edit",
				args: { path: str(input.filePath) ?? "", edits: [{ oldText: str(input.oldString) ?? "", newText: str(input.newString) ?? "" }], ...(input.replaceAll ? { replaceAll: true } : {}) },
				prometheus: false,
			};
		case "write":
			return { name: "write", args: { path: str(input.filePath) ?? "", content: str(input.content) ?? "" }, prometheus: false };
		case "grep":
			return { name: "grep", args: drop({ pattern: str(input.pattern), path: str(input.path), glob: str(input.include) }), prometheus: false };
		case "glob":
			return { name: "find", args: drop({ pattern: str(input.pattern), path: str(input.path) }), prometheus: false };
		case "list":
			return { name: "ls", args: drop({ path: str(input.path) }), prometheus: false };
		case "webfetch":
			return { name: "web_fetch", args: input, prometheus: false };
		case "websearch":
			return { name: "web_search", args: input, prometheus: false };
		case "todowrite": {
			const todos = (Array.isArray(input.todos) ? input.todos : []).map(obj).map((t) => {
				const content = str(t.content) ?? "";
				return { content, status: t.status === "in_progress" ? "in_progress" : t.status === "completed" ? "completed" : "pending", activeForm: content };
			});
			return { name: "todo_write", args: { todos }, prometheus: false };
		}
		case "task":
			return { name: "subagent", args: input, prometheus: false };
		default:
			return { name: native, args: input, prometheus: false };
	}
}

export class OpenCodeMapper {
	readonly messages: ChatMessage[] = [];
	readonly total = zeroUsage();
	/** Tokens in the context after the latest model step (input + cache + output). */
	contextTokens = 0;
	totalCost = 0;
	private inRun = false;
	private turnOpen = false;
	private compacting = false;
	/** `user`, `assistant`, or `hidden` (summaries made by compaction) per message id. */
	private readonly roles = new Map<string, "user" | "assistant" | "hidden">();
	/** Events of a message whose role is not known yet, in arrival order. */
	private readonly held = new Map<string, { type: string; p: any }[]>();
	private readonly items = new Map<string, Live>();
	private readonly ended = new Set<string>();
	private readonly counted = new Set<string>();
	/** Prometheus MCP calls seen from opencode but not yet bound to a bus call, and the reverse. */
	private pendingMcp: { id: string; tool: string; key: string }[] = [];
	private waitingBus: { busId: string; tool: string; key: string }[] = [];
	private readonly busToItem = new Map<string, string>();
	private readonly busResults = new Map<string, Extract<BusToolEvent, { type: "end" }>>();
	private readonly lateEnds = new Map<string, Extract<BusToolEvent, { type: "end" }>>();
	private errorText: string | undefined;
	private readonly opts: OpenCodeMapperOptions;

	constructor(opts: OpenCodeMapperOptions) {
		this.opts = opts;
	}

	private now(): number {
		return this.opts.now?.() ?? Date.now();
	}
	private emit(e: SessionEvent): void {
		this.opts.emit(e);
	}
	get running(): boolean {
		return this.inRun;
	}
	setMessages(messages: ChatMessage[]): void {
		this.messages.length = 0;
		this.messages.push(...messages);
	}

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
		this.errorText = undefined;
		this.emit({ type: "agent_start" });
	}
	private openTurn(): void {
		if (this.turnOpen) return;
		this.turnOpen = true;
		this.emit({ type: "turn_start" });
	}
	private closeTurn(): void {
		if (!this.turnOpen) return;
		this.turnOpen = false;
		this.emit({ type: "turn_end" });
	}

	private assistant(): AssistantMessage {
		return { role: "assistant", content: [], provider: this.opts.provider, model: this.opts.model(), usage: zeroUsage(), stopReason: "pending", timestamp: this.now() };
	}

	// ---------- events ----------

	/** One event of this session's stream. Unknown types are ignored: the server adds event types often. */
	handle(type: string, p: any): void {
		switch (type) {
			case "message.updated":
				return this.messageUpdated(p?.info);
			case "message.part.updated":
			case "message.part.delta": {
				const messageId = String(type === "message.part.updated" ? p?.part?.messageID : p?.messageID);
				const role = this.roles.get(messageId);
				if (!role) {
					const queue = this.held.get(messageId) ?? [];
					queue.push({ type, p });
					this.held.set(messageId, queue);
					return;
				}
				if (role !== "assistant") return;
				return type === "message.part.updated" ? this.part(p.part) : this.delta(p);
			}
			case "session.compacted":
				return this.compactionEnd();
			case "session.error": {
				const e = p?.error;
				if (e && e.name !== "MessageAbortedError") this.errorText = errorMessage(e);
				return;
			}
			default:
				return;
		}
	}

	private messageUpdated(info: any): void {
		if (!info?.id) return;
		const known = this.roles.get(info.id);
		if (info.role === "user") this.roles.set(info.id, "user");
		else if (info.role === "assistant") {
			this.roles.set(info.id, info.summary ? "hidden" : "assistant");
			if (info.error && info.error.name !== "MessageAbortedError") this.errorText = errorMessage(info.error);
		}
		if (known) return;
		const queue = this.held.get(info.id);
		if (!queue) return;
		this.held.delete(info.id);
		for (const e of queue) this.handle(e.type, e.p);
	}

	private part(part: any): void {
		if (!part?.id) return;
		switch (part.type) {
			case "text":
				if (part.synthetic || part.ignored) return;
				return this.textPart(part, "text");
			case "reasoning":
				return this.textPart(part, "thinking");
			case "tool":
				return this.toolPart(part);
			case "step-finish":
				return this.stepFinish(part);
			case "compaction":
				if (part.auto) this.compactionStart("auto");
				return;
			case "retry":
				if (!this.ended.has(part.id)) {
					this.ended.add(part.id);
					this.emit({ type: "auto_retry_start", attempt: part.attempt ?? 1, maxAttempts: part.attempt ?? 1, delayMs: 0, errorMessage: errorMessage(part.error) });
				}
				return;
			default:
				return;
		}
	}

	private begin(id: string, kind: Live["kind"], extra: Partial<Live> = {}): Live {
		this.startRun();
		this.openTurn();
		const message = this.assistant();
		const live: Live = { message, kind, ...extra };
		this.items.set(id, live);
		this.emit({ type: "message_start", message });
		this.emit({ type: "message_update", delta: { type: "start" } });
		return live;
	}

	private textPart(part: any, kind: "text" | "thinking"): void {
		if (this.ended.has(part.id)) return;
		const text = String(part.text ?? "");
		let live = this.items.get(part.id);
		if (!live && text) {
			live = this.begin(part.id, kind);
			live.message.content[0] = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
			this.emit({ type: "message_update", delta: { type: kind === "text" ? "text_start" : "thinking_start", contentIndex: 0 } });
		}
		if (live) {
			const have = this.textOf(live);
			// Normally the deltas delivered everything; this covers a part that arrives complete (replay, missed delta).
			if (text.length > have.length && text.startsWith(have)) this.append(live, text.slice(have.length));
		}
		if (!part.time?.end) return;
		this.ended.add(part.id);
		if (!live) return;
		this.items.delete(part.id);
		this.emit({ type: "message_update", delta: { type: kind === "text" ? "text_end" : "thinking_end", contentIndex: 0 } });
		live.message.stopReason = "stop";
		this.emit({ type: "message_update", delta: { type: "done", reason: "stop" } });
		this.messages.push(live.message);
		this.emit({ type: "message_end", message: live.message });
	}

	private textOf(live: Live): string {
		const c = live.message.content[0];
		return c?.type === "text" ? c.text : c?.type === "thinking" ? c.thinking : "";
	}

	private append(live: Live, delta: string): void {
		const c = live.message.content[0];
		if (c?.type === "text") {
			c.text += delta;
			this.emit({ type: "message_update", delta: { type: "text_delta", contentIndex: 0, delta } });
		} else if (c?.type === "thinking") {
			c.thinking += delta;
			this.emit({ type: "message_update", delta: { type: "thinking_delta", contentIndex: 0, delta } });
		}
	}

	private delta(p: any): void {
		const partId = String(p?.partID);
		if (p?.field !== "text" || !p?.delta) return;
		const live = this.items.get(partId);
		if (live) this.append(live, String(p.delta));
	}

	private toolPart(part: any): void {
		const state = obj(part.state);
		const status = str(state.status);
		const id = String(part.callID ?? part.id);
		// `pending` carries no arguments yet.
		if (!status || status === "pending") return;
		if (this.ended.has(id)) return;
		let live = this.items.get(part.id);
		if (!live) live = this.toolStart(part, id, obj(state.input));
		if (status === "running") {
			const out = str(obj(state.metadata).output);
			if (out) this.emit({ type: "tool_execution_update", toolCallId: id, toolName: live.toolName ?? "tool", partialResult: { content: [{ type: "text", text: out }] } });
			return;
		}
		if (status === "completed" || status === "error") this.toolDone(part, id, live, state, status === "error");
	}

	private toolStart(part: any, id: string, input: Record<string, unknown>): Live {
		const call = canonicalTool(String(part.tool), input);
		const live = this.begin(part.id, "tool", { toolName: call.name, args: call.args, started: this.now(), native: String(part.tool) });
		live.message.content[0] = { type: "toolCall", id, name: call.name, arguments: call.args };
		this.emit({ type: "message_update", delta: { type: "toolcall_start", contentIndex: 0, id, name: call.name } });
		this.emit({ type: "message_update", delta: { type: "toolcall_end", contentIndex: 0, toolCall: live.message.content[0] as never } });
		live.message.stopReason = "toolUse";
		this.emit({ type: "message_update", delta: { type: "done", reason: "toolUse" } });
		this.messages.push(live.message);
		this.emit({ type: "message_end", message: live.message });
		this.emit({ type: "tool_execution_start", toolCallId: id, toolName: call.name, args: call.args });
		if (call.prometheus) this.bindMcp(id, call.name, stable(call.args));
		return live;
	}

	private toolDone(part: any, id: string, live: Live, state: Record<string, unknown>, failed: boolean): void {
		this.ended.add(id);
		this.items.delete(part.id);
		const name = live.toolName ?? "tool";
		const meta = obj(state.metadata);
		let parts: { type: "text"; text: string }[] = [{ type: "text", text: failed ? String(state.error ?? "error") : String(state.output ?? "") }];
		let isError = failed;
		let details: Record<string, unknown> = {};
		if (name === "edit" && typeof meta.diff === "string") details = { diff: meta.diff };
		if (name === "todo_write") {
			details = { todos: (live.args as any)?.todos ?? [] };
			parts = [{ type: "text", text: "Todos updated." }];
		}
		const bus = this.busResults.get(id);
		if (bus) {
			parts = (bus.result.content ?? []).map((c: any) => ({ type: "text" as const, text: c.type === "text" ? String(c.text) : "[image]" }));
			isError = bus.isError;
			details = (bus.result.details ?? {}) as Record<string, unknown>;
		}
		const time = obj(state.time);
		const durationMs = typeof time.end === "number" && typeof time.start === "number" ? time.end - time.start : this.now() - (live.started ?? this.now());
		// Our own tools already ended when the bus reported them.
		if (!this.busEnded.has(id)) this.emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: parts, details }, isError, durationMs });
		const message: ToolResultMessage = { role: "toolResult", toolCallId: id, toolName: name, content: parts, isError, timestamp: this.now() };
		this.messages.push(message);
		this.emit({ type: "message_start", message });
		this.emit({ type: "message_end", message });
	}

	private stepFinish(part: any): void {
		if (this.counted.has(part.id)) return;
		this.counted.add(part.id);
		const t = obj(part.tokens);
		const cache = obj(t.cache);
		const num = (v: unknown) => (typeof v === "number" ? v : 0);
		this.total.input += num(t.input);
		this.total.output += num(t.output) + num(t.reasoning);
		this.total.cacheRead += num(cache.read);
		this.total.cacheWrite += num(cache.write);
		this.total.totalTokens = this.total.input + this.total.output + this.total.cacheRead + this.total.cacheWrite;
		this.contextTokens = num(t.input) + num(t.output) + num(cache.read) + num(cache.write);
		this.totalCost += num(part.cost);
	}

	// ---------- compaction ----------

	compactionStart(reason: "manual" | "auto"): void {
		if (this.compacting) return;
		this.compacting = true;
		this.emit({ type: "compaction_start", reason });
	}

	/** Safe to call more than once: the event and the request that triggered it both end a compaction. */
	compactionEnd(errorMessage?: string, reason: "manual" | "auto" = "auto"): void {
		if (!this.compacting) return;
		this.compacting = false;
		this.emit({ type: "compaction_end", reason, aborted: false, ...(errorMessage ? { errorMessage } : {}) });
	}

	// ---------- tool bus correlation: opencode gives no call id to the MCP server, so match by tool name and arguments ----------

	private readonly busEnded = new Set<string>();

	private bindMcp(itemId: string, tool: string, key: string): void {
		const i = this.waitingBus.findIndex((w) => w.tool === tool && w.key === key);
		if (i >= 0) {
			const [w] = this.waitingBus.splice(i, 1);
			this.busToItem.set(w!.busId, itemId);
			this.flushLate();
			return;
		}
		this.pendingMcp.push({ id: itemId, tool, key });
	}

	bus(e: BusToolEvent): void {
		if (e.type === "start") {
			const key = stable(e.args ?? {});
			const i = this.pendingMcp.findIndex((p) => p.tool === e.name && p.key === key);
			if (i >= 0) {
				const [p] = this.pendingMcp.splice(i, 1);
				this.busToItem.set(e.toolCallId, p!.id);
			} else this.waitingBus.push({ busId: e.toolCallId, tool: e.name, key });
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

	private flushLate(): void {
		for (const [busId, end] of this.lateEnds) {
			if (!this.busToItem.has(busId)) continue;
			this.lateEnds.delete(busId);
			this.bus(end);
		}
	}

	// ---------- run end ----------

	finish(aborted: boolean, error?: string): void {
		const failure = error ?? this.errorText;
		if (failure && !aborted) {
			const message: AssistantMessage = { ...this.assistant(), content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: failure };
			this.messages.push(message);
			this.emit({ type: "message_start", message });
			this.emit({ type: "message_end", message });
		}
		this.items.clear();
		this.pendingMcp = [];
		this.waitingBus = [];
		this.closeTurn();
		if (this.inRun) this.emit({ type: "agent_end", willRetry: false });
		this.inRun = false;
		this.errorText = undefined;
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

/** The text of an opencode error object. */
export function errorMessage(e: any): string {
	const data = obj(e?.data);
	const message = str(data.message) ?? str(e?.message);
	const body = str(data.responseBody);
	const name = str(e?.name) ?? "error";
	return message ? (body && !message.includes(body.slice(0, 40)) ? `${message}: ${body.slice(0, 300)}` : message) : name;
}

const CONTEXT_RE = /<prometheus-context>[\s\S]*?<\/prometheus-context>\s*/g;

/** Rebuilds the transcript of a stored session (`GET /session/:id/message`) as ChatMessages, using the live mapper with a silent sink. */
export function replaySession(list: any[], provider: string, model: string): ChatMessage[] {
	const mapper = new OpenCodeMapper({ provider, model: () => model, emit: () => {} });
	for (const entry of list) {
		const info = entry?.info;
		const parts: any[] = Array.isArray(entry?.parts) ? entry.parts : [];
		if (info?.role === "user") {
			if (mapper.running) mapper.finish(false);
			const content: any[] = parts.flatMap((p): any[] => (p?.type === "text" && !p.synthetic && !p.ignored ? [{ type: "text", text: String(p.text ?? "").replace(CONTEXT_RE, "") }] : p?.type === "file" && String(p.mime ?? "").startsWith("image/") ? [{ type: "image", data: "", mimeType: String(p.mime) }] : []));
			const kept = content.filter((c) => c.type !== "text" || c.text.trim());
			if (kept.length) mapper.user(kept.length === 1 && kept[0].type === "text" ? kept[0].text : (kept as any[]));
			mapper.handle("message.updated", { info });
		} else if (info?.role === "assistant") {
			mapper.handle("message.updated", { info });
			for (const part of parts) mapper.handle("message.part.updated", { part });
		}
	}
	if (mapper.running) mapper.finish(false);
	return [...mapper.messages];
}
