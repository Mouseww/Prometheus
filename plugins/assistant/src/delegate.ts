import type { AgentRunOptions, AgentRunResult, WorkspaceRef } from "@prometheus/plugin-sdk";
import type { RunAccess } from "@prometheus/protocol";
import { sameDir } from "./home.ts";
import type { PendingQuestion } from "./ask.ts";

export interface DelegationCard {
	sessionId?: string;
	project: string;
	/** "asking": the run is waiting for an answer; "running": still going when the wait ran out. */
	status: "success" | "error" | "aborted" | "refused" | "asking" | "running";
	/** What the model asked for and what the host let the run do. */
	requested: RunAccess;
	access: RunAccess;
}

export interface DelegateDeps {
	homeDir: string;
	workspaces(): Promise<WorkspaceRef[]>;
	runAgent(options: AgentRunOptions): Promise<AgentRunResult>;
	/** The project a session was delegated to, if this assistant delegated it. */
	delegatedProject(sessionId: string): string | undefined;
	/** A delegated session came into being (called while it is still running). */
	started(sessionId: string, project: string): void;
	/** Runs that are going right now, by session id. */
	live: Map<string, LiveRun>;
	/** A run nobody was waiting for has finished (the user answered its question from the home page): tell the chat that delegated it. */
	deliver?(parentSessionId: string, text: string): void;
	/** The session's open question, now or when it next asks (undefined when `signal` aborts first). */
	nextQuestion(sessionId: string, signal: AbortSignal): Promise<PendingQuestion | undefined>;
}

/** A run's time budget that stops counting while the run waits for the user. */
export interface Budget {
	pause(): void;
	resume(): void;
	clear(): void;
}

export function budget(ms: number, onExpire: () => void): Budget {
	let left = ms;
	let since = Date.now();
	let handle: ReturnType<typeof setTimeout> | undefined = setTimeout(onExpire, left);
	handle.unref?.();
	return {
		pause() {
			if (!handle) return;
			clearTimeout(handle);
			handle = undefined;
			left = Math.max(0, left - (Date.now() - since));
		},
		resume() {
			if (handle || left <= 0) return;
			since = Date.now();
			handle = setTimeout(onExpire, left);
			handle.unref?.();
		},
		clear() {
			if (handle) clearTimeout(handle);
			handle = undefined;
			left = 0;
		},
	};
}

type Finished = { ok: true; r: AgentRunResult } | { ok: false; err: unknown };

export interface LiveRun {
	project: string;
	requested: RunAccess;
	result: Promise<Finished>;
	budget: Budget;
	stop(): void;
	/** How many tool calls are waiting on this run right now. */
	waiters: number;
}

/** How long one tool call waits before telling the model the run is still going. */
const WAIT_MS = 10 * 60_000;
const RUN_MS = 20 * 60_000;

export interface DelegateParams {
	project: string;
	task: string;
	access?: string;
	/** Session id of an earlier delegation to carry on instead of starting a new one. */
	continue_session?: string;
	/** Short name for the run, shown in lists. */
	title?: string;
}

/** A list title: the model's own short title, else the task up to its first sentence break, cut at a word-ish length. */
export function runTitle(title: string | undefined, task: string): string {
	const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
	const t = oneLine(title ?? "");
	if (t) return t.slice(0, 30);
	const first = oneLine(task).split(/[。!?！？;；]|\.\s/)[0] ?? "";
	const base = first || oneLine(task);
	return base.length > 28 ? `${base.slice(0, 27)}…` : base;
}

export interface DelegateCall {
	cwd: string;
	sessionId: string | undefined;
	signal?: AbortSignal;
}

export interface DelegateOutcome {
	text: string;
	card: DelegationCard;
}

const projectsOf = (list: WorkspaceRef[], homeDir: string) => list.filter((w) => !sameDir(w.path, homeDir));

/** Exactly one project by id, exact name, or an unambiguous part of the name. */
export function pickProject(list: WorkspaceRef[], query: string): WorkspaceRef | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	const byId = list.find((w) => w.id === query.trim());
	if (byId) return byId;
	const exact = list.filter((w) => w.name.toLowerCase() === q);
	if (exact.length === 1) return exact[0];
	const part = list.filter((w) => w.name.toLowerCase().includes(q));
	return part.length === 1 ? part[0] : undefined;
}

const refused = (project: string, why: string, requested: RunAccess): DelegateOutcome => ({ text: why, card: { project, status: "refused", requested, access: "readonly" } });

