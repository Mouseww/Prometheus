/**
 * Questions a delegated run asks the user. The run is unattended, so its tool waits here until the user answers
 * (from the home page) or the run is aborted. Kept in memory: when the app restarts the run is gone too.
 */
export interface PendingQuestion {
	id: string;
	sessionId: string;
	question: string;
	options: string[];
	at: number;
}

export interface AskDeps {
	/** Whether the assistant delegated this session; nobody else may ask. */
	delegated(sessionId: string): boolean;
	changed(): void;
	now(): number;
	/** A run started or stopped waiting for an answer (its time budget pauses meanwhile). */
	waiting?(sessionId: string, waiting: boolean): void;
	/** How long a question stays open before it fails and the run decides for itself. Default 30 minutes. */
	waitMs?: number;
}

export interface Ask {
	ask(sessionId: string | undefined, question: string, options?: string[], signal?: AbortSignal): Promise<{ ok: true; answer: string } | { ok: false; reason: string }>;
	pending(): PendingQuestion[];
	answer(id: string, text: string): boolean;
	/** Resolves with the session's open question, now or when it next asks; undefined when `signal` aborts first. */
	next(sessionId: string, signal?: AbortSignal): Promise<PendingQuestion | undefined>;
}

const MAX_PENDING = 20;

export function createAsk(deps: AskDeps): Ask {
	const waiting = new Map<string, { q: PendingQuestion; settle: (r: { ok: true; answer: string } | { ok: false; reason: string }) => void }>();
	const listeners = new Set<{ sessionId: string; resolve: (q: PendingQuestion) => void }>();
	let seq = 0;

	return {
		ask(sessionId, question, options, signal) {
			const text = String(question ?? "").trim().slice(0, 1000);
			if (!sessionId || !deps.delegated(sessionId)) return Promise.resolve({ ok: false, reason: "assistant_ask only works inside a run the assistant delegated. Decide yourself and mention the assumption in your report." });
			if (!text) return Promise.resolve({ ok: false, reason: "Write the question." });
			if (waiting.size >= MAX_PENDING) return Promise.resolve({ ok: false, reason: "Too many unanswered questions. Decide yourself and mention the assumption in your report." });
			// One open question per run: asking again replaces the earlier one rather than stacking them.
			for (const [id, w] of waiting) if (w.q.sessionId === sessionId) w.settle({ ok: false, reason: "Superseded by a newer question." }), waiting.delete(id);
			const q: PendingQuestion = { id: `q${++seq}-${deps.now()}`, sessionId, question: text, options: (options ?? []).map((o) => String(o).trim().slice(0, 120)).filter(Boolean).slice(0, 6), at: deps.now() };
			return new Promise((resolve) => {
				const timer = setTimeout(() => done({ ok: false, reason: "The user did not answer in time. Decide yourself and say what you assumed." }), deps.waitMs ?? 30 * 60_000);
				timer.unref?.();
				const done = (r: { ok: true; answer: string } | { ok: false; reason: string }) => {
					if (waiting.get(q.id)?.settle !== done) return;
					waiting.delete(q.id);
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					deps.waiting?.(sessionId, false);
					deps.changed();
					resolve(r);
				};
				const onAbort = () => done({ ok: false, reason: "The run was stopped or timed out before the user answered." });
				waiting.set(q.id, { q, settle: done });
				if (signal?.aborted) return onAbort();
				signal?.addEventListener("abort", onAbort, { once: true });
				deps.waiting?.(sessionId, true);
				for (const l of [...listeners]) if (l.sessionId === sessionId) listeners.delete(l), l.resolve(q);
				deps.changed();
			});
		},
		next(sessionId, signal) {
			const open = [...waiting.values()].find((w) => w.q.sessionId === sessionId);
			if (open) return Promise.resolve(open.q);
			return new Promise((resolve) => {
				const l = { sessionId, resolve: (q: PendingQuestion) => resolve(q) };
				listeners.add(l);
				signal?.addEventListener("abort", () => void (listeners.delete(l), resolve(undefined)), { once: true });
			});
		},
		pending: () => [...waiting.values()].map((w) => w.q).sort((a, b) => a.at - b.at),
		answer(id, text) {
			const w = waiting.get(id);
			const a = String(text ?? "").trim().slice(0, 4000);
			if (!w || !a) return false;
			w.settle({ ok: true, answer: a });
			return true;
		},
	};
}
