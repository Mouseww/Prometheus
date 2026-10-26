// Pure helpers over a PI AgentSession: token estimates, context breakdown and message text.
import { type AgentSession, calculateContextTokens } from "@earendil-works/pi-coding-agent";
import type { ContextBreakdown } from "@prometheus/protocol";

const CJK = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/gu;

/** chars/4 undercounts CJK badly (roughly one token per character), so weigh those separately. */
export function approxTokens(text: string): number {
	const cjk = text.match(CJK)?.length ?? 0;
	return cjk + Math.ceil((text.length - cjk) / 4);
}

interface Block {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
}

export function estimateTokens(m: AgentSession["messages"][number]): number {
	const r = m as unknown as { content?: string | Block[]; summary?: string; command?: string; output?: string };
	let n = approxTokens(`${r.summary ?? ""}${r.command ?? ""}${r.output ?? ""}`);
	if (typeof r.content === "string") return n + approxTokens(r.content);
	for (const b of r.content ?? []) {
		if (b.type === "text") n += approxTokens(b.text ?? "");
		else if (b.type === "thinking") n += approxTokens(b.thinking ?? "");
		else if (b.type === "toolCall") n += approxTokens(`${b.name ?? ""}${JSON.stringify(b.arguments ?? {})}`);
		else if (b.type === "image") n += 1200;
	}
	return n;
}

/** Whether any reply in the current context carries provider-reported usage (some gateways report none). */
export function hasReportedUsage(s: AgentSession): boolean {
	return s.messages.some((m) => {
		const a = m as unknown as { role: string; stopReason?: string; usage?: Parameters<typeof calculateContextTokens>[0] };
		return a.role === "assistant" && a.stopReason !== "aborted" && a.stopReason !== "error" && !!a.usage && calculateContextTokens(a.usage) > 0;
	});
}

export function firstUserText(messages: readonly { role: string }[]): string {
	const m = messages.find((x) => x.role === "user") as unknown as { content?: string | Block[] } | undefined;
	if (!m) return "";
	return typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

export function contextBreakdown(s: AgentSession): ContextBreakdown {
	const out: ContextBreakdown = { system: approxTokens(s.systemPrompt), tools: 0, user: 0, assistant: 0, toolResults: 0, other: 0 };
	const active = new Set(s.getActiveToolNames());
	for (const t of s.getAllTools()) {
		if (active.has(t.name)) out.tools += approxTokens(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }));
	}
	for (const m of s.messages) {
		// The system message mirrors `systemPrompt` + tool definitions, already counted above.
		if (m.role === "system") continue;
		const n = estimateTokens(m);
		if (m.role === "user") out.user += n;
		else if (m.role === "assistant") out.assistant += n;
		else if (m.role === "toolResult") out.toolResults += n;
		else out.other += n;
	}
	return out;
}

/** The reply text of the last assistant message. */
export function lastReply(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const m = session.messages[i] as unknown as { role: string; content?: Block[] | string };
		if (m.role !== "assistant") continue;
		if (typeof m.content === "string") return m.content;
		return (m.content ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("").trim();
	}
	return "";
}
