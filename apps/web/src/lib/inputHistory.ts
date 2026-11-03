/**
 * What was sent from the chat box, newest first, so ArrowUp can bring it back (like a shell).
 * Kept in localStorage so it survives restarts; shared by every chat.
 */
const KEY = "prometheus.inputHistory";
const MAX = 50;

function load(): string[] {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
		return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
	} catch {
		return [];
	}
}

let items: string[] | undefined;
const list = () => (items ??= load());

export function rememberInput(text: string): void {
	const value = text.trim();
	if (!value) return;
	const rest = list().filter((x) => x !== value);
	items = [value, ...rest].slice(0, MAX);
	try {
		localStorage.setItem(KEY, JSON.stringify(items));
	} catch {
		// Storage full or blocked: the in-memory list still works for this run.
	}
}

/** The n-th most recent entry (0 = latest), or undefined past the end. */
export const inputAt = (n: number): string | undefined => list()[n];
