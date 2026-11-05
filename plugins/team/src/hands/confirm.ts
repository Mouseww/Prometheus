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

/**
 * The only tools "allow for this session" may apply to: read-only ones. Every other tool (`local_exec` and anything added later) is asked
 * about on every call, because a command can do anything the member's account can, whatever its working directory is.
 */
const SESSION_ALLOWED_TOOLS: ReadonlySet<string> = new Set(["local_read", "local_ls", "local_grep"]);

/** Whether the user may answer "allow for this session" for this tool (the UI hides the button otherwise). */
export const allowsSessionGrant = (tool: string): boolean => SESSION_ALLOWED_TOOLS.has(tool);

const key = (session: string, tool: string): string => `${session}\u0000${tool}`;

/**
 * Asks the user before a tool of the team server runs on their machine. "Allow for this session" exists only for read-only tools: it is
 * remembered per session and tool and skips the question only while the call's real target path (symlinks resolved, checked on every
 * call) is inside the project copy. Commands are asked about every time.
 */
export class ConfirmGate {
	private readonly opts: ConfirmOptions;
	private readonly waiting = new Map<string, Waiting>();
	private readonly allowed = new Set<string>();

	constructor(opts: ConfirmOptions) {
		this.opts = opts;
	}

	/** Open questions (the client may have missed the stream message, e.g. after a reload). */
	pending(): { callId: string; tool: string; input: unknown; session: string; insideProject: boolean; allowSession: boolean }[] {
		return [...this.waiting.values()].map((w) => ({ ...w.request, insideProject: w.insideProject, allowSession: allowsSessionGrant(w.request.tool) }));
	}

	/** Resolves when the call may run; rejects with `handDenied` (refused or timed out) or `duplicateCallId` (a question with this id is open). */
	request(req: HandRequest, insideProject: boolean): Promise<void> {
		if (insideProject && allowsSessionGrant(req.tool) && this.allowed.has(key(req.session, req.tool))) return Promise.resolve();
		// A reused callId must never replace an open question: the card the user is looking at would stop matching the call it answers.
		if (this.waiting.has(req.callId)) return Promise.reject(new TeamError("duplicateCallId", `已有一个 callId 相同的本机操作确认在等待中: ${req.callId}`, 409));
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(req.callId);
				this.opts.publish("handResolved", { callId: req.callId, decision: "timeout" });
				reject(new TeamError("handDenied", "用户没有在 120 秒内确认，已按拒绝处理", 403));
			}, this.opts.timeoutMs ?? CONFIRM_TIMEOUT_MS);
			timer.unref();
			this.waiting.set(req.callId, { request: req, insideProject, resolve, reject, timer });
			this.opts.publish("handRequest", { ...req, insideProject, allowSession: allowsSessionGrant(req.tool) });
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
		// A session grant for a tool that does not allow one counts as a plain "once" (a stale or hand-made client may still send it).
		if (decision === "session" && allowsSessionGrant(w.request.tool) && w.insideProject) this.allowed.add(key(w.request.session, w.request.tool));
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
