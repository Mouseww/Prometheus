// Things laid over the page: the browser's own states (starting, missing, crashed), JavaScript dialogs, the file
// chooser, and the start page of a blank tab.
import clsx from "clsx";
import { AlertTriangle, Download, FileUp, Globe, LoaderCircle, Power, RotateCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { installRuntime, useRuntimes } from "../../lib/runtimes.ts";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { Button, Input } from "../ui.tsx";
import type { BrowserState, TabInfo } from "./types.ts";
import { browserCall } from "./useBrowser.ts";

const M = defineMessages({
	zh: {
		connecting: "正在连接浏览器…",
		starting: "正在启动浏览器…",
		stopped: "浏览器已关闭",
		stoppedHint: "空闲一段时间后会自动关闭以节省内存，登录状态和 Cookie 都会保留。",
		start: "启动浏览器",
		failed: "浏览器启动失败",
		retry: "重试",
		missing: "没有找到可用的浏览器",
		missingHint: "内置浏览器使用本机的 Chrome、Edge 或 Chromium（浏览数据与你日常用的浏览器完全隔离）。可以下载一个专用的 Chrome，或者指定浏览器路径。",
		install: "下载 Chrome（约 150 MB）",
		installing: "正在下载 Chrome…",
		extracting: "正在解压…",
		resolving: "正在查询最新版本…",
		cancel: "取消",
		pathLabel: "浏览器可执行文件路径",
		save: "保存",
		nativeInstall: "安装浏览器组件（约 130 MB）",
		nativeHint: "手机上的内置浏览器运行在应用自带的 Linux 环境里，需要先下载浏览器和少量系统库（首次还会下载约 30 MB 的基础系统），之后可以离线使用。",
		nativeBusy: "正在安装…",
		noInstall: "这个平台没有可下载的 Chrome，请用系统包管理器安装 chromium，或指定路径。",
		crashed: "页面崩溃了",
		reload: "重新加载",
		alert: "网页消息",
		confirm: "网页请求确认",
		prompt: "网页请求输入",
		beforeunload: "离开此页面？",
		beforeunloadHint: "你做的更改可能不会保存。",
		ok: "确定",
		leave: "离开",
		stay: "留下",
		agentAnswers: "Agent 正在操作，也可以由它来回答。",
		fileTitle: "网页请求上传文件",
		fileHint: "选中的文件会先传到运行 Prometheus 的机器上，再交给网页。",
		pick: "选择文件",
		pickMany: "选择文件（可多选）",
		uploading: "正在上传 {name}… {pct}%",
		startTitle: "新标签页",
		startHint: "Agent 和你用的是同一个浏览器：它打开的页面你能实时看到，也可以随时接手。",
		searchPlaceholder: "搜索，或者输入网址",
	},
	en: {
		connecting: "Connecting to the browser…",
		starting: "Starting the browser…",
		stopped: "The browser is closed",
		stoppedHint: "It closes itself after a while idle to save memory; logins and cookies are kept.",
		start: "Start browser",
		failed: "The browser did not start",
		retry: "Retry",
		missing: "No usable browser found",
		missingHint: "The built-in browser runs this machine's Chrome, Edge or Chromium with its own profile, separate from your everyday browser. Download a dedicated Chrome, or set the path to one.",
		install: "Download Chrome (about 150 MB)",
		installing: "Downloading Chrome…",
		extracting: "Unpacking…",
		resolving: "Looking up the latest version…",
		cancel: "Cancel",
		pathLabel: "Browser executable path",
		save: "Save",
		nativeInstall: "Install the browser component (about 130 MB)",
		nativeHint: "On a phone the built-in browser runs inside the app's own Linux environment, so a browser and a few system libraries must be downloaded first (the first time also about 30 MB of base system). After that it works offline.",
		nativeBusy: "Installing…",
		noInstall: "There is no Chrome download for this platform. Install chromium with the system package manager, or set the path.",
		crashed: "The page crashed",
		reload: "Reload",
		alert: "Message from the page",
		confirm: "The page asks you to confirm",
		prompt: "The page asks for input",
		beforeunload: "Leave this page?",
		beforeunloadHint: "Changes you made may not be saved.",
		ok: "OK",
		leave: "Leave",
		stay: "Stay",
		agentAnswers: "The agent is working and may answer this itself.",
		fileTitle: "The page wants a file",
		fileHint: "The files go to the machine running Prometheus first, then to the page.",
		pick: "Choose file",
		pickMany: "Choose files",
		uploading: "Uploading {name}… {pct}%",
		startTitle: "New tab",
		startHint: "You and the agent share this browser: you see the pages it opens as it works, and can take over at any time.",
		searchPlaceholder: "Search or type a URL",
	},
});

function Center({ children }: { children: React.ReactNode }) {
	return <div className="absolute inset-0 z-10 grid place-items-center overflow-y-auto bg-ink-950 p-6">{children}</div>;
}

/** Phone: the browser is an on-demand runtime of the app (downloaded and unpacked by the native side). */
function NativeInstall({ runtime, onDone, t }: { runtime: string; onDone: () => void; t: (k: "nativeInstall" | "nativeBusy" | "cancel") => string }) {
	const job = useRuntimes((s) => s.jobs[runtime]);
	const running = !!job && !job.finished;
	const done = useRef(false);
	useEffect(() => {
		if (job?.finished && job.ok && !done.current) {
			done.current = true;
			onDone();
		}
		if (!job || !job.finished) done.current = false;
	}, [job, onDone]);
	const pct = job && job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
	return (
		<div className="space-y-2">
			{running ? (
				<>
					<div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
						<div className="h-full bg-ember-500 transition-[width]" style={{ width: `${Math.max(pct, 3)}%` }} />
					</div>
					<div className="flex items-center justify-between text-xs text-ink-400">
						<span>{job.message || t("nativeBusy")}</span>
						<span>{job.total ? `${pct}%` : ""}</span>
					</div>
				</>
			) : (
				<Button variant="primary" onClick={() => void installRuntime(runtime)}>
					<Download className="size-4" />
					{t("nativeInstall")}
				</Button>
			)}
			{job?.finished && !job.ok && job.error && <p className="text-xs text-rose-400">{job.error}</p>}
		</div>
	);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Shown instead of the page while the browser is not running. Null when the page should show. */
export function StatusScreen({ state, startError, onStart, onSaveSettings }: { state: BrowserState | null; startError: string | null; onStart: () => void; onSaveSettings: (patch: Record<string, unknown>) => Promise<void> }) {
	const t = useT(M);
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!state)
		return (
			<Center>
				<div className="flex items-center gap-2 text-sm text-ink-400">
					<LoaderCircle className="size-4 animate-spin" />
					{startError ?? t("connecting")}
				</div>
			</Center>
		);
	if (state.status === "running" && state.tabs.length) return null;
	if (state.unsupported)
		return (
			<Center>
				<div className="max-w-sm space-y-3 text-center">
					<Globe className="mx-auto size-8 text-ink-500" />
					<p className="text-sm text-ink-300">{state.unsupported}</p>
				</div>
			</Center>
		);
	if (state.status === "starting" || (state.status === "running" && !state.tabs.length))
		return (
			<Center>
				<div className="flex items-center gap-2 text-sm text-ink-400">
					<LoaderCircle className="size-4 animate-spin" />
					{t("starting")}
				</div>
			</Center>
		);

	if (state.missing) {
		const inst = state.install;
		const installing = inst && (inst.stage === "resolve" || inst.stage === "download" || inst.stage === "extract");
		const pct = inst && inst.total ? Math.round((inst.done / inst.total) * 100) : 0;
		return (
			<Center>
				<div className="w-full max-w-md space-y-4 text-center">
					<div className="mx-auto grid size-12 place-items-center rounded-2xl border border-ink-700 bg-ink-900 text-ember-400">
						<Globe className="size-6" />
					</div>
					<h3 className="font-display text-lg font-semibold">{t("missing")}</h3>
					<p className="text-sm text-ink-400">{state.nativeInstall ? t("nativeHint") : t("missingHint")}</p>
					{state.nativeInstall ? (
						<NativeInstall runtime={state.nativeInstall.runtime} onDone={onStart} t={t} />
					) : state.canInstall ? (
						installing ? (
							<div className="space-y-2">
								<div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
									<div className="h-full bg-ember-500 transition-[width]" style={{ width: `${inst.stage === "resolve" ? 3 : pct}%` }} />
								</div>
								<div className="flex items-center justify-between text-xs text-ink-400">
									<span>{inst.stage === "resolve" ? t("resolving") : inst.stage === "extract" ? t("extracting") : t("installing")}</span>
									<span>{inst.stage === "download" && inst.total ? `${(inst.done / 1048576).toFixed(0)} / ${(inst.total / 1048576).toFixed(0)} MB` : `${pct}%`}</span>
								</div>
								<Button variant="ghost" onClick={() => void browserCall("install.cancel").catch(() => {})}>
									{t("cancel")}
								</Button>
							</div>
						) : (
							<Button
								variant="primary"
								disabled={busy}
								onClick={async () => {
									setBusy(true);
									setError(null);
									try {
										await browserCall("install");
										onStart();
									} catch (e) {
										setError(errText(e));
									} finally {
										setBusy(false);
									}
								}}
							>
								<Download className="size-4" />
								{t("install")}
							</Button>
						)
					) : (
						<p className="text-sm text-ink-400">{t("noInstall")}</p>
					)}
					{(error || inst?.stage === "error") && <p className="text-xs text-rose-400">{error ?? inst?.message}</p>}
					{!state.nativeInstall && (
					<form
						className="flex gap-2 pt-2 text-left"
						onSubmit={async (e) => {
							e.preventDefault();
							if (!path.trim()) return;
							await onSaveSettings({ executablePath: path.trim() });
							onStart();
						}}
					>
						<Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t("pathLabel")} className="font-mono text-xs" />
						<Button variant="outline" type="submit">
							{t("save")}
						</Button>
					</form>
					)}
				</div>
			</Center>
		);
	}

	if (state.status === "error" || startError)
		return (
			<Center>
				<div className="max-w-md space-y-3 text-center">
					<AlertTriangle className="mx-auto size-8 text-rose-400" />
					<h3 className="font-display text-lg font-semibold">{t("failed")}</h3>
					<p className="text-sm break-words text-ink-400">{state.error ?? startError}</p>
					<Button variant="primary" onClick={onStart}>
						<RotateCw className="size-4" />
						{t("retry")}
					</Button>
				</div>
			</Center>
		);

	return (
		<Center>
			<div className="max-w-sm space-y-3 text-center">
				<Power className="mx-auto size-8 text-ink-500" />
				<h3 className="font-display text-lg font-semibold">{t("stopped")}</h3>
				<p className="text-sm text-ink-400">{t("stoppedHint")}</p>
				<Button variant="primary" onClick={onStart}>
					{t("start")}
				</Button>
			</div>
		</Center>
	);
}

