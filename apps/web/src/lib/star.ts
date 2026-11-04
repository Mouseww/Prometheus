// Asking for a GitHub star, without nagging.
//
// Rules, in order of importance:
// 1. Never more than once. Any answer (including "later") is remembered on this machine, forever.
// 2. Only after the user got something out of the app, not on first launch: the prompt fires when a run has actually
//    finished and the app has been used on a couple of different days.
// 3. Never blocking. It is a small card, dismissible, and it never appears while a run is going on.
// 4. The count is fetched once, when someone opens the About page. A failure just hides the number — no retry loop,
//    no cached number that goes stale, no network call on startup.
import { create } from "zustand";

export const REPO = "Mouseww/Prometheus";
export const REPO_URL = `https://github.com/${REPO}`;
const STARS_API = `https://api.github.com/repos/${REPO}`;

const KEY = "prometheus.star";

/** `asked`: the card was shown and answered. `done`: the user says they starred — silence forever, and no re-ask. */
type StarState = { asked: boolean; done: boolean; days: string[] };

const localDate = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function read(): StarState {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<StarState> | null;
		return { asked: Boolean(raw?.asked), done: Boolean(raw?.done), days: Array.isArray(raw?.days) ? raw.days.filter((d): d is string => typeof d === "string") : [] };
	} catch {
		return { asked: false, done: false, days: [] };
	}
}

function write(state: StarState): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(state));
	} catch {
		// Private mode or full storage: the prompt may come back, which is harmless.
	}
}

interface StarStore {
	stars: number | null;
	/** Fetching failed (offline, rate limit, no network): the About page shows the link without a count. */
	failed: boolean;
	loading: boolean;
	/** Whether the one-time card should be on screen right now. */
	asking: boolean;
}

export const useStar = create<StarStore>(() => ({ stars: null, failed: false, loading: false, asking: false }));

let requested = false;
/** Once per app run: the About page and the card share one request. */
export async function loadStars(): Promise<void> {
	if (requested || useStar.getState().loading) return;
	requested = true;
	useStar.setState({ loading: true });
	try {
		const res = await fetch(STARS_API, { headers: { Accept: "application/vnd.github+json" } });
		if (!res.ok) throw new Error(`GitHub ${res.status}`);
		const data = (await res.json()) as { stargazers_count?: number };
		useStar.setState({ stars: typeof data.stargazers_count === "number" ? data.stargazers_count : null, failed: false, loading: false });
	} catch {
		useStar.setState({ failed: true, loading: false });
	}
}

/** Count today as a day of use, and decide whether the card may show. Called when a run finishes. */
export function noteUse(): void {
	const state = read();
	if (state.asked || state.done) return;
	const today = localDate();
	const days = state.days.includes(today) ? state.days : [...state.days, today].slice(-30);
	write({ ...state, days });
	// Two different days means the app earned a second visit; one finished run means it did something.
	if (days.length >= 2 && !useStar.getState().asking) useStar.setState({ asking: true });
}

/** The user answered the card (either way): it never comes back on this machine. */
export function answerStar(starred: boolean): void {
	write({ ...read(), asked: true, done: starred });
	useStar.setState({ asking: false });
	if (starred) void loadStars();
}

/** "I already starred": stop asking, and show the real count if it can be fetched. */
export function alreadyStarred(): void {
	write({ ...read(), asked: true, done: true });
	useStar.setState({ asking: false });
	void loadStars();
}

export function starsText(n: number | null): string {
	if (n === null) return "";
	return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}
