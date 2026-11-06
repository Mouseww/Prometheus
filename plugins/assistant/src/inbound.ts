import type { AgentRunOptions, AgentRunResult } from "@prometheus/plugin-sdk";

export const MAX_BODY = 64 * 1024;
export const MAX_TEXT = 4000;

export interface InboundDeps {
	main(): Promise<{ sessionId: string }>;
	/** When given, each channel label gets its own conversation instead of the main chat. */
	sessionFor?(label: string): Promise<{ sessionId: string }>;
	run(options: AgentRunOptions): Promise<AgentRunResult>;
	now(): number;
	/** Messages accepted per minute across all channels; the rest get 429. */
	perMinute?: number;
	timeoutMs?: number;
}

export interface InboundResult {
	status: number;
	body: { ok: boolean; error?: string; reply?: string; sessionId?: string; result?: AgentRunResult["status"] };
}

const fail = (status: number, error: string): InboundResult => ({ status, body: { ok: false, error } });

/** "feishu:ou_123" - letters, digits and a few separators only, so it can sit inside the prompt as a label. */
export function channelLabel(raw: unknown): string {
	return String(raw ?? "").replace(/[^\w:.@-]/g, "").slice(0, 40) || "channel";
}

/**
 * Messages from outside (an IM bridge, a phone shortcut) continue the assistant's main chat, but nobody is at the
 * computer: the run is read-only no matter what the message says, and delegations from it inherit that.
 */
export function createInbound(deps: InboundDeps): (body: unknown) => Promise<InboundResult> {
	let inFlight = false;
	const stamps: number[] = [];
	const limit = deps.perMinute ?? 20;
	return async (body) => {
		const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
		const text = typeof b.text === "string" ? b.text.trim() : "";
		if (!text) return fail(400, "text is required");
		if (text.length > MAX_TEXT) return fail(413, `text is longer than ${MAX_TEXT} characters`);

		const t = deps.now();
		while (stamps.length && t - stamps[0]! > 60_000) stamps.shift();
		if (stamps.length >= limit) return fail(429, "too many messages, slow down");
		// One at a time: the chat is a single conversation, and replies must not interleave.
		if (inFlight) return fail(409, "the assistant is still working on the previous message");
		stamps.push(t);

		inFlight = true;
		try {
			const label = channelLabel(b.channel);
			const { sessionId } = deps.sessionFor ? await deps.sessionFor(label) : await deps.main();
			const prompt = `（来自「${label}」的消息。对方不在电脑前：只能查看、回答和规划，不能修改任何东西；需要改动就告诉对方回到电脑前处理。）\n${text}`;
			const r = await deps.run({ cwd: "", sessionId, prompt, access: "readonly", timeoutMs: deps.timeoutMs ?? 5 * 60_000 });
			const reply = String(r.text || r.error || "").slice(0, 8000);
			return { status: r.status === "success" ? 200 : 502, body: { ok: r.status === "success", reply, sessionId: r.sessionId, result: r.status } };
		} catch {
			// The chat is open and busy (someone is typing in it on the desktop), or the host could not run it.
			return fail(409, "the main chat is busy or unavailable, try again shortly");
		} finally {
			inFlight = false;
		}
	};
}
