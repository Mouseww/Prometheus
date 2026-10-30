import { ArrowUpCircle, Bot, CircleAlert, Download, Pencil, Plus, RefreshCw, RotateCcw, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ACP_PRESETS, type AgentProfile, type AgentServer, type AgentUpdateInfo, agentPreset, type RuntimeInfo } from "@prometheus/protocol";
import { confirmDialog } from "../lib/dialogs.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call, callNewer, refreshHostSettings, refreshRuntimes, setDefaultAgent, toast, useStore } from "../lib/store.ts";
import { Badge, Button, Dialog, Empty, Field, Input, PageHeader, Select } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "Agent 运行时",
		subtitle: "对话由哪个 Agent 驱动。内置 PI、Claude Code、Codex、OpenCode、Qwen Code；任何支持 ACP（Agent Client Protocol）的 Agent 都能添加，例如 Goose、Kimi CLI。OpenCode 还可以连接一个常驻的 opencode 服务。",
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
		installManual: "没有找到它的命令。请按它自己的说明安装，或在编辑里填写可执行文件的完整路径。",
		checkUpdates: "检查更新",
		checking: "检查中…",
		upToDate: "均为最新版本",
		updatesFound: "{n} 个 Agent 有新版本",
		updateBadge: "可更新 {from} → {to}",
		updateTo: "更新到 {v}",
		updating: "更新中…",
		updateDone: "{name} 已更新到 {v}，新会话起生效",
		updateHintPrometheus: "用 npm 把 Prometheus 目录里的这份升级到最新版",
		updateHintPath: "它不是用 npm 装的，Prometheus 无法替它更新，请用你安装它的方式更新",
		updateHintNpm: "用 npm 在它所在的位置升级到最新版",
		updateHintBundled: "当前使用的是 Prometheus 内置的版本。更新会在 Prometheus 自己的目录安装最新版，之后优先使用它",
		updateCustom: "使用自定义可执行文件，请自行更新",
		updateServer: "连接的是外部服务，请在服务所在机器上更新",
		updateNoPackage: "不是通过 npm 发布的，请按它自己的方式更新",
		updateCheckFailed: "无法获取最新版本：{error}",
		version: "版本",
		sync: "同步会话",
		syncing: "同步中…",
		syncTitle: "把这个 Agent 自己保存的工作区和会话同步到 Prometheus",
		syncDone: "{name}：找到 {found} 个会话，新增 {added} 个，新增 {ws} 个工作区",
		uninstall: "卸载",
		confirmUninstall: "删除 Prometheus 为 {name} 安装的命令行工具？机器上其他位置安装的不受影响。",
		installedAt: "由 Prometheus 安装",
		oldServer: "已连接的服务器版本较旧，不支持多 Agent 运行时。请把服务器升级到 0.12.0 或更高版本。",
		piNote: "PI 内置，无需配置；它使用「AI 网关」里配置的模型。",
		default: "默认",
		setDefault: "设为默认",
		setDefaultTitle: "新建会话时默认使用这个 Agent",
		defaultSet: "新会话将默认使用 {name}",
		defaultHidden: "已隐藏的 Agent 不能设为默认",
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
		executableHint: "留空则使用 PATH 中的默认命令（claude、codex、opencode，或预设的 ACP 命令）。可填完整路径，例如另一个版本",
		args: "启动参数",
		argsHint: "以空格分隔，含空格的参数用引号括起来。ACP Agent 需要让它进入 ACP 模式的参数，例如 --acp",
		preset: "预设",
		presetCustom: "其他 ACP Agent",
		presetHint: "选择一个常见的 ACP Agent 自动填写命令和参数；未列出的选「其他」自己填写",
		serverTitle: "运行方式",
		serverPerChat: "每个会话一个进程（默认）",
		serverAttach: "连接已运行的 opencode 服务",
		serverShared: "启动一个固定端口的共享服务",
		serverHint: "连接服务时使用该服务自己配置的模型与登录，不能选 Prometheus 网关；Prometheus 工具只对同一台机器上的服务可用。共享服务供所有会话使用，你也可以用 opencode attach 接入同一个服务。",
		serverUrl: "服务地址",
		serverPort: "端口",
		serverUser: "用户名",
		serverPassword: "密码",
		serverPasswordHint: "对应服务的 OPENCODE_SERVER_PASSWORD；共享服务留空则使用随机密码（外部客户端无法接入）",
		server: "服务",
		argsLabel: "参数",
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
		acp: "ACP Agent",
	},
	en: {
		title: "Agent runtimes",
		subtitle: "Which agent drives a chat. PI, Claude Code, Codex, OpenCode and Qwen Code are built in; any agent that speaks ACP (Agent Client Protocol), such as Goose or Kimi CLI, can be added. OpenCode can also use a long-running opencode server.",
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
		installManual: "Its command was not found. Install it as its own documentation describes, or enter the full path of the executable under Edit.",
		checkUpdates: "Check for updates",
		checking: "Checking…",
		upToDate: "Every agent is up to date",
		updatesFound: "Updates available for {n} agents",
		updateBadge: "Update {from} → {to}",
		updateTo: "Update to {v}",
		updating: "Updating…",
		updateDone: "{name} updated to {v}; new chats use it",
		updateHintPrometheus: "Upgrades the copy in Prometheus' folder to the latest version with npm",
		updateHintPath: "It was not installed with npm, so Prometheus cannot update it; update it the way you installed it",
		updateHintNpm: "Upgrades it with npm where it is installed",
		updateHintBundled: "The version bundled with Prometheus is in use. Updating installs the latest version into Prometheus' own folder and uses it from then on",
		updateCustom: "Uses a custom executable; update it yourself",
		updateServer: "Connects to an external server; update it where the server runs",
		updateNoPackage: "Not published on npm; update it the way it was installed",
		updateCheckFailed: "Could not look up the latest version: {error}",
		version: "Version",
		sync: "Sync chats",
		syncing: "Syncing…",
		syncTitle: "Bring the workspaces and chats this agent keeps in its own store into Prometheus",
		syncDone: "{name}: found {found} chats, added {added}, {ws} new workspaces",
		uninstall: "Uninstall",
		confirmUninstall: "Remove the CLI that Prometheus installed for {name}? An installation elsewhere on this machine is left alone.",
		installedAt: "Installed by Prometheus",
		oldServer: "The connected server is older and has no agent runtimes. Upgrade it to 0.12.0 or later.",
		piNote: "PI is built in and needs no setup; it uses the models set up under AI Gateways.",
		default: "Default",
		setDefault: "Set as default",
		setDefaultTitle: "New chats start with this agent",
		defaultSet: "New chats now start with {name}",
		defaultHidden: "A hidden agent cannot be the default",
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
		executableHint: "Empty uses the default command from PATH (claude, codex, opencode, or the preset's ACP command). A full path picks another build",
		args: "Arguments",
		argsHint: "Separated by spaces; quote arguments that contain spaces. ACP agents need the switch that starts ACP mode, e.g. --acp",
		preset: "Preset",
		presetCustom: "Other ACP agent",
		presetHint: "Pick a common ACP agent to fill in its command and arguments, or \"Other\" to enter your own",
		serverTitle: "How it runs",
		serverPerChat: "One process per chat (default)",
		serverAttach: "Connect to a running opencode server",
		serverShared: "Start one shared server on a fixed port",
		serverHint: "On a server, chats use the server's own models and login (no Prometheus gateways), and Prometheus tools only work when the server runs on this machine. A shared server serves every chat; you can join it with opencode attach too.",
		serverUrl: "Server URL",
		serverPort: "Port",
		serverUser: "Username",
		serverPassword: "Password",
		serverPasswordHint: "The server's OPENCODE_SERVER_PASSWORD. Empty for a shared server means a random one (other clients cannot join)",
		server: "Server",
		argsLabel: "Arguments",
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
		acp: "ACP Agent",
	},
});

