// Pure state and parsing for hybrid execution (block 3): where a session runs, the hand confirmation queue and sync status.
// The events come from the local team plugin's stream (plugins/team/src: hands/confirm.ts, handoff/handoff.ts, sync/manager.ts).
// Nothing here touches the DOM or the network, so the reducers are unit tested directly.
import type { ExecLocation, ExecMode, ExecState } from "../types.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const side = (v: unknown): ExecLocation | undefined => (v === "local" || v === "team" ? v : undefined);

// ---- session links (local session id to Hub session id) ----

/** What the app knows about one local session that belongs to a team session. */
export interface SessionLink {
	hubSessionId: string;
	/** Side this session currently runs on, from the Hub's exec state or the last `execChanged`. */
	location?: ExecLocation;
	mode?: ExecMode;
	/** This copy moved to the other side: it only mirrors and refuses prompts. */
	readOnly?: { to: ExecLocation; activeSessionId?: string };
}

export type SessionLinks = Readonly<Record<string, SessionLink>>;

export interface ExecChanged {
	hubSessionId: string;
	sessionId: string;
	activeSide: ExecLocation;
	activeSessionId?: string;
	readOnly: boolean;
}

export function parseExecChanged(data: unknown): ExecChanged | undefined {
	if (!isRecord(data)) return undefined;
	const hubSessionId = str(data.hubSessionId);
	const sessionId = str(data.sessionId);
	const activeSide = side(data.activeSide);
	if (!hubSessionId || !sessionId || !activeSide) return undefined;
	const activeSessionId = str(data.activeSessionId);
	return { hubSessionId, sessionId, activeSide, ...(activeSessionId ? { activeSessionId } : {}), readOnly: data.readOnly === true };
}

/** Records (or refreshes) that `localSessionId` is the local copy of a Hub session. Existing facts are kept. */
export function linkSession(links: SessionLinks, localSessionId: string, hubSessionId: string): SessionLinks {
	const current = links[localSessionId];
	if (current?.hubSessionId === hubSessionId) return links;
	return { ...links, [localSessionId]: { hubSessionId } };
}

/** `session.start` / `session.fork` answer with both ids; anything else yields no link. */
export function linkFromStartResult(result: unknown): { localSessionId: string; hubSessionId: string } | undefined {
	const data = isRecord(result) && result.ok === true && isRecord(result.data) ? result.data : result;
	if (!isRecord(data)) return undefined;
	const localSessionId = str(data.sessionId) ?? str(data.localSessionId);
	const hubSessionId = str(data.hubSessionId);
	return localSessionId && hubSessionId ? { localSessionId, hubSessionId } : undefined;
}

/** What RPC `session.link` knows about a local session. */
export interface SessionLinkInfo {
	hubSessionId: string;
	workspaceId: string;
	readOnly: boolean;
	activeSide: ExecLocation;
	activeSessionId?: string;
	execMode?: ExecMode;
}

/** Answer of `session.link`: null when the session is not a team session, undefined when it is not shaped like an answer. */
export function parseSessionLink(data: unknown): SessionLinkInfo | null | undefined {
	if (data === null) return null;
	if (!isRecord(data)) return undefined;
	const hubSessionId = str(data.hubSessionId);
	const activeSide = side(data.activeSide);
	if (!hubSessionId || !activeSide) return undefined;
	const activeSessionId = str(data.activeSessionId);
	const execMode = data.execMode === "local-first" || data.execMode === "team-first" ? data.execMode : undefined;
	return {
		hubSessionId,
		workspaceId: str(data.workspaceId) ?? "",
		readOnly: data.readOnly === true,
		activeSide,
		...(activeSessionId ? { activeSessionId } : {}),
		...(execMode ? { execMode } : {}),
	};
}

/** Sets the link of a local session from the plugin's answer. It is authoritative for side and read-only state; a known mode is kept when it brings none. */
export function applySessionLink(links: SessionLinks, localSessionId: string, info: SessionLinkInfo): SessionLinks {
	const mode = info.execMode ?? (links[localSessionId]?.hubSessionId === info.hubSessionId ? links[localSessionId]?.mode : undefined);
	const next: SessionLink = {
		hubSessionId: info.hubSessionId,
		location: info.activeSide,
		...(mode ? { mode } : {}),
		...(info.readOnly ? { readOnly: { to: info.activeSide, ...(info.activeSessionId ? { activeSessionId: info.activeSessionId } : {}) } } : {}),
	};
	const current = links[localSessionId];
	if (current && JSON.stringify(current) === JSON.stringify(next)) return links;
	return { ...links, [localSessionId]: next };
}

