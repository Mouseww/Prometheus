// Translates Codex app-server notifications into Prometheus wire events and ChatMessages.
// Codex reports whole items (message, reasoning, command, file change, MCP call, ...); each becomes one assistant
// message so tool calls and results line up the way the existing renderers expect (docs §3, §4.3, §4.4).
import type { AssistantMessage, ChatMessage, SessionEvent, ToolResultMessage, Usage } from "@prometheus/protocol";
import type { BusToolEvent } from "../bus/tool-bus.ts";

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export interface CodexMapperOptions {
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
}

/** MCP content blocks -> the text/image parts of a tool result. */
function mcpParts(content: unknown): { type: "text"; text: string }[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content.map((c: any) => (c?.type === "text" ? { type: "text" as const, text: String(c.text ?? "") } : { type: "text" as const, text: c?.type === "image" ? "[image]" : JSON.stringify(c) }));
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val));

export class CodexMapper {
	readonly messages: ChatMessage[] = [];
	readonly total = zeroUsage();
	/** Tokens in the context after the latest model call, and the model's window, as Codex reports them. */
	contextTokens = 0;
	contextWindow = 0;
	turnId: string | undefined;
	private inRun = false;
	private turnOpen = false;
	private readonly items = new Map<string, Live>();
	private readonly ended = new Set<string>();
	/** Prometheus MCP calls seen from Codex but not yet bound to a bus call, and the reverse. */
	private pendingMcp: { id: string; tool: string; key: string }[] = [];
	private waitingBus: { busId: string; tool: string; key: string }[] = [];
	private readonly busToItem = new Map<string, string>();
	private readonly busResults = new Map<string, Extract<BusToolEvent, { type: "end" }>>();
	private errorText: string | undefined;
	private readonly opts: CodexMapperOptions;

