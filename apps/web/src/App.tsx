import { useEffect, useState } from "react";
import { ChatView } from "./components/ChatView.tsx";
import { ConnectScreen } from "./components/ConnectScreen.tsx";
import { DialogHost } from "./components/DialogHost.tsx";
import { KnowledgeView } from "./components/KnowledgeView.tsx";
import { MemoryView } from "./components/MemoryView.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { UpdateDialog } from "./components/UpdateDialog.tsx";
import type { BackendTarget } from "./lib/client.ts";
import { PrometheusClient } from "./lib/client.ts";
import { discoverBackend, establishCookie, isTauri, saveMode } from "./lib/backend.ts";
import { bindClient, useStore } from "./lib/store.ts";
import { checkForUpdate } from "./lib/updater.ts";

export function App() {
	const [target, setTarget] = useState<BackendTarget | null | undefined>(undefined);
	const [bootError, setBootError] = useState<string | null>(null);
	const [sidebar, setSidebar] = useState(() => window.innerWidth >= 768);
	const conn = useStore((s) => s.conn);
	const view = useStore((s) => s.view);
	const title = useStore((s) => s.title);

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
		const unbind = bindClient(client);
		void establishCookie(target);
		client.connect();
		return () => {
			unbind();
			client.close();
			useStore.setState({ client: null, session: null, conn: "idle" });
		};
	}, [target]);

	useEffect(() => {
		void checkForUpdate(true);
	}, []);

	useEffect(() => {
		document.title = title ? `${title} · Prometheus` : "Prometheus";
	}, [title]);

	if (target === undefined) return <div className="forge-bg h-full" />;
	if (target === null || conn === "unauthorized") {
		return (
			<Shell>
				<ConnectScreen unauthorized={conn === "unauthorized"} error={bootError} onConnect={setTarget} />
			</Shell>
		);
	}

	return (
		<div className="forge-bg flex h-full flex-col">
			<TitleBar onToggleSidebar={() => setSidebar((v) => !v)} />
			<div className="flex min-h-0 flex-1">
				{sidebar && <Sidebar target={target} onDisconnect={() => setTarget(null)} />}
				<main className="relative flex min-w-0 flex-1 flex-col">
					{view === "chat" && <ChatView />}
					{view === "knowledge" && <KnowledgeView />}
					{view === "memory" && <MemoryView />}
					{view === "settings" && <SettingsView />}
					{typeof view === "object" && <PanelFrame target={target} url={view.panel} />}
				</main>
			</div>
			<DialogHost />
			<UpdateDialog />
			<Toasts />
		</div>
	);
}

/** Frameless desktop windows still need a drag strip and window buttons before connecting. */
function Shell({ children }: { children: React.ReactNode }) {
	if (!isTauri()) return <>{children}</>;
	return (
		<div className="forge-bg flex h-full flex-col">
			<TitleBar bare />
			<div className="min-h-0 flex-1">{children}</div>
		</div>
	);
}

function PanelFrame({ target, url }: { target: BackendTarget; url: string }) {
	return <iframe title="plugin panel" src={`${target.httpBase}${url}`} sandbox="allow-scripts allow-forms" className="h-full w-full border-0 bg-ink-900" />;
}