export function applyExecChanged(links: SessionLinks, ev: ExecChanged): SessionLinks {
	const current = links[ev.sessionId];
	const next: SessionLink = {
		hubSessionId: ev.hubSessionId,
		...(current?.mode ? { mode: current.mode } : {}),
		location: ev.activeSide,
		...(ev.readOnly ? { readOnly: { to: ev.activeSide, ...(ev.activeSessionId ? { activeSessionId: ev.activeSessionId } : {}) } } : {}),
	};
	return { ...links, [ev.sessionId]: next };
}

/** Merges the Hub's authoritative exec state into the link of the open session. */
export function applyExecState(links: SessionLinks, localSessionId: string, state: Pick<ExecState, "location" | "mode">): SessionLinks {
	const current = links[localSessionId];
	if (!current) return links;
	if (current.location === state.location && current.mode === state.mode) return links;
	// A read-only copy keeps pointing at the side it moved to; only the mode can change under it.
	return { ...links, [localSessionId]: { ...current, mode: state.mode, location: current.readOnly ? current.location : state.location } };
}

export const isReadOnly = (link: SessionLink | undefined): boolean => link?.readOnly !== undefined;

/** The session whose composer takes prompts now; undefined when this copy is not read-only or does not know. */
export const activeCopyOf = (link: SessionLink | undefined): string | undefined => link?.readOnly?.activeSessionId;

/** The other side a handoff would move to. */
export const otherSide = (location: ExecLocation): ExecLocation => (location === "team" ? "local" : "team");

// ---- hand confirmation queue ----

export interface HandItem {
	callId: string;
	tool: string;
	input: unknown;
	/** Hub session id of the session that asks. */
	session: string;
	insideProject: boolean;
}

export function parseHandRequest(data: unknown): HandItem | undefined {
	if (!isRecord(data)) return undefined;
	const callId = str(data.callId);
	const tool = str(data.tool);
	const session = str(data.session);
	if (!callId || !tool || !session) return undefined;
	return { callId, tool, input: data.input, session, insideProject: data.insideProject === true };
}

/** `hand.pending` answers `{ items: [...] }`; malformed entries are dropped. */
export function parsePendingHands(result: unknown): HandItem[] {
	const items = isRecord(result) && Array.isArray(result.items) ? result.items : Array.isArray(result) ? result : [];
	return items.map(parseHandRequest).filter((h): h is HandItem => h !== undefined);
}

/** Adds a request; a repeated `callId` replaces the old entry (reload recovery plus a live event can both deliver it). */
export function addHand(hands: readonly HandItem[], item: HandItem): HandItem[] {
	return [...hands.filter((h) => h.callId !== item.callId), item];
}

/** Merges the list recovered with `hand.pending` into the live queue. */
export function mergeHands(hands: readonly HandItem[], recovered: readonly HandItem[]): HandItem[] {
	return recovered.reduce<HandItem[]>((acc, h) => (acc.some((x) => x.callId === h.callId) ? acc : [...acc, h]), [...hands]);
}

export interface HandResolved {
	callId: string;
	decision: string;
}

export function parseHandResolved(data: unknown): HandResolved | undefined {
	if (!isRecord(data)) return undefined;
	const callId = str(data.callId);
	const decision = str(data.decision);
	return callId && decision ? { callId, decision } : undefined;
}

/** Removes the answered request; `timedOut` carries it when the plugin gave up waiting so the bar can say so briefly. */
export function resolveHand(hands: readonly HandItem[], ev: HandResolved): { hands: HandItem[]; timedOut?: HandItem } {
	const found = hands.find((h) => h.callId === ev.callId);
	const rest = hands.filter((h) => h.callId !== ev.callId);
	return found && ev.decision === "timeout" ? { hands: rest, timedOut: found } : { hands: rest };
}

/**
 * Requests to show in the open session: those of its own Hub session, plus the ones no known local session owns
 * (the question must stay answerable even when the asking session has no local copy here).
 */
export function handsForSession(hands: readonly HandItem[], links: SessionLinks, localSessionId: string | undefined): HandItem[] {
	const known = new Set(Object.values(links).map((l) => l.hubSessionId));
	const mine = localSessionId ? links[localSessionId]?.hubSessionId : undefined;
	return hands.filter((h) => h.session === mine || !known.has(h.session));
}

const INPUT_KEYS = ["command", "cmd", "path", "file_path", "filePath", "file", "url", "query", "pattern"] as const;

/** One-line summary of a tool input: the most telling field, else compact JSON, cut to `max` characters. */
export function summarizeInput(input: unknown, max = 120): string {
	const clip = (s: string): string => {
		const one = s.replace(/\s+/g, " ").trim();
		return one.length > max ? `${one.slice(0, Math.max(0, max - 1))}…` : one;
	};
	if (typeof input === "string") return clip(input);
	if (!isRecord(input)) return input === undefined || input === null ? "" : clip(String(input));
	for (const key of INPUT_KEYS) {
		const v = input[key];
		if (typeof v === "string" && v.trim()) return clip(v);
	}
	try {
		return clip(JSON.stringify(input));
	} catch {
		return "";
	}
}

