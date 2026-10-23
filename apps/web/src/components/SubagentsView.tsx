import clsx from "clsx";
import { Bot, Copy, Plus, Power, RotateCcw, Save, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { confirmDialog, promptDialog } from "../lib/dialogs.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { onPluginChange, pluginCall, toast, useStore } from "../lib/store.ts";
import { Badge, Button, Empty, Field, Input, PageHeader, Select, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "子代理",
		subtitle: "配置主代理可以委派任务的子代理：说明、提示词、模型、工具与上下文，并选择由 PI、Claude Code 还是 Codex 来执行。",
		newAgent: "新建子代理",
		duplicate: "复制",
		namePrompt: "子代理名称（小写字母、数字、- _ .）",
		cliMissing: "本机没有找到 {cli} 命令行工具，这个子代理暂时无法运行。请先安装并登录。",
		runner: "执行方式",
		runnerPi: "PI（本应用内）",
		runnerClaude: "Claude Code 命令行",
		runnerCodex: "Codex 命令行",
		runnerHint: "命令行类子代理使用本机已登录的 CLI；提示词作为任务说明一并发给它，工具和提示词模式由 CLI 自己决定。",
		writable: "允许修改工作区文件",
		writableHint: "关闭时命令行只能读取和分析；开启后可以编辑文件和执行命令。",
		cliModelHint: "命令行的模型名，例如 sonnet、opus；留空使用 CLI 自己的默认值。",
		builtin: "内置",
		custom: "自定义",
		shadows: "覆盖内置",
		modified: "已修改",
		disabled: "已停用",
		advertised: "已公布",
		loading: "加载中…",
		emptyTitle: "没有找到子代理",
		emptyBody: "新建一个子代理，写好它的提示词，主代理就可以把任务委派给它。",
		basics: "基本",
		name: "名称",
		description: "说明",
		descriptionHint: "主代理靠这句话决定要不要把任务交给它，写清楚擅长什么。",
		prompt: "提示词",
		promptMode: "提示词模式",
		modeReplace: "replace · 只用上面的提示词，不带 PI 默认提示词",
		modeAppend: "append · 在 PI 默认提示词之后追加",
		model: "模型",
		modelInherit: "继承主代理当前模型",
		thinking: "思考强度",
		thinkingDefault: "代理默认",
		toolsLabel: "可用工具",
		toolsAll: "PI 默认工具",
		toolsSome: "仅限 {n} 个",
		toolsHint: "子代理的工具是严格白名单；留空使用 PI 默认工具（read、bash、edit、write）。插件提供的工具暂不会传给子代理。",
		addTool: "添加工具名",
		contextSection: "上下文限制",
		contextStart: "起始上下文",
		contextDefault: "不指定（默认全新）",
		contextFresh: "fresh · 全新上下文，只看到任务说明",
		contextFork: "fork · 复制主对话的当前分支",
		inheritProject: "继承项目指令（AGENTS.md / CLAUDE.md）",
		inheritGlobal: "继承全局指令（~/.pi/agent/AGENTS.md，需同时继承项目指令）",
		inheritSkills: "可见技能目录",
		timeout: "单次运行时限（分钟）",
		timeoutHint: "0 表示使用默认值。内置子代理的时限固定为 30 分钟，请复制为自定义子代理后设置。",
		advertise: "在主代理的提示词中公布这个子代理",
		advertiseHint: "公布后主代理无需先查询列表就知道它的存在。公布数量和长度有上限。",
		save: "保存",
		saved: "已保存",
		reset: "恢复内置",
		resetShadow: "删除覆盖，恢复内置",
		delete: "删除",
		disable: "停用",
		enable: "启用",
		confirmDelete: "删除子代理「{name}」？文件会被移除。",
		confirmReset: "恢复为内置定义？你对它做的修改会丢失。",
		deleted: "已删除",
		resetDone: "已恢复",
		toggled: "已更新",
		bytes: "{n} 字",
		fileNote: "保存位置",
		fromSettings: "修改保存在 ~/.pi/agent/settings.json 的 subagents.agentOverrides",
	},
	en: {
		title: "Subagents",
		subtitle: "Configure the agents the main agent can delegate to: description, prompt, model, tools and context. Each agent runs on PI itself, Claude Code or Codex.",
		newAgent: "New subagent",
		duplicate: "Duplicate",
		namePrompt: "Subagent name (lowercase letters, digits, - _ .)",
		cliMissing: "The {cli} command-line tool was not found on this machine, so this subagent cannot run yet. Install it and sign in first.",
		runner: "Runs on",
		runnerPi: "PI (inside this app)",
		runnerClaude: "Claude Code CLI",
		runnerCodex: "Codex CLI",
		runnerHint: "CLI agents use the locally signed-in tool; the prompt is sent along with the task, and the CLI decides its own tools and prompt handling.",
		writable: "May modify workspace files",
		writableHint: "Off: the CLI can only read and analyze. On: it can edit files and run commands.",
		cliModelHint: "The CLI's own model name, such as sonnet or opus; empty uses the CLI default.",
		builtin: "Built in",
		custom: "Custom",
		shadows: "Overrides built-in",
		modified: "Modified",
		disabled: "Disabled",
		advertised: "Advertised",
		loading: "Loading…",
		emptyTitle: "No subagents found",
		emptyBody: "Create a subagent and write its prompt; the main agent can then delegate tasks to it.",
		basics: "Basics",
		name: "Name",
		description: "Description",
		descriptionHint: "The main agent decides whether to hand a task over from this line, so say what it is good at.",
		prompt: "Prompt",
		promptMode: "Prompt mode",
		modeReplace: "replace · the prompt above alone, without PI's default prompt",
		modeAppend: "append · added after PI's default prompt",
		model: "Model",
		modelInherit: "Inherit the main agent's model",
		thinking: "Thinking level",
		thinkingDefault: "Agent default",
		toolsLabel: "Tools",
		toolsAll: "PI default tools",
		toolsSome: "{n} selected",
		toolsHint: "A subagent's tools are a strict allowlist; empty uses PI's default tools. Plugin tools are not passed to subagents yet.",
		addTool: "Add a tool name",
		contextSection: "Context limits",
		contextStart: "Starting context",
		contextDefault: "Unspecified (fresh by default)",
		contextFresh: "fresh · a clean context that only sees the task",
		contextFork: "fork · a copy of the main conversation's current branch",
		inheritProject: "Inherit project instructions (AGENTS.md / CLAUDE.md)",
		inheritGlobal: "Inherit global instructions (~/.pi/agent/AGENTS.md; needs project instructions too)",
		inheritSkills: "See the skills catalog",
		timeout: "Run time limit (minutes)",
		timeoutHint: "0 uses the default. Built-in agents are fixed at 30 minutes; duplicate one as a custom agent to set it.",
		advertise: "Advertise this subagent in the main agent's prompt",
		advertiseHint: "An advertised agent is known without listing first. The count and length of the catalog are capped.",
		save: "Save",
		saved: "Saved",
		reset: "Restore built-in",
		resetShadow: "Remove override, restore built-in",
		delete: "Delete",
		disable: "Disable",
		enable: "Enable",
		confirmDelete: "Delete subagent \"{name}\"? Its file is removed.",
		confirmReset: "Restore the built-in definition? Your edits are lost.",
		deleted: "Deleted",
		resetDone: "Restored",
		toggled: "Updated",
		bytes: "{n} chars",
		fileNote: "Stored at",
		fromSettings: "Edits are stored in ~/.pi/agent/settings.json under subagents.agentOverrides",
	},
});