export function CrashedPage({ onReload }: { onReload: () => void }) {
	const t = useT(M);
	return (
		<Center>
			<div className="space-y-3 text-center">
				<AlertTriangle className="mx-auto size-8 text-ember-400" />
				<h3 className="font-display text-lg font-semibold">{t("crashed")}</h3>
				<Button variant="primary" onClick={onReload}>
					<RotateCw className="size-4" />
					{t("reload")}
				</Button>
			</div>
		</Center>
	);
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="absolute inset-0 z-20 grid animate-backdrop place-items-center bg-ink-950/50 p-4 backdrop-blur-[1px]">
			<div role="dialog" aria-label={title} className="w-full max-w-sm animate-pop space-y-3 rounded-xl border border-ink-700 bg-ink-900 p-4 shadow-2xl shadow-black/50">
				<h3 className="text-sm font-semibold text-ink-100">{title}</h3>
				{children}
			</div>
		</div>
	);
}

/** A JavaScript alert / confirm / prompt / beforeunload, drawn by the app. */
export function PageDialog({ tab, agentBusy }: { tab: TabInfo; agentBusy: boolean }) {
	const t = useT(M);
	const d = tab.dialog;
	const [text, setText] = useState(d?.defaultPrompt ?? "");
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		setText(d?.defaultPrompt ?? "");
		input.current?.focus();
	}, [d]);
	if (!d) return null;
	const answer = (accept: boolean) => void browserCall("dialog", { tab: tab.id, accept, ...(d.type === "prompt" && accept ? { text } : {}) }).catch(() => {});
	let host = "";
	try {
		host = new URL(d.url).host;
	} catch {
		// about:blank and the like
	}
	const title = d.type === "beforeunload" ? t("beforeunload") : t(d.type);
	return (
		<Card title={host ? `${host} · ${title}` : title}>
			<p className="max-h-48 overflow-y-auto text-sm break-words whitespace-pre-wrap text-ink-300">{d.type === "beforeunload" ? t("beforeunloadHint") : d.message}</p>
			{d.type === "prompt" && (
				<input
					ref={input}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && answer(true)}
					className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 focus:border-ember-500/70 focus:outline-none"
				/>
			)}
			{agentBusy && <p className="text-xs text-ink-500">{t("agentAnswers")}</p>}
			<div className="flex justify-end gap-2">
				{d.type !== "alert" && (
					<Button variant="ghost" onClick={() => answer(false)}>
						{d.type === "beforeunload" ? t("stay") : t("cancel")}
					</Button>
				)}
				<Button variant="primary" autoFocus={d.type !== "prompt"} onClick={() => answer(true)}>
					{d.type === "beforeunload" ? t("leave") : t("ok")}
				</Button>
			</div>
		</Card>
	);
}

