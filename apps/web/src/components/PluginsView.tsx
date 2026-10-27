import clsx from "clsx";
import { confirmDialog } from "../lib/dialogs.ts";
import { Blocks, CircleAlert, FolderSearch, Info, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { PluginInfo } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call, newChatIn, refreshPlugins, toast, useStore } from "../lib/store.ts";
import { Badge, Button, Dialog, Empty, PageHeader, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "Prometheus 插件",
		subtitle: "扩展本项目自身：网关、知识库、工具、命令、面板。PI 扩展包请到“PI 插件市场”安装",
		empty: "没有已加载的插件",
		externalNote: "在 Claude Code / Codex 下部分不可用：",
		panels: "面板：{list}",
		listSep: "、",
		source_builtin: "内置",
		source_config: "配置",
		source_directory: "本地",
		disabled: "已停用",
		enable: "启用",
		disable: "停用",
		reload: "重新加载",
		remove: "删除",
		confirmRemove: "删除插件「{name}」？它的文件会被移除，无法恢复。",
		enabledToast: "已启用 {name}",
		disabledToast: "已停用 {name}",
		reloaded: "已重新加载 {name}",
		removed: "已删除 {name}",
		scan: "扫描新插件",
		scanned: "已扫描：没有发现新插件",
		scannedN: "发现并加载了 {n} 个新插件",
		generate: "用 AI 生成插件",
		generateTitle: "让 AI 为你写一个插件",
		generateHint: "描述你想要的功能。AI 会写好代码，并在你确认后立即装上，无需重启。",
		generatePh: "例如：加一个查询天气的工具；或者：在侧栏加一个页面，显示当前项目的 TODO 注释",
		generateGo: "开始生成",
		generateNeedWs: "先在侧栏添加一个工作区，生成会在那里开始一次对话",
		builderSafety: "每次安装前都会显示全部代码并要求你确认。插件拥有和应用相同的权限，请只安装你看得懂、信得过的代码。",
		restartNote: "需要手动操作",
		howTitle: "手动编写插件",
		howBody: "把插件放进 ~/.prometheus/plugins/<名称>/（含 package.json 与 index.js），点上方「扫描新插件」即可加载，无需重启；修改代码后点「重新加载」。",
		trust: "插件以宿主进程权限运行，请只安装可信来源的插件。",
		stateBuiltin: "应用自带，不可停用",
	},
	en: {
		title: "Prometheus Plugins",
		subtitle: "Extend this app itself: gateways, knowledge, tools, commands, panels. For PI packages, use the PI Marketplace",
		empty: "No plugins loaded",
		externalNote: "Partly unavailable under Claude Code / Codex: ",
		panels: "Panels: {list}",
		listSep: ", ",
		source_builtin: "built-in",
		source_config: "config",
		source_directory: "local",
		disabled: "Disabled",
		enable: "Enable",
		disable: "Disable",
		reload: "Reload",
		remove: "Remove",
		confirmRemove: "Remove plugin \"{name}\"? Its files are deleted and can't be recovered.",
		enabledToast: "{name} enabled",
		disabledToast: "{name} disabled",
		reloaded: "{name} reloaded",
		removed: "{name} removed",
		scan: "Scan for new plugins",
		scanned: "Scanned: no new plugins found",
		scannedN: "Found and loaded {n} new plugin(s)",
		generate: "Generate with AI",
		generateTitle: "Have the AI write a plugin for you",
		generateHint: "Describe what you want. The AI writes the code and, once you confirm, installs it right away with no restart.",
		generatePh: "e.g. Add a tool that looks up the weather; or: add a sidebar page listing the TODO comments in this project",
		generateGo: "Start",
		generateNeedWs: "Add a workspace in the sidebar first; generation starts a chat there",
		builderSafety: "Every install shows you all of the code and asks for confirmation first. A plugin has the same permissions as the app: only install code you understand and trust.",
		restartNote: "Manual step needed",
		howTitle: "Writing one by hand",
		howBody: "Put the plugin in ~/.prometheus/plugins/<name>/ (with package.json and index.js), then press \"Scan for new plugins\" above. No restart needed; after editing the code press Reload.",
		trust: "Plugins run with host process permissions. Only install plugins from trusted sources.",
		stateBuiltin: "Part of the app, can't be switched off",
	},
});

