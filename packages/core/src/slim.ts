// Tool results can be megabytes (a whole file read, a build log). Sent in a snapshot or a history page they dominate
// the transfer and the browser's parsing, yet nobody reads them unless the card is opened. The wire carries the start
// of each long text block; `truncatedChars` says how much the full result had, and `session.toolResult` fetches it.
import type { ChatMessage, ToolResultMessage } from "@prometheus/protocol";

/** Longest text of one tool result that goes out with the conversation. */
export const MAX_RESULT_CHARS = 16 * 1024;

export function slimMessage(m: ChatMessage): ChatMessage {
	if (m.role !== "toolResult") return m;
	const r = m as ToolResultMessage;
	let total = 0;
	for (const c of r.content) if (c.type === "text") total += c.text.length;
	if (total <= MAX_RESULT_CHARS) return m;
	// The budget is shared by the blocks in order, so several medium blocks cannot add up to a large result.
	let left = MAX_RESULT_CHARS;
	const content = r.content.map((c) => {
		if (c.type !== "text") return c;
		const text = c.text.slice(0, Math.max(0, left));
		left -= text.length;
		return { ...c, text };
	});
	return { ...r, content, truncatedChars: total };
}

export function slimMessages(messages: readonly ChatMessage[]): ChatMessage[] {
	return messages.map(slimMessage);
}

/** The full text of a tool result, as `slimMessage` cut it. */
export function fullResultContent(messages: readonly ChatMessage[], toolCallId: string): ToolResultMessage["content"] | undefined {
	for (const m of messages) if (m.role === "toolResult" && (m as ToolResultMessage).toolCallId === toolCallId) return (m as ToolResultMessage).content;
	return undefined;
}
