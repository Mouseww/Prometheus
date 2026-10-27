import type { ChatMessage } from "@prometheus/protocol";

const TOOL_RESULT_CHARS = 300;
const TOTAL_CHARS = 40_000;
export const HANDOFF_TAG = "previous_conversation";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b: any) => (b?.type === "text" ? String(b.text ?? "") : b?.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One line-oriented rendering of a message, or "" for the ones that carry nothing a new agent needs. */
function render(m: ChatMessage): string {
	const msg = m as any;
	switch (msg.role) {
		case "user":
			return `User: ${textOf(msg.content).trim()}`;
		case "assistant": {
			const parts: string[] = [];
			for (const b of msg.content ?? []) {
				if (b.type === "text" && b.text?.trim()) parts.push(b.text.trim());
				else if (b.type === "toolCall") parts.push(`[tool ${b.name}(${clip(JSON.stringify(b.arguments ?? {}), 200)})]`);
			}
			return parts.length ? `Assistant: ${parts.join("\n")}` : "";
		}
		case "toolResult":
			return `[tool result${msg.isError ? " (error)" : ""}: ${clip(textOf(msg.content).trim(), TOOL_RESULT_CHARS)}]`;
		case "compactionSummary":
		case "branchSummary":
			return typeof msg.summary === "string" ? `Summary of earlier work: ${msg.summary}` : "";
		default:
			return "";
	}
}

/**
 * Plain-text transcript for continuing a conversation in another runtime. Keeps the most recent part when it
 * is too long. Returns "" when there is nothing to carry over.
 */
export function buildHandoff(messages: ChatMessage[], from: string): string {
	const lines = messages.map(render).filter(Boolean);
	if (lines.length === 0) return "";
	let total = 0;
	const kept: string[] = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		if (total + line.length > TOTAL_CHARS && kept.length > 0) {
			kept.unshift("[earlier messages omitted]");
			break;
		}
		kept.unshift(line);
		total += line.length;
	}
	return [`This conversation was started in ${from} and is being continued here. Treat it as earlier context; do not repeat the work already done.`, "", ...kept].join("\n");
}

/** Wraps a handoff for the model-facing context of the first turn. */
export function handoffBlock(handoff: string): string {
	return `<${HANDOFF_TAG}>\n${handoff}\n</${HANDOFF_TAG}>`;
}