type Runner = "pi" | "claude-code" | "codex";

type Summary = {
	name: string;
	description: string;
	source: "builtin" | "custom";
	shadows: boolean;
	modified: boolean;
	disabled: boolean;
	advertise: boolean;
	runner: Runner;
	promptLength: number;
	file?: string;
};

interface Draft {
	runner: Runner;
	description: string;
	mode: "replace" | "append";
	prompt: string;
	model: string;
	thinking: string;
	tools: string[];
	context: "" | "fresh" | "fork";
	inheritProject: boolean;
	inheritGlobal: boolean;
	inheritSkills: boolean;
	timeoutMin: number;
	advertise: boolean;
	writable: boolean;
}

type Full = Draft & Summary;

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

const draftOf = (a: Full): Draft => ({
	description: a.description,
	mode: a.mode,
	prompt: a.prompt,
	model: a.model,
	thinking: a.thinking,
	tools: [...a.tools],
	context: a.context,
	inheritProject: a.inheritProject,
	inheritGlobal: a.inheritGlobal,
	inheritSkills: a.inheritSkills,
	timeoutMin: a.timeoutMin,
	advertise: a.advertise,
	runner: a.runner,
	writable: a.writable,
});

export function SubagentsView() {
	const t = useT(M);
	const [agents, setAgents] = useState<Summary[]>([]);
	const [clis, setClis] = useState<Record<string, boolean>>({});
	const [picked, setPicked] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);

	const load = async () => {
		const res = await pluginCall<{ clis: Record<string, boolean>; agents: Summary[] }>("subagents", "list");
		if (!res) return;
		setAgents(res.agents);
		setClis(res.clis);
		setPicked((s) => (s && res.agents.some((a) => a.name === s) ? s : (res.agents[0]?.name ?? null)));
		setLoaded(true);
	};
	useEffect(() => {
		void load();
		return onPluginChange("subagents", () => void load());
	}, []);

	const create = async (from?: Full) => {
		const name = (await promptDialog(t("namePrompt"), from ? `${from.name}-copy` : ""))?.trim();
		if (!name) return;
		const agent = from ? draftOf(from) : { description: "", prompt: "", mode: "replace" };
		const res = await pluginCall<{ name: string }>("subagents", "create", { name, agent });
		if (!res) return;
		await load();
		setPicked(res.name);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<Button variant="primary" onClick={() => void create()}>
						<Plus className="size-4" /> {t("newAgent")}
					</Button>
				}
			/>
			<div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
				<div className="max-h-[34%] w-full shrink-0 space-y-1 overflow-y-auto border-b hairline p-3 @3xl:max-h-none @3xl:w-72 @3xl:border-r @3xl:border-b-0">
					{agents.map((a) => (
						<button key={a.name} type="button" onClick={() => setPicked(a.name)} className={clsx("w-full rounded-lg px-3 py-2.5 text-left transition-colors", a.name === picked ? "bg-ink-850" : "hover:bg-ink-900")}>
							<div className="flex items-center gap-2">
								<span className={clsx("truncate font-mono text-sm", a.disabled ? "text-ink-500 line-through" : "text-ink-100")}>{a.name}</span>
								{a.source === "custom" && <Badge tone="ember">{t("custom")}</Badge>}
								{a.disabled && <Badge tone="rose">{t("disabled")}</Badge>}
							</div>
							<div className="mt-0.5 line-clamp-2 text-xs text-ink-500">{a.description || t("bytes", { n: a.promptLength })}</div>
						</button>
					))}
					{loaded && agents.length === 0 && <p className="px-3 py-4 text-sm text-ink-500">{t("emptyTitle")}</p>}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{picked ? (
						<AgentEditor key={picked} name={picked} clis={clis} onChanged={load} onDuplicate={(a) => void create(a)} onRemoved={() => setPicked(null)} />
					) : (
						<Empty icon={<Bot className="size-5" />} title={t("emptyTitle")}>
							{t("emptyBody")}
						</Empty>
					)}
				</div>
			</div>
		</div>
	);
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
	return (
		<label className="flex items-center gap-2 text-sm text-ink-300">
			<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-ember-500" />
			{children}
		</label>
	);
}

