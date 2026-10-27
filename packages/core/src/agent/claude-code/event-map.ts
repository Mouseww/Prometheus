// Translates Claude Agent SDK messages into Prometheus wire events and ChatMessages (docs §3, §4.3).
// Pure and synchronous apart from the emit callback, so it is tested with recorded/synthetic streams.
import type { AssistantMessage, ChatMessage, StopReason, ToolCallContent, ToolResultMessage, Usage } from "@prometheus/protocol";
import type { SessionEvent } from "@prometheus/protocol";
import type { BusToolEvent } from "../bus/tool-bus.ts";
import { canonicalTool } from "./tool-map.ts";

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

const STOP: Record<string, StopReason> = { end_turn: "stop", stop_sequence: "stop", tool_use: "toolUse", max_tokens: "length", pause_turn: "stop", refusal: "error" };

interface Block {
	kind: "text" | "thinking" | "tool";
	/** json text collected for a tool_use block */
	json: string;
	nativeName?: string;
	id?: string;
}

export interface MapperOptions {
	provider: string;
	emit(event: SessionEvent): void;
	now?: () => number;
}

export class CcMapper {
	readonly messages: ChatMessage[] = [];
	model = "";
	private current: AssistantMessage | undefined;
	private blocks = new Map<number, Block>();
	private streamed = false;
	private inRun = false;
	private turnOpen = false;
	/** tool_use id -> canonical name, for results and bus events */
	private names = new Map<string, string>();
	private started = new Set<string>();
	private ended = new Set<string>();
	private startedAt = new Map<string, number>();
	/** bus call id -> tool_use id */
	private busIds = new Map<string, string>();
	readonly total = zeroUsage();
	private readonly opts: MapperOptions;

