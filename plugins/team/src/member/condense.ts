import type { SessionEvent, UIRequest } from "@prometheus/protocol";

/** Tool results and arguments are cut to this many characters before upload (spec 6.2). */
export const MAX_TOOL_TEXT = 20 * 1024;

export interface OutgoingEvent {
	kind: string;
	payload: Record<string, unknown>;
}

function clip(text: string): string {
	return text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n...(已截断，原文 ${text.length} 字符)` : text;
}

/** The text of a tool result: text parts of a `{content: [...]}` result, otherwise the JSON form. */
export function resultText(result: unknown): string {
	if (typeof result === "string") return clip(result);
	if (result && typeof result === "object") {
		const content = (result as { content?: unknown }).content;
		if (Array.isArray(content)) {
			const texts = content.flatMap((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []));
			if (texts.length > 0) return clip(texts.join("\n"));
		}
	}
	try {
		return clip(JSON.stringify(result) ?? "");
	} catch {
		return "";
	}
}

function boundedArgs(args: unknown): unknown {
	let json: string | undefined;
	try {
		json = JSON.stringify(args);
	} catch {
		return { truncated: true };
	}
	if (json === undefined || json.length <= MAX_TOOL_TEXT) return args;
	return { truncated: true, preview: json.slice(0, MAX_TOOL_TEXT) };
}

/**
 * What a session event becomes on the Hub, or undefined when it is dropped. Kept: run start/end, finished messages, tool
 * start/end (result text capped) and renames. Streaming deltas and UI chatter never leave the machine.
 */
export function condense(event: SessionEvent): OutgoingEvent | undefined {
	switch (event.type) {
		case "agent_start":
			return { kind: "agent_start", payload: {} };
		case "agent_end":
			return { kind: "agent_end", payload: { willRetry: event.willRetry } };
		case "message_end":
			return { kind: "message_end", payload: { message: event.message } };
		case "tool_execution_start":
			return {
				kind: "tool_execution_start",
				payload: { toolCallId: event.toolCallId, toolName: event.toolName, args: boundedArgs(event.args), ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}) },
			};
		case "tool_execution_end":
			return {
				kind: "tool_execution_end",
				payload: {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					result: resultText(event.result),
					...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
					...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
				},
			};
		case "session_info_changed":
			return { kind: "session_info_changed", payload: event.name !== undefined ? { name: event.name } : {} };
		default:
			return undefined;
	}
}

/** Requests that block the session until someone answers; only these put it in `waiting`. */
export const BLOCKING_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor", "permission"]);

/** A short description of a UI request for the Hub: the method plus whatever identifies what is being asked. */
export function summarizeRequest(request: UIRequest): Record<string, unknown> {
	const r = request as unknown as Record<string, unknown>;
	const out: Record<string, unknown> = { requestId: request.id, method: request.method };
	for (const key of ["kind", "title", "message", "toolName", "summary", "detail", "placeholder"]) {
		if (typeof r[key] === "string") out[key] = (r[key] as string).slice(0, 2000);
	}
	if (Array.isArray(r.options)) out.options = (r.options as unknown[]).filter((o): o is string => typeof o === "string").slice(0, 20);
	return out;
}