function AgentEditor({ name, clis, onChanged, onDuplicate, onRemoved }: { name: string; clis: Record<string, boolean>; onChanged: () => Promise<void>; onDuplicate: (a: Full) => void; onRemoved: () => void }) {
	const t = useT(M);
	const models = useStore((s) => s.models);
	const [full, setFull] = useState<Full | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saved, setSaved] = useState<Draft | null>(null);
	const [known, setKnown] = useState<string[]>([]);
	const [adding, setAdding] = useState("");
	const [busy, setBusy] = useState(false);

	const reload = async () => {
		const a = await pluginCall<Full>("subagents", "get", { name });
		if (!a) return;
		setFull(a);
		const d = draftOf(a);
		setDraft(d);
		setSaved(d);
	};
	useEffect(() => {
		void reload();
		void pluginCall<{ known: string[] }>("subagents", "tools").then((r) => r && setKnown(r.known));
	}, [name]);

	const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
	const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
	const custom = full?.source === "custom";
	const cli = draft ? draft.runner !== "pi" : false;

	const modelOptions = useMemo(() => {
		const ids = models.map((m) => `${m.provider}/${m.id}`);
		return draft?.model && !ids.includes(draft.model) ? [draft.model, ...ids] : ids;
	}, [models, draft?.model]);

	const toggleTool = (tool: string) => {
		if (!draft) return;
		set("tools", draft.tools.includes(tool) ? draft.tools.filter((n) => n !== tool) : [...draft.tools, tool]);
	};

	const run = async (fn: () => Promise<unknown>, done: string) => {
		setBusy(true);
		const res = await fn();
		setBusy(false);
		if (res === undefined) return false;
		toast(done);
		return true;
	};

	const save = async () => {
		if (!draft) return;
		if (await run(() => pluginCall("subagents", "save", { name, agent: draft }), t("saved"))) {
			await reload();
			await onChanged();
		}
	};
	const remove = async () => {
		if (!(await confirmDialog(t("confirmDelete", { name })))) return;
		if (await run(() => pluginCall("subagents", "delete", { name }), t("deleted"))) {
			onRemoved();
			await onChanged();
		}
	};
	const reset = async () => {
		if (!(await confirmDialog(t("confirmReset")))) return;
		if (await run(() => pluginCall("subagents", "reset", { name }), t("resetDone"))) {
			await reload();
			await onChanged();
		}
	};
	const toggleDisabled = async () => {
		if (!full) return;
		if (await run(() => pluginCall("subagents", "disable", { name, disabled: !full.disabled }), t("toggled"))) {
			await reload();
			await onChanged();
		}
	};

	if (!full || !draft) return <p className="p-6 text-sm text-ink-500">{t("loading")}</p>;
	const canReset = (!custom && full.modified) || (custom && full.shadows);

	return (
		<div className="mx-auto max-w-4xl animate-rise space-y-5 p-4 @3xl:p-6">
			<div className="flex flex-wrap items-center gap-2">
				<h2 className="font-mono text-xl font-semibold">{full.name}</h2>
				<Badge tone={custom ? "ember" : "sky"}>{custom ? t("custom") : t("builtin")}</Badge>
				{full.shadows && <Badge tone="muted">{t("shadows")}</Badge>}
				{full.modified && <Badge tone="muted">{t("modified")}</Badge>}
				{full.disabled && <Badge tone="rose">{t("disabled")}</Badge>}
				{draft.advertise && <Badge tone="moss">{t("advertised")}</Badge>}
			</div>

			<Field label={t("runner")} hint={cli ? t("runnerHint") : undefined}>
				<Select value={draft.runner} onChange={(e) => set("runner", e.target.value as Draft["runner"])}>
					<option value="pi">{t("runnerPi")}</option>
					<option value="claude-code">{t("runnerClaude")}</option>
					<option value="codex">{t("runnerCodex")}</option>
				</Select>
			</Field>
			{cli && clis[draft.runner] === false && (
				<div className="flex items-center gap-2 rounded-lg bg-ember-500/10 px-3 py-2 text-sm text-ember-200">
					<TriangleAlert className="size-4 shrink-0" />
					{t("cliMissing", { cli: draft.runner === "codex" ? "codex" : "claude" })}
				</div>
			)}

			<Field label={t("description")} hint={t("descriptionHint")}>
				<Input value={draft.description} onChange={(e) => set("description", e.target.value)} />
			</Field>

			<Field label={t("prompt")}>
				<Textarea value={draft.prompt} onChange={(e) => set("prompt", e.target.value)} spellCheck={false} className="min-h-[34vh] font-mono text-[13px] leading-relaxed" />
			</Field>

			<div className="grid gap-3 @xl:grid-cols-3">
				{!cli && (
					<Field label={t("promptMode")}>
						<Select value={draft.mode} onChange={(e) => set("mode", e.target.value as Draft["mode"])}>
							<option value="replace">{t("modeReplace")}</option>
							<option value="append">{t("modeAppend")}</option>
						</Select>
					</Field>
				)}
				<Field label={t("model")} hint={cli ? t("cliModelHint") : undefined}>
					{cli ? (
						<Input value={draft.model} onChange={(e) => set("model", e.target.value)} placeholder="sonnet" className="font-mono" />
					) : (
					<Select value={draft.model} onChange={(e) => set("model", e.target.value)}>
						<option value="">{t("modelInherit")}</option>
						{modelOptions.map((m) => (
							<option key={m} value={m}>
								{m}
							</option>
						))}
					</Select>
					)}
				</Field>
				<Field label={t("thinking")}>
					<Select value={draft.thinking} onChange={(e) => set("thinking", e.target.value)}>
						<option value="">{t("thinkingDefault")}</option>
						{THINKING.map((l) => (
							<option key={l} value={l}>
								{l}
							</option>
						))}
					</Select>
				</Field>
			</div>

			{cli && (
				<div className="space-y-1">
					<Check checked={draft.writable} onChange={(v) => set("writable", v)}>
						{t("writable")}
					</Check>
					<p className="pl-6 text-xs text-ink-500">{t("writableHint")}</p>
				</div>
			)}

			{!cli && (<>
			<Field label={`${t("toolsLabel")} · ${draft.tools.length ? t("toolsSome", { n: draft.tools.length }) : t("toolsAll")}`} hint={t("toolsHint")}>
				<div className="space-y-2">
					<div className="flex flex-wrap gap-1.5 rounded-lg border border-ink-800 p-2">
						{[...new Set([...known, ...draft.tools])].sort().map((tool) => {
							const on = draft.tools.includes(tool);
							return (
								<button key={tool} type="button" onClick={() => toggleTool(tool)} className={clsx("rounded-md px-1.5 py-0.5 font-mono text-[11px] transition-colors", on ? "bg-ember-500/20 text-ember-200" : "bg-ink-800 text-ink-400 hover:bg-ink-700")}>
									{tool}
								</button>
							);
						})}
					</div>
					<div className="flex gap-2">
						<Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={t("addTool")} className="max-w-56 font-mono" />
						<Button
							variant="outline"
							disabled={!adding.trim() || draft.tools.includes(adding.trim())}
							onClick={() => {
								toggleTool(adding.trim());
								setAdding("");
							}}
						>
							<Plus className="size-4" />
						</Button>
					</div>
				</div>
			</Field>

			<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/40 p-4">
				<h3 className="font-mono text-[10.5px] tracking-[0.18em] text-ink-500 uppercase">{t("contextSection")}</h3>
				<div className="grid gap-3 @xl:grid-cols-2">
					<Field label={t("contextStart")}>
						<Select value={draft.context} onChange={(e) => set("context", e.target.value as Draft["context"])}>
							<option value="">{t("contextDefault")}</option>
							<option value="fresh">{t("contextFresh")}</option>
							<option value="fork">{t("contextFork")}</option>
						</Select>
					</Field>
					<Field label={t("timeout")} hint={custom ? undefined : t("timeoutHint")}>
						<Input type="number" min={0} max={1440} value={draft.timeoutMin} disabled={!custom} onChange={(e) => set("timeoutMin", Math.max(0, Number(e.target.value) || 0))} />
					</Field>
				</div>
				<div className="space-y-2">
					<Check checked={draft.inheritProject} onChange={(v) => set("inheritProject", v)}>
						{t("inheritProject")}
					</Check>
					<Check checked={draft.inheritGlobal} onChange={(v) => set("inheritGlobal", v)}>
						{t("inheritGlobal")}
					</Check>
					<Check checked={draft.inheritSkills} onChange={(v) => set("inheritSkills", v)}>
						{t("inheritSkills")}
					</Check>
				</div>
			</section>

			</>)}

			<div className="space-y-1">
				<Check checked={draft.advertise} onChange={(v) => set("advertise", v)}>
					{t("advertise")}
				</Check>
				<p className="pl-6 text-xs text-ink-500">{t("advertiseHint")}</p>
			</div>

			<p className="font-mono text-[11px] break-all text-ink-600">{custom ? `${t("fileNote")}: ${full.file}` : t("fromSettings")}</p>

			<div className="flex flex-wrap items-center gap-2">
				{custom && (
					<Button variant="danger" disabled={busy} onClick={() => void remove()}>
						<Trash2 className="size-4" /> {t("delete")}
					</Button>
				)}
				<div className="flex-1" />
				<Button variant="outline" disabled={busy} onClick={() => void toggleDisabled()}>
					<Power className="size-4" /> {full.disabled ? t("enable") : t("disable")}
				</Button>
				<Button variant="outline" disabled={busy} onClick={() => onDuplicate(full)}>
					<Copy className="size-4" /> {t("duplicate")}
				</Button>
				{canReset && (
					<Button variant="outline" disabled={busy} onClick={() => void reset()}>
						<RotateCcw className="size-4" /> {custom ? t("resetShadow") : t("reset")}
					</Button>
				)}
				<Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
					<Save className="size-4" /> {t("save")}
				</Button>
			</div>
		</div>
	);
}
