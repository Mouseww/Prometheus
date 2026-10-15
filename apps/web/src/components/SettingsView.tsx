import clsx from "clsx";
import { Blocks, Cable, Check, Laptop, Moon, Network, Sparkles, Sun, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { type Lang, SKINS, type Skin, setPrefs, type ThemeMode, usePrefs } from "../lib/prefs.ts";
import { openSettings, type SettingsTab, updateHostSettings, useStore } from "../lib/store.ts";
import { GatewaysView } from "./GatewaysView.tsx";
import { McpView } from "./McpView.tsx";
import { PluginsView } from "./PluginsView.tsx";
import { SkillsView } from "./SkillsView.tsx";
import { PageHeader } from "./ui.tsx";

const M = defineMessages({
	zh: {
		general: "通用",
		gateways: "AI 网关",
		mcp: "MCP",
		skills: "技能",
		plugins: "插件",
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
		autoCompact: "自动压缩上下文",
		autoCompactHint: "上下文接近模型窗口上限时自动生成摘要并压缩。与 PI TUI 共享此设置。",
	},
	en: {
		general: "General",
		gateways: "AI Gateways",
		mcp: "MCP",
		skills: "Skills",
		plugins: "Plugins",
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
		autoCompact: "Auto-compact context",
		autoCompactHint: "Summarise and compact automatically when the context nears the model's window. Shared with the PI TUI.",
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

function GeneralSettings() {
	const t = useT(M);
	const prefs = usePrefs();
	const host = useStore((s) => s.hostSettings);

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
	{ id: "plugins", icon: Blocks },
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
				{tab === "plugins" && <PluginsView />}
			</div>
		</div>
	);
}
