import { TeamError } from "../types.ts";

/** The user has this long to answer a local-hand request; silence counts as a refusal (spec 4.1). */
export const CONFIRM_TIMEOUT_MS = 120_000;

export type Decision = "once" | "session" | "deny";

export interface HandRequest {
	callId: string;
	tool: string;
	input: unknown;
	/** Hub id of the session that asks. */
	session: string;
}

export interface ConfirmOptions {
	/** `ctx.stream.publish`. Topics: `handRequest` (a question for the user) and `handResolved` (it is answered or gone). */
	publish(topic: string, data: unknown): void;
	timeoutMs?: number;
}

interface Waiting {
	request: HandRequest;
	insideProject: boolean;
	resolve(): void;
	reject(err: Error): void;
	timer: NodeJS.Timeout;
}

const key = (session: string, tool: string): string => `${session}\u0000${tool}`;

/**
 * Asks the user before a tool of the team server runs on their machine. "Allow for this session" is remembered per session and tool and
 * only skips the question for paths inside the project copy; anything outside the copy is asked about every time.
 */
export class ConfirmGate {
	private readonly opts: ConfirmOptions;
	private readonly waiting = new Map<string, Waiting>();
	private readonly allowed = new Set<string>();

	constructor(opts: ConfirmOptions) {
		this.opts = opts;
	}

	/** Open questions (the client may have missed the stream message, e.g. after a reload). */
	pending(): { callId: string; tool: string; input: unknown; session: string; insideProject: boolean }[] {
		return [...this.waiting.values()].map((w) => ({ ...w.request, insideProject: w.insideProject }));
	}

	/** Resolves when the call may run; rejects with `handDenied` (refused or timed out). */
	request(req: HandRequest, insideProject: boolean): Promise<void> {
		if (insideProject && this.allowed.has(key(req.session, req.tool))) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(req.callId);
				this.opts.publish("handResolved", { callId: req.callId, decision: "timeout" });
				reject(new TeamError("handDenied", "用户没有在 120 秒内确认，已按拒绝处理", 403));
			}, this.opts.timeoutMs ?? CONFIRM_TIMEOUT_MS);
			timer.unref();
			this.waiting.set(req.callId, { request: req, insideProject, resolve, reject, timer });
			this.opts.publish("handRequest", { ...req, insideProject });
		});
	}

	/** The user's answer. False when the question is not (or no longer) open. */
	answer(callId: string, decision: Decision): boolean {
		const w = this.waiting.get(callId);
		if (!w) return false;
		clearTimeout(w.timer);
		this.waiting.delete(callId);
		this.opts.publish("handResolved", { callId, decision });
		if (decision === "deny") {
			w.reject(new TeamError("handDenied", "用户拒绝了这次本机操作", 403));
			return true;
		}
		if (decision === "session") this.allowed.add(key(w.request.session, w.request.tool));
		w.resolve();
		return true;
	}

	dispose(): void {
		for (const [id, w] of this.waiting) {
			clearTimeout(w.timer);
			this.waiting.delete(id);
			w.reject(new TeamError("handDenied", "插件已停止", 503));
		}
	}
}
