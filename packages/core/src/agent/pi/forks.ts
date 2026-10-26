// Forked sessions waiting to be resumed. The fork exists only as a SessionManager until the host resumes it,
// so the runtime keeps it here; entries must not outlive the session that made them.
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export class PendingForks {
	private readonly byId = new Map<string, { manager: SessionManager; origin: string }>();

	/** Remembers the manager of a fork made by session `origin`, by the fork's own session id. */
	keep(origin: string, manager: SessionManager): void {
		this.byId.set(manager.getSessionId(), { manager, origin });
	}

	/** Hands out (and forgets) the manager of fork `id`, if it is still pending. */
	take(id: string): SessionManager | undefined {
		const entry = this.byId.get(id);
		this.byId.delete(id);
		return entry?.manager;
	}

	/** Forgets the forks of `origin` that were never resumed. */
	dropFrom(origin: string): void {
		for (const [id, entry] of this.byId) if (entry.origin === origin) this.byId.delete(id);
	}

	get size(): number {
		return this.byId.size;
	}
}
