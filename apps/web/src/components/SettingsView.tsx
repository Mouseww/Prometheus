import clsx from "clsx";
import { BarChart3, Blocks, Cable, Check, Copy, Laptop, Moon, Network, Package, Sparkles, Sun, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { isTauri } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { type Lang, SKINS, type Skin, setPrefs, type ThemeMode, usePrefs } from "../lib/prefs.ts";
import { openSettings, type SettingsTab, toast, updateHostSettings, useStore } from "../lib/store.ts";
import { checkForUpdate, showUpdate, updaterSupported, useUpdater } from "../lib/updater.ts";
import { GatewaysView } from "./GatewaysView.tsx";
import { MarketView } from "./MarketView.tsx";
import { McpView } from "./McpView.tsx";
import { PluginsView } from "./PluginsView.tsx";
import { SkillsView } from "./SkillsView.tsx";
import { Button, PageHeader } from "./ui.tsx";
import { UsageView } from "./UsageView.tsx";

const M = defineMessages({
	zh: {
		general: "通用",
		gateways: "AI 网关",
		mcp: "MCP",
		skills: "技能",
		market: "PI 插件市场",
		plugins: "Prometheus 插件",
		usage: "用量统计",
		title: "通用设置",
		subtitle: "外观、语言与会话行为",
		appearance: "外观",
		theme: "主题",
		dark: "深色",
		light: "浅色",
		system: "跟随系统",
		skin: "皮肤",
		ember: "余烬",
		ocean: "深海",
		forest: "森林",
		violet: "星云",
		rose: "玫瑰",
		language: "语言",
		session: "会话",
		window: "窗口",
		closeToTray: "关闭时最小化到托盘",
		closeToTrayHint: "关闭窗口后 Prometheus 继续在后台运行，会话不会中断；点击托盘图标查看运行中的会话，右键可显示、隐藏或退出。",
		autoCompact: "自动压缩上下文",
		autoCompactHint: "上下文接近模型窗口上限时自动生成摘要并压缩。与 PI TUI 共享此设置。",
		updates: "更新",
		checkUpdate: "检查更新",
		checking: "检查中…",
		upToDate: "已是最新版本",
		newVersion: "发现新版本 {v}",
		viewUpdate: "查看并更新",
		updateHint: "桌面版的本机服务端随应用一同更新。",
		updateFailed: "检查失败：{e}",
		about: "关于",
		appVersion: "客户端版本",
		serverVersion: "服务端版本",
		piVersion: "PI Agent 版本",
		mismatch: "与客户端版本不一致",
		copyVersion: "复制版本信息",
		copied: "已复制",
	},
	en: {
		general: "General",
		gateways: "AI Gateways",
		mcp: "MCP",
		skills: "Skills",
		market: "PI Marketplace",
		plugins: "Prometheus Plugins",
		usage: "Usage",
		title: "General",
		subtitle: "Appearance, language and session behaviour",
		appearance: "Appearance",
		theme: "Theme",
		dark: "Dark",
		light: "Light",
		system: "System",
		skin: "Skin",
		ember: "Ember",
		ocean: "Ocean",
		forest: "Forest",
		violet: "Nebula",
		rose: "Rose",
		language: "Language",
		session: "Session",
		window: "Window",
		closeToTray: "Minimize to tray on close",
		closeToTrayHint: "Closing the window keeps Prometheus running in the background so sessions are not interrupted. Click the tray icon to see running sessions; right-click to show, hide or quit.",
		autoCompact: "Auto-compact context",
		autoCompactHint: "Summarise and compact automatically when the context nears the model's window. Shared with the PI TUI.",
		updates: "Updates",
		checkUpdate: "Check for updates",
		checking: "Checking…",
		upToDate: "You are up to date",
		newVersion: "Version {v} is available",
		viewUpdate: "View and update",
		updateHint: "The desktop app's local server is updated together with the app.",
		updateFailed: "Check failed: {e}",
		about: "About",
		appVersion: "Client version",
		serverVersion: "Server version",
		piVersion: "PI Agent version",
		mismatch: "Differs from the client version",
		copyVersion: "Copy version info",
		copied: "Copied",
	},
});

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="space-y-3">
			<h2 className="font-mono text-[10.5px] tracking-[0.18em] text-ink-500 uppercase">{title}</h2>
			<div className="divide-y divide-ink-800 rounded-xl border border-ink-800 bg-ink-900/50">{children}</div>
		</section>
	);
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-4 px-4 py-3.5">
			<div className="min-w-48 flex-1">
				<div className="text-sm text-ink-100">{label}</div>
				{hint && <div className="mt-0.5 text-xs text-ink-500">{hint}</div>}
			</div>
			{children}
		</div>
	);
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void }) {
	return (
		<div className="flex rounded-lg border border-ink-700 bg-ink-950/60 p-0.5">
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					onClick={() => onChange(o.value)}
					className={clsx(
						"flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors",
						value === o.value ? "bg-ink-800 text-ink-100 shadow-sm" : "text-ink-400 hover:text-ink-200",
					)}
				>
					{o.icon}
					{o.label}
				</button>
			))}
		</div>
	);
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={clsx("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40", checked ? "bg-ember-500" : "bg-ink-700")}
		>
			<span className={clsx("absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform", checked && "translate-x-5")} />
		</button>
	);
}

function UpdateRow() {
	const t = useT(M);
	const { phase, version, error } = useUpdater();
	const busy = phase === "checking" || phase === "installing";
	const status =
		phase === "checking" ? t("checking") : phase === "uptodate" ? t("upToDate") : version && phase !== "error" ? t("newVersion", { v: version }) : phase === "error" ? t("updateFailed", { e: error ?? "" }) : t("updateHint");
	return (
		<Row label={t("checkUpdate")} hint={status}>
			{phase === "available" ? (
				<Button variant="primary" onClick={showUpdate}>
					{t("viewUpdate")}
				</Button>
			) : (
				<Button variant="outline" disabled={busy} onClick={() => void checkForUpdate()}>
					{t("checkUpdate")}
				</Button>
			)}
		</Row>
	);
}

