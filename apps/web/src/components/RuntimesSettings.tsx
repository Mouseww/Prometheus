import clsx from "clsx";
import { AlertTriangle, Check, ChevronDown, Download, LoaderCircle, RotateCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import {
	cancelRuntime,
	dismissRequest,
	dismissRuntimeJob,
	formatBytes,
	formatEta,
	initRuntimes,
	installMsvc,
	installRuntime,
	jobFraction,
	jobLabel,
	refreshRuntimes,
	restartApp,
	type RuntimeItem,
	type RuntimeJob,
	uninstallRuntime,
	useRuntimes,
} from "../lib/runtimes.ts";
import { openSettings, toast } from "../lib/store.ts";
import { ToolStore } from "./ToolStore.tsx";
import { Button, PageHeader } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "运行环境",
		subtitle: "按需安装 Python、Go、Rust、Git。安装包不再内置它们，需要时在这里下载。",
		install: "安装",
		reinstall: "重新安装",
		uninstall: "卸载",
		cancel: "取消",
		retry: "重试",
		installed: "已安装 {v}",
		notInstalled: "未安装",
		systemHas: "系统已有：{p}",
		unsupported: "当前平台不支持自动安装",
		size: "约 {n} MB",
		offline: "使用离线包",
		offlinePath: "离线安装包的完整路径",
		offlineHint: "文件必须是清单里对应版本的安装包，会校验 SHA-256。",
		offlineGo: "导入",
		restart: "已安装的运行环境需要重启 Prometheus 后才会出现在 Agent 的 PATH 里。",
		restartBtn: "立即重启",
		confirmUninstall: "卸载 {name}？已装的包和缓存会被删除。",
		uninstalled: "{name} 已卸载",
		details: "详情",
		hideDetails: "收起",
		prepare: "准备中",
		download: "下载中",
		verify: "校验中",
		extract: "解压中",
		setup: "正在安装",
		apt: "安装系统组件",
		finish: "完成",
		done: "安装完成",
		failed: "安装失败",
		open: "查看",
		noLog: "暂无日志",
		askTitle: "Agent 需要 {name}",
		askBody: "刚才的命令 {cmd} 找不到。现在安装约 {n} MB，装好后让 Agent 重试即可，无需重启。",
		askYes: "安装",
		askNo: "暂不",
		msvcName: "VS 生成工具",
		installMsvc: "安装 VS 生成工具",
		msvcHint: "体积数 GB，会弹出管理员授权窗口。装好后重新安装 Rust 即可改用 MSVC。",
	},
	en: {
		title: "Runtimes",
		subtitle: "Install Python, Go, Rust and Git on demand. They are no longer bundled; download them here when needed.",
		install: "Install",
		reinstall: "Reinstall",
		uninstall: "Uninstall",
		cancel: "Cancel",
		retry: "Retry",
		installed: "Installed {v}",
		notInstalled: "Not installed",
		systemHas: "Already on this system: {p}",
		unsupported: "Automatic install is not available on this platform",
		size: "about {n} MB",
		offline: "Use an offline package",
		offlinePath: "Full path of the offline package",
		offlineHint: "It must be the package for the version in the manifest; its SHA-256 is checked.",
		offlineGo: "Import",
		restart: "Restart Prometheus so newly installed runtimes appear on the agent's PATH.",
		restartBtn: "Restart now",
		confirmUninstall: "Uninstall {name}? Its files and cache will be deleted.",
		uninstalled: "{name} uninstalled",
		details: "Details",
		hideDetails: "Hide",
		prepare: "Preparing",
		download: "Downloading",
		verify: "Verifying",
		extract: "Unpacking",
		setup: "Installing",
		apt: "Installing system components",
		finish: "Done",
		done: "Installed",
		failed: "Install failed",
		open: "View",
		noLog: "No log yet",
		askTitle: "The agent needs {name}",
		askBody: "The command {cmd} was not found. Installing takes about {n} MB; ask the agent to retry afterwards, no restart needed.",
		askYes: "Install",
		askNo: "Not now",
		msvcName: "VS Build Tools",
		installMsvc: "Install VS Build Tools",
		msvcHint: "Several GB, and Windows asks for administrator rights. Reinstall Rust afterwards to switch to MSVC.",
	},
});

type Key = keyof (typeof M)["zh"];

function stageLabel(t: (k: Key, v?: Record<string, string | number>) => string, job: RuntimeJob): string {
	return t(job.stage as Key);
}

