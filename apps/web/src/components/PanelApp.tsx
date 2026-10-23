import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { SessionSummary } from "@prometheus/protocol";
import { discoverBackend } from "../lib/backend.ts";
import { PrometheusClient } from "../lib/client.ts";
import { localizeError } from "../lib/errors.ts";
import { defineMessages, relativeTime, useT } from "../lib/i18n.ts";
import { usePrefs } from "../lib/prefs.ts";
import { Flame } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "正在运行",
		empty: "没有正在运行的会话",
		connecting: "正在连接…",
		failed: "无法连接本地服务",
		untitled: "新会话",
		open: "显示主窗口",
	},
	en: {
		title: "Running now",
		empty: "No sessions are running",
		connecting: "Connecting…",
		failed: "Cannot reach the local server",
		untitled: "New chat",
		open: "Show main window",
	},
});

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

async function invoke(cmd: string, args?: Record<string, unknown>): Promise<void> {
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke(cmd, args);
}

/** Compact tray window: lists the sessions currently running; clicking one opens it in the main window. */
export function PanelApp() {
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let client: PrometheusClient | undefined;
		let dead = false;
		const refresh = () => {
			void client
				?.rpc("session.list", {})
				.then((list) => !dead && setSessions(list.filter((s) => s.running)))
				.catch(() => undefined);
		};
		let connecting = false;
		const connect = () => {
			if (client || connecting) return;
			connecting = true;
			discoverBackend()
				.then((target) => {
					if (dead) return;
					setFailed(!target);
					if (!target) return;
					client = new PrometheusClient(target);
					client.onFrame((f) => f.type === "sessions.changed" && refresh());
					client.onState((s) => s === "open" && refresh());
					client.connect();
				})
				.catch(() => !dead && setFailed(true))
				.finally(() => {
					connecting = false;
				});
		};
		connect();
		// The window is hidden rather than closed; retry a failed connection and refresh whenever it is shown again.
		const onFocus = () => (client ? refresh() : connect());
		window.addEventListener("focus", onFocus);
		return () => {
			dead = true;
			window.removeEventListener("focus", onFocus);
			client?.close();
		};
	}, []);

	return (
		<div className="forge-bg flex h-full flex-col overflow-hidden rounded-xl border border-ink-700">
			<header className="flex items-center gap-2 border-b hairline px-4 py-3">
				<Flame className="size-5" />
				<span className="font-display text-sm font-semibold tracking-tight">Prometheus</span>
				<span className="ml-auto font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">{t("title")}</span>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				{failed ? (
					<p className="px-3 py-8 text-center text-sm text-ink-500">{t("failed")}</p>
				) : sessions === null ? (
					<p className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-ink-500">
						<LoaderCircle className="size-4 animate-spin" /> {t("connecting")}
					</p>
				) : sessions.length === 0 ? (
					<p className="px-3 py-8 text-center text-sm text-ink-500">{t("empty")}</p>
				) : (
					sessions.map((s) => (
						<button
							key={s.id}
							type="button"
							onClick={() => void invoke("open_session_in_main", { id: s.id })}
							className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-ink-850"
						>
							<span className="size-2 shrink-0 animate-breathe rounded-full bg-moss-400" />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[13px] text-ink-100">{s.name || localizeError(s.firstMessage ?? "") || t("untitled")}</span>
								<span className="block truncate text-[10.5px] text-ink-500">
									{baseName(s.cwd)} · {relativeTime(s.modified, lang)}
								</span>
							</span>
						</button>
					))
				)}
			</div>
			<footer className="border-t hairline p-2">
				<button type="button" onClick={() => void invoke("show_main_window")} className="w-full rounded-lg py-1.5 text-xs text-ink-300 hover:bg-ink-850 hover:text-ink-100">
					{t("open")}
				</button>
			</footer>
		</div>
	);
}