// ---- sync status ----

export interface SnapshotApplied {
	hubSessionId: string;
	commit: string;
	status: string;
}

export function parseSnapshotApplied(data: unknown): SnapshotApplied | undefined {
	if (!isRecord(data)) return undefined;
	const hubSessionId = str(data.hubSessionId);
	const commit = str(data.commit);
	const status = str(data.status);
	return hubSessionId && commit && status ? { hubSessionId, commit, status } : undefined;
}

export interface SyncConflict {
	hubSessionId: string;
	conflictRef: string;
	conflictCommit: string;
	worktree: string;
	message: string;
}

export function parseSyncConflict(data: unknown): SyncConflict | undefined {
	if (!isRecord(data)) return undefined;
	const hubSessionId = str(data.hubSessionId);
	const conflictRef = str(data.conflictRef);
	const worktree = str(data.worktree);
	if (!hubSessionId || !conflictRef || !worktree) return undefined;
	return { hubSessionId, conflictRef, conflictCommit: str(data.conflictCommit) ?? "", worktree, message: str(data.message) ?? "" };
}

/** Answer of `sync.conflicts`, newest first; malformed entries are dropped. The saved message text is not kept, the notice uses its default. */
export function parseConflictList(data: unknown, hubSessionId: string): SyncConflict[] {
	const items = isRecord(data) && Array.isArray(data.conflicts) ? data.conflicts : [];
	const out: SyncConflict[] = [];
	for (const item of items) {
		if (!isRecord(item)) continue;
		const conflictRef = str(item.conflictRef);
		const worktree = str(item.worktree);
		if (conflictRef && worktree) out.push({ hubSessionId, conflictRef, conflictCommit: str(item.commit) ?? "", worktree, message: "" });
	}
	return out;
}

/** Shows a conflict loaded after a reload unless the session already has one (a live event is newer) or the user dismissed this very one. */
export function seedConflict(conflicts: Readonly<Record<string, SyncConflict>>, dismissed: Readonly<Record<string, string>>, loaded: readonly SyncConflict[]): Record<string, SyncConflict> {
	const newest = loaded[0];
	if (!newest || conflicts[newest.hubSessionId] || dismissed[newest.hubSessionId] === newest.conflictRef) return conflicts;
	return setConflict(conflicts, newest);
}

export interface SyncInfo {
	commit: string;
	status: string;
	/** Epoch milliseconds the event arrived. */
	at: number;
}

export function applySnapshot(sync: Readonly<Record<string, SyncInfo>>, ev: SnapshotApplied, now: number): Record<string, SyncInfo> {
	return { ...sync, [ev.hubSessionId]: { commit: ev.commit, status: ev.status, at: now } };
}

/** The conflict of a Hub session, newest wins. */
export function setConflict(conflicts: Readonly<Record<string, SyncConflict>>, ev: SyncConflict): Record<string, SyncConflict> {
	return { ...conflicts, [ev.hubSessionId]: ev };
}

export function dismissConflict(conflicts: Readonly<Record<string, SyncConflict>>, hubSessionId: string): Record<string, SyncConflict> {
	const { [hubSessionId]: _gone, ...rest } = conflicts;
	return rest;
}

/** Quotes one argument for a POSIX shell, cmd and PowerShell alike: bare when plain, else in double quotes. */
const quote = (s: string): string => (/^[A-Za-z0-9_./:@%+=,\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** The command that shows what the conflict snapshot holds compared with the working tree. */
export function gitInspectCommand(c: Pick<SyncConflict, "worktree" | "conflictRef" | "conflictCommit">): string {
	const rev = c.conflictRef || c.conflictCommit;
	return `git -C ${quote(c.worktree)} diff --stat HEAD ${quote(rev)}`;
}

export type RestoreMode = "apply" | "branch";

export interface RestoreResult {
	mode: RestoreMode;
	conflictRef: string;
	worktree: string;
	branch?: string;
	files: string[];
}

/** Answer of RPC `sync.restoreConflict`; undefined when it is not shaped like one. */
export function parseRestoreResult(data: unknown): RestoreResult | undefined {
	if (!isRecord(data)) return undefined;
	const mode = data.mode === "apply" || data.mode === "branch" ? data.mode : undefined;
	const conflictRef = str(data.conflictRef);
	const worktree = str(data.worktree);
	if (!mode || !conflictRef || !worktree) return undefined;
	const branch = str(data.branch);
	const files = Array.isArray(data.files) ? data.files.filter((f): f is string => typeof f === "string") : [];
	return { mode, conflictRef, worktree, ...(branch ? { branch } : {}), files };
}

export function shortCommit(commit: string): string {
	return commit.slice(0, 8);
}