	constructor(opts: MapperOptions) {
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

	/** Replace history (resume, compaction). */
	setMessages(messages: ChatMessage[]): void {
		this.messages.length = 0;
		this.messages.push(...messages);
	}

	/** The user's prompt: shown immediately, before the SDK echoes anything. */
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
	private closeTurn(): void {
		if (!this.turnOpen) return;
		this.turnOpen = false;
		this.emit({ type: "turn_end" });
	}

	/** One SDK message. Unknown shapes are ignored: the SDK adds message types often. */
	handle(msg: any): void {
		if (!msg || typeof msg !== "object") return;
		// Output of subagent runs inside Claude Code is not rendered in the main transcript.
		if (msg.parent_tool_use_id) return;
		switch (msg.type) {
			case "stream_event":
				return this.stream(msg.event);
			case "assistant":
				return this.assistant(msg);
			case "user":
				return this.userMessage(msg);
			case "system":
				return this.system(msg);
			default:
				return;
		}
	}

	private system(msg: any): void {
		if (msg.subtype === "init" && typeof msg.model === "string") this.model = msg.model;
		if (msg.subtype === "api_retry") {
			this.emit({ type: "auto_retry_start", attempt: msg.attempt ?? 1, maxAttempts: msg.max_retries ?? msg.attempt ?? 1, delayMs: msg.retry_delay_ms ?? 0, errorMessage: msg.error && msg.error !== "unknown" ? String(msg.error) : `${msg.error_status ?? "network error"}: cannot reach the model endpoint (check proxy / login / gateway)` });
		}
	}

	private begin(model: string | undefined, usage?: any): void {
		this.startRun();
		this.closeTurn();
		this.openTurn();
		this.blocks.clear();
		this.current = { role: "assistant", content: [], provider: this.opts.provider, model: model || this.model, usage: zeroUsage(), stopReason: "pending", timestamp: this.now() };
		this.applyUsage(usage);
		this.emit({ type: "message_start", message: this.current });
		this.emit({ type: "message_update", delta: { type: "start" } });
	}

	private applyUsage(u: any): void {
		if (!u || !this.current) return;
		const cu = this.current.usage;
		if (typeof u.input_tokens === "number") cu.input = u.input_tokens;
		if (typeof u.output_tokens === "number") cu.output = u.output_tokens;
		if (typeof u.cache_read_input_tokens === "number") cu.cacheRead = u.cache_read_input_tokens;
		if (typeof u.cache_creation_input_tokens === "number") cu.cacheWrite = u.cache_creation_input_tokens;
		cu.totalTokens = cu.input + cu.output + cu.cacheRead + cu.cacheWrite;
	}

	private stream(ev: any): void {
		if (!ev) return;
		const cur = this.current;
		switch (ev.type) {
			case "message_start":
				this.streamed = true;
				this.begin(ev.message?.model, ev.message?.usage);
				return;
			case "content_block_start": {
				if (!cur) return;
				const i = Number(ev.index);
				const b = ev.content_block ?? {};
				if (b.type === "text") {
					cur.content[i] = { type: "text", text: "" };
					this.blocks.set(i, { kind: "text", json: "" });
					this.emit({ type: "message_update", delta: { type: "text_start", contentIndex: i } });
				} else if (b.type === "thinking" || b.type === "redacted_thinking") {
					cur.content[i] = { type: "thinking", thinking: "", ...(b.type === "redacted_thinking" ? { redacted: true } : {}) };
					this.blocks.set(i, { kind: "thinking", json: "" });
					this.emit({ type: "message_update", delta: { type: "thinking_start", contentIndex: i } });
				} else if (b.type === "tool_use" || b.type === "server_tool_use") {
					const c = canonicalTool(String(b.name), {});
					cur.content[i] = { type: "toolCall", id: String(b.id), name: c.name, arguments: {} };
					this.blocks.set(i, { kind: "tool", json: "", nativeName: String(b.name), id: String(b.id) });
					this.names.set(String(b.id), c.name);
					this.emit({ type: "message_update", delta: { type: "toolcall_start", contentIndex: i, id: String(b.id), name: c.name } });
				}
				return;
			}
			case "content_block_delta": {
				if (!cur) return;
				const i = Number(ev.index);
				const block = this.blocks.get(i);
				const d = ev.delta ?? {};
				const part = cur.content[i];
				if (!block || !part) return;
				if (d.type === "text_delta" && part.type === "text") {
					part.text += d.text ?? "";
					this.emit({ type: "message_update", delta: { type: "text_delta", contentIndex: i, delta: d.text ?? "" } });
				} else if (d.type === "thinking_delta" && part.type === "thinking") {
					part.thinking += d.thinking ?? "";
					this.emit({ type: "message_update", delta: { type: "thinking_delta", contentIndex: i, delta: d.thinking ?? "" } });
				} else if (d.type === "input_json_delta" && block.kind === "tool") {
					block.json += d.partial_json ?? "";
					this.emit({ type: "message_update", delta: { type: "toolcall_delta", contentIndex: i, delta: d.partial_json ?? "" } });
				}
				return;
			}
			case "content_block_stop": {
				if (!cur) return;
				const i = Number(ev.index);
				const block = this.blocks.get(i);
				const part = cur.content[i];
				if (!block || !part) return;
				if (block.kind === "text") this.emit({ type: "message_update", delta: { type: "text_end", contentIndex: i } });
				else if (block.kind === "thinking") this.emit({ type: "message_update", delta: { type: "thinking_end", contentIndex: i } });
				else if (part.type === "toolCall") {
					let parsed: unknown = {};
					try {
						parsed = block.json ? JSON.parse(block.json) : {};
					} catch {
						parsed = {};
					}
					const c = canonicalTool(block.nativeName ?? part.name, parsed);
					part.name = c.name;
					part.arguments = c.args;
					this.emit({ type: "message_update", delta: { type: "toolcall_end", contentIndex: i, toolCall: part as ToolCallContent } });
					this.toolStart(part.id, c.name, c.args);
				}
				return;
			}
			case "message_delta": {
				if (!cur) return;
				if (ev.delta?.stop_reason) cur.stopReason = STOP[ev.delta.stop_reason] ?? "stop";
				this.applyUsage(ev.usage);
				return;
			}
			case "message_stop": {
				if (!cur) return;
				if (cur.stopReason === "pending") cur.stopReason = "stop";
				this.finishAssistant(cur);
				return;
			}
		}
	}

	private finishAssistant(cur: AssistantMessage): void {
		this.emit({ type: "message_update", delta: { type: "done", reason: cur.stopReason } });
		this.messages.push(cur);
		this.emit({ type: "message_end", message: cur });
		this.total.input += cur.usage.input;
		this.total.output += cur.usage.output;
		this.total.cacheRead += cur.usage.cacheRead;
		this.total.cacheWrite += cur.usage.cacheWrite;
		this.total.totalTokens += cur.usage.totalTokens;
		this.current = undefined;
		this.blocks.clear();
		if (cur.stopReason !== "toolUse") this.closeTurn();
	}

	/** Full assistant message. With partial streaming it only confirms; without it, it is the sole source. */
	private assistant(msg: any): void {
		if (this.streamed && this.current === undefined) return;
		const m = msg.message ?? {};
		if (this.current === undefined) {
			this.begin(m.model, m.usage);
			const cur = this.current as AssistantMessage | undefined;
			if (!cur) return;
			const content: any[] = Array.isArray(m.content) ? m.content : [];
			content.forEach((b, i) => {
				if (b.type === "text") {
					cur.content[i] = { type: "text", text: b.text ?? "" };
					this.emit({ type: "message_update", delta: { type: "text_start", contentIndex: i } });
					this.emit({ type: "message_update", delta: { type: "text_delta", contentIndex: i, delta: b.text ?? "" } });
					this.emit({ type: "message_update", delta: { type: "text_end", contentIndex: i } });
				} else if (b.type === "thinking") {
					cur.content[i] = { type: "thinking", thinking: b.thinking ?? "" };
				} else if (b.type === "tool_use") {
					const c = canonicalTool(String(b.name), b.input);
					const call: ToolCallContent = { type: "toolCall", id: String(b.id), name: c.name, arguments: c.args };
					cur.content[i] = call;
					this.names.set(call.id, c.name);
					this.emit({ type: "message_update", delta: { type: "toolcall_end", contentIndex: i, toolCall: call } });
					this.toolStart(call.id, c.name, c.args);
				}
			});
			cur.stopReason = STOP[m.stop_reason] ?? (content.some((b) => b.type === "tool_use") ? "toolUse" : "stop");
			this.finishAssistant(cur);
		}
	}

	private toolStart(id: string, name: string, args: unknown): void {
		if (this.started.has(id)) return;
		this.started.add(id);
		this.startedAt.set(id, this.now());
		this.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
	}

	/** Tool results come back as user messages. */
	private userMessage(msg: any): void {
		const content = msg.message?.content;
		if (!Array.isArray(content)) return;
		for (const block of content) {
			if (block?.type !== "tool_result") continue;
			const id = String(block.tool_use_id);
			const name = this.names.get(id) ?? "tool";
			const parts = toParts(block.content);
			const isError = block.is_error === true;
			if (!this.started.has(id)) this.toolStart(id, name, {});
			if (!this.ended.has(id)) {
				this.ended.add(id);
				this.emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: parts, details: {} }, isError, durationMs: this.now() - (this.startedAt.get(id) ?? this.now()) });
			}
			const message: ToolResultMessage = { role: "toolResult", toolCallId: id, toolName: name, content: parts, isError, timestamp: this.now() };
			this.messages.push(message);
			this.emit({ type: "message_start", message });
			this.emit({ type: "message_end", message });
		}
	}

	/** The tool bus is authoritative for our own tools (docs §4.3): args, partial results, details and timing. */
	bus(e: BusToolEvent): void {
		if (e.type === "start") {
			const toolUseId = (e.meta as any)?.["claudecode/toolUseId"];
			const id = typeof toolUseId === "string" ? toolUseId : e.toolCallId;
			this.busIds.set(e.toolCallId, id);
			this.names.set(id, e.name);
			if (this.started.has(id)) return;
			this.toolStart(id, e.name, e.args);
			return;
		}
		const id = this.busIds.get(e.toolCallId) ?? e.toolCallId;
		if (e.type === "update") {
			this.emit({ type: "tool_execution_update", toolCallId: id, toolName: e.name, partialResult: e.partial });
			return;
		}
		if (this.ended.has(id)) return;
		this.ended.add(id);
		this.emit({ type: "tool_execution_end", toolCallId: id, toolName: e.name, result: { content: e.result.content ?? [], details: e.result.details ?? {} }, isError: e.isError, durationMs: e.durationMs });
	}

	/** The run ended (result message, abort or failure). */
	finish(aborted: boolean, error?: string): void {
		if (this.current) {
			const cur = this.current;
			cur.stopReason = aborted ? "aborted" : error ? "error" : cur.stopReason === "pending" ? "stop" : cur.stopReason;
			if (error) cur.errorMessage = error;
			this.emit({ type: "message_update", delta: { type: "error", reason: aborted ? "aborted" : "error" } });
			this.messages.push(cur);
			this.emit({ type: "message_end", message: cur });
			this.current = undefined;
			this.blocks.clear();
		} else if (error) {
			const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "" }], provider: this.opts.provider, model: this.model, usage: zeroUsage(), stopReason: "error", errorMessage: error, timestamp: this.now() };
			this.messages.push(message);
			this.emit({ type: "message_start", message });
			this.emit({ type: "message_end", message });
		}
		this.closeTurn();
		if (this.inRun) this.emit({ type: "agent_end", willRetry: false });
		this.inRun = false;
		this.emit({ type: "agent_settled", aborted });
	}

	/** Text the assistant wrote since the last user message (used as the plan when ExitPlanMode carries none). */
	textSinceUser(): string {
		const parts: string[] = [];
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i]!;
			if (m.role === "user") break;
			if (m.role === "assistant") parts.unshift((m as AssistantMessage).content.map((c) => (c.type === "text" ? c.text : "")).join(""));
		}
		const live = this.current;
		if (live) parts.push(live.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
		return parts.join("\n\n").trim();
	}

	lastReply(): string {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i]!;
			if (m.role === "assistant") return (m as AssistantMessage).content.map((c) => (c.type === "text" ? c.text : "")).join("");
		}
		return "";
	}
}

function toParts(content: unknown): { type: "text"; text: string }[] | { type: "text"; text: string }[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) {
		return content.map((c: any) => (c?.type === "text" ? { type: "text" as const, text: String(c.text ?? "") } : { type: "text" as const, text: c?.type === "image" ? "[image]" : JSON.stringify(c) }));
	}
	return [{ type: "text", text: content === undefined || content === null ? "" : JSON.stringify(content) }];
}