/** Progress bar, stage, speed, ETA and a collapsible log: shared by the settings page and the floating card. */
export function JobView({ job, compact }: { job: RuntimeJob; compact?: boolean }) {
	const t = useT(M);
	const [open, setOpen] = useState(false);
	const fraction = jobFraction(job);
	const eta = formatEta(job);
	const failed = job.finished && !job.ok;
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between gap-2 text-xs text-ink-400">
				<span className="min-w-0 truncate">
					{job.finished ? (job.ok ? t("done") : t("failed")) : stageLabel(t, job)}
					{!job.finished && job.stage !== "download" && job.message && !compact ? ` · ${job.message}` : ""}
				</span>
				{!job.finished && job.total > 0 && job.stage === "download" && (
					<span className="shrink-0 tabular-nums">
						{formatBytes(job.done)} / {formatBytes(job.total)}
						{job.speed > 0 && ` · ${formatBytes(job.speed)}/s`}
						{eta && ` · ${eta}`}
					</span>
				)}
				{!job.finished && fraction != null && job.stage !== "download" && <span className="shrink-0 tabular-nums">{Math.round(fraction * 100)}%</span>}
			</div>
			<div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
				<div
					className={clsx(
						"h-full rounded-full transition-[width] duration-150",
						failed ? "bg-rose-400" : "bg-ember-400",
						fraction == null && !job.finished && "w-1/3 animate-pulse",
					)}
					style={fraction != null || job.finished ? { width: `${Math.round((failed ? 1 : (fraction ?? 1)) * 100)}%` } : undefined}
				/>
			</div>
			{failed && job.error && <p className="text-xs leading-relaxed break-words text-rose-400">{job.error}</p>}
			{!compact && (
				<>
					<button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-xs text-ink-500 hover:text-ink-300">
						<ChevronDown className={clsx("size-3 transition-transform", open && "rotate-180")} />
						{open ? t("hideDetails") : t("details")}
					</button>
					{open && (
						<pre className="max-h-40 overflow-auto rounded-lg bg-ink-950 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-400">
							{job.logs.length ? job.logs.join("\n") : t("noLog")}
						</pre>
					)}
				</>
			)}
		</div>
	);
}

function Row({ item }: { item: RuntimeItem }) {
	const t = useT(M);
	const job = useRuntimes((s) => s.jobs[item.id]);
	const running = item.installing || (job != null && !job.finished);
	const [offlineOpen, setOffline] = useState(false);
	const [path, setPath] = useState("");

	const remove = async () => {
		if (!window.confirm(t("confirmUninstall", { name: item.name }))) return;
		try {
			await uninstallRuntime(item.id);
			toast(t("uninstalled", { name: item.name }));
		} catch (err) {
			toast(String(err));
		}
	};

	return (
		<section className="space-y-3 rounded-2xl border border-ink-800 bg-ink-900/40 p-5">
			<div className="flex flex-wrap items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h3 className="text-sm font-medium text-ink-100">{item.name}</h3>
						{item.installed ? (
							<span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-400">
								<Check className="size-3" />
								{t("installed", { v: item.installed })}
							</span>
						) : (
							<span className="rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-ink-400">{item.supported ? t("notInstalled") : t("unsupported")}</span>
						)}
					</div>
					<p className="mt-1 text-xs leading-relaxed text-ink-400">{item.description}</p>
					{!item.supported && item.hint && <p className="mt-1 text-xs leading-relaxed text-ink-500">{item.hint}</p>}
					{item.system && !item.installed && <p className="mt-1 truncate text-xs text-ink-500">{t("systemHas", { p: item.system })}</p>}
					{item.supported && !item.installed && item.sizeMb > 0 && <p className="mt-1 text-xs text-ink-500">{t("size", { n: item.sizeMb })}</p>}
				</div>
				{item.supported && (
					<div className="flex shrink-0 items-center gap-1.5">
						{running ? (
							<Button variant="outline" onClick={() => void cancelRuntime(item.id)}>
								<X className="size-4" />
								{t("cancel")}
							</Button>
						) : (
							<>
								{item.installed && (
									<Button variant="danger" onClick={() => void remove()}>
										<Trash2 className="size-4" />
										{t("uninstall")}
									</Button>
								)}
								<Button variant={item.installed ? "outline" : "primary"} onClick={() => void installRuntime(item.id)}>
									{job?.finished && !job.ok ? <RotateCw className="size-4" /> : <Download className="size-4" />}
									{job?.finished && !job.ok ? t("retry") : item.installed ? t("reinstall") : t("install")}
								</Button>
							</>
						)}
					</div>
				)}
			</div>
			{item.notice && (
				<div className={clsx("flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed", item.notice.level === "warn" ? "bg-amber-400/10 text-amber-300" : "bg-ink-800/60 text-ink-300")}>
					<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
					<div className="min-w-0 flex-1">
						<p>{item.notice.text}</p>
						{item.msvcInstallable && !running && (
							<div className="mt-2 flex flex-wrap items-center gap-2">
								<Button variant="outline" onClick={() => void installMsvc()}>
									<Download className="size-4" />
									{t("installMsvc")}
								</Button>
								<span className="text-ink-500">{t("msvcHint")}</span>
							</div>
						)}
					</div>
				</div>
			)}
			{job && (running || job.finished) && <JobView job={job} />}
			{item.supported && !running && (
				<div>
					<button type="button" onClick={() => setOffline(!offlineOpen)} className="text-xs text-ink-500 hover:text-ink-300">
						{t("offline")}
					</button>
					{offlineOpen && (
						<div className="mt-2 space-y-1.5">
							<div className="flex gap-2">
								<input
									value={path}
									onChange={(e) => setPath(e.target.value)}
									placeholder={t("offlinePath")}
									className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-sm text-ink-100 outline-none focus:border-ember-400"
								/>
								<Button variant="outline" disabled={!path.trim()} onClick={() => void installRuntime(item.id, path.trim())}>
									{t("offlineGo")}
								</Button>
							</div>
							<p className="text-xs text-ink-500">{t("offlineHint")}</p>
						</div>
					)}
				</div>
			)}
		</section>
	);
}

