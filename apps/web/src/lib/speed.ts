// How fast the model answers: tokens per second while it writes, time to the first token, and the average over a conversation.
// Measured in the client from the same event stream every agent runtime produces, so it works for PI, Claude Code, Codex,
// OpenCode and ACP alike. Only replies that streamed are timed (a reply that arrives in one piece says nothing about speed).
import type { SessionEvent } from "@prometheus/protocol";

export interface ReplySpeed {
	/** Output tokens per second, from the first token to the end of the reply. */
	tps: number;
	ttftMs: number;
	outputTokens: number;
	/** Model that produced it, `provider/id`. */
	model?: string;
}

export interface SpeedSummary {
	last: ReplySpeed | null;
	/** Weighted over every timed reply of the conversation since the app opened. */
	avgTps: number | null;
	replies: number;
}

interface Running {
	start: number;
	first: number | null;
	/** Rough token count of what arrived so far: the provider reports the true number only at the end. */
	estimate: number;
}

const EMPTY: SpeedSummary = { last: null, avgTps: null, replies: 0 };
/** Replies shorter than this are too quick to give a meaningful rate. */
const MIN_MS = 400;
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/;

/** ~1 token per CJK character, ~1 per 4 other characters. */
export function estimateTokens(text: string): number {
	let n = 0;
	let other = 0;
	for (const ch of text) {
		if (CJK.test(ch)) n++;
		else other++;
	}
	return n + other / 4;
}

export class SpeedTracker {
	private readonly running = new Map<string, Running>();
	private readonly summaries = new Map<string, SpeedSummary>();
	/** Speed of each timed reply, by `sessionId:timestamp` of its final message. */
	private readonly byMessage = new Map<string, ReplySpeed>();
	private readonly totals = new Map<string, { tokens: number; ms: number }>();
	private readonly listeners = new Set<() => void>();

	subscribe = (fn: () => void): (() => void) => {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	};

	/** The measured speed of one assistant message, or undefined (loaded from history, not streamed, too quick). */
	of(sessionId: string, timestamp: number): ReplySpeed | undefined {
		return this.byMessage.get(`${sessionId}:${timestamp}`);
	}

	summary(sessionId: string): SpeedSummary {
		return this.summaries.get(sessionId) ?? EMPTY;
	}

	/** The reply being written right now, or null. Tokens are estimated until it ends. */
	live(sessionId: string, now: number): { tps: number | null; ttftMs: number | null } | null {
		const r = this.running.get(sessionId);
		if (!r) return null;
		if (r.first === null) return { tps: null, ttftMs: null };
		const secs = (now - r.first) / 1000;
		return { tps: secs >= 0.5 ? r.estimate / secs : null, ttftMs: r.first - r.start };
	}

	feed(sessionId: string, e: SessionEvent, now: number): void {
		if (e.type === "message_start") {
			if (e.message.role === "assistant") this.running.set(sessionId, { start: now, first: null, estimate: 0 });
			return;
		}
		if (e.type === "message_update") {
			const r = this.running.get(sessionId);
			const d = e.delta;
			if (!r || !("delta" in d)) return;
			if (r.first === null) r.first = now;
			r.estimate += estimateTokens(d.delta);
			return;
		}
		if (e.type === "message_end") {
			if (e.message.role !== "assistant") return;
			const r = this.running.get(sessionId);
			this.running.delete(sessionId);
			const m = e.message as { usage?: { output?: number }; provider?: string; model?: string };
			const out = m.usage?.output ?? 0;
			if (!r || r.first === null || out <= 0) return;
			const ms = now - r.first;
			if (ms < MIN_MS) return;
			const last: ReplySpeed = { tps: out / (ms / 1000), ttftMs: r.first - r.start, outputTokens: out, ...(m.provider && m.model ? { model: `${m.provider}/${m.model}` } : {}) };
			this.byMessage.set(`${sessionId}:${(e.message as { timestamp?: number }).timestamp ?? 0}`, last);
			const t = this.totals.get(sessionId) ?? { tokens: 0, ms: 0 };
			t.tokens += out;
			t.ms += ms;
			this.totals.set(sessionId, t);
			this.summaries.set(sessionId, { last, avgTps: t.tokens / (t.ms / 1000), replies: (this.summaries.get(sessionId)?.replies ?? 0) + 1 });
			for (const fn of this.listeners) fn();
			return;
		}
		// A run that stops without a message_end (abort, crash) leaves nothing to time.
		if (e.type === "agent_settled") this.running.delete(sessionId);
	}
}

export const speedTracker = new SpeedTracker();
