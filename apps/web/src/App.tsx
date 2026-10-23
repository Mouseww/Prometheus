import { useEffect, useState } from "react";
import { AutomationsView } from "./components/AutomationsView.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { ConnectScreen } from "./components/ConnectScreen.tsx";
import { AppDialogHost } from "./components/AppDialog.tsx";
import { ContextMenuHost } from "./components/ContextMenuHost.tsx";
import { DialogHost } from "./components/DialogHost.tsx";
import { GitView } from "./components/GitView.tsx";
import { KnowledgeView } from "./components/KnowledgeView.tsx";
import { MemoryView } from "./components/MemoryView.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SubagentPanel } from "./components/SubagentPanel.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { WorkbenchPanel } from "./components/WorkbenchPanel.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { Modal } from "./components/ui.tsx";
import { UpdateDialog } from "./components/UpdateDialog.tsx";
import type { BackendTarget } from "./lib/client.ts";
import { PrometheusClient } from "./lib/client.ts";
import { clearSession, discoverBackend, establishCookie, isDesktopShell, saveMode, saveSession } from "./lib/backend.ts";
import { bindClient, openSession, pluginActive, setView, useStore } from "./lib/store.ts";
import { CONNECT_EVENT } from "./lib/platforms.ts";
import { usePrefs } from "./lib/prefs.ts";
import { checkForUpdate } from "./lib/updater.ts";
import { useIsMobile } from "./lib/viewport.ts";

const closeView = () => setView("chat");

export function App() {
	const [target, setTarget] = useState<BackendTarget | null | undefined>(undefined);
	const [bootError, setBootError] = useState<string | null>(null);
	const [wantsPassword, setWantsPassword] = useState(false);
	const isMobile = useIsMobile();
	const [sidebar, setSidebar] = useState(() => window.innerWidth >= 768);
	const conn = useStore((s) => s.conn);
	const view = useStore((s) => s.view);
	const title = useStore((s) => s.title);
	const plugins = useStore((s) => s.plugins);
	const sessionId = useStore((s) => s.session?.id);

	// On a phone the sidebar is a drawer: picking a chat or a page should reveal it, not leave the menu on top.
	useEffect(() => {
		if (isMobile) setSidebar(false);
	}, [sessionId, view]);
	useEffect(() => {
		setSidebar(!isMobile);
	}, [isMobile]);

	// A view whose plugin was just switched off would render against RPCs that no longer exist.
	useEffect(() => {
		if (!plugins.length) return;
		if (
			(view === "automations" && !pluginActive(plugins, "automations")) ||
			(view === "git" && !pluginActive(plugins, "git"))
		)
			setView("chat");
	}, [view, plugins]);

	useEffect(() => {
		discoverBackend().then(setTarget, (err: unknown) => {
			// Saved local mode failed to start: drop back to the chooser with the reason.
			saveMode(null);
			setBootError(err instanceof Error ? err.message : String(err));
			setTarget(null);
		});
	}, []);

	useEffect(() => {
		if (!target) return;
		const client = new PrometheusClient(target);
		client.onSession = (token) => saveSession(target, token);
		client.onState((s) => {
			if (s === "unauthorized") setWantsPassword(client.loginKind === "password");
			// A saved session the server no longer accepts (password changed, access revoked) must not be retried forever.
			if (s === "unauthorized" && client.loginKind === "password") clearSession(target);
		});
		const unbind = bindClient(client);
		void establishCookie(target);
		client.connect();
		return () => {
			unbind();
			client.close();
			useStore.setState({ client: null, session: null, conn: "idle", booted: false });
		};
	}, [target]);

	// The platform switcher announces a new server; replacing the target tears down the old connection.
	useEffect(() => {
		const onConnect = (e: Event) => {
			setBootError(null);
			setWantsPassword(false);
			setTarget((e as CustomEvent<BackendTarget>).detail);
			setView("chat");
		};
		window.addEventListener(CONNECT_EVENT, onConnect);
		return () => window.removeEventListener(CONNECT_EVENT, onConnect);
	}, []);

	useEffect(() => {
		void checkForUpdate(true);
	}, []);

	const closeToTray = usePrefs((p) => p.closeToTray);
	useEffect(() => {
		if (!isDesktopShell()) return;
		void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_close_to_tray", { enabled: closeToTray })).catch(() => undefined);
	}, [closeToTray]);

	// The tray panel asks the main window to jump to a running session.
	useEffect(() => {
		if (!isDesktopShell()) return;
		let off: (() => void) | undefined;
		let dead = false;
		void import("@tauri-apps/api/event").then(async ({ listen }) => {
			const un = await listen<string>("open-session", (e) => void openSession(e.payload));
			if (dead) un();
			else off = un;
		});
		return () => {
			dead = true;
			off?.();
		};
	}, []);

	useEffect(() => {
		document.title = title ? `${title} · Prometheus` : "Prometheus";
	}, [title]);

	if (target === undefined) return <div className="forge-bg h-full" />;
	if (target === null || conn === "unauthorized") {
		return (
			<Shell>
				<ConnectScreen unauthorized={conn === "unauthorized"} wantsPassword={wantsPassword} error={bootError} onConnect={setTarget} />
				<UpdateDialog />
			</Shell>
		);
	}

	return (
		<div className="forge-bg flex h-full flex-col">
			<TitleBar onToggleSidebar={() => setSidebar((v) => !v)} />
			<div className="relative flex min-h-0 flex-1">
				{sidebar && isMobile && <div className="absolute inset-0 z-30 bg-ink-950/60 backdrop-blur-[2px]" onClick={() => setSidebar(false)} aria-hidden />}
				{sidebar && (
					<div className={isMobile ? "absolute inset-y-0 left-0 z-40 flex w-[min(20rem,88%)] shadow-2xl shadow-black/60" : "flex"}>
						<Sidebar target={target} onDisconnect={() => setTarget(null)} />
					</div>
				)}
				<main className="relative flex min-w-0 flex-1 flex-col">
					<ChatView />
					{view !== "chat" && (
						<Modal key={typeof view === "object" ? view.panel : view} onClose={closeView} floatingClose={typeof view === "object"}>
							{view === "knowledge" && <KnowledgeView />}
							{view === "memory" && <MemoryView />}
							{view === "automations" && <AutomationsView />}
							{view === "git" && <GitView />}
							{view === "settings" && <SettingsView />}
							{typeof view === "object" && <PanelFrame target={target} url={view.panel} />}
						</Modal>
					)}
				</main>
				<WorkbenchPanel />
				<SubagentPanel />
			</div>
			<DialogHost />
			<AppDialogHost />
			<ContextMenuHost />
			<UpdateDialog remote={target.label !== "local"} />
			<Toasts />
		</div>
	);
}

