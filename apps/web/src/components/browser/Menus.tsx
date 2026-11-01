// The browser's settings and downloads, as popovers under the toolbar.
import clsx from "clsx";
import { Copy, Download, FolderOpen, Trash2, X } from "lucide-react";
import { useState } from "react";
import { isTauri } from "../../lib/backend.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { confirmDialog } from "../../lib/dialogs.ts";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { uninstallRuntime } from "../../lib/runtimes.ts";
import { call, toast, useStore } from "../../lib/store.ts";
import { Button, Input, Select } from "../ui.tsx";
import type { BrowserSettings, BrowserState, DownloadInfo } from "./types.ts";
import { browserCall } from "./useBrowser.ts";

const M = defineMessages({
	zh: {
		settings: "浏览器设置",
		display: "显示方式",
		headless: "在面板中（推荐）",
		window: "独立窗口 + 面板同步",
		windowHint: "独立窗口只能在运行 Prometheus 的这台电脑上看到，适合手动登录、过验证码。",
		search: "搜索引擎",
		custom: "自定义",
		searchUrl: "搜索地址（%s 为关键词）",
		quality: "画质",
		fps: "最高帧率",
		proxy: "代理",
		proxyHint: "例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080，留空直连。",
		path: "浏览器路径",
		pathHint: "留空自动查找（Chrome → Edge → Chromium）。当前：{product}",
		idle: "空闲多久后自动关闭",
		never: "从不",
		minutes: "{n} 分钟",
		restore: "启动时恢复上次的标签页",
		eval: "允许 Agent 在网页里执行脚本（browser_eval）",
		mobile: "手机屏幕上按手机版网页显示",
		uninstall: "卸载浏览器组件",
		uninstallConfirm: "卸载后浏览器会关闭，需要时可以重新安装。登录状态保留在浏览数据里，不受影响。继续吗？",
		downloadDir: "下载目录",
		downloadDirHint: "留空使用插件数据目录。",
		wipe: "清除浏览数据",
		wipeConfirm: "清除内置浏览器的全部浏览数据（Cookie、登录状态、缓存、历史）？此操作不可撤销。",
		stop: "关闭浏览器",
		saved: "已保存",
		downloads: "下载",
		noDownloads: "还没有下载。",
		reveal: "在文件夹中显示",
		save: "保存到本机",
		copyPath: "复制路径",
		cancel: "取消下载",
		remove: "从列表移除",
		canceled: "已取消",
		saved2: "已保存 {name}",
	},
	en: {
		settings: "Browser settings",
		display: "Display",
		headless: "In the panel (recommended)",
		window: "Separate window + panel",
		windowHint: "The separate window only shows on the machine running Prometheus; handy for logging in by hand or solving a captcha.",
		search: "Search engine",
		custom: "Custom",
		searchUrl: "Search URL (%s is the query)",
		quality: "Picture quality",
		fps: "Max frame rate",
		proxy: "Proxy",
		proxyHint: "e.g. http://127.0.0.1:7890 or socks5://127.0.0.1:1080; empty for direct.",
		path: "Browser path",
		pathHint: "Empty finds one (Chrome → Edge → Chromium). Now: {product}",
		idle: "Close when idle for",
		never: "Never",
		minutes: "{n} minutes",
		restore: "Reopen last tabs on start",
		eval: "Let the agent run scripts in pages (browser_eval)",
		mobile: "Show pages as on a phone when the screen is small",
		uninstall: "Uninstall the browser component",
		uninstallConfirm: "The browser will close; you can install it again later. Logins stay in the browsing data. Continue?",
		downloadDir: "Download folder",
		downloadDirHint: "Empty uses the plugin's data folder.",
		wipe: "Clear browsing data",
		wipeConfirm: "Clear all browsing data of the built-in browser (cookies, logins, cache, history)? This cannot be undone.",
		stop: "Close browser",
		saved: "Saved",
		downloads: "Downloads",
		noDownloads: "No downloads yet.",
		reveal: "Show in folder",
		save: "Save to this device",
		copyPath: "Copy path",
		cancel: "Cancel download",
		remove: "Remove from list",
		canceled: "Canceled",
		saved2: "Saved {name}",
	},
});

const ENGINES: { id: string; label: string; url: string }[] = [
	{ id: "bing", label: "Bing", url: "https://www.bing.com/search?q=%s" },
	{ id: "google", label: "Google", url: "https://www.google.com/search?q=%s" },
	{ id: "baidu", label: "百度", url: "https://www.baidu.com/s?wd=%s" },
	{ id: "ddg", label: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
];

function Popover({ children, onClose, className }: { children: React.ReactNode; onClose: () => void; className?: string }) {
	return (
		<>
			<div className="fixed inset-0 z-30" onMouseDown={onClose} />
			<div className={clsx("absolute top-full right-1 z-40 mt-1 max-h-[min(36rem,80vh)] w-80 animate-rise overflow-y-auto rounded-xl border border-ink-700 bg-ink-900/97 p-3 shadow-2xl shadow-black/50 backdrop-blur", className)}>{children}</div>
		</>
	);
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
	return (
		<label className="flex cursor-pointer items-center justify-between gap-3 py-1 text-[13px] text-ink-200">
			<span>{label}</span>
			<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-ember-500" />
		</label>
	);
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="space-y-1">
			<div className="text-xs font-medium text-ink-300">{label}</div>
			{children}
			{hint && <div className="text-[11px] text-ink-500">{hint}</div>}
		</div>
	);
}