const KIND_LABEL = { "claude-code": "claudeCode", codex: "codex", opencode: "opencode", acp: "acp" } as const;

/** The npm package that provides an agent's CLI, when Prometheus can install it. */
const npmPackage = (a: AgentProfile): string | undefined => agentPreset(a.id)?.npm?.pkg;

/** Splits an argument line on spaces, keeping quoted parts together. */
function splitArgs(line: string): string[] {
	const out: string[] = [];
	for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
	return out;
}
const joinArgs = (args: string[] | undefined): string => (args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");

function serverMode(server: AgentServer | undefined): "process" | "attach" | "shared" {
	return server?.url ? "attach" : server?.port ? "shared" : "process";
}

function blank(): AgentProfile {
	return { id: "", name: "", kind: "claude-code", enabled: true };
}

export function AgentsSettings() {
	const t = useT(M);
	const runtimes = useStore((s) => s.runtimes);
	const defaultId = useStore((s) => s.hostSettings?.defaultAgent);
	// An older server has no default-agent setting: hide the control instead of offering one that does nothing.
	const canDefault = defaultId !== undefined;
	const [agents, setAgents] = useState<AgentProfile[]>([]);
	const [editing, setEditing] = useState<{ agent: AgentProfile; isNew: boolean } | null>(null);
	const [supported, setSupported] = useState(true);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [updates, setUpdates] = useState<Record<string, AgentUpdateInfo>>({});
	const [checking, setChecking] = useState(false);

	const load = useCallback(async () => {
		const list = await callNewer("agent.list", (c) => c.rpc("agent.list", {}));
		setSupported(list !== undefined);
		if (list) setAgents(list);
		await Promise.all([refreshRuntimes(), refreshHostSettings()]);
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	/** Compares installed CLIs with npm (cached on the server for an hour unless `refresh`). Older servers lack it: nothing shows. */
	const checkUpdates = useCallback(async (refresh: boolean, id?: string) => {
		if (!id) setChecking(true);
		try {
			const list = await callNewer("agent.checkUpdates", (c) => c.rpc("agent.checkUpdates", { ...(id ? { id } : {}), refresh }));
			if (!list) return undefined;
			setUpdates((prev) => ({ ...(id ? prev : {}), ...Object.fromEntries(list.map((u) => [u.id, u])) }));
			return list;
		} finally {
			if (!id) setChecking(false);
		}
	}, []);
	useEffect(() => {
		void checkUpdates(false);
	}, [checkUpdates]);

	const checkNow = async () => {
		const list = await checkUpdates(true);
		if (!list) return;
		const n = list.filter((u) => u.updateAvailable).length;
		toast(n ? t("updatesFound", { n }) : t("upToDate"), "info");
	};

	const update = async (a: AgentProfile, latest: string) => {
		setBusyId(a.id);
		try {
			await call((c) => c.rpc("agent.install", { kind: a.kind, agent: a.id }));
			toast(t("updateDone", { name: a.name, v: latest }), "info");
		} catch (e) {
			toast(e instanceof Error ? e.message : String(e), "error");
		} finally {
			setBusyId(null);
			await load();
			// Every agent built on the same CLI changed with it.
			await checkUpdates(false);
		}
	};

	const health = (id: string): RuntimeInfo | undefined => runtimes.find((r) => r.id === id);

	const install = async (a: AgentProfile) => {
		setBusyId(a.id);
		try {
			await call((c) => c.rpc("agent.install", { kind: a.kind, agent: a.id }));
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
			await call((c) => c.rpc("agent.uninstall", { kind: a.kind, agent: a.id }));
		} finally {
			setBusyId(null);
			await load();
		}
	};

	const makeDefault = async (id: string, name: string) => {
		await setDefaultAgent(id);
		if (useStore.getState().hostSettings?.defaultAgent === id) toast(t("defaultSet", { name }), "info");
	};

	/** "Default" badge, or the button that makes this agent the default. */
	const defaultControl = (id: string, name: string, available: boolean, hidden: boolean) => {
		if (!canDefault || defaultId === id) return null;
		return (
			<Button
				variant="outline"
				className="px-2.5 py-1 text-xs"
				title={hidden ? t("defaultHidden") : t("setDefaultTitle")}
				disabled={hidden || !available}
				onClick={() => void makeDefault(id, name)}
			>
				<Star className="size-3.5" /> {t("setDefault")}
			</Button>
		);
	};

	/** One quiet line under an agent when Prometheus cannot update it, or the version lookup failed. */
	const updateNote = (u: AgentUpdateInfo | undefined) => {
		if (!u) return null;
		const text = u.error ? t("updateCheckFailed", { error: u.error }) : u.updateAvailable && u.canUpdate === false ? t("updateHintPath") : u.reason === "custom" ? t("updateCustom") : u.reason === "server" ? t("updateServer") : u.reason === "noPackage" ? t("updateNoPackage") : null;
		return text ? <p className="mt-1.5 text-xs text-ink-500">{text}</p> : null;
	};

	const pi = health("pi");

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
					<>
						<Button variant="outline" disabled={!supported || checking} onClick={() => void checkNow()}>
							<RefreshCw className={`size-4 ${checking ? "animate-spin" : ""}`} /> {t(checking ? "checking" : "checkUpdates")}
						</Button>
						<Button variant="primary" disabled={!supported} onClick={() => setEditing({ agent: blank(), isNew: true })}>
							<Plus className="size-4" /> {t("add")}
						</Button>
					</>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 @3xl:px-8">
				<div className="mx-auto max-w-3xl space-y-3">
					{!supported && <p className="rounded-lg bg-ember-500/10 px-3 py-2.5 text-sm text-ember-200">{t("oldServer")}</p>}
					<div className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-sm font-medium text-ink-100">PI</span>
							<Badge tone="ember">PI</Badge>
							<Badge>{t("builtin")}</Badge>
							{canDefault && (defaultId ?? "pi") === "pi" && <Badge tone="moss">{t("default")}</Badge>}
							<span className="flex-1" />
							{pi && <Badge tone={pi.health.available ? "moss" : "rose"}>{pi.health.available ? `${t("available")}${pi.health.version ? ` ${pi.health.version}` : ""}` : t("unavailable")}</Badge>}
						</div>
						<p className="mt-2 flex items-start gap-1.5 text-xs text-ink-400">
							<Bot className="mt-0.5 size-3.5 shrink-0" /> {t("piNote")}
						</p>
						{canDefault && defaultId !== "pi" && <div className="mt-3 flex flex-wrap items-center gap-1.5">{defaultControl("pi", "PI", pi?.health.available ?? true, false)}</div>}
					</div>
					{agents.map((a) => {
						const info = health(a.id);
						return (
							<div key={a.id} className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-sm font-medium text-ink-100">{a.name}</span>
									<Badge tone="ember">{t(KIND_LABEL[a.kind])}</Badge>
									<Badge>{a.builtin ? t("builtin") : t("custom")}</Badge>
									{a.enabled === false && <Badge>{t("disabled")}</Badge>}
									{canDefault && defaultId === a.id && <Badge tone="moss">{t("default")}</Badge>}
									<span className="flex-1" />
									{updates[a.id]?.updateAvailable && updates[a.id]?.current && updates[a.id]?.latest && (
										<Badge tone="sky">
											<ArrowUpCircle className="mr-1 inline size-3" />
											{t("updateBadge", { from: updates[a.id]!.current!, to: updates[a.id]!.latest! })}
										</Badge>
									)}
									{info && <Badge tone={info.health.available ? "moss" : "rose"}>{info.health.available ? `${t("available")}${info.health.version ? ` ${info.health.version}` : ""}` : t("unavailable")}</Badge>}
								</div>
								{updateNote(updates[a.id])}
								{info && !info.health.available && info.health.reason && (
									<p className="mt-2 flex items-start gap-1.5 text-xs text-rose-400">
										<CircleAlert className="mt-0.5 size-3.5 shrink-0" />
										<span className="min-w-0 break-words">{info.health.reason}</span>
									</p>
								)}
								{info && !info.health.available && (
									<p className="mt-1.5 text-xs text-ink-500">{!npmPackage(a) ? (info.health.missing ? t("installManual") : null) : info.health.installable === false ? t("installNoNpm") : t("installHint", { pkg: npmPackage(a) ?? "" })}</p>
								)}
								<dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-ink-400 @xl:grid-cols-[auto_1fr]">
									<dt>{t("executable")}</dt>
									<dd className="min-w-0 truncate font-mono text-ink-300">{a.executable || (a.kind === "acp" ? agentPreset(a.id)?.command : undefined) || t("fromPath")}</dd>
									{a.kind === "acp" && (
										<>
											<dt>{t("argsLabel")}</dt>
											<dd className="min-w-0 truncate font-mono text-ink-300">{joinArgs(a.args ?? agentPreset(a.id)?.args) || "—"}</dd>
										</>
									)}
									{a.kind === "opencode" && serverMode(a.server) !== "process" && (
										<>
											<dt>{t("server")}</dt>
											<dd className="min-w-0 truncate font-mono text-ink-300">{a.server?.url ?? `127.0.0.1:${a.server?.port} (${t("serverShared")})`}</dd>
										</>
									)}
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
									{defaultControl(a.id, a.name, info?.health.available ?? false, a.enabled === false)}
									{updates[a.id]?.updateAvailable && updates[a.id]?.latest && updates[a.id]?.canUpdate !== false && info?.health.available && (
										<Button
											variant="primary"
											className="px-2.5 py-1 text-xs"
											disabled={busyId !== null}
											title={t(updates[a.id]!.source === "prometheus" ? "updateHintPrometheus" : updates[a.id]!.source === "bundled" ? "updateHintBundled" : "updateHintNpm")}
											onClick={() => void update(a, updates[a.id]!.latest!)}
										>
											<ArrowUpCircle className="size-3.5" /> {busyId === a.id ? t("updating") : t("updateTo", { v: updates[a.id]!.latest! })}
										</Button>
									)}
									{info && !info.health.available && info.health.installable !== false && npmPackage(a) && (
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
	const [args, setArgs] = useState(joinArgs(initial.args ?? agentPreset(initial.id)?.args));
	const [mode, setMode] = useState(serverMode(initial.server));
	const [server, setServer] = useState<AgentServer>(initial.server ?? {});
	const [busy, setBusy] = useState(false);
	const patch = (p: Partial<AgentProfile>) => setA((x) => ({ ...x, ...p }));
	const idOk = /^[a-z0-9][a-z0-9-_]{0,47}$/.test(a.id);
	const applyPreset = (id: string) => {
		const preset = ACP_PRESETS.find((p) => p.id === id);
		if (!preset) return;
		patch({ id: taken.includes(preset.id) ? a.id : preset.id, name: a.name || preset.name, executable: preset.command ?? "" });
		setArgs(joinArgs(preset.args));
	};
	const serverOk = a.kind !== "opencode" || mode === "process" || (mode === "attach" ? Boolean(server.url?.trim()) : Number.isInteger(Number(server.port)) && Number(server.port) > 0 && Number(server.port) < 65536);
	const dup = isNew && taken.includes(a.id);

	const save = async () => {
		setBusy(true);
		try {
			const draft: AgentProfile = { ...a, env: Object.fromEntries(env.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])) };
			if (a.kind === "acp") draft.args = splitArgs(args);
			else delete draft.args;
			if (a.kind === "opencode" && mode !== "process") {
				const { url, port, username, ...rest } = server;
				draft.server = mode === "attach" ? { ...rest, url: url?.trim(), ...(username ? { username } : {}) } : { ...rest, port: Number(port), ...(username ? { username } : {}) };
			} else delete draft.server;
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
						<option value="acp">{t("acp")}</option>
					</Select>
				</Field>
				{a.kind === "acp" && isNew && (
					<Field label={t("preset")} hint={t("presetHint")}>
						<Select value={ACP_PRESETS.some((p) => p.id === a.id) ? a.id : ""} onChange={(e) => applyPreset(e.target.value)}>
							<option value="">{t("presetCustom")}</option>
							{ACP_PRESETS.map((p) => (
								<option key={p.id} value={p.id} disabled={taken.includes(p.id)}>
									{p.name}
								</option>
							))}
						</Select>
					</Field>
				)}
				<Field label={t("executable")} hint={t("executableHint")}>
					<Input value={a.executable ?? ""} onChange={(e) => patch({ executable: e.target.value })} className="font-mono" placeholder={a.kind === "codex" ? "codex" : a.kind === "opencode" ? "opencode" : a.kind === "acp" ? (agentPreset(a.id)?.command ?? "qwen") : "claude"} />
				</Field>
				{a.kind === "acp" && (
					<Field label={t("args")} hint={t("argsHint")}>
						<Input value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono" placeholder="--acp" />
					</Field>
				)}
				{a.kind === "opencode" && (
					<Field label={t("serverTitle")} hint={t("serverHint")}>
						<div className="space-y-2">
							<Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
								<option value="process">{t("serverPerChat")}</option>
								<option value="attach">{t("serverAttach")}</option>
								<option value="shared">{t("serverShared")}</option>
							</Select>
							{mode !== "process" && (
								<div className="grid gap-2 @xl:grid-cols-2">
									{mode === "attach" ? (
										<Input value={server.url ?? ""} onChange={(e) => setServer((x) => ({ ...x, url: e.target.value }))} className="font-mono @xl:col-span-2" placeholder="http://127.0.0.1:4096" aria-label={t("serverUrl")} title={t("serverUrl")} />
									) : (
										<Input value={server.port ?? ""} onChange={(e) => setServer((x) => ({ ...x, port: e.target.value === "" ? undefined : Number(e.target.value.replace(/\D/g, "")) }))} inputMode="numeric" className="font-mono @xl:col-span-2" placeholder="4096" aria-label={t("serverPort")} title={t("serverPort")} />
									)}
									<Input value={server.username ?? ""} onChange={(e) => setServer((x) => ({ ...x, username: e.target.value }))} className="font-mono" placeholder={`${t("serverUser")} (opencode)`} aria-label={t("serverUser")} />
									<Input type="password" value={server.password ?? ""} onChange={(e) => setServer((x) => ({ ...x, password: e.target.value }))} className="font-mono" placeholder={t("serverPassword")} aria-label={t("serverPassword")} title={t("serverPasswordHint")} autoComplete="new-password" />
								</div>
							)}
						</div>
					</Field>
				)}
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
					<Button variant="primary" disabled={busy || !a.name.trim() || !serverOk || (isNew && (!idOk || dup))} onClick={() => void save()}>
						{t("save")}
					</Button>
				</div>
			</div>
		</Dialog>
	);
}