export function RuntimesSettings() {
	const t = useT(M);
	const items = useRuntimes((s) => s.items);
	const restartNeeded = useRuntimes((s) => s.restartNeeded);
	const loadError = useRuntimes((s) => s.loadError);
	const available = useRuntimes((s) => s.available);
	useEffect(() => {
		void initRuntimes();
	}, []);
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 @3xl:p-8">
				{loadError && (
					<div className="space-y-2 rounded-2xl border border-rose-400/40 bg-rose-400/10 p-4 text-sm text-ink-200">
						<p className="break-words">{loadError}</p>
						<Button variant="outline" onClick={() => void initRuntimes().then(refreshRuntimes)}>
							<RotateCw className="size-4" />
							{t("retry")}
						</Button>
					</div>
				)}
				{restartNeeded && (
					<div className="flex flex-wrap items-center gap-3 rounded-2xl border border-ember-400/40 bg-ember-400/10 p-4 text-sm text-ink-200">
						<span className="min-w-0 flex-1">{t("restart")}</span>
						<Button variant="primary" onClick={() => void restartApp()}>
							{t("restartBtn")}
						</Button>
					</div>
				)}
				{items.map((item) => (
					<Row key={item.id} item={item} />
				))}
				{available && <ToolStore />}
			</div>
		</div>
	);
}

/**
 * Floating progress card, mounted once at the app root so an install started anywhere (or running while the user
 * browses elsewhere) always has a visible, cancellable progress indicator instead of a silent wait.
 */
export function RuntimeProgressCard() {
	const t = useT(M);
	const jobs = useRuntimes((s) => s.jobs);
	const items = useRuntimes((s) => s.items);
	const requests = Object.values(useRuntimes((s) => s.requests));
	useEffect(() => {
		void initRuntimes();
	}, []);
	const shown = Object.values(jobs).filter((j) => !j.dismissed && (!j.finished || !j.ok || Date.now() - j.startedAt < 60_000));
	// A successful install fades from the card on its own; a failure stays until dismissed.
	useEffect(() => {
		const timers = Object.values(jobs)
			.filter((j) => j.finished && j.ok && !j.dismissed)
			.map((j) => window.setTimeout(() => dismissRuntimeJob(j.id), 6000));
		return () => timers.forEach(window.clearTimeout);
	}, [jobs]);
	if (shown.length === 0 && requests.length === 0) return null;
	return (
		<div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
			{requests.map((req) => {
				const item = items.find((i) => i.id === req.id);
				if (!item) return null;
				return (
					<div key={`ask-${req.id}`} className="pointer-events-auto space-y-2 rounded-2xl border border-ember-400/50 bg-ink-900 p-4 shadow-xl">
						<p className="text-sm font-medium text-ink-100">{t("askTitle", { name: item.name })}</p>
						<p className="text-xs leading-relaxed text-ink-400">{t("askBody", { cmd: req.command, n: item.sizeMb })}</p>
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={() => dismissRequest(req.id)}>
								{t("askNo")}
							</Button>
							<Button variant="primary" onClick={() => void installRuntime(req.id)}>
								<Download className="size-4" />
								{t("askYes")}
							</Button>
						</div>
					</div>
				);
			})}
			{shown.map((job) => {
				const name = job.id === "msvc" ? t("msvcName") : (items.find((i) => i.id === job.id)?.name ?? jobLabel(job.id) ?? job.id);
				return (
					<div key={job.id} className="pointer-events-auto space-y-2 rounded-2xl border border-ink-700 bg-ink-900 p-4 shadow-xl">
						<div className="flex items-center gap-2">
							{!job.finished ? (
								<LoaderCircle className="size-4 shrink-0 animate-spin text-ember-400" />
							) : job.ok ? (
								<Check className="size-4 shrink-0 text-emerald-400" />
							) : (
								<AlertTriangle className="size-4 shrink-0 text-rose-400" />
							)}
							<span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-100">{name}</span>
							<button type="button" onClick={() => openSettings("runtimes")} className="text-xs text-ink-400 hover:text-ink-100">
								{t("open")}
							</button>
							{job.finished ? (
								<button type="button" aria-label="close" onClick={() => dismissRuntimeJob(job.id)} className="text-ink-500 hover:text-ink-100">
									<X className="size-4" />
								</button>
							) : (
								<button type="button" onClick={() => void cancelRuntime(job.id)} className="text-xs text-ink-400 hover:text-rose-400">
									{t("cancel")}
								</button>
							)}
						</div>
						<JobView job={job} compact />
					</div>
				);
			})}
		</div>
	);
}
