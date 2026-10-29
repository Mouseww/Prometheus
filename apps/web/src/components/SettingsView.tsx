import { copyToClipboard } from "../lib/clipboard.ts";
import clsx from "clsx";
import { BarChart3, Blocks, Boxes, Bot, Cable, Check, Copy, FolderOpen, Globe, Laptop, Layers, Mic, Moon, Network, Package, Plug, Server, Shield, Sparkles, Sun, SlidersHorizontal, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { isAndroid, isDesktopShell, isTauri, loadMode } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { requestNotifyPermission } from "../lib/notify.ts";
import { switchLook } from "../lib/look.ts";
import { initRuntimes } from "../lib/runtimes.ts";
import { type Lang, SKINS, type SendMode, type Skin, setPrefs, type ThemeMode, usePrefs } from "../lib/prefs.ts";
import { openSettings, pluginActive, type SettingsTab, toast, updateHostSettings, useStore } from "../lib/store.ts";
import { checkForUpdate, showUpdate, updaterSupported, useUpdater } from "../lib/updater.ts";
import { GatewaysView } from "./GatewaysView.tsx";
import { FolderPicker } from "./FolderPicker.tsx";
import { MarketView } from "./MarketView.tsx";
import { ConnectorsView } from "./ConnectorsView.tsx";
import { McpView } from "./McpView.tsx";
import { NetworkSettings } from "./NetworkSettings.tsx";
import { AgentsSettings } from "./AgentsSettings.tsx";
import { RuntimesSettings } from "./RuntimesSettings.tsx";
import { PlatformsView } from "./PlatformsView.tsx";
import { SshView } from "./SshView.tsx";
import { PluginsView } from "./PluginsView.tsx";
import { ModesView } from "./ModesView.tsx";
import { SubagentsView } from "./SubagentsView.tsx";
import { VeilView } from "./VeilView.tsx";
import { SkillsView } from "./SkillsView.tsx";
import { Button, PageHeader } from "./ui.tsx";
import { UsageView } from "./UsageView.tsx";
import { VoiceSettings } from "./VoiceSettings.tsx";

const M = defineMessages({
	zh: {
		general: "通用",
		agents: "Agent",
		gateways: "AI 网关",
		mcp: "MCP",
		connectors: "连接器",
		skills: "技能",
		market: "PI 插件市场",
		plugins: "Prometheus 插件",
		modes: "模式",
		subagents: "子代理",
		veil: "隐私面罩",
		voice: "语音输入",
		network: "网络访问",
		runtimes: "运行环境",
		platforms: "多平台",
		ssh: "SSH",
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
		workspace: "工作区",
		workspaceRoot: "默认根目录",
		workspaceRootHint: "选择工作区时从这里开始，并可以直接在它下面新建文件夹作为新工作区。留空则使用服务端主目录。",
		workspaceRootEmpty: "未设置（使用主目录）",
		chooseRoot: "选择…",
		clearRoot: "清除",
		session: "会话",
		notifications: "通知",
		notifyOnDone: "任务完成时通知",
		notifyOnDoneHint: "每轮对话结束后，通过系统通知提醒你（Windows、macOS、Android 或浏览器）。首次开启会请求通知权限。",
		notifyBackgroundOnly: "仅在后台时通知",
		notifyBackgroundOnlyHint: "窗口在前台并处于焦点时不打扰你。",
		notifyDenied: "系统已拒绝通知权限。请在系统设置里允许 Prometheus 发送通知，然后重新开启。",
		notifyUnsupported: "当前环境不支持系统通知。",
		window: "窗口",
		closeToTray: "关闭时最小化到托盘",
		closeToTrayHint: "关闭窗口后 Prometheus 继续在后台运行，会话不会中断；点击托盘图标查看运行中的会话，右键可显示、隐藏或退出。",
		autoCompact: "自动压缩上下文",
		autoCompactHint: "上下文接近模型窗口上限时自动生成摘要并压缩。与 PI TUI 共享此设置。",
		chatWidth: "对话宽度",
		chatWidthHint: "也可以在对话页面里拖动内容两侧的边缘调整，双击边缘恢复自适应。",
		motion: "界面动效",
		motionHint: "窗口过渡、火苗光标、切换主题时的扩散动画等。关闭后界面立即切换。",
		splash: "启动动画",
		splashHint: "打开软件时播放“点火”开屏动画；关闭后启动期间只显示静态 Logo。",
		chatWidthAuto: "自适应",
		sendMode: "回复中发送时",
		sendModeHint: "Agent 还在回复时发送新消息：排队是等本轮结束后再发，插队是在当前工具调用结束后立即插入。也可以在发送按钮旁的箭头上切换。",
		sendFollowUp: "排队",
		sendSteer: "插队",
		updates: "更新",
		checkUpdate: "检查更新",
		checking: "检查中…",
		upToDate: "已是最新版本",
		newVersion: "发现新版本 {v}",
		viewUpdate: "查看并更新",
		updateHint: "桌面版的本机服务端随应用一同更新。",
		updateHintAndroid: "安卓版从 GitHub Release 下载新安装包，由系统安装。",
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
		agents: "Agents",
		gateways: "AI Gateways",
		mcp: "MCP",
		connectors: "Connectors",
		skills: "Skills",
		market: "PI Marketplace",
		plugins: "Prometheus Plugins",
		modes: "Modes",
		subagents: "Subagents",
		veil: "Privacy Mask",
		voice: "Voice",
		network: "Network access",
		runtimes: "Runtimes",
		platforms: "Platforms",
		ssh: "SSH",
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
		workspace: "Workspace",
		workspaceRoot: "Default root folder",
		workspaceRootHint: "The workspace picker starts here and you can create new folders under it right from the dialog. Leave empty to use the server's home directory.",
		workspaceRootEmpty: "Not set (home directory)",
		chooseRoot: "Choose…",
		clearRoot: "Clear",
		session: "Session",
		notifications: "Notifications",
		notifyOnDone: "Notify when a task finishes",
		notifyOnDoneHint: "Shows a system notification after each turn ends (Windows, macOS, Android or the browser). Turning it on asks for notification permission.",
		notifyBackgroundOnly: "Only when in the background",
		notifyBackgroundOnlyHint: "Stay quiet while the window is in front and focused.",
		notifyDenied: "The system denied notification permission. Allow notifications for Prometheus in system settings, then turn this on again.",
		notifyUnsupported: "System notifications are not supported here.",
		window: "Window",
		closeToTray: "Minimize to tray on close",
		closeToTrayHint: "Closing the window keeps Prometheus running in the background so sessions are not interrupted. Click the tray icon to see running sessions; right-click to show, hide or quit.",
		autoCompact: "Auto-compact context",
		autoCompactHint: "Summarise and compact automatically when the context nears the model's window. Shared with the PI TUI.",
		chatWidth: "Chat width",
		chatWidthHint: "You can also drag the edges beside the chat column; double-click an edge to go back to automatic.",
		motion: "Interface motion",
		motionHint: "Window transitions, the flame cursor, the ripple when switching themes. Off switches instantly.",
		splash: "Startup animation",
		splashHint: "Play the ignition splash when the app opens; when off, a still logo covers start-up instead.",
		chatWidthAuto: "Auto",
		sendMode: "When sending during a reply",
		sendModeHint: "What a message does when the agent is still replying: Queue waits for the turn to end, Steer cuts in after the current tool call. You can also switch from the arrow beside the send button.",
		sendFollowUp: "Queue",
		sendSteer: "Steer",
		updates: "Updates",
		checkUpdate: "Check for updates",
		checking: "Checking…",
		upToDate: "You are up to date",
		newVersion: "Version {v} is available",
		viewUpdate: "View and update",
		updateHint: "The desktop app's local server is updated together with the app.",
		updateHintAndroid: "The Android app downloads the new package from the GitHub release and the system installs it.",
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
		phase === "checking" ? t("checking") : phase === "uptodate" ? t("upToDate") : version && phase !== "error" ? t("newVersion", { v: version }) : phase === "error" ? t("updateFailed", { e: error ?? "" }) : t(isAndroid() ? "updateHintAndroid" : "updateHint");
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

function WorkspaceRootRow() {
	const t = useT(M);
	const host = useStore((s) => s.hostSettings);
	const [picking, setPicking] = useState(false);
	const root = host?.workspaceRoot ?? "";
	return (
		<>
			<Row label={t("workspaceRoot")} hint={t("workspaceRootHint")}>
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<span className="max-w-72 min-w-0 truncate rounded-md bg-ink-950/60 px-2 py-1 font-mono text-xs text-ink-300" title={root}>
						{root || <span className="text-ink-500">{t("workspaceRootEmpty")}</span>}
					</span>
					<Button variant="outline" disabled={!host} onClick={() => setPicking(true)}>
						<FolderOpen className="size-4" /> {t("chooseRoot")}
					</Button>
					{root && (
						<Button variant="ghost" onClick={() => void updateHostSettings({ workspaceRoot: "" })}>
							{t("clearRoot")}
						</Button>
					)}
				</div>
			</Row>
			{picking && (
				<FolderPicker
					onClose={() => setPicking(false)}
					onPick={(path) => {
						setPicking(false);
						void updateHostSettings({ workspaceRoot: path });
					}}
				/>
			)}
		</>
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
						void copyToClipboard(summary).then(
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
	const [notifyMsg, setNotifyMsg] = useState<string | null>(null);
	const toggleNotify = async (on: boolean) => {
		setNotifyMsg(null);
		if (!on) return setPrefs({ notifyOnDone: false });
		const perm = await requestNotifyPermission();
		if (perm === "granted") return setPrefs({ notifyOnDone: true });
		setPrefs({ notifyOnDone: false });
		setNotifyMsg(perm === "unsupported" ? t("notifyUnsupported") : t("notifyDenied"));
	};
	useEffect(() => {
		void updaterSupported().then(setCanUpdate);
	}, []);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="max-w-3xl space-y-8 p-4 md:p-8">
					<Section title={t("appearance")}>
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
						<Row label={t("theme")}>
							<Segmented<ThemeMode>
								value={prefs.theme}
								onChange={(theme) => switchLook({ theme })}
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
										onClick={(e) => switchLook({ skin: s.id as Skin }, e)}
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
						<Row label={t("motion")} hint={t("motionHint")}>
							<Toggle checked={prefs.motion} onChange={(motion) => setPrefs({ motion })} />
						</Row>
						<Row label={t("splash")} hint={t("splashHint")}>
							<Toggle checked={prefs.splash} onChange={(splash) => setPrefs({ splash })} />
						</Row>
						<Row label={t("chatWidth")} hint={t("chatWidthHint")}>
							<div className="flex items-center gap-3">
								<input
									type="range"
									min={640}
									max={1600}
									step={20}
									value={prefs.chatWidth ?? 880}
									onChange={(e) => setPrefs({ chatWidth: Number(e.target.value) })}
									className="w-40 accent-ember-500"
									aria-label={t("chatWidth")}
								/>
								<span className="w-14 font-mono text-xs text-ink-400">{prefs.chatWidth ? `${prefs.chatWidth}px` : t("chatWidthAuto")}</span>
								<button type="button" disabled={prefs.chatWidth === null} onClick={() => setPrefs({ chatWidth: null })} className="text-xs text-ember-300 hover:underline disabled:opacity-40">
									{t("chatWidthAuto")}
								</button>
							</div>
						</Row>
					</Section>

					<Section title={t("session")}>
						<Row label={t("autoCompact")} hint={t("autoCompactHint")}>
							<Toggle checked={host?.autoCompaction ?? false} disabled={!host} onChange={(v) => void updateHostSettings({ autoCompaction: v })} />
						</Row>
						<Row label={t("sendMode")} hint={t("sendModeHint")}>
							<Segmented<SendMode>
								value={prefs.sendMode}
								onChange={(sendMode) => setPrefs({ sendMode })}
								options={[
									{ value: "followUp", label: t("sendFollowUp") },
									{ value: "steer", label: t("sendSteer") },
								]}
							/>
						</Row>
					</Section>

					<Section title={t("notifications")}>
						<Row label={t("notifyOnDone")} hint={notifyMsg ?? t("notifyOnDoneHint")}>
							<Toggle checked={prefs.notifyOnDone} onChange={(v) => void toggleNotify(v)} />
						</Row>
						{prefs.notifyOnDone && (
							<Row label={t("notifyBackgroundOnly")} hint={t("notifyBackgroundOnlyHint")}>
								<Toggle checked={prefs.notifyBackgroundOnly} onChange={(notifyBackgroundOnly) => setPrefs({ notifyBackgroundOnly })} />
							</Row>
						)}
					</Section>

					<Section title={t("workspace")}>
						<WorkspaceRootRow />
					</Section>

					{isDesktopShell() && (
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

/**
 * Tabs in groups, each separated by a rule: the basics, then everything that shapes the agent
 * (what it says, who it delegates to, what it can reach), then extensions, then network and privacy,
 * then statistics. Voice sits beside the gateways because it needs one to transcribe.
 * A tab owned by a switchable plugin only shows while that plugin runs.
 */
const TAB_GROUPS: { id: SettingsTab; icon: typeof Network; plugin?: string; local?: boolean }[][] = [
	[
		{ id: "general", icon: SlidersHorizontal },
		{ id: "agents", icon: Bot },
		{ id: "gateways", icon: Network },
		{ id: "voice", icon: Mic, plugin: "voice" },
	],
	[
		{ id: "modes", icon: Layers, plugin: "modes" },
		{ id: "subagents", icon: Bot, plugin: "subagents" },
		{ id: "skills", icon: Sparkles },
		{ id: "mcp", icon: Cable },
		{ id: "connectors", icon: Plug },
		{ id: "ssh", icon: Terminal, plugin: "ssh" },
	],
	[
		{ id: "market", icon: Package },
		{ id: "plugins", icon: Blocks },
		{ id: "runtimes", icon: Boxes, local: true },
	],
	[
		{ id: "network", icon: Globe },
		{ id: "veil", icon: Shield, plugin: "veil" },
		{ id: "platforms", icon: Server },
	],
	[{ id: "usage", icon: BarChart3 }],
];

export function SettingsView() {
	const t = useT(M);
	const tab = useStore((s) => s.settingsTab);
	const plugins = useStore((s) => s.plugins);
	// Runtimes install into this machine, so the tab exists only where the shell can do that (local mode).
	const localShell = isTauri() && loadMode() !== "remote";
	useEffect(() => {
		void initRuntimes();
	}, []);
	const groups = TAB_GROUPS.map((g) => g.filter((x) => (!x.plugin || pluginActive(plugins, x.plugin)) && (!x.local || localShell))).filter((g) => g.length > 0);
	return (
		<div className="@container flex min-h-0 flex-1 flex-col overflow-hidden @2xl:flex-row">
			<nav className="flex shrink-0 gap-1 overflow-x-auto border-b hairline p-2 @2xl:block @2xl:w-44 @2xl:space-y-0.5 @2xl:overflow-x-visible @2xl:border-r @2xl:border-b-0 @2xl:p-3">
				{groups.map((group, i) => (
					<div key={group[0]?.id} className={clsx("flex shrink-0 gap-1 @2xl:block @2xl:space-y-0.5", i > 0 && "border-l hairline pl-1 @2xl:mt-2 @2xl:border-t @2xl:border-l-0 @2xl:pt-2 @2xl:pl-0")}>
						{group.map(({ id, icon: Icon }) => (
							<button
								key={id}
								type="button"
								onClick={() => openSettings(id)}
								className={clsx(
									"flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm whitespace-nowrap transition-colors @2xl:w-full",
									tab === id ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:bg-ink-850 hover:text-ink-100",
								)}
							>
								<Icon className={clsx("size-4 shrink-0", tab === id && "text-ember-400")} />
								<span className="min-w-0 truncate">{t(id)}</span>
							</button>
						))}
					</div>
				))}
			</nav>
			<div className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
				{tab === "general" && <GeneralSettings />}
				{tab === "agents" && <AgentsSettings />}
				{tab === "gateways" && <GatewaysView />}
				{tab === "mcp" && <McpView />}
				{tab === "connectors" && <ConnectorsView />}
				{tab === "skills" && <SkillsView />}
				{tab === "market" && <MarketView />}
				{tab === "voice" && <VoiceSettings />}
				{tab === "network" && <NetworkSettings />}
				{tab === "runtimes" && <RuntimesSettings />}
				{tab === "modes" && <ModesView />}
				{tab === "subagents" && <SubagentsView />}
				{tab === "veil" && <VeilView />}
				{tab === "platforms" && <PlatformsView />}
				{tab === "ssh" && <SshView />}
				{tab === "plugins" && <PluginsView />}
				{tab === "usage" && <UsageView />}
			</div>
		</div>
	);
}
