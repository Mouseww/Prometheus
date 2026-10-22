import { isAndroid, isTauri } from "./backend.ts";

/** Opens a link outside Prometheus (system default browser) so the app itself never navigates away. */
export async function openExternal(url: string): Promise<void> {
	let u: URL;
	try {
		u = new URL(url, location.href);
	} catch {
		return;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "mailto:") return;
	if (isTauri()) {
		const { invoke } = await import("@tauri-apps/api/core");
		try {
			await invoke(isAndroid() ? "plugin:opener|open_url" : "open_external", { url: u.href });
			return;
		} catch {
			// fall through to the browser path
		}
	}
	window.open(u.href, "_blank", "noopener,noreferrer");
}

/** Capture-phase guards, installed once: external links open in the default browser; the context menu is app-owned. */
export function installGlobalGuards(): void {
	document.addEventListener(
		"click",
		(e) => {
			if (e.defaultPrevented || e.button !== 0) return;
			const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
			if (!a) return;
			const href = a.getAttribute("href") ?? "";
			if (href.startsWith("#")) return;
			e.preventDefault();
			void openExternal(a.href);
		},
		true,
	);
	document.addEventListener("auxclick", (e) => {
		if (e.button === 1 && (e.target as Element | null)?.closest?.("a[href]")) e.preventDefault();
	});
	// Components with their own menu call preventDefault themselves; everything else gets no browser menu.
	// Text fields keep a way to cut/copy/paste through the keyboard, and the menu stays available in dev builds.
	document.addEventListener("contextmenu", (e) => {
		if (import.meta.env.DEV && e.shiftKey) return;
		e.preventDefault();
	});
}