	constructor(opts: CodexMapperOptions) {
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

	handle(method: string, p: any): void {
		switch (method) {
			case "turn/started":
				this.turnId = p?.turn?.id;
				this.startRun();
				this.openTurn();
				return;
			case "item/started":
				return this.itemStarted(p?.item);
			case "item/agentMessage/delta":
				return this.textDelta(String(p?.itemId), String(p?.delta ?? ""), "text");
			case "item/reasoning/summaryTextDelta":
			case "item/reasoning/textDelta":
				return this.textDelta(String(p?.itemId), String(p?.delta ?? ""), "thinking");
			case "item/commandExecution/outputDelta":
				this.emit({ type: "tool_execution_update", toolCallId: String(p?.itemId), toolName: "bash", partialResult: { content: [{ type: "text", text: String(p?.delta ?? "") }] } });
				return;
			case "item/completed":
				return this.itemCompleted(p?.item);
			case "turn/plan/updated":
				return this.plan(p);
			case "thread/tokenUsage/updated": {
				const last = p?.tokenUsage?.last;
				if (typeof p?.tokenUsage?.modelContextWindow === "number") this.contextWindow = p.tokenUsage.modelContextWindow;
				if (last) {
					this.contextTokens = last.totalTokens ?? (last.inputTokens ?? 0) + (last.outputTokens ?? 0);
					this.total.input += last.inputTokens ?? 0;
					this.total.output += last.outputTokens ?? 0;
					this.total.cacheRead += last.cachedInputTokens ?? 0;
					this.total.totalTokens = this.total.input + this.total.output + this.total.cacheRead;
				}
				return;
			}
			case "error": {
				const message = String(p?.error?.message ?? "error");
				if (p?.willRetry) this.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 0, errorMessage: message });
				else this.errorText = message;
				return;
			}
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

	private itemStarted(item: any): void {
		if (!item?.id || this.items.has(item.id)) return;
		switch (item.type) {
			case "agentMessage": {
				const live = this.begin(item.id, "text");
				live.message.content[0] = { type: "text", text: "" };
				this.emit({ type: "message_update", delta: { type: "text_start", contentIndex: 0 } });
				if (item.text) this.textDelta(item.id, item.text, "text");
				return;
			}
			case "reasoning": {
				const live = this.begin(item.id, "thinking");
				live.message.content[0] = { type: "thinking", thinking: "" };
				this.emit({ type: "message_update", delta: { type: "thinking_start", contentIndex: 0 } });
				return;
			}
			case "commandExecution":
				return this.toolItem(item, "bash", { command: String(item.command ?? "") });
			case "fileChange": {
				const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
				const first = changes[0];
				const single = changes.length === 1 ? first : undefined;
				const kind = single?.kind?.type;
				const name = kind === "add" ? "write" : "edit";
				const args = single
					? kind === "add"
						? { path: String(single.path), content: String(single.diff ?? "") }
						: { path: String(single.path), edits: [], diff: String(single.diff ?? "") }
					: { path: changes.map((c) => c.path).join(", "), edits: [], diff: changes.map((c) => `--- ${c.path}\n${c.diff ?? ""}`).join("\n") };
				return this.toolItem(item, name, args);
			}
			case "mcpToolCall": {
				const ours = item.server === "prometheus";
				const name = ours ? String(item.tool) : `${item.server}__${item.tool}`;
				this.toolItem(item, name, item.arguments ?? {});
				if (ours) this.bindMcp(item.id, String(item.tool), stable(item.arguments ?? {}));
				return;
			}
			case "webSearch":
				return this.toolItem(item, "web_search", { query: String(item.query ?? "") });
			case "contextCompaction":
				this.emit({ type: "compaction_start", reason: "auto" });
				return;
			default:
				return;
		}
	}

	private toolItem(item: any, name: string, args: unknown): void {
		const live = this.begin(item.id, "tool", { toolName: name, args, started: this.now() });
		live.message.content[0] = { type: "toolCall", id: item.id, name, arguments: (args ?? {}) as Record<string, unknown> };
		this.emit({ type: "message_update", delta: { type: "toolcall_start", contentIndex: 0, id: item.id, name } });
		this.emit({ type: "message_update", delta: { type: "toolcall_end", contentIndex: 0, toolCall: live.message.content[0] as never } });
		live.message.stopReason = "toolUse";
		this.emit({ type: "message_update", delta: { type: "done", reason: "toolUse" } });
		this.messages.push(live.message);
		this.emit({ type: "message_end", message: live.message });
		this.emit({ type: "tool_execution_start", toolCallId: item.id, toolName: name, args });
	}

	private textDelta(id: string, delta: string, kind: "text" | "thinking"): void {
		const live = this.items.get(id);
		if (!live || !delta) return;
		const part = live.message.content[0];
		if (kind === "text" && part?.type === "text") {
			part.text += delta;
			this.emit({ type: "message_update", delta: { type: "text_delta", contentIndex: 0, delta } });
		} else if (kind === "thinking" && part?.type === "thinking") {
			part.thinking += delta;
			this.emit({ type: "message_update", delta: { type: "thinking_delta", contentIndex: 0, delta } });
		}
	}

	private itemCompleted(item: any): void {
		if (!item?.id) return;
		if (!this.items.has(item.id)) this.itemStarted(item);
		const live = this.items.get(item.id);
		if (item.type === "contextCompaction") {
			this.emit({ type: "compaction_end", reason: "auto", aborted: false });
			return;
		}
		if (!live) return;
		if (item.type === "agentMessage" || item.type === "reasoning") {
			const part = live.message.content[0];
			if (item.type === "agentMessage" && part?.type === "text") {
				if (typeof item.text === "string" && item.text.length >= part.text.length) part.text = item.text;
				this.emit({ type: "message_update", delta: { type: "text_end", contentIndex: 0 } });
			} else if (part?.type === "thinking") {
				const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
				if (text && !part.thinking) part.thinking = text;
				this.emit({ type: "message_update", delta: { type: "thinking_end", contentIndex: 0 } });
			}
			live.message.stopReason = "stop";
			this.emit({ type: "message_update", delta: { type: "done", reason: "stop" } });
			this.messages.push(live.message);
			this.emit({ type: "message_end", message: live.message });
			return;
		}
		if (live.kind === "tool") this.toolDone(item, live);
	}

	private toolDone(item: any, live: Live): void {
		const name = live.toolName ?? "tool";
		let parts: { type: "text"; text: string }[] = [];
		let isError = false;
		let details: unknown = {};
		if (item.type === "commandExecution") {
			parts = [{ type: "text", text: String(item.aggregatedOutput ?? "") }];
			isError = (item.exitCode ?? 0) !== 0 || item.status === "failed" || item.status === "declined";
		} else if (item.type === "fileChange") {
			parts = [{ type: "text", text: item.status === "completed" ? "Applied." : `Change ${item.status}` }];
			isError = item.status === "failed" || item.status === "declined";
		} else if (item.type === "mcpToolCall") {
			const bus = this.busResults.get(item.id);
			if (bus) {
				parts = (bus.result.content ?? []).map((c: any) => (c.type === "text" ? { type: "text" as const, text: c.text } : { type: "text" as const, text: "[image]" }));
				isError = bus.isError;
				details = bus.result.details ?? {};
			} else {
				parts = mcpParts(item.result?.content);
				isError = item.status === "failed" || Boolean(item.error);
				if (item.error?.message) parts = [{ type: "text", text: String(item.error.message) }];
				details = item.result?.structuredContent ?? {};
			}
		} else if (item.type === "webSearch") {
			parts = [{ type: "text", text: String(item.query ?? "") }];
		}
		if (!this.ended.has(item.id)) {
			this.ended.add(item.id);
			this.emit({ type: "tool_execution_end", toolCallId: item.id, toolName: name, result: { content: parts, details }, isError, durationMs: item.durationMs ?? this.now() - (live.started ?? this.now()) });
		}
		const message: ToolResultMessage = { role: "toolResult", toolCallId: item.id, toolName: name, content: parts, isError, timestamp: this.now() };
		this.messages.push(message);
		this.emit({ type: "message_start", message });
		this.emit({ type: "message_end", message });
	}

	/** Codex's plan updates feed the todo panel the same way `todo_write` does. */
	private plan(p: any): void {
		const steps: any[] = Array.isArray(p?.plan) ? p.plan : [];
		if (!steps.length) return;
		const todos = steps.map((s) => ({ content: String(s.step), status: s.status === "inProgress" ? "in_progress" : s.status === "completed" ? "completed" : "pending", activeForm: String(s.step) }));
		const id = `plan-${this.now()}-${Math.random().toString(36).slice(2, 6)}`;
		this.emit({ type: "tool_execution_start", toolCallId: id, toolName: "todo_write", args: { todos } });
		this.emit({ type: "tool_execution_end", toolCallId: id, toolName: "todo_write", result: { content: [{ type: "text", text: "Plan updated." }], details: { todos } }, isError: false });
	}

	// ----- tool bus correlation: Codex gives no call id in the MCP request, so match by tool name and arguments -----

	private bindMcp(itemId: string, tool: string, key: string): void {
		const i = this.waitingBus.findIndex((w) => w.tool === tool && w.key === key);
		if (i >= 0) {
			const [w] = this.waitingBus.splice(i, 1);
			this.busToItem.set(w!.busId, itemId);
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
			// The item has not been seen yet (the bus can be faster than the notification); keep the result for it.
			if (e.type === "end") this.waitingEnd(e);
			return;
		}
		if (e.type === "update") {
			this.emit({ type: "tool_execution_update", toolCallId: itemId, toolName: e.name, partialResult: e.partial });
			return;
		}
		this.busResults.set(itemId, e);
		if (!this.ended.has(itemId)) {
			this.ended.add(itemId);
			this.emit({ type: "tool_execution_end", toolCallId: itemId, toolName: e.name, result: { content: e.result.content ?? [], details: e.result.details ?? {} }, isError: e.isError, durationMs: e.durationMs });
		}
	}

	private lateEnds = new Map<string, Extract<BusToolEvent, { type: "end" }>>();
	private waitingEnd(e: Extract<BusToolEvent, { type: "end" }>): void {
		this.lateEnds.set(e.toolCallId, e);
		// Resolved when the matching item shows up: bindMcp moves it over.
		queueMicrotask(() => this.flushLate());
	}
	private flushLate(): void {
		for (const [busId, end] of this.lateEnds) {
			const itemId = this.busToItem.get(busId);
			if (!itemId) continue;
			this.lateEnds.delete(busId);
			this.bus(end);
		}
	}

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
		this.turnId = undefined;
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

/** Rebuilds the transcript of a stored thread (`thread/read` with turns) as ChatMessages, using the live mapper with a silent sink. */
export function replayThread(turns: any[], provider: string, model: string): ChatMessage[] {
	const mapper = new CodexMapper({ provider, model: () => model, emit: () => {} });
	for (const turn of turns) {
		for (const item of turn?.items ?? []) {
			if (item?.type === "userMessage") {
				const parts: any[] = (item.content ?? []).flatMap((c: any) => (c?.type === "text" ? [{ type: "text", text: stripContext(String(c.text ?? "")) }] : c?.type === "image" ? [{ type: "image", data: "", mimeType: "image/png" }] : []));
				const textParts = parts.filter((p) => p.type !== "text" || p.text.trim());
				if (textParts.length) mapper.user(textParts.length === 1 && textParts[0].type === "text" ? textParts[0].text : textParts);
			} else mapper.handle("item/completed", { item });
		}
		mapper.finish(false);
	}
	return [...mapper.messages];
}

const CONTEXT_RE = /<prometheus-context>[\s\S]*?<\/prometheus-context>\s*/g;
function stripContext(text: string): string {
	return text.replace(CONTEXT_RE, "");
}
