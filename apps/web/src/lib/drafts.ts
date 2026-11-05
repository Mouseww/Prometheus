// Unsent composer contents, one per conversation (plus one for the new-chat page), so switching conversations neither
// carries a draft along nor loses it. The composer is torn down and rebuilt on many switches (the loading placeholder
// has none), so its own state cannot be the place a draft lives. Text also goes to localStorage to survive a reload;
// pictures and attached files only live for this page (they can be large).
import type { ImageContent } from "@prometheus/protocol";
import type { Attachment } from "./attachments.ts";

export interface Draft {
	text: string;
	images: ImageContent[];
	docs: Attachment[];
	/** ArrowUp browsing of sent messages: position (-1: not browsing) and what was typed before; this page only. */
	history?: { at: number; draft: string };
}

/**
 * Key of the new-chat page before a workspace is picked: its session id changes while it is set up (workspace or agent
 * picked), the draft must not. Once a workspace is known the draft belongs to that workspace instead (see
 * `newChatDraft`), or typing into one project's new-chat page would show up in every other project's.
 */
export const NEW_CHAT_DRAFT = "new";

/** Draft key of the new-chat page for `scope` (the workspace it is set up in); unscoped is the workspace-less page. */
export function newChatDraft(scope?: string | null): string {
	return scope ? `${NEW_CHAT_DRAFT}:${scope}` : NEW_CHAT_DRAFT;
}

const STORAGE_KEY = "prometheus.drafts";
const MAX_SAVED = 200;

const memory = new Map<string, Draft>();
let saved: Record<string, { text: string; at: number }> | null = null;

function storage(): Record<string, { text: string; at: number }> {
	if (saved) return saved;
	try {
		const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
		saved = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	} catch {
		saved = {};
	}
	return saved!;
}

function persist(): void {
	const all = storage();
	const keys = Object.keys(all);
	if (keys.length > MAX_SAVED) {
		for (const k of keys.sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0)).slice(0, keys.length - MAX_SAVED)) delete all[k];
	}
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
	} catch {
		// Storage full or unavailable: the draft still lives for this page.
	}
}

export function loadDraft(key: string): Draft {
	const kept = memory.get(key);
	if (kept) return kept;
	return { text: storage()[key]?.text ?? "", images: [], docs: [] };
}

export function saveDraft(key: string, draft: Draft): void {
	const empty = !draft.text && !draft.images.length && !draft.docs.length && !(draft.history && (draft.history.at >= 0 || draft.history.draft));
	if (empty) memory.delete(key);
	else memory.set(key, draft);
	const all = storage();
	const before = all[key]?.text ?? "";
	if (before === draft.text) return;
	if (draft.text) all[key] = { text: draft.text, at: Date.now() };
	else delete all[key];
	persist();
}

/**
 * Hand what was typed before a workspace was picked over to that workspace's page, once: after that the two are apart.
 * Returns the draft to show (the adopted one, or the target's own when it already has something).
 */
export function adoptDraft(from: string, to: string): Draft {
	const target = loadDraft(to);
	if (target.text || target.images.length || target.docs.length) return target;
	const source = loadDraft(from);
	if (!source.text && !source.images.length && !source.docs.length) return target;
	saveDraft(to, source);
	saveDraft(from, { text: "", images: [], docs: [] });
	return source;
}

/**
 * The composer moved on to `to` while it stayed mounted: keep `mine` with the key it was typed under (`from`) and report
 * what the new one holds. Picking a workspace turns the plain new-chat page into that workspace's page, and only that
 * transition carries text over: every other switch (another conversation, another workspace) starts from its own draft.
 */
export function switchDraft(from: string, to: string, mine: Draft): Draft {
	if (from === to) return mine;
	saveDraft(from, mine);
	return from === NEW_CHAT_DRAFT && to.startsWith(`${NEW_CHAT_DRAFT}:`) ? adoptDraft(from, to) : loadDraft(to);
}