const PIECE = 2 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

/** A file input on the page was clicked: the user picks files here and they are handed to the page. */
export function FileChooser({ tab }: { tab: TabInfo }) {
	const t = useT(M);
	const picker = useRef<HTMLInputElement>(null);
	const [progress, setProgress] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	if (!tab.fileChooser) return null;
	const multiple = tab.fileChooser.multiple;

	const upload = async (files: FileList) => {
		setError(null);
		try {
			const paths: string[] = [];
			let token: string | undefined;
			for (const file of Array.from(files)) {
				let path = "";
				for (let offset = 0; offset < file.size || offset === 0; offset += PIECE) {
					const bytes = new Uint8Array(await file.slice(offset, offset + PIECE).arrayBuffer());
					const r = await browserCall<{ token: string; path: string }>("files.upload", { token, name: file.name, offset, data: toBase64(bytes) });
					token = r.token;
					path = r.path;
					setProgress(t("uploading", { name: file.name, pct: file.size ? Math.min(100, Math.round(((offset + bytes.length) / file.size) * 100)) : 100 }));
					if (file.size === 0) break;
				}
				paths.push(path);
			}
			await browserCall("files.choose", { tab: tab.id, paths });
		} catch (e) {
			setError(errText(e));
		} finally {
			setProgress(null);
		}
	};

	return (
		<Card title={t("fileTitle")}>
			<p className="text-xs text-ink-400">{t("fileHint")}</p>
			{progress && <p className="text-xs text-ink-300">{progress}</p>}
			{error && <p className="text-xs text-rose-400">{error}</p>}
			<input ref={picker} type="file" multiple={multiple} className="hidden" onChange={(e) => e.target.files?.length && void upload(e.target.files)} />
			<div className="flex justify-end gap-2">
				<Button variant="ghost" disabled={!!progress} onClick={() => void browserCall("files.cancel", { tab: tab.id }).catch(() => {})}>
					{t("cancel")}
				</Button>
				<Button variant="primary" disabled={!!progress} onClick={() => picker.current?.click()}>
					<FileUp className="size-4" />
					{multiple ? t("pickMany") : t("pick")}
				</Button>
			</div>
		</Card>
	);
}

/** What a blank tab shows: a search box. */
export function StartPage({ onGo }: { onGo: (input: string) => void }) {
	const t = useT(M);
	const [q, setQ] = useState("");
	return (
		<div className="absolute inset-0 z-[5] grid place-items-center bg-ink-950 p-6">
			<div className="w-full max-w-lg space-y-5 text-center">
				<Globe className="mx-auto size-9 text-ember-400" />
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (q.trim()) onGo(q.trim());
					}}
					className={clsx("flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900 px-4 py-2.5 shadow-lg shadow-black/20 focus-within:border-ember-500/70")}
				>
					<Search className="size-4 shrink-0 text-ink-500" />
					<input
						autoFocus
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder={t("searchPlaceholder")}
						className="min-w-0 flex-1 bg-transparent text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none"
					/>
				</form>
				<p className="text-xs text-ink-500">{t("startHint")}</p>
			</div>
		</div>
	);
}
