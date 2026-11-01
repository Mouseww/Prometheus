import type { BrowserMode } from "./types.ts";

export interface BrowserSettings {
	/** Empty: find one automatically. */
	executablePath: string;
	mode: BrowserMode;
	/** `%s` is replaced by the query. */
	searchUrl: string;
	/** http://host:port or socks5://host:port; empty for direct. */
	proxy: string;
	/** Close the browser after this many idle minutes with nobody watching; 0 keeps it running. */
	idleMinutes: number;
	/** JPEG quality of the streamed view. */
	quality: number;
	maxFps: number;
	restoreTabs: boolean;
	/** Empty: the plugin's data folder. */
	downloadDir: string;
	/** Accept-Language and the browser UI language. */
	lang: string;
	/** Let the agent run JavaScript in pages (browser_eval). */
	allowEval: boolean;
	/** On a phone-sized screen show pages as a phone would. */
	mobile: boolean;
}

function defaultLang(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
	} catch {
		return "en-US";
	}
}

export const DEFAULT_SETTINGS: BrowserSettings = {
	executablePath: "",
	mode: "headless",
	searchUrl: "https://www.bing.com/search?q=%s",
	proxy: "",
	idleMinutes: 15,
	quality: 70,
	maxFps: 30,
	restoreTabs: true,
	downloadDir: "",
	lang: defaultLang(),
	allowEval: true,
	mobile: true,
};

const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

/** Keeps known keys with sane values; anything else from a client or config is dropped. */
export function sanitizeSettings(raw: unknown): Partial<BrowserSettings> {
	const r = (raw ?? {}) as Record<string, unknown>;
	const proxy = str(r.proxy);
	const searchUrl = str(r.searchUrl);
	const lang = str(r.lang, 35);
	const out: Partial<BrowserSettings> = {
		executablePath: str(r.executablePath),
		mode: r.mode === "headless" || r.mode === "window" ? r.mode : undefined,
		searchUrl: searchUrl === undefined ? undefined : /^https?:\/\//i.test(searchUrl) ? searchUrl : undefined,
		proxy: proxy === undefined ? undefined : proxy === "" || /^(https?|socks[45]?):\/\/[^\s]+$/i.test(proxy) ? proxy : undefined,
		idleMinutes: num(r.idleMinutes, 0, 24 * 60),
		quality: num(r.quality, 20, 95),
		maxFps: num(r.maxFps, 5, 60),
		restoreTabs: bool(r.restoreTabs),
		downloadDir: str(r.downloadDir),
		lang: lang === undefined ? undefined : /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang) ? lang : undefined,
		allowEval: bool(r.allowEval),
		mobile: bool(r.mobile),
	};
	for (const k of Object.keys(out) as (keyof BrowserSettings)[]) if (out[k] === undefined) delete out[k];
	return out;
}
