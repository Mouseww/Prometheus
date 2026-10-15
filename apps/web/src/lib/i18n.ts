import { useCallback } from "react";
import { type Lang, usePrefs } from "./prefs.ts";

export type Dict<K extends string> = { zh: Record<K, string>; en: Record<K, string> };

/** Co-locate messages with the component: `const M = defineMessages({ zh: {...}, en: {...} })`. */
export function defineMessages<K extends string>(dict: Dict<K>): Dict<K> {
	return dict;
}

function format(template: string, vars?: Record<string, string | number>): string {
	if (!vars) return template;
	return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function translate<K extends string>(dict: Dict<K>, lang: Lang, key: K, vars?: Record<string, string | number>): string {
	return format(dict[lang][key] ?? dict.zh[key] ?? key, vars);
}

export function useT<K extends string>(dict: Dict<K>) {
	const lang = usePrefs((s) => s.lang);
	return useCallback((key: K, vars?: Record<string, string | number>) => translate(dict, lang, key, vars), [dict, lang]);
}

/** For non-React code (store actions, toasts). */
export function tr<K extends string>(dict: Dict<K>, key: K, vars?: Record<string, string | number>): string {
	return translate(dict, usePrefs.getState().lang, key, vars);
}

export function relativeTime(iso: string, lang: Lang): string {
	const diff = (Date.now() - new Date(iso).getTime()) / 1000;
	const rtf = new Intl.RelativeTimeFormat(lang === "zh" ? "zh" : "en", { numeric: "auto" });
	if (diff < 60) return rtf.format(0, "second");
	if (diff < 3600) return rtf.format(-Math.floor(diff / 60), "minute");
	if (diff < 86400) return rtf.format(-Math.floor(diff / 3600), "hour");
	if (diff < 86400 * 30) return rtf.format(-Math.floor(diff / 86400), "day");
	return new Date(iso).toLocaleDateString(lang === "zh" ? "zh" : "en");
}