function GenerateDialog({ onClose }: { onClose: () => void }) {
	const t = useT(M);
	const workspaces = useStore((s) => s.workspaces);
	const active = useStore((s) => s.session?.workspaceId);
	const [idea, setIdea] = useState("");
	const target = workspaces.find((w) => w.id === active) ?? workspaces[0];

	const go = async () => {
		if (!target || !idea.trim()) return;
		onClose();
		useStore.setState({ view: "chat" });
		await newChatIn(target);
		// The composer picks this up from the shared editor channel, so the user can adjust it before sending.
		useStore.setState({
			editorText: {
				text: `Use the prometheus_plugin_install tool to build a Prometheus plugin for me, and install it so it works without a restart. What I want:\n\n${idea.trim()}`,
				nonce: Date.now(),
			},
		});
	};

	return (
		<Dialog title={t("generateTitle")} onClose={onClose}>
			<p className="text-sm text-ink-400">{t("generateHint")}</p>
			<Textarea rows={5} autoFocus value={idea} onChange={(e) => setIdea(e.target.value)} placeholder={t("generatePh")} />
			{!target && <p className="text-xs text-ember-300">{t("generateNeedWs")}</p>}
			<p className="flex items-start gap-1.5 text-xs text-ink-500">
				<Info className="mt-0.5 size-3.5 shrink-0" /> {t("builderSafety")}
			</p>
			<div className="flex justify-end">
				<Button variant="primary" disabled={!target || !idea.trim()} onClick={() => void go()}>
					<Sparkles className="size-4" /> {t("generateGo")}
				</Button>
			</div>
		</Dialog>
	);
}

