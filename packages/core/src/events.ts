import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantDelta, ChatMessage, ModelRef, SessionEvent, ToolCallContent } from "@prometheus/protocol";

const MAX_TOOL_PAYLOAD = 64 * 1024;

/** Tool results can be huge (file dumps); cap what crosses the wire, full data stays in the session file. */
function capPayload(value: unknown): unknown {
	if (value === undefined) return undefined;
	const json = JSON.stringify(value);
	if (json === undefined || json.length <= MAX_TOOL_PAYLOAD) return value;
	return { truncated: true, preview: json.slice(0, MAX_TOOL_PAYLOAD) };
}

function delta(e: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"]): AssistantDelta | undefined {
	switch (e.type) {
		case "start":
			return { type: "start" };
		case "text_start":
		case "thinking_start":
			return { type: e.type, contentIndex: e.contentIndex };
		case "toolcall_start": {
			const block = e.partial.content[e.contentIndex];
			const call = block?.type === "toolCall" ? block : undefined;
			return { type: e.type, contentIndex: e.contentIndex, id: call?.id, name: call?.name };
		}
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return { type: e.type, contentIndex: e.contentIndex, delta: e.delta };
		case "text_end":
		case "thinking_end":
			return { type: e.type, contentIndex: e.contentIndex };
		case "toolcall_end":
			return { type: "toolcall_end", contentIndex: e.contentIndex, toolCall: e.toolCall as ToolCallContent };
		case "done":
			return { type: "done", reason: e.reason };
		case "error":
			return { type: "error", reason: e.reason };
		default:
			return undefined;
	}
}

export function toModelRef(model: { provider: string; id: string } | undefined | null): ModelRef | null {
	// PI reports a placeholder "unknown" model when nothing is configured.
	if (!model || model.provider === "unknown") return null;
	return { provider: model.provider, id: model.id };
}

/** Convert a PI session event into its slim wire form; returns undefined for events clients don't need. */
export function slimEvent(e: AgentSessionEvent): SessionEvent | undefined {
	switch (e.type) {
		case "agent_start":
		case "turn_start":
			return { type: e.type };
		case "turn_end":
			return { type: "turn_end" };
		case "agent_end":
			return { type: "agent_end", willRetry: "willRetry" in e ? Boolean(e.willRetry) : false };
		case "agent_settled":
			return { type: "agent_settled", aborted: e.aborted };
		case "message_start":
		case "message_end":
			return { type: e.type, message: e.message as unknown as ChatMessage };
		case "message_update": {
			const d = delta(e.assistantMessageEvent);
			return d && { type: "message_update", delta: d };
		}
		case "tool_execution_start":
			return { type: e.type, toolCallId: e.toolCallId, toolName: e.toolName, args: capPayload(e.args) };
		case "tool_execution_update":
			return { type: e.type, toolCallId: e.toolCallId, toolName: e.toolName, partialResult: capPayload(e.partialResult) };
		case "tool_execution_end":
			return { type: e.type, toolCallId: e.toolCallId, toolName: e.toolName, result: capPayload(e.result), isError: e.isError, durationMs: e.durationMs };
		case "queue_update":
			return { type: e.type, steering: [...e.steering], followUp: [...e.followUp] };
		case "compaction_start":
			return { type: e.type, reason: e.reason };
		case "compaction_end":
			return { type: e.type, reason: e.reason, aborted: e.aborted, errorMessage: e.errorMessage };
		case "auto_retry_start":
			return { type: e.type, attempt: e.attempt, maxAttempts: e.maxAttempts, delayMs: e.delayMs, errorMessage: e.errorMessage };
		case "auto_retry_end":
			return { type: e.type, success: e.success, attempt: e.attempt, finalError: e.finalError };
		case "session_info_changed":
			return { type: e.type, name: e.name };
		case "thinking_level_changed":
			return { type: e.type, level: e.level };
		default:
			return undefined;
	}
}
