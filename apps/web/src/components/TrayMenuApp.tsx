import clsx from "clsx";
import { AppWindow, EyeOff, LayoutPanelTop, Power, type LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";

const M = defineMessages({
	zh: { show: "显示主窗口", hide: "隐藏主窗口", panel: "工作面板", quit: "退出 Prometheus" },
	en: { show: "Show main window", hide: "Hide main window", panel: "Work panel", quit: "Quit Prometheus" },
});

async function invoke(cmd: string, args?: Record<string, unknown>): Promise<void> {
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke(cmd, args);
}

interface Item {
	id: "show" | "hide" | "panel" | "quit";
	icon: LucideIcon;
	danger?: boolean;
}

const ITEMS: Item[] = [
	{ id: "show", icon: AppWindow },
	{ id: "hide", icon: EyeOff },
	{ id: "panel", icon: LayoutPanelTop },
	{ id: "quit", icon: Power, danger: true },
];

/**
 * The tray icon's right-click menu. It lives in its own borderless window (the native menu ignored the app's
 * look), which the desktop shell hides as soon as it loses focus. Styled like the in-app context menu.
 */
export function TrayMenuApp() {
	const t = useT(M);

	useEffect(() => {
		// The window is hidden rather than closed, so the page outlives every opening of the menu.
		const key = (e: KeyboardEvent) => e.key === "Escape" && void invoke("tray_menu_close");
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, []);

	return (
		<div className="h-full p-2" onContextMenu={(e) => e.preventDefault()}>
			<div role="menu" className="animate-rise rounded-xl border border-ink-700 bg-ink-900 p-1 text-sm shadow-2xl shadow-black/50">
				{ITEMS.map((it) => (
					<div key={it.id}>
						{it.id === "quit" && <div className="my-1 h-px bg-ink-700/70" />}
						<button
							type="button"
							role="menuitem"
							onClick={() => void invoke("tray_menu_action", { id: it.id })}
							className={clsx(
								"flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left transition-colors",
								it.danger ? "text-rose-400 hover:bg-rose-400/10" : "text-ink-200 hover:bg-ink-800",
							)}
						>
							<it.icon className={clsx("size-4 shrink-0", it.danger ? "text-rose-400" : "text-ink-400")} />
							{t(it.id)}
						</button>
					</div>
				))}
			</div>
		</div>
	);
}
