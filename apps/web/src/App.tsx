import { useCallback, useEffect, useState } from "react";
import { AutomationsView } from "./components/AutomationsView.tsx";
import { FlowsView } from "./components/FlowsView.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { ConnectScreen } from "./components/ConnectScreen.tsx";
import { AgentSetup } from "./components/AgentSetup.tsx";
import { SetupScreen } from "./components/SetupScreen.tsx";
import { AppDialogHost } from "./components/AppDialog.tsx";
import { ConnectionBanner, type Recovery } from "./components/ConnectionBanner.tsx";
import { ContextMenuHost } from "./components/ContextMenuHost.tsx";
import { DialogHost } from "./components/DialogHost.tsx";
import { GitView } from "./components/GitView.tsx";
import { PersonalHome } from "./components/PersonalHome.tsx";
import { KnowledgeView } from "./components/KnowledgeView.tsx";
import { MemoryView } from "./components/MemoryView.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SubagentPanel } from "./components/SubagentPanel.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { WorkbenchPanel } from "./components/WorkbenchPanel.tsx";
import { RuntimeProgressCard } from "./components/RuntimesSettings.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { Modal } from "./components/ui.tsx";
import { UpdateDialog } from "./components/UpdateDialog.tsx";
import type { BackendTarget } from "./lib/client.ts";
import { PrometheusClient } from "./lib/client.ts";
import { BACK_LAYER, useBackLayer } from "./lib/back.ts";
import { clearSession, discoverBackend, establishCookie, isDesktopShell, parseSetupNeeded, type SetupComponent, saveMode, saveSession, startLocal } from "./lib/backend.ts";
import { bindClient, openSession, pluginActive, setSpace, setView, useStore } from "./lib/store.ts";
import { CONNECT_EVENT } from "./lib/platforms.ts";
import { usePrefs } from "./lib/prefs.ts";
import { checkForUpdate, startIdleUpdater } from "./lib/updater.ts";
import { dismissSplash } from "./lib/splash.ts";
import { useIsMobile } from "./lib/viewport.ts";

const closeView = () => setView("chat");