export function PluginsView() {
	const t = useT(M);
	const plugins = useStore((s) => s.plugins);
	const [busy, setBusy] = useState<string | null>(null);
	const [compat, setCompat] = useState<Record<string, string[]>>({});
	useEffect(() => {
		void call((c) => c.rpc("plugin.compatibility", {})).then((r) => setCompat(Object.fromEntries((r ?? []).map((x) => [x.plugin, x.warnings]))));
	}, [plugins]);
	const [generating, setGenerating] = useState(false);

	const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
		setBusy(id);
		const res = await fn();
		setBusy(null);
		if (res !== undefined) {
			toast(done);
			await refreshPlugins();
		}
	};

	const scan = async () => {
		const before = plugins.length;
		const list = await call((c) => c.rpc("plugin.scan", {}));
		if (!list) return;
		await refreshPlugins();
		const added = list.length - before;
		toast(added > 0 ? t("scannedN", { n: added }) : t("scanned"));
	};

	const row = (p: PluginInfo) => {
		const working = busy === p.id;
		return (
			<div key={p.id} className={clsx("animate-rise rounded-xl border bg-ink-900/60 p-4", p.status === "disabled" ? "border-ink-800/60" : "border-ink-800")}>
				<div className="flex flex-wrap items-center gap-2">
					<span className={clsx("size-2 shrink-0 rounded-full", p.status === "loaded" ? "bg-moss-400" : p.status === "disabled" ? "bg-ink-600" : "bg-rose-400")} />
					<span className={clsx("font-mono text-sm font-medium", p.status === "disabled" && "text-ink-500")}>{p.name}</span>
					{p.version && <span className="font-mono text-[11px] text-ink-500">v{p.version}</span>}
					{p.status === "disabled" && <Badge>{t("disabled")}</Badge>}
					<span className="flex-1" />
					<Badge tone={p.source === "builtin" ? "muted" : "ember"}>{t(`source_${p.source}`)}</Badge>
				</div>
				{p.error && (
					<p className="mt-2 flex items-start gap-1.5 text-xs text-rose-400">
						<CircleAlert className="mt-0.5 size-3.5 shrink-0" />
						<span className="min-w-0 break-words">{p.error}</span>
					</p>
				)}
				{p.notes.length > 0 && (
					<p className="mt-2 flex items-start gap-1.5 rounded-lg bg-ember-500/10 px-2.5 py-2 text-xs text-ember-200">
						<Info className="mt-0.5 size-3.5 shrink-0" />
						<span>
							<b>{t("restartNote")}: </b>
							{p.notes.join(" ")}
						</span>
					</p>
				)}
				{(compat[p.name] ?? compat[p.id])?.length ? (
					<p className="mt-2 flex items-start gap-1.5 rounded-lg bg-ink-800 px-2.5 py-2 text-xs text-ink-300">
						<Info className="mt-0.5 size-3.5 shrink-0" />
						<span>
							<b>{t("externalNote")}</b>
							{(compat[p.name] ?? compat[p.id])?.join("; ")}
						</span>
					</p>
				) : null}
				{p.panels.length > 0 && p.status === "loaded" && <p className="mt-2 text-xs text-ink-500">{t("panels", { list: p.panels.map((x) => x.title).join(t("listSep")) })}</p>}
				<div className="mt-3 flex flex-wrap items-center gap-1.5">
					{p.toggleable ? (
						<Button
							variant="outline"
							className="px-2.5 py-1 text-xs"
							disabled={working}
							onClick={() =>
								void act(p.id, () => call((c) => c.rpc("plugin.setEnabled", { id: p.id, enabled: p.status === "disabled" })), t(p.status === "disabled" ? "enabledToast" : "disabledToast", { name: p.name }))
							}
						>
							{p.status === "disabled" ? t("enable") : t("disable")}
						</Button>
					) : (
						<span className="text-[11px] text-ink-600">{t("stateBuiltin")}</span>
					)}
					{p.status !== "disabled" && p.source !== "builtin" && (
						<Button variant="ghost" className="px-2.5 py-1 text-xs" disabled={working} onClick={() => void act(p.id, () => call((c) => c.rpc("plugin.reload", { id: p.id })), t("reloaded", { name: p.name }))}>
							<RefreshCw className={clsx("size-3.5", working && "animate-spin")} /> {t("reload")}
						</Button>
					)}
					{p.removable && (
						<Button
							variant="danger"
							className="ml-auto px-2.5 py-1 text-xs"
							disabled={working}
							onClick={() => void confirmDialog(t("confirmRemove", { name: p.name })).then((ok) => { if (ok) void act(p.id, () => call((c) => c.rpc("plugin.remove", { id: p.id })), t("removed", { name: p.name })); })}
						>
							<Trash2 className="size-3.5" /> {t("remove")}
						</Button>
					)}
				</div>
			</div>
		);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<div className="flex items-center gap-2">
						<Button variant="outline" onClick={() => void scan()}>
							<FolderSearch className="size-4" /> {t("scan")}
						</Button>
						<Button variant="primary" onClick={() => setGenerating(true)}>
							<Sparkles className="size-4" /> {t("generate")}
						</Button>
					</div>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto p-4 @3xl:p-6">
				<div className="mx-auto max-w-4xl space-y-8">
					{plugins.length === 0 ? <Empty icon={<Blocks className="size-5" />} title={t("empty")} /> : <div className="grid gap-3 @3xl:grid-cols-2">{plugins.map(row)}</div>}

					<section className="rounded-2xl border border-ink-800 bg-ink-900/40 p-6">
						<h3 className="font-display text-lg font-semibold">{t("howTitle")}</h3>
						<p className="mt-1 text-sm text-ink-400">{t("howBody")}</p>
						<p className="mt-3 text-xs text-ink-500">{t("trust")}</p>
					</section>
				</div>
			</div>
			{generating && <GenerateDialog onClose={() => setGenerating(false)} />}
		</div>
	);
}
