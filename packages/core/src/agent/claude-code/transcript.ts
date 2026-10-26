// Converts a Claude Code transcript (SDK `getSessionMessages`) to Prometheus ChatMessages, using the same
// canonical tool names as live events, so a resumed session renders like a live one.
import type { AssistantMessage, ChatMessage, ToolCallContent, ToolResultMessage } from "@prometheus/protocol";
import { canonicalTool } from "./tool-map.ts";

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

interface Raw {
	type: string;
	message?: any;
	parent_tool_use_id?: string | null;
	timestamp?: string | number;
}

export function transcriptToMessages(raw: Raw[], provider: string): ChatMessage[] {
	const out: ChatMessage[] = [];
	const names = new Map<string, string>();
	let t = 0;
	const stamp = (m: Raw) => {
		const v = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : m.timestamp;
		return Number.isFinite(v) ? (v as number) : ++t;
	};
	for (const m of raw) {
		if (m.parent_tool_use_id) continue;
		const content = m.message?.content;
		if (m.type === "user") {
			if (typeof content === "string") {
				out.push({ role: "user", content, timestamp: stamp(m) });
				continue;
			}
			if (!Array.isArray(content)) continue;
			const results = content.filter((c: any) => c?.type === "tool_result");
			for (const r of results) {
				const id = String(r.tool_use_id);
				const body = typeof r.content === "string" ? [{ type: "text" as const, text: r.content }] : Array.isArray(r.content) ? r.content.map((c: any) => ({ type: "text" as const, text: c?.type === "text" ? String(c.text ?? "") : "[image]" })) : [];
				const msg: ToolResultMessage = { role: "toolResult", toolCallId: id, toolName: names.get(id) ?? "tool", content: body, isError: r.is_error === true, timestamp: stamp(m) };
				out.push(msg);
			}
			const rest = content.filter((c: any) => c?.type === "text" || c?.type === "image");
			if (rest.length && !results.length) {
				out.push({
					role: "user",
					content: rest.map((c: any) => (c.type === "text" ? { type: "text" as const, text: String(c.text ?? "") } : { type: "image" as const, data: String(c.source?.data ?? ""), mimeType: String(c.source?.media_type ?? "image/png") })),
					timestamp: stamp(m),
				});
			}
		} else if (m.type === "assistant" && Array.isArray(content)) {
			const parts: AssistantMessage["content"] = [];
			for (const c of content) {
				if (c?.type === "text") parts.push({ type: "text", text: String(c.text ?? "") });
				else if (c?.type === "thinking") parts.push({ type: "thinking", thinking: String(c.thinking ?? "") });
				else if (c?.type === "tool_use") {
					const call = canonicalTool(String(c.name), c.input);
					names.set(String(c.id), call.name);
					parts.push({ type: "toolCall", id: String(c.id), name: call.name, arguments: call.args } satisfies ToolCallContent);
				}
			}
			const usage = zero();
			const u = m.message?.usage;
			if (u) {
				usage.input = u.input_tokens ?? 0;
				usage.output = u.output_tokens ?? 0;
				usage.cacheRead = u.cache_read_input_tokens ?? 0;
				usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
				usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			}
			out.push({
				role: "assistant",
				content: parts,
				provider,
				model: String(m.message?.model ?? ""),
				usage,
				stopReason: m.message?.stop_reason === "tool_use" ? "toolUse" : m.message?.stop_reason === "max_tokens" ? "length" : "stop",
				timestamp: stamp(m),
			});
		}
	}
	return out;
}