export function SettingsPopover({ settings, state, onSave, onClose }: { settings: BrowserSettings; state: BrowserState; onSave: (patch: Partial<BrowserSettings>) => Promise<void>; onClose: () => void }) {
	const t = useT(M);
	const local = useStore((s) => s.client?.local ?? false);
	const known = ENGINES.find((e) => e.url === settings.searchUrl)?.id ?? "custom";
	const [custom, setCustom] = useState(known === "custom");
	const engine = custom ? "custom" : known;
	const [draft, setDraft] = useState({ proxy: settings.proxy, executablePath: settings.executablePath, downloadDir: settings.downloadDir, searchUrl: settings.searchUrl });
	const commit = (key: keyof typeof draft) => {
		if (draft[key] !== settings[key]) void onSave({ [key]: draft[key] });
	};
	return (
		<Popover onClose={onClose}>
			<div className="space-y-3">
				<h3 className="text-sm font-semibold">{t("settings")}</h3>
				{local && !state.guest && (
					<Row label={t("display")} hint={settings.mode === "window" ? t("windowHint") : undefined}>
						<Select value={settings.mode} onChange={(e) => void onSave({ mode: e.target.value as BrowserSettings["mode"] })} className="py-1.5 text-[13px]">
							<option value="headless">{t("headless")}</option>
							<option value="window">{t("window")}</option>
						</Select>
					</Row>
				)}
				<Row label={t("search")}>
					<Select
						value={engine}
						onChange={(e) => {
							const hit = ENGINES.find((x) => x.id === e.target.value);
							setCustom(!hit);
							if (hit) void onSave({ searchUrl: hit.url });
						}}
						className="py-1.5 text-[13px]"
					>
						{ENGINES.map((e) => (
							<option key={e.id} value={e.id}>
								{e.label}
							</option>
						))}
						<option value="custom">{t("custom")}</option>
					</Select>
					{engine === "custom" && (
						<Input value={draft.searchUrl} placeholder={t("searchUrl")} onChange={(e) => setDraft((d) => ({ ...d, searchUrl: e.target.value }))} onBlur={() => commit("searchUrl")} className="mt-1 py-1.5 font-mono text-xs" />
					)}
				</Row>
				<div className="grid grid-cols-2 gap-2">
					<Row label={`${t("quality")} · ${settings.quality}`}>
						<input type="range" min={30} max={95} step={5} value={settings.quality} onChange={(e) => void onSave({ quality: Number(e.target.value) })} className="w-full accent-ember-500" />
					</Row>
					<Row label={t("fps")}>
						<Select value={String(settings.maxFps)} onChange={(e) => void onSave({ maxFps: Number(e.target.value) })} className="py-1.5 text-[13px]">
							{[10, 15, 30, 60].map((n) => (
								<option key={n} value={n}>
									{n} fps
								</option>
							))}
						</Select>
					</Row>
				</div>
				<Row label={t("proxy")} hint={t("proxyHint")}>
					<Input value={draft.proxy} onChange={(e) => setDraft((d) => ({ ...d, proxy: e.target.value }))} onBlur={() => commit("proxy")} className="py-1.5 font-mono text-xs" />
				</Row>
				{!state.guest && <Row label={t("path")} hint={t("pathHint", { product: state.browser ? `${state.browser.product || state.browser.kind}` : "—" })}>
					<Input value={draft.executablePath} placeholder={state.browser?.path} onChange={(e) => setDraft((d) => ({ ...d, executablePath: e.target.value }))} onBlur={() => commit("executablePath")} className="py-1.5 font-mono text-xs" />
				</Row>}
				{!state.guest && <Row label={t("downloadDir")} hint={t("downloadDirHint")}>
					<Input value={draft.downloadDir} onChange={(e) => setDraft((d) => ({ ...d, downloadDir: e.target.value }))} onBlur={() => commit("downloadDir")} className="py-1.5 font-mono text-xs" />
				</Row>}
				<Row label={t("idle")}>
					<Select value={String(settings.idleMinutes)} onChange={(e) => void onSave({ idleMinutes: Number(e.target.value) })} className="py-1.5 text-[13px]">
						{[5, 15, 30, 60, 0].map((n) => (
							<option key={n} value={n}>
								{n ? t("minutes", { n }) : t("never")}
							</option>
						))}
					</Select>
				</Row>
				<Toggle checked={settings.restoreTabs} onChange={(v) => void onSave({ restoreTabs: v })} label={t("restore")} />
				<Toggle checked={settings.mobile} onChange={(v) => void onSave({ mobile: v })} label={t("mobile")} />
				<Toggle checked={settings.allowEval} onChange={(v) => void onSave({ allowEval: v })} label={t("eval")} />
				<div className="flex flex-wrap gap-2 border-t hairline pt-3">
					{state.guest && state.nativeInstall && !state.missing && (
						<Button
							variant="outline"
							className="flex-1 text-xs"
							onClick={async () => {
								if (!(await confirmDialog(t("uninstallConfirm"), { danger: true }))) return;
								await browserCall("stop").catch(() => {});
								await uninstallRuntime(state.nativeInstall?.runtime ?? "chromium").catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"));
								await browserCall("state").catch(() => {});
							}}
						>
							{t("uninstall")}
						</Button>
					)}
					<Button
						variant="danger"
						className="flex-1 text-xs"
						onClick={async () => {
							if (!(await confirmDialog(t("wipeConfirm"), { danger: true }))) return;
							await browserCall("wipe").catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"));
						}}
					>
						<Trash2 className="size-3.5" />
						{t("wipe")}
					</Button>
					<Button
						variant="outline"
						className="flex-1 text-xs"
						onClick={() => {
							onClose();
							void browserCall("stop").catch(() => {});
						}}
					>
						{t("stop")}
					</Button>
				</div>
			</div>
		</Popover>
	);
}

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function saveToDevice(d: DownloadInfo): Promise<void> {
	const parts: Uint8Array[] = [];
	let offset = 0;
	for (;;) {
		const r = await browserCall<{ data: string; eof: boolean }>("download.read", { id: d.id, offset, length: 4 * 1024 * 1024 });
		const bin = atob(r.data);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		parts.push(bytes);
		offset += bytes.length;
		if (r.eof || !bytes.length) break;
	}
	const url = URL.createObjectURL(new Blob(parts as BlobPart[]));
	const a = document.createElement("a");
	a.href = url;
	a.download = d.name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function DownloadsPopover({ downloads, onClose }: { downloads: DownloadInfo[]; onClose: () => void }) {
	const t = useT(M);
	const local = useStore((s) => s.client?.local ?? false);
	const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, "");
	return (
		<Popover onClose={onClose}>
			<h3 className="mb-2 text-sm font-semibold">{t("downloads")}</h3>
			{!downloads.length && <p className="text-xs text-ink-500">{t("noDownloads")}</p>}
			<ul className="space-y-1.5">
				{downloads.map((d) => {
					const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
					return (
						<li key={d.id} className="group rounded-lg border border-ink-800 p-2">
							<div className="flex items-center gap-2">
								<Download className={clsx("size-3.5 shrink-0", d.state === "completed" ? "text-moss-400" : d.state === "canceled" ? "text-ink-600" : "text-ember-400")} />
								<span className="min-w-0 flex-1 truncate text-[13px] text-ink-200" title={d.path || d.url}>
									{d.name}
								</span>
								<button type="button" onClick={() => void browserCall("download.forget", { id: d.id })} className="rounded p-0.5 text-ink-500 opacity-0 group-hover:opacity-100 hover:text-ink-200" title={t("remove")}>
									<X className="size-3.5" />
								</button>
							</div>
							{d.state === "inProgress" && (
								<div className="mt-1.5 flex items-center gap-2">
									<div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-800">
										<div className="h-full bg-ember-500" style={{ width: `${d.total ? pct : 30}%` }} />
									</div>
									<span className="font-mono text-[10.5px] text-ink-500">{size(d.received)}</span>
									<button type="button" onClick={() => void browserCall("download.cancel", { id: d.id })} className="text-[11px] text-ink-400 hover:text-rose-400">
										{t("cancel")}
									</button>
								</div>
							)}
							{d.state === "canceled" && <div className="mt-1 text-[11px] text-ink-500">{t("canceled")}</div>}
							{d.state === "completed" && (
								<div className="mt-1.5 flex items-center gap-1 text-[11px]">
									<span className="mr-auto font-mono text-ink-500">{size(d.total || d.received)}</span>
									{local && (
										<button type="button" onClick={() => void call((c) => c.rpc("system.openIn", { app: "files", path: dirOf(d.path) }))} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-300 hover:bg-ink-800" title={t("reveal")}>
											<FolderOpen className="size-3" />
										</button>
									)}
									{!isTauri() && (
										<button
											type="button"
											onClick={() => void saveToDevice(d).then(() => toast(t("saved2", { name: d.name })), (e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"))}
											className="flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-300 hover:bg-ink-800"
											title={t("save")}
										>
											<Download className="size-3" />
										</button>
									)}
									<button type="button" onClick={() => void copyToClipboard(d.path)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-300 hover:bg-ink-800" title={t("copyPath")}>
										<Copy className="size-3" />
									</button>
								</div>
							)}
						</li>
					);
				})}
			</ul>
		</Popover>
	);
}
