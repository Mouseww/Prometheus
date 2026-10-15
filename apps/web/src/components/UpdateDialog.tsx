import { defineMessages, useT } from "../lib/i18n.ts";
import { dismissUpdate, installUpdate, useUpdater } from "../lib/updater.ts";
import { Button } from "./ui.tsx";

const M = defineMessages({
	zh: {
		heading: "发现新版本",
		title: "Prometheus {v} 可用",
		hint: "更新会重启应用，并同时更新、重启本机服务端；进行中的任务将被中断。",
		remoteHint: "仅更新本客户端并重启应用；当前连接的远程服务器不会被更新，需由其管理员自行升级。",
		later: "稍后",
		install: "立即更新",
		installing: "正在更新…",
		failed: "更新失败：",
	},
	en: {
		heading: "Update available",
		title: "Prometheus {v} is available",
		hint: "Updating restarts the app and updates and restarts the local server; running tasks will be interrupted.",
		remoteHint: "Only this client is updated and restarted; the connected remote server is not updated and must be upgraded by its administrator.",
		later: "Later",
		install: "Update now",
		installing: "Updating…",
		failed: "Update failed: ",
	},
});

/** Startup prompt shown when a newer desktop build is published; the bundled local server ships inside it. */
export function UpdateDialog({ remote = false }: { remote?: boolean }) {
	const t = useT(M);
	const { phase, version, notes, error, dismissed } = useUpdater();
	const open = (phase === "available" || phase === "installing" || (phase === "error" && version)) && !dismissed;
	if (!open) return null;
	const installing = phase === "installing";

	return (
		<div className="fixed inset-0 z-40 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal>
			<div className="w-full max-w-md animate-rise rounded-2xl border border-ink-700 bg-ink-900 p-5 shadow-2xl shadow-black/60">
				<div className="mb-1 font-mono text-[10.5px] tracking-widest text-ember-400 uppercase">{t("heading")}</div>
				<h2 className="font-display text-lg font-semibold">{t("title", { v: version ?? "" })}</h2>
				{notes && <p className="mt-2 max-h-40 overflow-y-auto text-sm whitespace-pre-wrap text-ink-300">{notes}</p>}
				<p className="mt-3 text-xs text-ink-500">{t(remote ? "remoteHint" : "hint")}</p>
				{phase === "error" && error && <p className="mt-3 text-xs break-words text-rose-400">{t("failed") + error}</p>}
				<div className="mt-5 flex justify-end gap-2">
					<Button variant="outline" disabled={installing} onClick={dismissUpdate}>
						{t("later")}
					</Button>
					<Button variant="primary" autoFocus disabled={installing} onClick={() => void installUpdate()}>
						{installing ? t("installing") : t("install")}
					</Button>
				</div>
			</div>
		</div>
	);
}
