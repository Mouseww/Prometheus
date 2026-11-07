/**
 * Personal space vs. work space.
 *
 * The personal space is the assistant's home folder: every conversation whose working directory is that folder
 * belongs to it, and that folder is hidden from the project list. Nothing is stored per conversation: the folder
 * alone decides, so existing sessions sort themselves into the right space.
 */
export type Space = "personal" | "work";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
	return Boolean(a) && Boolean(b) && norm(a as string) === norm(b as string);
}

/** The space a conversation or folder belongs to, given the assistant's home folder (null: no personal space). */
export function spaceOf(cwd: string, home: string | null): Space {
	return home && samePath(cwd, home) ? "personal" : "work";
}

/** The space a conversation belongs to. A chat running in its own worktree has a cwd elsewhere; its project folder (root) decides. */
export function sessionSpace(s: { cwd: string; worktree?: { root: string } | null }, home: string | null): Space {
	return spaceOf(s.worktree?.root ?? s.cwd, home);
}

/** The space actually shown: without an assistant there is only the work space. */
export function effectiveSpace(chosen: Space, home: string | null): Space {
	return home ? chosen : "work";
}

export type AgeGroup = "today" | "week" | "earlier";

const DAY = 24 * 3600 * 1000;

/** Newest-first conversations split into today / the last 7 days / earlier, empty groups dropped. */
export function groupByAge<T extends { modified: string }>(items: readonly T[], now = Date.now()): { key: AgeGroup; items: T[] }[] {
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	const today = startOfToday.getTime();
	const out: Record<AgeGroup, T[]> = { today: [], week: [], earlier: [] };
	const sorted = [...items].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
	for (const item of sorted) {
		const at = Date.parse(item.modified);
		out[at >= today ? "today" : at >= today - 6 * DAY ? "week" : "earlier"].push(item);
	}
	return (["today", "week", "earlier"] as const).filter((k) => out[k].length > 0).map((key) => ({ key, items: out[key] }));
}

/** Prefix `assistant_delegate` puts on the names of the sessions it starts; only used to tidy titles, never to identify them. */
export const DELEGATION_PREFIX = "助理派活：";

/**
 * Runs the assistant handed to projects (known by session id, which the assistant plugin records), newest first.
 * "running" is what is in progress now; "done" is the most recent finished ones (capped), so the home page stays short.
 */
export function delegatedRuns<T extends { id: string; modified: string; running: boolean; archived: boolean }>(
	sessions: readonly T[],
	delegated: ReadonlySet<string>,
	doneLimit = 5,
): { running: T[]; done: T[] } {
	const mine = sessions.filter((s) => !s.archived && delegated.has(s.id)).sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
	return { running: mine.filter((s) => s.running), done: mine.filter((s) => !s.running).slice(0, doneLimit) };
}

/** The title of a delegated run without the prefix. */
export const delegationTitle = (name: string | undefined): string => (name ?? "").replace(DELEGATION_PREFIX, "").trim();
