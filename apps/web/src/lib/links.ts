import { isAndroid, isLoopbackHost, isTauri } from "./backend.ts";
import { toast, useStore } from "./store.ts";
import { defineMessages, tr } from "./i18n.ts";
import { showContextMenu } from "./contextMenu.ts";

const M = defineMessages({
	zh: { openLink: "在默认浏览器中打开", copyLink: "复制链接", failed: "无法打开链接，已复制到剪贴板：{u}" },
	en: { openLink: "Open in default browser", copyLink: "Copy link", failed: "Could not open the link, copied to clipboard: {u}" },
});

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
		// Two native routes (own command, then the opener plugin), then a local server, each tried only if the one before failed.
		for (const cmd of isAndroid() ? ["plugin:opener|open_url"] : ["open_external", "plugin:opener|open_url"]) {
			try {
				await invoke(cmd, { url: u.href });
				return;
			} catch {
				// try the next route
			}
		}
		const client = useStore.getState().client;
		if (client && isLoopbackHost(client.target.httpBase)) {
			try {
				await client.rpc("system.open", { url: u.href });
				return;
			} catch {
				// fall through
			}
		}
		// A webview cannot open a browser window itself; say so instead of failing silently.
		void navigator.clipboard?.writeText(u.href).catch(() => undefined);
		toast(tr(M, "failed", { u: u.href }), "error");
		return;
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
	document.addEventListener("contextmenu", (e) => {
		const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
		if (!a || e.defaultPrevented || a.getAttribute("href")?.startsWith("#")) return;
		e.preventDefault();
		showContextMenu(e.clientX, e.clientY, [
			{ label: tr(M, "openLink"), run: () => void openExternal(a.href) },
			{ label: tr(M, "copyLink"), run: () => void navigator.clipboard?.writeText(a.href) },
		]);
	});
	// Components with their own menu call preventDefault themselves; everything else gets no browser menu.
	// Text fields keep a way to cut/copy/paste through the keyboard, and the menu stays available in dev builds.
	document.addEventListener("contextmenu", (e) => {
		if (import.meta.env.DEV && e.shiftKey) return;
		e.preventDefault();
	});
}