export async function delegate(deps: DelegateDeps, call: DelegateCall, params: DelegateParams): Promise<DelegateOutcome> {
	const requested: RunAccess = params.access === "edits" ? "edits" : "readonly";
	if (!sameDir(call.cwd, deps.homeDir)) return refused(params.project, "assistant_delegate only works from the assistant's own home, not from inside a project.", requested);
	const task = String(params.task ?? "").trim().slice(0, 6000);
	if (!task) return refused(params.project, "Describe the task.", requested);
	const projects = projectsOf(await deps.workspaces(), deps.homeDir);
	const ws = pickProject(projects, String(params.project ?? ""));
	if (!ws) return refused(String(params.project ?? ""), `No single project matches "${params.project}". Projects:\n${projects.map((w) => `- ${w.name}`).join("\n") || "(none)"}`, requested);

	// One piece of work, one session: carrying on an earlier delegation goes back into that session. Only the model
	// can say the new task belongs to it, so it names the session; a different project or a stranger's id is refused.
	const again = String(params.continue_session ?? "").trim();
	if (again) {
		const was = deps.delegatedProject(again);
		if (was === undefined) return refused(ws.name, `continue_session "${again}" is not a session you delegated. Leave it out to start a new one.`, requested);
		if (was.toLowerCase() !== ws.name.toLowerCase()) return refused(ws.name, `Session "${again}" belongs to project "${was}", not "${ws.name}".`, requested);
	}

	const ctl = new AbortController();
	const timer = budget(RUN_MS, () => ctl.abort());
	let onStart: (id: string) => void = () => {};
	const started = new Promise<string>((res) => (onStart = res));
	const result: Promise<Finished> = deps
		.runAgent({
			cwd: ws.path,
			prompt: task,
			name: `助理派活：${runTitle(params.title, task)}`,
			access: requested,
			...(again ? { sessionId: again } : {}),
			onStart: (id) => {
				deps.started(id, ws.name);
				onStart(id);
			},
			// The host caps this at what the calling chat may do; an unknown caller can only read.
			...(call.sessionId ? { parentSessionId: call.sessionId } : {}),
			// Our own budget (paused while the run waits for an answer) decides; the host's is just a backstop.
			signal: ctl.signal,
			timeoutMs: 24 * 3600_000,
		})
		.then(
			(r): Finished => ({ ok: true, r }),
			(err): Finished => ({ ok: false, err }),
		)
		.finally(() => timer.clear());

	const id = await Promise.race([started, result.then(() => undefined)]);
	if (!id) {
		const f = await result;
		return finish({ project: ws.name, requested }, f, again);
	}
	const run: LiveRun = { project: ws.name, requested, result, budget: timer, stop: () => ctl.abort(), waiters: 0 };
	deps.live.set(id, run);
	void result.then((f) => {
		deps.live.delete(id);
		// Nobody was waiting (the answer came from the home page, after the calling tool had already returned): say so in the chat.
		if (run.waiters > 0 || !call.sessionId || !deps.deliver) return;
		try {
			deps.deliver(call.sessionId, finish({ project: ws.name, requested }, f).text);
		} catch {
			// a failed run with nothing to report; the session and the home page still show it
		}
	});
	return await waitOn(deps, id, call.signal);
}

function finish(meta: { project: string; requested: RunAccess }, f: Finished, again?: string): DelegateOutcome {
	const { project, requested } = meta;
	if (!f.ok) {
		if (again) return refused(project, `Session "${again}" could not be continued (it is probably still running). Wait for it to finish, or start a new one by leaving continue_session out.`, requested);
		throw f.err;
	}
	const r = f.r;
	const note = r.access !== requested ? `Edits were not allowed here (this chat's permission mode), so the task ran read-only; tell the user if changes were needed and how to allow them.
` : "";
	const body = String(r.text || r.error || "").slice(0, 8000);
	return {
		text: `${note}Project "${project}" (${r.access}): ${r.status} (session ${r.sessionId}; pass it as continue_session to carry on the same work)
${body}`,
		card: { sessionId: r.sessionId, project, status: r.status, requested, access: r.access },
	};
}

/**
 * Waits for a live run to finish or to ask something. A question comes back to the model as the result, so the
 * model can answer it (assistant_reply) instead of the run being stuck; the run's clock is paused while it waits.
 */
export async function waitOn(deps: DelegateDeps, sessionId: string, signal?: AbortSignal): Promise<DelegateOutcome> {
	const run = deps.live.get(sessionId);
	if (!run) return { text: `No run is in progress in session ${sessionId} (it finished, or it was never delegated by you).`, card: { sessionId, project: "", status: "refused", requested: "readonly", access: "readonly" } };
	const stopWaiting = new AbortController();
	let giveUp: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => run.stop();
	signal?.addEventListener("abort", onAbort, { once: true });
	run.waiters++;
	try {
		const r = await Promise.race([
			run.result.then((f) => ({ k: "done" as const, f })),
			deps.nextQuestion(sessionId, stopWaiting.signal).then((q) => (q ? { k: "ask" as const, q } : new Promise<never>(() => {}))),
			new Promise<{ k: "late" }>((res) => (giveUp = setTimeout(() => res({ k: "late" }), WAIT_MS))),
		]);
		if (r.k === "done") return finish({ project: run.project, requested: run.requested }, r.f);
		const card = { sessionId, project: run.project, requested: run.requested, access: run.requested };
		if (r.k === "ask") {
			const opts = r.q.options.length ? `
Options: ${r.q.options.join(" | ")}` : "";
			return {
				text: `The run in session ${sessionId} (project "${run.project}") is paused and asks:
${r.q.question}${opts}

Answer it with assistant_reply if the user's request and what you know of them settle it. If they do not, ask the user in this chat first, then call assistant_reply with their answer.`,
				card: { ...card, status: "asking" },
			};
		}
		return { text: `The run in session ${sessionId} is still going. Call assistant_wait with this session id to keep waiting, or tell the user it is in progress.`, card: { ...card, status: "running" } };
	} finally {
		run.waiters--;
		stopWaiting.abort();
		if (giveUp) clearTimeout(giveUp);
		signal?.removeEventListener("abort", onAbort);
	}
}
