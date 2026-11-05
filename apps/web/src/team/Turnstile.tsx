// Cloudflare Turnstile widget (explicit render). The script is only fetched when the Hub requires the check.
import { useEffect, useRef, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { Notice } from "./kit.tsx";

export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
	render(el: HTMLElement, options: Record<string, unknown>): string;
	remove(widgetId: string): void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

let loading: Promise<TurnstileApi> | undefined;

/** Injects the script once; a failure is not cached so a later mount can retry. */
function loadTurnstile(): Promise<TurnstileApi> {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	loading ??= new Promise<TurnstileApi>((resolve, reject) => {
		const s = document.createElement("script");
		s.src = TURNSTILE_SCRIPT_URL;
		s.async = true;
		s.defer = true;
		s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
		s.onerror = () => reject(new Error("turnstile load failed"));
		document.head.appendChild(s);
	}).catch((err: unknown) => {
		loading = undefined;
		throw err;
	});
	return loading;
}

const M = defineMessages({
	zh: { failed: "无法加载人机验证，请检查网络后刷新页面", label: "人机验证" },
	en: { failed: "The human check could not be loaded. Check your network and reload the page.", label: "Human check" },
});

interface TurnstileProps {
	siteKey: string;
	/** Called with the token, or with undefined when it expires or errors. */
	onToken: (token: string | undefined) => void;
}

/** Remount it (change its `key`) to get a fresh challenge; tokens are single use. */
export function Turnstile({ siteKey, onToken }: TurnstileProps) {
	const t = useT(M);
	const host = useRef<HTMLDivElement>(null);
	const cb = useRef(onToken);
	cb.current = onToken;
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let widgetId: string | undefined;
		let live = true;
		loadTurnstile().then(
			(api) => {
				if (!live || !host.current) return;
				widgetId = api.render(host.current, {
					sitekey: siteKey,
					theme: "dark",
					callback: (token: string) => cb.current(token),
					"expired-callback": () => cb.current(undefined),
					"error-callback": () => cb.current(undefined),
				});
			},
			() => live && setFailed(true),
		);
		return () => {
			live = false;
			cb.current(undefined);
			if (widgetId !== undefined) window.turnstile?.remove(widgetId);
		};
	}, [siteKey]);

	return (
		<div>
			<div ref={host} role="group" aria-label={t("label")} />
			{failed && <Notice kind="error">{t("failed")}</Notice>}
		</div>
	);
}
