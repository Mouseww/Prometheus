// Drives /goal: after every settled run of a conversation with an active goal, read what the agent reported and
// either stop (complete, blocked, failed, stopped by the user, out of turns) or send the next turn. Runtime-neutral:
// it only needs to prompt a session and look at its state, so PI, Claude Code, Codex and OpenCode behave the same.
import { GOAL_DEFAULT_TURNS, GOAL_MAX_TURNS, type GoalState, goalDirective, readGoalStatus } from "@prometheus/protocol";

/** What the tracker needs to know about a session once a run settled. */
export interface GoalView {
	isStreaming: boolean;
	/** Messages the user queued; they run first, and the goal waits for the run after them. */
	queued: boolean;
	/** Text of the last assistant reply. */
	lastReply: string;
	/** Error of the last reply, when it failed. */
	error?: string;
}

export interface GoalDeps {
	/** Start a turn in the session; rejects when the runtime refuses the prompt. */
	prompt(sessionId: string, text: string): Promise<unknown>;
	/** The session's state, or undefined when it is no longer open. */
	view(sessionId: string): GoalView | undefined;
	emit(sessionId: string, goal: GoalState | null): void;
	/** Pause between turns, so a settled run is fully written and the user can step in. */
	delayMs?: number;
	now?: () => number;
}

export class GoalTracker {
	private readonly goals = new Map<string, GoalState>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly deps: GoalDeps;

	constructor(deps: GoalDeps) {
		this.deps = deps;
	}

	get(sessionId: string): GoalState | undefined {
		return this.goals.get(sessionId);
	}

	/** A new goal replaces the old one. It starts now when the session is idle, else when the current run settles. */
	async set(sessionId: string, objective: string, maxTurns?: number): Promise<GoalState> {
		const text = objective.trim();
		if (!text) throw new Error("empty objective");
		this.cancelTimer(sessionId);
		const now = this.now();
		const limit = Math.min(GOAL_MAX_TURNS, Math.max(1, Math.floor(maxTurns ?? GOAL_DEFAULT_TURNS)));
		this.put(sessionId, { objective: text, status: "active", turns: 0, maxTurns: limit, startedAt: now, updatedAt: now });
		const view = this.deps.view(sessionId);
		if (view && !view.isStreaming) await this.step(sessionId);
		return this.goals.get(sessionId)!;
	}

	pause(sessionId: string, note?: string): GoalState | null {
		const goal = this.goals.get(sessionId);
		if (!goal) return null;
		this.cancelTimer(sessionId);
		if (goal.status !== "active") return goal;
		return this.update(sessionId, { status: "paused", ...(note ? { note } : {}) });
	}

	/** Carry on after a pause, a block or the turn limit (which then grows by the original budget). */
	async resume(sessionId: string): Promise<GoalState | null> {
		const goal = this.goals.get(sessionId);
		if (!goal) return null;
		if (goal.status === "complete") return goal;
		const maxTurns = goal.turns >= goal.maxTurns ? goal.turns + Math.min(goal.maxTurns, GOAL_DEFAULT_TURNS) : goal.maxTurns;
		const next = this.update(sessionId, { status: "active", maxTurns, note: undefined });
		const view = this.deps.view(sessionId);
		// The last reply is what stopped the goal; reading it again would stop it right away.
		if (view && !view.isStreaming) await this.step(sessionId, true);
		return this.goals.get(sessionId) ?? next;
	}

	clear(sessionId: string): null {
		this.cancelTimer(sessionId);
		if (this.goals.delete(sessionId)) this.deps.emit(sessionId, null);
		return null;
	}

	/** The session is gone (closed or deleted): forget its goal without telling anyone. */
	drop(sessionId: string): void {
		this.cancelTimer(sessionId);
		this.goals.delete(sessionId);
	}

	/** The conversation moved to a new session id (another agent took over); the goal goes with it. */
	move(from: string, to: string): void {
		const goal = this.goals.get(from);
		this.drop(from);
		if (!goal) return;
		this.goals.set(to, goal);
		this.deps.emit(to, goal);
		if (goal.status === "active") this.schedule(to);
	}

	/** A run of the session settled. */
	settled(sessionId: string, aborted: boolean): void {
		const goal = this.goals.get(sessionId);
		if (!goal || goal.status !== "active") return;
		if (aborted) {
			this.pause(sessionId);
			return;
		}
		this.schedule(sessionId);
	}

	dispose(): void {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		this.goals.clear();
	}

	// ---------- internals ----------

	private schedule(sessionId: string): void {
		this.cancelTimer(sessionId);
		const timer = setTimeout(() => {
			this.timers.delete(sessionId);
			void this.step(sessionId);
		}, this.deps.delayMs ?? 1000);
		this.timers.set(sessionId, timer);
	}

	/** Look at the last reply and decide: stop, or send the next turn. */
	private async step(sessionId: string, fresh = false): Promise<void> {
		const goal = this.goals.get(sessionId);
		if (!goal || goal.status !== "active") return;
		const view = this.deps.view(sessionId);
		if (!view) {
			this.drop(sessionId);
			return;
		}
		// Something else is running (the user wrote, or a queued message went out): its own settle comes back here.
		if (view.isStreaming || view.queued) return;
		if (goal.turns > 0 && !fresh) {
			if (view.error) {
				this.update(sessionId, { status: "paused", note: view.error });
				return;
			}
			const reported = readGoalStatus(view.lastReply);
			if (reported?.status === "complete") {
				this.update(sessionId, { status: "complete", note: summaryOf(view.lastReply) });
				return;
			}
			if (reported?.status === "blocked") {
				this.update(sessionId, { status: "blocked", ...(reported.reason ? { note: reported.reason } : {}) });
				return;
			}
			if (goal.turns >= goal.maxTurns) {
				this.update(sessionId, { status: "limit" });
				return;
			}
		}
		const turn = goal.turns + 1;
		this.update(sessionId, { turns: turn });
		try {
			await this.deps.prompt(sessionId, goalDirective(goal.objective, turn, goal.maxTurns));
		} catch (err) {
			// Only pause the goal this turn belonged to: it may have been replaced or cleared meanwhile.
			if (this.goals.get(sessionId)?.startedAt === goal.startedAt) this.update(sessionId, { status: "paused", note: err instanceof Error ? err.message : String(err) });
		}
	}

	private update(sessionId: string, patch: Partial<GoalState>): GoalState {
		const goal = this.goals.get(sessionId);
		if (!goal) throw new Error("no goal");
		const next: GoalState = { ...goal, ...patch, updatedAt: this.now() };
		if (patch.note === undefined && "note" in patch) delete next.note;
		this.put(sessionId, next);
		return next;
	}

	private put(sessionId: string, goal: GoalState): void {
		this.goals.set(sessionId, goal);
		this.deps.emit(sessionId, goal);
	}

	private cancelTimer(sessionId: string): void {
		const t = this.timers.get(sessionId);
		if (t) clearTimeout(t);
		this.timers.delete(sessionId);
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}
}

/** The closing words of a finished goal: the reply's last paragraph before the status tag, kept short. */
function summaryOf(reply: string): string | undefined {
	const before = reply.slice(0, reply.toLowerCase().lastIndexOf("<goal_status>")).trim();
	const last = before.split(/\n\s*\n/).pop()?.trim();
	if (!last) return undefined;
	return last.length > 400 ? `${last.slice(0, 400)}…` : last;
}