export function App() {
	const [target, setTarget] = useState<BackendTarget | null | undefined>(undefined);
	const [bootError, setBootError] = useState<string | null>(null);
	/** The local backend is waiting for components the installer leaves out (Node.js, the PI agent). */
	const [setup, setSetup] = useState<SetupComponent[] | null>(null);
	const [wantsPassword, setWantsPassword] = useState(false);
	const isMobile = useIsMobile();
	const [sidebar, setSidebar] = useState(() => window.innerWidth >= 768);
	const conn = useStore((s) => s.conn);
	const view = useStore((s) => s.view);
	const title = useStore((s) => s.title);
	const plugins = useStore((s) => s.plugins);
	const sessionId = useStore((s) => s.session?.id);
	const booted = useStore((s) => s.booted);

	// The splash covers the whole start-up (the local server can take a while to boot) and leaves only when there is a
	// real screen behind it: the chat, the connect chooser, a login, or the reconnecting state of an unreachable server.
	useEffect(() => {
		if (target === null || conn === "unauthorized" || conn === "closed" || booted) dismissSplash();
	}, [target, conn, booted]);
	// Last resort only: start_local_backend itself gives up after 90 s and then lands on the connect chooser.
	useEffect(() => {
		const timer = window.setTimeout(dismissSplash, 120_000);
		return () => window.clearTimeout(timer);
	}, []);

	// On a phone the sidebar is a drawer: picking a chat or a page should reveal it, not leave the menu on top.
	useEffect(() => {
		if (isMobile) setSidebar(false);
	}, [sessionId, view]);
	useEffect(() => {
		setSidebar(!isMobile);
	}, [isMobile]);

	// The back gesture closes the drawer and the open view before it hands the app to the background (lib/back.ts).
	useBackLayer(BACK_LAYER.view, view !== "chat", closeView);
	useBackLayer(BACK_LAYER.drawer, isMobile && sidebar, () => setSidebar(false));

	// A view whose plugin was just switched off would render against RPCs that no longer exist.
	useEffect(() => {
		if (!plugins.length) return;
		if (
			(view === "automations" && !pluginActive(plugins, "automations")) ||
			(view === "flows" && !pluginActive(plugins, "flows")) ||
			(view === "git" && !pluginActive(plugins, "git"))
		)
			setView("chat");
	}, [view, plugins]);

	// Ctrl/Cmd+1 personal space, Ctrl/Cmd+2 work space.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
			if (e.key !== "1" && e.key !== "2") return;
			if (!useStore.getState().assistant) return;
			e.preventDefault();
			void setSpace(e.key === "1" ? "personal" : "work");
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const boot = useCallback((afterInstall = false) => {
		discoverBackend().then(
			(next) => {
				setBootError(null);
				setSetup(null);
				setTarget(next);
			},
			(err: unknown) => {
				// Nothing broke: the installer just does not carry Node.js / the PI agent. Keep local mode and offer the install.
				// Still missing right after an install means it did not take; say so rather than offering the same button forever.
				const needed = parseSetupNeeded(err);
				if (needed && !afterInstall) {
					setSetup(needed.missing);
					setTarget(null);
					return;
				}
				setSetup(null);
				// Saved local mode failed to start: drop back to the chooser with the reason.
				saveMode(null);
				setBootError(err instanceof Error ? err.message : String(err));
				setTarget(null);
			},
		);
	}, []);
	useEffect(() => boot(), [boot]);

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

	// A local backend that died (crash, killed, out of memory) never comes back by reconnecting: the port is gone and the token was
	// one-time. After a few seconds without an answer, check it and start a fresh one instead of retrying forever.
	const [recovery, setRecovery] = useState<Recovery>({ state: "idle" });
	useEffect(() => {
		if (!target || target.label !== "local" || conn !== "closed") {
			if (conn === "open") setRecovery({ state: "idle" });
			return;
		}
		let dead = false;
		const timer = window.setTimeout(async () => {
			const alive = await fetch(`${target.httpBase}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
			if (dead || alive) return;
			setRecovery({ state: "restarting" });
			try {
				const { invoke } = await import("@tauri-apps/api/core");
				await invoke("stop_local_backend");
				const next = await startLocal();
				if (!dead) setTarget(next);
			} catch (err) {
				if (!dead) setRecovery({ state: "failed", error: err instanceof Error ? err.message : String(err) });
			}
		}, 5000);
		return () => {
			dead = true;
			window.clearTimeout(timer);
		};
	}, [target, conn, recovery.state === "failed"]);

	// No agent runtime works yet (the installer carries none): offer to install one, PI preselected. Any usable one ends it.
	const [agentSkipped, setAgentSkipped] = useState(false);
	const runtimes = useStore((s) => s.runtimes);
	const needAgent = conn === "open" && booted && !agentSkipped && runtimes.length > 0 && !runtimes.some((r) => r.health.available);
	const restartBackend = useCallback(async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("stop_local_backend");
		setTarget(await startLocal());
	}, []);

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
		return startIdleUpdater();
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
	if (target === null && setup) {
		return (
			<Shell>
				<SetupScreen
					missing={setup}
					onReady={() => boot(true)}
					onRemote={() => {
						saveMode(null);
						setSetup(null);
					}}
				/>
				<UpdateDialog />
			</Shell>
		);
	}
	if (target === null || conn === "unauthorized") {
		return (
			<Shell>
				<ConnectScreen unauthorized={conn === "unauthorized"} onSetup={setSetup} wantsPassword={wantsPassword} error={bootError} onConnect={setTarget} />
				<UpdateDialog />
			</Shell>
		);
	}

	if (needAgent) {
		return (
			<Shell>
				<AgentSetup local={target.label === "local" && isDesktopShell()} onRestartBackend={restartBackend} onSkip={() => setAgentSkipped(true)} />
			</Shell>
		);
	}

	return (
		<div className="forge-bg flex h-full flex-col">
			<TitleBar onToggleSidebar={() => setSidebar((v) => !v)} />
			<ConnectionBanner recovery={recovery} />
			<div className="relative flex min-h-0 flex-1">
				{sidebar && isMobile && <div className="absolute inset-0 z-30 animate-fade bg-ink-950/60 backdrop-blur-[2px]" onClick={() => setSidebar(false)} aria-hidden />}
				{sidebar && (
					<div className={isMobile ? "absolute inset-y-0 left-0 z-40 flex w-[min(20rem,88%)] animate-slide-in shadow-2xl shadow-black/60" : "flex animate-slide-in"}>
						<Sidebar target={target} onDisconnect={() => setTarget(null)} />
					</div>
				)}
				<main className="relative flex min-w-0 flex-1 flex-col">
					{view === "home" ? <PersonalHome /> : <ChatView />}
					{view !== "chat" && view !== "home" && (
						<Modal key={typeof view === "object" ? view.panel : view} onClose={closeView} floatingClose={typeof view === "object"}>
							{view === "knowledge" && <KnowledgeView />}
							{view === "memory" && <MemoryView />}
							{view === "automations" && <AutomationsView />}
							{view === "flows" && <FlowsView />}
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
			<RuntimeProgressCard />
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
	const client = useStore((s) => s.client);
	// The desktop shell's origin differs from the server's, so the login cookie never reaches this
	// iframe. A short-lived pass fetched over the authenticated connection stands in for it; a server
	// that does not know `panel.link` yields null and the cookie path is used as before.
	const [pass, setPass] = useState<string | null | undefined>(undefined);
	useEffect(() => {
		let live = true;
		setPass(undefined);
		if (!client) {
			setPass(null);
			return;
		}
		client
			.rpc("panel.link", {})
			.then((r) => live && setPass(r.id))
			.catch(() => live && setPass(null));
		return () => {
			live = false;
		};
	}, [client, url, theme, skin]);
	if (pass === undefined) return <div className="h-full w-full bg-ink-900" />;
	const sep = url.includes("?") ? "&" : "?";
	return (
		<iframe
			title="plugin panel"
			src={`${target.httpBase}${url}${sep}theme=${theme}&skin=${skin}${pass ? `&pt=${encodeURIComponent(pass)}` : ""}`}
			sandbox="allow-scripts allow-forms"
			className="h-full w-full border-0 bg-ink-900"
		/>
	);
}
