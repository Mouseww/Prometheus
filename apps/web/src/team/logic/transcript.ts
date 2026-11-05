// Builds the read-only transcript of a mirrored session from its Hub events (see plugins/team/src/member/condense.ts
// for what the owner's plugin uploads). Pure: no React, no clock.
import type { SessionEvent } from "../types.ts";

export interface UserItem {
	type: "user";
	key: string;
	seq: number;
	text: string;
}

export interface AssistantItem {
	type: "assistant";
	key: string;
	seq: number;
	text: string;
}

export interface ToolItem {
	type: "tool";
	key: string;
	seq: number;
	toolCallId: string;
	name: string;
	args: unknown;
	status: "running" | "done" | "error";
	result?: string;
	durationMs?: number;
	/** Set for tool calls made by a sub-agent. */
	parentToolCallId?: string;
}

export interface RequestItem {
	type: "request";
	key: string;
	seq: number;
	requestId: string;
	method: string;
	/** `tool` / `plan` for permission requests. */
	requestKind?: string;
	title: string;
	detail?: string;
	toolName?: string;
	options: string[];
	resolved: boolean;
}

export interface RenameItem {
	type: "rename";
	key: string;
	seq: number;
	name: string;
}

export type TranscriptItem = UserItem | AssistantItem | ToolItem | RequestItem | RenameItem;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Text of a PI message: a string, or the text parts of a content array. Empty when there is none. */
export function messageText(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => (typeof part === "string" ? [part] : isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

/** Merges new events into a list: sorted by seq, duplicates (live push overlapping a page) dropped. Returns a new array. */
export function mergeEvents(existing: readonly SessionEvent[], incoming: readonly SessionEvent[]): SessionEvent[] {
	if (incoming.length === 0) return [...existing];
	const bySeq = new Map<number, SessionEvent>();
	for (const e of existing) bySeq.set(e.seq, e);
	for (const e of incoming) bySeq.set(e.seq, e);
	return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The highest seq in a list, or -1 for an empty one (the Hub's `after` starts at -1). */
export function lastSeq(events: readonly SessionEvent[]): number {
	return events.reduce((m, e) => (e.seq > m ? e.seq : m), -1);
}

/** Folds events (in any order) into transcript items in seq order. Unknown event kinds are ignored. */
export function buildTranscript(events: readonly SessionEvent[]): TranscriptItem[] {
	const sorted = mergeEvents([], events);
	const items: TranscriptItem[] = [];
	const tools = new Map<string, ToolItem>();
	const requests = new Map<string, RequestItem>();

	for (const ev of sorted) {
		const p = isRecord(ev.payload) ? ev.payload : {};
		switch (ev.kind) {
			case "message_end": {
				const message = isRecord(p.message) ? p.message : undefined;
				const role = str(message?.role);
				const text = messageText(message).trim();
				if (!text) break;
				if (role === "user") items.push({ type: "user", key: `m${ev.seq}`, seq: ev.seq, text });
				else if (role === "assistant") items.push({ type: "assistant", key: `m${ev.seq}`, seq: ev.seq, text });
				break;
			}
			case "tool_execution_start": {
				const id = str(p.toolCallId) ?? `seq${ev.seq}`;
				const existing = tools.get(id);
				if (existing) {
					// The end event arrived first (out-of-order page): fill in the call details.
					existing.name = str(p.toolName) ?? existing.name;
					existing.args = p.args;
					break;
				}
				const item: ToolItem = { type: "tool", key: `t${id}`, seq: ev.seq, toolCallId: id, name: str(p.toolName) ?? "tool", args: p.args, status: "running" };
				const parent = str(p.parentToolCallId);
				if (parent) item.parentToolCallId = parent;
				tools.set(id, item);
				items.push(item);
				break;
			}
			case "tool_execution_end": {
				const id = str(p.toolCallId) ?? `seq${ev.seq}`;
				let item = tools.get(id);
				if (!item) {
					item = { type: "tool", key: `t${id}`, seq: ev.seq, toolCallId: id, name: str(p.toolName) ?? "tool", args: undefined, status: "running" };
					tools.set(id, item);
					items.push(item);
				}
				item.status = p.isError === true ? "error" : "done";
				item.result = str(p.result) ?? "";
				if (typeof p.durationMs === "number") item.durationMs = p.durationMs;
				break;
			}
			case "ui_request": {
				const requestId = str(p.requestId) ?? String(p.requestId ?? "");
				if (!requestId || requests.has(requestId)) break;
				const options = Array.isArray(p.options) ? p.options.filter((o): o is string => typeof o === "string") : [];
				const item: RequestItem = {
					type: "request",
					key: `r${requestId}`,
					seq: ev.seq,
					requestId,
					method: str(p.method) ?? "unknown",
					title: str(p.title) ?? str(p.summary) ?? str(p.message) ?? "",
					options,
					resolved: false,
				};
				const kind = str(p.kind);
				if (kind) item.requestKind = kind;
				const detail = str(p.detail) ?? str(p.message);
				if (detail && detail !== item.title) item.detail = detail;
				const toolName = str(p.toolName);
				if (toolName) item.toolName = toolName;
				requests.set(requestId, item);
				items.push(item);
				break;
			}
			case "ui_resolved": {
				const requestId = str(p.requestId) ?? String(p.requestId ?? "");
				const item = requests.get(requestId);
				if (item) item.resolved = true;
				break;
			}
			case "session_info_changed": {
				const name = str(p.name);
				if (name) items.push({ type: "rename", key: `n${ev.seq}`, seq: ev.seq, name });
				break;
			}
			default:
				break;
		}
	}
	return items;
}

/** UI requests still waiting for an answer (only blocking methods can be answered from the Hub). */
export function pendingRequests(items: readonly TranscriptItem[]): RequestItem[] {
	return items.filter((i): i is RequestItem => i.type === "request" && !i.resolved && ["permission", "select", "confirm", "input", "editor"].includes(i.method));
}

/** Compact one-line text of tool arguments for the collapsed header. */
export function argsPreview(args: unknown, max = 100): string {
	if (args === undefined || args === null) return "";
	let text: string;
	if (typeof args === "string") text = args;
	else {
		try {
			text = JSON.stringify(args) ?? "";
		} catch {
			text = "";
		}
	}
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Pretty JSON of tool arguments for the expanded view. */
export function argsText(args: unknown): string {
	if (args === undefined) return "";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args, null, 2) ?? "";
	} catch {
		return String(args);
	}
}

/** The answer sent through the relay for a request and a chosen action. */
export function responseFor(req: Pick<RequestItem, "method" | "requestKind">, action: "approve" | "deny" | { value: string }): unknown {
	if (typeof action === "object") return { value: action.value };
	if (req.method === "confirm") return { confirmed: action === "approve" };
	if (req.method === "permission") {
		if (req.requestKind === "plan") return { value: action === "approve" ? "default" : "keep" };
		return { value: action === "approve" ? "allow" : "deny" };
	}
	return action === "approve" ? { value: "" } : { cancelled: true };
}
