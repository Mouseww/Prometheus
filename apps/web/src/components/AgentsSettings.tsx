import { Bot, CircleAlert, Download, Pencil, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AgentProfile, RuntimeInfo } from "@prometheus/protocol";
import { confirmDialog } from "../lib/dialogs.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call, callNewer, refreshRuntimes, toast, useStore } from "../lib/store.ts";
import { Badge, Button, Dialog, Empty, Field, Input, PageHeader, Select } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "Agent 运行时",
		subtitle: "对话由哪个 Agent 驱动。内置 PI、Claude Code、Codex，也可以基于 Claude Code 或 Codex 添加自己的 Agent，例如换一个可执行文件、配置目录或环境变量。",
		add: "添加 Agent",
		builtin: "内置",
		custom: "自定义",
		available: "可用",
		unavailable: "不可用",
		install: "一键安装",
		installing: "安装中…",
		installDone: "{name} 已安装",
		installHint: "会把 {pkg} 安装到 Prometheus 自己的目录，并加入这个运行时的 PATH；本机需要能用 npm。",
		installNoNpm: "没有安装，也无法在这里一键安装：找不到 npm。请先安装 Node.js，或给这个 Agent 指定已有的可执行文件。",
		sync: "同步会话",
		syncing: "同步中…",
		syncTitle: "把这个 Agent 自己保存的工作区和会话同步到 Prometheus",
		syncDone: "{name}：找到 {found} 个会话，新增 {added} 个，新增 {ws} 个工作区",
		uninstall: "卸载",
		confirmUninstall: "删除 Prometheus 为 {name} 安装的命令行工具？机器上其他位置安装的不受影响。",
		installedAt: "由 Prometheus 安装",
		oldServer: "已连接的服务器版本较旧，不支持多 Agent 运行时。请把服务器升级到 0.12.0 或更高版本。",
		piNote: "PI 内置，无需配置；它使用「AI 网关」里配置的模型。",
		executable: "可执行文件",
		fromPath: "PATH 中的默认命令",
		env: "{n} 个环境变量",
		disabled: "已隐藏",
		edit: "编辑",
		remove: "删除",
		reset: "恢复默认",
		confirmRemove: "删除 Agent「{name}」？已有的会话仍保留，但不能再继续。",
		confirmReset: "清除「{name}」的自定义设置？",
		newTitle: "添加 Agent",
		editTitle: "编辑 Agent",
		id: "ID",
		idHint: "小写字母、数字、-、_；创建后不可修改",
		name: "显示名称",
		base: "基于",
		executableHint: "留空则使用 PATH 中的 claude、codex 或 opencode。可填完整路径，例如另一个版本",
		envTitle: "环境变量",
		envHint: "只作用于这个 Agent 的进程，例如 CLAUDE_CONFIG_DIR、HTTPS_PROXY、CODEX_HOME 之外的自定义变量",
		envKey: "变量名",
		envValue: "值",
		addEnv: "添加变量",
		show: "在聊天里显示这个 Agent",
		save: "保存",
		saved: "已保存 Agent {name}",
		badId: "ID 只能用小写字母、数字、- 和 _，且以字母或数字开头",
		dupId: "这个 ID 已存在",
		empty: "还没有自定义 Agent",
		emptyBody: "添加后会出现在新建会话和对话里的 Agent 菜单中，模型来自它自己的登录和与之兼容的网关。",
		claudeCode: "Claude Code",
		codex: "Codex",
		opencode: "OpenCode",
	},
	en: {
		title: "Agent runtimes",
		subtitle: "Which agent drives a chat. PI, Claude Code and Codex are built in; you can add your own agents on top of Claude Code or Codex, for example with another executable, config directory or environment.",
		add: "Add agent",
		builtin: "Built in",
		custom: "Custom",
		available: "Available",
		unavailable: "Unavailable",
		install: "Install",
		installing: "Installing…",
		installDone: "{name} installed",
		installHint: "Installs {pkg} into Prometheus' own folder and puts it on this runtime's PATH. npm must be available on this machine.",
		installNoNpm: "It is not installed and cannot be installed here: npm was not found. Install Node.js, or point this agent at an existing executable.",
		sync: "Sync chats",
		syncing: "Syncing…",
		syncTitle: "Bring the workspaces and chats this agent keeps in its own store into Prometheus",
		syncDone: "{name}: found {found} chats, added {added}, {ws} new workspaces",
		uninstall: "Uninstall",
		confirmUninstall: "Remove the CLI that Prometheus installed for {name}? An installation elsewhere on this machine is left alone.",
		installedAt: "Installed by Prometheus",
		oldServer: "The connected server is older and has no agent runtimes. Upgrade it to 0.12.0 or later.",
		piNote: "PI is built in and needs no setup; it uses the models set up under AI Gateways.",
		executable: "Executable",
		fromPath: "Default command on PATH",
		env: "{n} environment variables",
		disabled: "Hidden",
		edit: "Edit",
		remove: "Delete",
		reset: "Reset",
		confirmRemove: "Delete agent \"{name}\"? Existing chats are kept but cannot be continued.",
		confirmReset: "Clear the custom settings of \"{name}\"?",
		newTitle: "Add agent",
		editTitle: "Edit agent",
		id: "ID",
		idHint: "Lowercase letters, digits, - and _; cannot be changed later",
		name: "Display name",
		base: "Based on",
		executableHint: "Empty uses claude, codex or opencode from PATH. A full path picks another build",
		envTitle: "Environment variables",
		envHint: "Applied to this agent's process only, e.g. CLAUDE_CONFIG_DIR or HTTPS_PROXY",
		envKey: "Name",
		envValue: "Value",
		addEnv: "Add variable",
		show: "Show this agent in chats",
		save: "Save",
		saved: "Saved agent {name}",
		badId: "The ID may only use lowercase letters, digits, - and _, starting with a letter or digit",
		dupId: "This ID already exists",
		empty: "No custom agents yet",
		emptyBody: "Once added it appears in the agent menu of new chats and open chats; its models come from its own login and the gateways it can use.",
		claudeCode: "Claude Code",
		codex: "Codex",
		opencode: "OpenCode",
	},
});