function AboutRow() {
	const t = useT(M);
	const info = useStore((s) => s.hostInfo);
	const client = __APP_VERSION__;
	const server = info?.version;
	const differs = Boolean(server) && server !== client;
	const summary = `Prometheus ${client}${server ? ` (server ${server}, PI ${info?.piVersion})` : ""} · ${info?.platform ?? navigator.platform}`;
	return (
		<>
			<Row label={t("appVersion")}>
				<span className="font-mono text-sm text-ink-200">v{client}</span>
			</Row>
			<Row label={t("serverVersion")} hint={differs ? t("mismatch") : undefined}>
				<span className={clsx("font-mono text-sm", differs ? "text-ember-300" : "text-ink-200")}>{server ? `v${server}` : "—"}</span>
			</Row>
			<Row label={t("piVersion")}>
				<span className="font-mono text-sm text-ink-200">{info?.piVersion ? `v${info.piVersion}` : "—"}</span>
			</Row>
			<Row label={t("copyVersion")}>
				<Button
					variant="outline"
					onClick={() =>
						void navigator.clipboard.writeText(summary).then(
							() => toast(t("copied")),
							() => toast(summary),
						)
					}
				>
					<Copy className="size-4" /> {t("copyVersion")}
				</Button>
			</Row>
		</>
	);
}

function GeneralSettings() {
	const t = useT(M);
	const prefs = usePrefs();
	const host = useStore((s) => s.hostSettings);
	const [canUpdate, setCanUpdate] = useState(false);
	useEffect(() => {
		void updaterSupported().then(setCanUpdate);
	}, []);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="max-w-3xl space-y-8 p-8">
					<Section title={t("appearance")}>
						<Row label={t("theme")}>
							<Segmented<ThemeMode>
								value={prefs.theme}
								onChange={(theme) => setPrefs({ theme })}
								options={[
									{ value: "dark", label: t("dark"), icon: <Moon className="size-3.5" /> },
									{ value: "light", label: t("light"), icon: <Sun className="size-3.5" /> },
									{ value: "system", label: t("system"), icon: <Laptop className="size-3.5" /> },
								]}
							/>
						</Row>
						<Row label={t("skin")}>
							<div className="flex flex-wrap gap-2">
								{SKINS.map((s) => (
									<button
										key={s.id}
										type="button"
										onClick={() => setPrefs({ skin: s.id as Skin })}
										className={clsx(
											"flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
											prefs.skin === s.id ? "border-ink-400 bg-ink-800 text-ink-100" : "border-ink-700 text-ink-400 hover:border-ink-500",
										)}
									>
										<span className="grid size-4 place-items-center rounded-full" style={{ background: s.swatch }}>
											{prefs.skin === s.id && <Check className="size-3 text-white" strokeWidth={3} />}
										</span>
										{t(s.id)}
									</button>
								))}
							</div>
						</Row>
						<Row label={t("language")}>
							<Segmented<Lang>
								value={prefs.lang}
								onChange={(lang) => setPrefs({ lang })}
								options={[
									{ value: "zh", label: "简体中文" },
									{ value: "en", label: "English" },
								]}
							/>
						</Row>
					</Section>

					<Section title={t("session")}>
						<Row label={t("autoCompact")} hint={t("autoCompactHint")}>
							<Toggle checked={host?.autoCompaction ?? false} disabled={!host} onChange={(v) => void updateHostSettings({ autoCompaction: v })} />
						</Row>
					</Section>

					{isTauri() && (
						<Section title={t("window")}>
							<Row label={t("closeToTray")} hint={t("closeToTrayHint")}>
								<Toggle checked={prefs.closeToTray} onChange={(closeToTray) => setPrefs({ closeToTray })} />
							</Row>
						</Section>
					)}

					{canUpdate && (
						<Section title={t("updates")}>
							<UpdateRow />
						</Section>
					)}

					<Section title={t("about")}>
						<AboutRow />
					</Section>
				</div>
			</div>
		</div>
	);
}

const TABS: { id: SettingsTab; icon: typeof Network }[] = [
	{ id: "general", icon: SlidersHorizontal },
	{ id: "gateways", icon: Network },
	{ id: "mcp", icon: Cable },
	{ id: "skills", icon: Sparkles },
	{ id: "market", icon: Package },
	{ id: "plugins", icon: Blocks },
	{ id: "usage", icon: BarChart3 },
];

export function SettingsView() {
	const t = useT(M);
	const tab = useStore((s) => s.settingsTab);
	return (
		<div className="flex min-h-0 flex-1">
			<nav className="w-48 shrink-0 space-y-0.5 border-r hairline p-3">
				{TABS.map(({ id, icon: Icon }) => (
					<button
						key={id}
						type="button"
						onClick={() => openSettings(id)}
						className={clsx(
							"flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
							tab === id ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:bg-ink-850 hover:text-ink-100",
						)}
					>
						<Icon className={clsx("size-4", tab === id && "text-ember-400")} />
						{t(id)}
					</button>
				))}
			</nav>
			<div className="flex min-w-0 flex-1 flex-col">
				{tab === "general" && <GeneralSettings />}
				{tab === "gateways" && <GatewaysView />}
				{tab === "mcp" && <McpView />}
				{tab === "skills" && <SkillsView />}
				{tab === "market" && <MarketView />}
				{tab === "plugins" && <PluginsView />}
				{tab === "usage" && <UsageView />}
			</div>
		</div>
	);
}
