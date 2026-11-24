import { isAndroid } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { cancelUpdate, dismissUpdate, installUpdate, useUpdater } from "../lib/updater.ts";
import { Button } from "./ui.tsx";

const M = defineMessages({
	zh: {
		heading: "发现新版本",
		title: "Prometheus {v} 可用",
		hint: "更新会重启应用，并同时更新、重启本机服务端；进行中的任务将被中断。",
		remoteHint: "仅更新本客户端并重启应用；当前连接的远程服务器不会被更新，需由其管理员自行升级。",
		androidHint: "将打开下载链接，下载完成后点击安装即可覆盖更新（数据保留）。若提示「签名不一致」，需要先卸载旧版本，本机模式的数据会丢失。",
		later: "稍后",
		cancel: "取消下载",
		downloading: "正在下载…",
		finishing: "下载完成，正在安装…",
		install: "立即更新",
		downloadApk: "下载安装包",
		installing: "正在更新…",
		failed: "更新失败：",
	},
	en: {
		heading: "Update available",
		title: "Prometheus {v} is available",
		hint: "Updating restarts the app and updates and restarts the local server; running tasks will be interrupted.",
		remoteHint: "Only this client is updated and restarted; the connected remote server is not updated and must be upgraded by its administrator.",
		androidHint: "Opens the download link; when it finishes, tap the file to install over the current app (your data is kept). If Android says the signature does not match, uninstall the old version first, which erases local-mode data.",
		later: "Later",
		cancel: "Cancel download",
		downloading: "Downloading…",
		finishing: "Downloaded, installing…",
		install: "Update now",
		downloadApk: "Download package",
		installing: "Updating…",
		failed: "Update failed: ",
	},
});

/** Startup prompt shown when a newer desktop build is published; the bundled local server ships inside it. */
export function UpdateDialog({ remote = false }: { remote?: boolean }) {
	const t = useT(M);
	const { phase, version, notes, error, dismissed, received, total, downloaded } = useUpdater();
	const open = (phase === "available" || phase === "installing" || (phase === "error" && version)) && !dismissed;
	if (!open) return null;
	const installing = phase === "installing";
	const pct = total ? Math.min(100, Math.round((received / total) * 100)) : null;
	const mb = (n: number) => (n / 1048576).toFixed(1);

	return (
		<div className="fixed inset-0 z-40 flex items-end justify-center bg-ink-950/70 backdrop-blur-sm md:items-center md:p-4" role="dialog" aria-modal>
			<div className="max-h-[88dvh] w-full max-w-md animate-rise overflow-y-auto rounded-2xl border border-ink-700 bg-ink-900 p-5 shadow-2xl shadow-black/60 max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:pb-[max(1.25rem,env(safe-area-inset-bottom))]">
				<div className="mb-1 font-mono text-[10.5px] tracking-widest text-ember-400 uppercase">{t("heading")}</div>
				<h2 className="font-display text-lg font-semibold">{t("title", { v: version ?? "" })}</h2>
				{notes && <p className="mt-2 max-h-40 overflow-y-auto text-sm whitespace-pre-wrap text-ink-300">{notes}</p>}
				<p className="mt-3 text-xs text-ink-500">{t(isAndroid() ? "androidHint" : remote ? "remoteHint" : "hint")}</p>
				{phase === "error" && error && <p className="mt-3 text-xs break-words text-rose-400">{t("failed") + error}</p>}
				{installing && (
					<div className="mt-4">
						<div
							className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800"
							role="progressbar"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={downloaded ? 100 : (pct ?? undefined)}
						>
							<div
								className={`h-full rounded-full bg-ember-500 transition-[width] ${pct === null && !downloaded ? "w-1/3 animate-pulse" : ""}`}
								style={pct !== null || downloaded ? { width: `${downloaded ? 100 : pct}%` } : undefined}
							/>
						</div>
						<div className="mt-1.5 flex justify-between font-mono text-[11px] text-ink-500">
							<span>{downloaded ? t("finishing") : t("downloading")}</span>
							<span>{downloaded ? "" : total ? `${mb(received)} / ${mb(total)} MB · ${pct}%` : `${mb(received)} MB`}</span>
						</div>
					</div>
				)}
				<div className="mt-5 flex justify-end gap-2 max-md:[&>button]:flex-1 max-md:[&>button]:py-2.5">
					{installing && !isAndroid() ? (
						<Button variant="outline" disabled={downloaded} onClick={cancelUpdate}>
							{t("cancel")}
						</Button>
					) : (
						<Button variant="outline" disabled={installing} onClick={dismissUpdate}>
							{t("later")}
						</Button>
					)}
					<Button variant="primary" autoFocus disabled={installing} onClick={() => void installUpdate()}>
						{installing ? t("installing") : t(isAndroid() ? "downloadApk" : "install")}
					</Button>
				</div>
			</div>
		</div>
	);
}