const KIND_LABEL = { "claude-code": "claudeCode", codex: "codex", opencode: "opencode" } as const;

/** The npm package that provides each CLI, shown in the install hint. */
const NPM_PACKAGE: Record<AgentProfile["kind"], string> = { "claude-code": "@anthropic-ai/claude-code", codex: "@openai/codex", opencode: "opencode-ai" };

function blank(): AgentProfile {
	return { id: "", name: "", kind: "claude-code", enabled: true };
}

export function AgentsSettings() {
	const t = useT(M);
	const runtimes = useStore((s) => s.runtimes);
	const [agents, setAgents] = useState<AgentProfile[]>([]);
	const [editing, setEditing] = useState<{ agent: AgentProfile; isNew: boolean } | null>(null);
	const [supported, setSupported] = useState(true);
	const [busyId, setBusyId] = useState<string | null>(null);

	const load = useCallback(async () => {
		const list = await callNewer("agent.list", (c) => c.rpc("agent.list", {}));
		setSupported(list !== undefined);
		if (list) setAgents(list);
		await refreshRuntimes();
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const health = (id: string): RuntimeInfo | undefined => runtimes.find((r) => r.id === id);

	const install = async (a: AgentProfile) => {
		setBusyId(a.id);
		try {
			await call((c) => c.rpc("agent.install", { kind: a.kind }));
			toast(t("installDone", { name: a.name }), "info");
		} catch (e) {
			toast(e instanceof Error ? e.message : String(e), "error");
		} finally {
			setBusyId(null);
			await load();
		}
	};

	const sync = async (a: AgentProfile) => {
		setBusyId(a.id);
		try {
			const r = await call((c) => c.rpc("agent.syncSessions", { id: a.id }));
			if (r) toast(t("syncDone", { name: a.name, found: r.found, added: r.added, ws: r.workspaces }), "info");
		} finally {
			setBusyId(null);
		}
	};

	const uninstall = async (a: AgentProfile) => {
		if (!(await confirmDialog(t("confirmUninstall", { name: a.name }), { danger: true }))) return;
		setBusyId(a.id);
		try {
			await call((c) => c.rpc("agent.uninstall", { kind: a.kind }));
		} finally {
			setBusyId(null);
			await load();
		}
	};

	const remove = async (a: AgentProfile) => {
		const ok = await confirmDialog(t(a.builtin ? "confirmReset" : "confirmRemove", { name: a.name }), { danger: true });
		if (!ok) return;
		await call((c) => c.rpc("agent.delete", { id: a.id }));
		await load();
	};

	return (
		<>
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<Button variant="primary" disabled={!supported} onClick={() => setEditing({ agent: blank(), isNew: true })}>
						<Plus className="size-4" /> {t("add")}
					</Button>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 @3xl:px-8">
				<div className="mx-auto max-w-3xl space-y-3">
					{!supported && <p className="rounded-lg bg-ember-500/10 px-3 py-2.5 text-sm text-ember-200">{t("oldServer")}</p>}
					<p className="flex items-start gap-2 rounded-lg bg-ink-850 px-3 py-2.5 text-sm text-ink-400">
						<Bot className="mt-0.5 size-4 shrink-0" /> {t("piNote")}
					</p>
					{agents.map((a) => {
						const info = health(a.id);
						return (
							<div key={a.id} className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-sm font-medium text-ink-100">{a.name}</span>
									<Badge tone="ember">{t(KIND_LABEL[a.kind])}</Badge>
									<Badge>{a.builtin ? t("builtin") : t("custom")}</Badge>
									{a.enabled === false && <Badge>{t("disabled")}</Badge>}
									<span className="flex-1" />
									{info && <Badge tone={info.health.available ? "moss" : "rose"}>{info.health.available ? `${t("available")}${info.health.version ? ` ${info.health.version}` : ""}` : t("unavailable")}</Badge>}
								</div>
								{info && !info.health.available && info.health.reason && (
									<p className="mt-2 flex items-start gap-1.5 text-xs text-rose-400">
										<CircleAlert className="mt-0.5 size-3.5 shrink-0" />
										<span className="min-w-0 break-words">{info.health.reason}</span>
									</p>
								)}
								{info && !info.health.available && (
									<p className="mt-1.5 text-xs text-ink-500">{info.health.installable === false ? t("installNoNpm") : t("installHint", { pkg: NPM_PACKAGE[a.kind] })}</p>
								)}
								<dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-ink-400 @xl:grid-cols-[auto_1fr]">
									<dt>{t("executable")}</dt>
									<dd className="min-w-0 truncate font-mono text-ink-300">{a.executable || t("fromPath")}</dd>
									{info?.health.installed && (
										<>
											<dt>{t("installedAt")}</dt>
											<dd className="min-w-0 truncate font-mono text-ink-300">{info.health.installed}</dd>
										</>
									)}
									{Object.keys(a.env ?? {}).length > 0 && (
										<>
											<dt>{t("envTitle")}</dt>
											<dd className="min-w-0 truncate font-mono text-ink-300">{Object.keys(a.env ?? {}).join(", ")}</dd>
										</>
									)}
								</dl>
								<div className="mt-3 flex flex-wrap items-center gap-1.5">
									{info && !info.health.available && info.health.installable !== false && (
										<Button variant="primary" className="px-2.5 py-1 text-xs" disabled={busyId === a.id} onClick={() => void install(a)}>
											<Download className="size-3.5" /> {t(busyId === a.id ? "installing" : "install")}
										</Button>
									)}
									{info?.health.available && (
										<Button variant="outline" className="px-2.5 py-1 text-xs" title={t("syncTitle")} disabled={busyId === a.id} onClick={() => void sync(a)}>
											<RefreshCw className={`size-3.5 ${busyId === a.id ? "animate-spin" : ""}`} /> {t(busyId === a.id ? "syncing" : "sync")}
										</Button>
									)}
									{info?.health.installed && (
										<Button variant="ghost" className="px-2.5 py-1 text-xs" disabled={busyId === a.id} onClick={() => void uninstall(a)}>
											<Trash2 className="size-3.5" /> {t("uninstall")}
										</Button>
									)}
									<Button variant="outline" className="px-2.5 py-1 text-xs" onClick={() => setEditing({ agent: structuredClone(a), isNew: false })}>
										<Pencil className="size-3.5" /> {t("edit")}
									</Button>
									{a.builtin ? (
										<Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => void remove(a)}>
											<RotateCcw className="size-3.5" /> {t("reset")}
										</Button>
									) : (
										<Button variant="ghost" className="px-2.5 py-1 text-xs text-rose-400" onClick={() => void remove(a)}>
											<Trash2 className="size-3.5" /> {t("remove")}
										</Button>
									)}
								</div>
							</div>
						);
					})}
					{supported && agents.every((a) => a.builtin) && <Empty icon={<Bot className="size-6" />} title={t("empty")}>{t("emptyBody")}</Empty>}
				</div>
			</div>
			{editing && (
				<AgentEditor
					initial={editing.agent}
					isNew={editing.isNew}
					taken={agents.map((a) => a.id)}
					onClose={() => setEditing(null)}
					onSaved={async (saved) => {
						setEditing(null);
						toast(t("saved", { name: saved.name }), "info");
						await load();
					}}
				/>
			)}
		</>
	);
}

function AgentEditor({ initial, isNew, taken, onClose, onSaved }: { initial: AgentProfile; isNew: boolean; taken: string[]; onClose: () => void; onSaved: (a: AgentProfile) => void | Promise<void> }) {
	const t = useT(M);
	const [a, setA] = useState<AgentProfile>(initial);
	const [env, setEnv] = useState<[string, string][]>(Object.entries(initial.env ?? {}));
	const [busy, setBusy] = useState(false);
	const patch = (p: Partial<AgentProfile>) => setA((x) => ({ ...x, ...p }));
	const idOk = /^[a-z0-9][a-z0-9-_]{0,47}$/.test(a.id);
	const dup = isNew && taken.includes(a.id);

	const save = async () => {
		setBusy(true);
		try {
			const draft: AgentProfile = { ...a, env: Object.fromEntries(env.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])) };
			const saved = await call((c) => c.rpc("agent.save", { agent: draft }));
			if (saved) await onSaved(saved);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog title={t(isNew ? "newTitle" : "editTitle")} onClose={onClose}>
			<div className="space-y-4">
				<div className="grid gap-4 @xl:grid-cols-2">
					<Field label={t("id")} hint={t("idHint")}>
						<Input value={a.id} disabled={!isNew} onChange={(e) => patch({ id: e.target.value })} placeholder="claude-work" />
					</Field>
					<Field label={t("name")}>
						<Input value={a.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Claude Code (work)" />
					</Field>
				</div>
				{isNew && !a.id ? null : isNew && !idOk ? <p className="text-xs text-rose-400">{t("badId")}</p> : dup ? <p className="text-xs text-rose-400">{t("dupId")}</p> : null}
				<Field label={t("base")}>
					<Select value={a.kind} disabled={!isNew || a.builtin} onChange={(e) => patch({ kind: e.target.value as AgentProfile["kind"] })}>
						<option value="claude-code">{t("claudeCode")}</option>
						<option value="codex">{t("codex")}</option>
						<option value="opencode">{t("opencode")}</option>
					</Select>
				</Field>
				<Field label={t("executable")} hint={t("executableHint")}>
					<Input value={a.executable ?? ""} onChange={(e) => patch({ executable: e.target.value })} className="font-mono" placeholder={a.kind === "codex" ? "codex" : a.kind === "opencode" ? "opencode" : "claude"} />
				</Field>
				<Field label={t("envTitle")} hint={t("envHint")}>
					<div className="space-y-2">
						{env.map(([k, v], i) => (
							<div key={i} className="flex gap-2">
								<Input value={k} onChange={(e) => setEnv((x) => x.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} className="w-2/5 font-mono" placeholder={t("envKey")} />
								<Input value={v} onChange={(e) => setEnv((x) => x.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} className="min-w-0 flex-1 font-mono" placeholder={t("envValue")} />
								<Button variant="ghost" className="px-2" onClick={() => setEnv((x) => x.filter((_, j) => j !== i))} aria-label={t("remove")}>
									<Trash2 className="size-4" />
								</Button>
							</div>
						))}
						<Button variant="outline" className="px-2.5 py-1 text-xs" onClick={() => setEnv((x) => [...x, ["", ""]])}>
							<Plus className="size-3.5" /> {t("addEnv")}
						</Button>
					</div>
				</Field>
				<label className="flex items-center gap-2 text-sm text-ink-300">
					<input type="checkbox" checked={a.enabled !== false} onChange={(e) => patch({ enabled: e.target.checked })} />
					{t("show")}
				</label>
				<div className="flex justify-end">
					<Button variant="primary" disabled={busy || !a.name.trim() || (isNew && (!idOk || dup))} onClick={() => void save()}>
						{t("save")}
					</Button>
				</div>
			</div>
		</Dialog>
	);
}
