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
}

/** Key of the new-chat page: its session id changes while it is set up (workspace or agent picked), the draft must not. */
export const NEW_CHAT_DRAFT = "new";

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
	const empty = !draft.text && !draft.images.length && !draft.docs.length;
	if (empty) memory.delete(key);
	else memory.set(key, draft);
	const all = storage();
	const before = all[key]?.text ?? "";
	if (before === draft.text) return;
	if (draft.text) all[key] = { text: draft.text, at: Date.now() };
	else delete all[key];
	persist();
}
