import { create } from "zustand";

export type ThemeMode = "dark" | "light" | "system";
export type Skin = "ember" | "ocean" | "forest" | "violet" | "rose";
export type Lang = "zh" | "en";
/** What the send button does while the agent is replying: wait for the turn to end, or cut in after the current tool call. */
export type SendMode = "followUp" | "steer";

export const SKINS: { id: Skin; swatch: string }[] = [
	{ id: "ember", swatch: "#ff5a1f" },
	{ id: "ocean", swatch: "#2f8cff" },
	{ id: "forest", swatch: "#2fb36b" },
	{ id: "violet", swatch: "#8b5cf6" },
	{ id: "rose", swatch: "#f43f6e" },
];

interface Prefs {
	theme: ThemeMode;
	skin: Skin;
	lang: Lang;
	/** Desktop: closing the window hides it to the tray instead of quitting. */
	closeToTray: boolean;
	sendMode: SendMode;
	/** System notification when an agent turn finishes. */
	notifyOnDone: boolean;
	/** Only notify while the window is hidden or not focused. */
	notifyBackgroundOnly: boolean;
	/** Chat column width in px; null follows the window size. */
	chatWidth: number | null;
	/** Decorative motion (transitions, flame caret, theme ripple). Off also skips the splash animation. */
	motion: boolean;
	/** The "ignition" splash shown while the app starts. */
	splash: boolean;
	/** Enter sends the message (Shift+Enter breaks the line); off means Enter only breaks the line. */
	enterToSend: boolean;
	/** Desktop: download and install updates by itself while no agent is running. */
	idleUpdate: boolean;
	/** Display names the user gave models, keyed by `provider/id`. Only changes what is shown. */
	modelAliases: Record<string, string>;
}

export const aliasKey = (provider: string, id: string) => `${provider}/${id}`;

const KEY = "prometheus.prefs";
// Touch keyboards have no comfortable Enter-to-send: there, Enter breaks the line unless the user opts in.
const touchFirst = window.matchMedia("(pointer: coarse)").matches;

function load(): Prefs {
	const fallback: Prefs = {
		theme: "dark",
		skin: "ember",
		lang: navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en",
		closeToTray: true,
		sendMode: "followUp",
		chatWidth: null,
		notifyOnDone: false,
		notifyBackgroundOnly: true,
		motion: true,
		splash: true,
		enterToSend: !touchFirst,
		idleUpdate: true,
		modelAliases: {},
	};
	try {
		return { ...fallback, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
	} catch {
		return fallback;
	}
}

export const usePrefs = create<Prefs>(load);

import { onMediaChange } from "./media.ts";
import { syncNativeTheme } from "./native.ts";
const media = window.matchMedia("(prefers-color-scheme: light)");

function apply(p: Prefs): void {
	const root = document.documentElement;
	const light = p.theme === "light" || (p.theme === "system" && media.matches);
	root.dataset.theme = light ? "light" : "dark";
	root.dataset.skin = p.skin;
	root.dataset.motion = p.motion ? "on" : "off";
	root.lang = p.lang === "zh" ? ["zh", "CN"].join("-") : "en";
	root.style.colorScheme = light ? "light" : "dark";
	// Android: the status bar icons follow the app theme, not the phone's (the two can differ).
	syncNativeTheme(!light);
	// Keep the Android status bar in step with the resolved theme (a fixed dark value made light mode unreadable).
	let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (!meta) {
		meta = document.createElement("meta");
		meta.name = "theme-color";
		document.head.appendChild(meta);
	}
	meta.content = light ? "#faf8f5" : "#1c1814";
}

apply(usePrefs.getState());
usePrefs.subscribe((p) => {
	apply(p);
	localStorage.setItem(KEY, JSON.stringify(p));
});
onMediaChange(media, () => apply(usePrefs.getState()));

export function setPrefs(p: Partial<Prefs>): void {
	usePrefs.setState(p);
}