/** Frameless desktop windows still need a drag strip and window buttons before connecting. */
function Shell({ children }: { children: React.ReactNode }) {
	if (!isDesktopShell()) return <>{children}</>;
	return (
		<div className="forge-bg flex h-full flex-col">
			<TitleBar bare />
			<div className="min-h-0 flex-1">{children}</div>
		</div>
	);
}

/**
 * Tracks the resolved theme of the app shell. `apply()` in lib/prefs.ts already resolves "system"
 * onto `<html data-theme>`, so watching that attribute keeps the panel in step with the shell
 * without duplicating the media-query logic.
 */
function useResolvedTheme(): { theme: string; skin: string } {
	const theme = usePrefs((p) => p.theme);
	const skin = usePrefs((p) => p.skin);
	const [resolved, setResolved] = useState<{ theme: string; skin: string }>({ theme: "dark", skin });
	useEffect(() => {
		const read = () => {
			const root = document.documentElement;
			setResolved({ theme: root.dataset.theme === "light" ? "light" : "dark", skin: root.dataset.skin ?? "ember" });
		};
		read();
		const observer = new MutationObserver(read);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin"] });
		return () => observer.disconnect();
	}, [theme, skin]);
	return resolved;
}

/**
 * A plugin panel is an iframe sandboxed without `allow-same-origin`, so it cannot read the app's
 * stylesheet or storage. The active theme and skin therefore travel in the URL; a change of either
 * changes the `src`, which reloads the frame so the panel re-skins immediately.
 */
function PanelFrame({ target, url }: { target: BackendTarget; url: string }) {
	const { theme, skin } = useResolvedTheme();
	const sep = url.includes("?") ? "&" : "?";
	return (
		<iframe
			title="plugin panel"
			src={`${target.httpBase}${url}${sep}theme=${theme}&skin=${skin}`}
			sandbox="allow-scripts allow-forms"
			className="h-full w-full border-0 bg-ink-900"
		/>
	);
}
