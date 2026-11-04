import { AlarmClock, Bug, CircleAlert, CircleCheck, Copy, FileText, GitPullRequest, LayoutTemplate, LoaderCircle, MessageSquare, Newspaper, Pencil, Play, Plus, Rocket, Sparkles, Trash2, Workflow } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Flow, FlowInput, FlowRun } from "@prometheus/protocol";
import { confirmDialog } from "../lib/dialogs.ts";
import { defineMessages, relativeTime, useT } from "../lib/i18n.ts";
import { usePrefs } from "../lib/prefs.ts";
import { onPluginChange, openSession, pluginCall, toast, useStore } from "../lib/store.ts";
import { runProgress } from "../lib/flowLayout.ts";
import { FLOW_TEMPLATES, type FlowTemplate } from "../lib/flowTemplates.ts";
import { blankFlow, FlowEditor } from "./FlowEditor.tsx";
import { describeSchedule } from "./FlowSchedule.tsx";
import { Badge, Button, Dialog, Field, PageHeader, Select, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "流程编排",
		subtitle: "把常用的多步骤工作拖成一条流程，固化为可重复执行的 SOP；也可以让 AI 直接帮你生成",
		add: "新建流程",
		ai: "AI 生成",
		aiTitle: "描述你的流程，AI 帮你编排",
		aiPh: "例如：收到一个需求后，先读代码梳理影响范围，再并行写实现方案和测试用例，最后汇总成一份评审文档",
		aiHint: "生成的流程会先在画布上打开供你检查，保存后才生效。",
		generating: "生成中…（可能需要一两分钟）",
		generate: "生成",
		cancel: "取消",
		workspace: "工作区",
		emptyTitle: "还没有流程",
		emptyBody: "从下面的模板开始，或者新建一条空白流程，也可以让 AI 帮你生成。",
		templates: "从模板新建",
		templatesHint: "常用 SOP，一键套用后可以随意改",
		blank: "空白流程",
		blankDesc: "从开始节点自己拖",
		progress: "步骤 {done}/{total}",
		now: "正在：{name}",
		next: "下次 {when}",
		noWorkspace: "先在侧栏添加一个工作区，流程会在该工作区里运行",
		steps: "{n} 个步骤",
		last: "上次运行 {when}",
		never: "尚未运行",
		run: "运行",
		edit: "编辑",
		duplicate: "复制",
		delete: "删除",
		confirmDelete: "删除流程「{name}」？",
		runs: "运行记录",
		noRuns: "还没有运行记录",
		clear: "清空记录",
		running: "运行中",
		success: "成功",
		error: "失败",
		cancelled: "已取消",
		openEditor: "打开查看进度",
		generated: "已生成，请检查后保存",
		input: "运行输入",
		inputHint: "启动时传给流程的内容，步骤里用 {{input}} 引用。可留空。",
		start: "开始运行",
		started: "已开始运行",
	},
	en: {
		title: "Flows",
		subtitle: "Drag a repeatable multi-step job into a flow and keep it as an SOP; or let AI generate it for you",
		add: "New flow",
		ai: "Generate with AI",
		aiTitle: "Describe your process and AI will lay it out",
		aiPh: "e.g. Given a feature request: read the code to find what is affected, then write the design and the test cases in parallel, and merge both into one review document",
		aiHint: "The result opens on the canvas for you to check; it only takes effect once saved.",
		generating: "Generating… (may take a minute or two)",
		generate: "Generate",
		cancel: "Cancel",
		workspace: "Workspace",
		emptyTitle: "No flows yet",
		emptyBody: "Start from a template below, create a blank flow, or let AI generate one.",
		templates: "From template",
		templatesHint: "Common SOPs; apply one and change anything",
		blank: "Blank flow",
		blankDesc: "Drag it out yourself",
		progress: "Step {done}/{total}",
		now: "Now: {name}",
		next: "Next {when}",
		noWorkspace: "Add a workspace in the sidebar first; flows run inside one",
		steps: "{n} steps",
		last: "Last run {when}",
		never: "Never run",
		run: "Run",
		edit: "Edit",
		duplicate: "Duplicate",
		delete: "Delete",
		confirmDelete: 'Delete flow "{name}"?',
		runs: "Run history",
		noRuns: "No runs yet",
		clear: "Clear history",
		running: "Running",
		success: "Done",
		error: "Failed",
		cancelled: "Cancelled",
		openEditor: "Open to watch",
		generated: "Generated; review it, then save",
		input: "Run input",
		inputHint: "Passed to the flow at start; steps reference it as {{input}}. May be empty.",
		start: "Start run",
		started: "Run started",
	},
});

function Progress({ flow, run }: { flow: Flow; run?: FlowRun }) {
	const t = useT(M);
	if (!run) return null;
	const { done, total, current } = runProgress(flow.nodes, run);
	return (
		<div className="mt-2 space-y-1">
			<div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
				<div className="h-full rounded-full bg-ember-400 transition-all duration-500" style={{ width: `${total ? Math.max(6, (done / total) * 100) : 0}%` }} />
			</div>
			<p className="truncate text-xs text-ember-200">
				{t("progress", { done, total })}
				{current.length > 0 && ` · ${t("now", { name: current.join("、") })}`}
			</p>
		</div>
	);
}

function RunBadge({ status }: { status: FlowRun["status"] }) {
	const t = useT(M);
	if (status === "running")
		return (
			<Badge tone="ember">
				<LoaderCircle className="mr-1 size-3 animate-spin" />
				{t("running")}
			</Badge>
		);
	if (status === "success")
		return (
			<Badge tone="moss">
				<CircleCheck className="mr-1 size-3" />
				{t("success")}
			</Badge>
		);
	if (status === "cancelled") return <Badge>{t("cancelled")}</Badge>;
	return (
		<Badge tone="rose">
			<CircleAlert className="mr-1 size-3" />
			{t("error")}
		</Badge>
	);
}

const TPL_ICON = { review: GitPullRequest, bug: Bug, spec: FileText, release: Rocket, report: Newspaper } as const;

function TemplateGrid({ onPick, onBlank }: { onPick: (tpl: FlowTemplate) => void; onBlank?: () => void }) {
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const l = lang === "zh" ? "zh" : "en";
	return (
		<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{FLOW_TEMPLATES.map((tpl) => {
				const Icon = TPL_ICON[tpl.icon];
				const steps = tpl.build(l).nodes.filter((n) => n.kind === "agent").length;
				return (
					<button key={tpl.id} type="button" onClick={() => onPick(tpl)} className="group flex flex-col gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-4 text-left transition-colors hover:border-ember-500/60 hover:bg-ember-500/5">
						<div className="flex items-center gap-2">
							<span className="grid size-8 place-items-center rounded-lg bg-ember-500/10 text-ember-300 transition-transform group-hover:scale-110">
								<Icon className="size-4" />
							</span>
							<span className="font-medium text-ink-100">{tpl.name[l]}</span>
						</div>
						<p className="text-xs leading-relaxed text-ink-400">{tpl.desc[l]}</p>
						<span className="mt-auto text-[11px] text-ink-500">{t("steps", { n: steps })}</span>
					</button>
				);
			})}
			{onBlank && (
				<button type="button" onClick={onBlank} className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-ink-600 p-4 text-left text-ink-400 transition-colors hover:border-ink-400 hover:text-ink-100">
					<span className="grid size-8 place-items-center rounded-lg bg-ink-800">
						<Plus className="size-4" />
					</span>
					<span className="font-medium">{t("blank")}</span>
					<span className="text-xs text-ink-500">{t("blankDesc")}</span>
				</button>
			)}
		</div>
	);
}

type Editing = (FlowInput & { id?: string; updatedAt?: string; nextRunAt?: string }) | null;

export function FlowsView() {
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const workspaces = useStore((s) => s.workspaces);
	const [data, setData] = useState<{ flows: Flow[]; runs: FlowRun[] } | null>(null);
	const [editing, setEditing] = useState<Editing>(null);
	const [aiOpen, setAiOpen] = useState(false);
	const [runFor, setRunFor] = useState<Flow | null>(null);
	const [tplOpen, setTplOpen] = useState(false);

	const load = useCallback(async () => {
		const res = await pluginCall<{ flows: Flow[]; runs: FlowRun[] }>("flows", "list");
		if (res) setData(res);
	}, []);
	useEffect(() => {
		void load();
		return onPluginChange("flows", () => void load());
	}, [load]);

	const call = async (method: string, params: Record<string, unknown>, ok?: string) => {
		const res = await pluginCall<unknown>("flows", method, params);
		if (res !== undefined) {
			if (ok) toast(ok);
			await load();
		}
	};

	const lang2 = lang === "zh" ? "zh" : "en";
	const fromTemplate = (tpl: FlowTemplate) => {
		setTplOpen(false);
		setEditing({ ...tpl.build(lang2), workspaceId: workspaces[0]?.id ?? "" });
	};

	if (editing)
		return (
			<FlowEditor
				key={editing.id ?? "new"}
				initial={editing}
				runs={data?.runs ?? []}
				flows={data?.flows ?? []}
				onOpenFlow={(f) => setEditing(f)}
				onClose={() => {
					setEditing(null);
					void load();
				}}
				onSaved={() => void load()}
			/>
		);

	const topRuns = (data?.runs ?? []).filter((r) => !r.parentRunId);
	const running = new Set(topRuns.filter((r) => r.status === "running").map((r) => r.flowId));
	const when = (iso?: string) => (iso ? relativeTime(iso, lang) : "");
	const noWs = workspaces.length === 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<>
						<Button variant="outline" disabled={noWs} onClick={() => setTplOpen(true)} title={noWs ? t("noWorkspace") : undefined}>
							<LayoutTemplate className="size-4" /> {t("templates")}
						</Button>
						<Button variant="outline" disabled={noWs} onClick={() => setAiOpen(true)} title={noWs ? t("noWorkspace") : undefined}>
							<Sparkles className="size-4" /> {t("ai")}
						</Button>
						<Button variant="primary" disabled={noWs} onClick={() => setEditing(blankFlow(workspaces[0]?.id ?? ""))} title={noWs ? t("noWorkspace") : undefined}>
							<Plus className="size-4" /> {t("add")}
						</Button>
					</>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
				<div className="mx-auto max-w-4xl space-y-8">
					{!data ? (
						<div className="grid place-items-center py-16 text-ink-500">
							<LoaderCircle className="size-5 animate-spin" />
						</div>
					) : data.flows.length === 0 ? (
						<div className="space-y-6">
							<div className="flex flex-col items-center gap-2 pt-4 text-center">
								<div className="grid size-11 place-items-center rounded-2xl border border-ink-700 bg-ink-900 text-ember-400">
									<Workflow className="size-5" />
								</div>
								<h3 className="font-display text-lg font-semibold">{t("emptyTitle")}</h3>
								<p className="max-w-md text-sm text-ink-400">{noWs ? t("noWorkspace") : t("emptyBody")}</p>
							</div>
							{!noWs && <TemplateGrid onPick={fromTemplate} onBlank={() => setEditing(blankFlow(workspaces[0]?.id ?? ""))} />}
						</div>
					) : (
						<ul className="grid gap-3 md:grid-cols-2">
							{data.flows.map((f) => (
								<li key={f.id} className="flex flex-col gap-3 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											<h3 className="truncate font-medium text-ink-100">{f.name}</h3>
											{running.has(f.id) && (
												<Badge tone="ember">
													<LoaderCircle className="mr-1 size-3 animate-spin" />
													{t("running")}
												</Badge>
											)}
										</div>
										{f.description && <p className="mt-1 line-clamp-2 text-sm text-ink-400">{f.description}</p>}
										<Progress flow={f} run={topRuns.find((r) => r.flowId === f.id && r.status === "running")} />
										<p className="mt-1 text-xs text-ink-500">
											{t("steps", { n: f.nodes.filter((n) => n.kind === "agent").length })} · {f.lastRunAt ? t("last", { when: when(f.lastRunAt) }) : t("never")}
										</p>
										{f.schedule && (
											<p className={`mt-1 flex items-center gap-1 text-xs ${f.scheduleEnabled ? "text-ember-300" : "text-ink-600"}`}>
												<AlarmClock className="size-3" /> {describeSchedule(f.schedule, lang2)}
												{f.scheduleEnabled && f.nextRunAt ? ` · ${t("next", { when: new Date(f.nextRunAt).toLocaleString() })}` : ""}
											</p>
										)}
									</div>
									<div className="mt-auto flex flex-wrap items-center gap-1.5">
										{running.has(f.id) ? (
											<Button variant="outline" onClick={() => setEditing(f)}>
												{t("openEditor")}
											</Button>
										) : (
											<Button variant="primary" onClick={() => setRunFor(f)}>
												<Play className="size-4" /> {t("run")}
											</Button>
										)}
										<Button variant="outline" onClick={() => setEditing(f)}>
											<Pencil className="size-4" /> {t("edit")}
										</Button>
										<Button variant="ghost" aria-label={t("duplicate")} title={t("duplicate")} onClick={() => void call("duplicate", { id: f.id })}>
											<Copy className="size-4" />
										</Button>
										<Button
											variant="danger"
											aria-label={t("delete")}
											title={t("delete")}
											onClick={() =>
												void confirmDialog(t("confirmDelete", { name: f.name }), { danger: true }).then((ok) => {
													if (ok) void call("remove", { id: f.id });
												})
											}
										>
											<Trash2 className="size-4" />
										</Button>
									</div>
								</li>
							))}
						</ul>
					)}

					{data && data.flows.length > 0 && (
						<section className="space-y-2">
							<div className="flex items-center justify-between">
								<h2 className="text-sm font-medium text-ink-300">{t("runs")}</h2>
								{topRuns.length > 0 && (
									<Button variant="ghost" onClick={() => void call("clearRuns", {})}>
										{t("clear")}
									</Button>
								)}
							</div>
							{topRuns.length === 0 ? (
								<p className="text-sm text-ink-500">{t("noRuns")}</p>
							) : (
								<ul className="divide-y divide-ink-800 rounded-xl border border-ink-700">
									{topRuns.map((r) => {
										const flow = data.flows.find((f) => f.id === r.flowId);
										const sessions = Object.values(r.nodes).filter((n) => n.sessionId);
										return (
											<li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
												<RunBadge status={r.status} />
												<span className="font-medium text-ink-200">{r.flowName}</span>
												<span className="text-xs text-ink-500">{when(r.startedAt)}</span>
												{r.error && <span className="min-w-0 flex-1 truncate text-xs text-rose-400">{r.error}</span>}
												<span className="ml-auto flex items-center gap-2">
													{sessions.length > 0 && (
														<button type="button" className="flex items-center gap-1 text-xs text-ember-300 hover:underline" onClick={() => void openSession(sessions[sessions.length - 1]!.sessionId!)}>
															<MessageSquare className="size-3" /> {sessions.length}
														</button>
													)}
													{flow && (
														<button type="button" className="text-xs text-ink-400 hover:text-ink-100" onClick={() => setEditing(flow)}>
															{t("edit")}
														</button>
													)}
												</span>
											</li>
										);
									})}
								</ul>
							)}
						</section>
					)}
				</div>
			</div>

			{tplOpen && (
				<Dialog title={t("templates")} onClose={() => setTplOpen(false)}>
					<p className="mb-3 text-xs text-ink-500">{t("templatesHint")}</p>
					<div className="max-h-[65dvh] overflow-y-auto pr-1">
						<TemplateGrid
							onPick={fromTemplate}
							onBlank={() => {
								setTplOpen(false);
								setEditing(blankFlow(workspaces[0]?.id ?? ""));
							}}
						/>
					</div>
				</Dialog>
			)}
			{aiOpen && (
				<AiDialog
					onClose={() => setAiOpen(false)}
					onDraft={(draft) => {
						setAiOpen(false);
						setEditing(draft);
						toast(t("generated"));
					}}
				/>
			)}
			{runFor && (
				<RunInputDialog
					flow={runFor}
					onClose={() => setRunFor(null)}
					onStart={async (input) => {
						const res = await pluginCall<{ runId: string }>("flows", "run", { id: runFor.id, input });
						setRunFor(null);
						if (res) {
							toast(t("started"));
							setEditing(runFor);
						}
					}}
				/>
			)}
		</div>
	);
}

function RunInputDialog({ flow, onClose, onStart }: { flow: Flow; onClose: () => void; onStart: (input: string) => Promise<void> }) {
	const t = useT(M);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<Dialog title={`${t("run")} · ${flow.name}`} onClose={onClose}>
			<div className="space-y-3">
				<Field label={t("input")} hint={t("inputHint")}>
					<Textarea rows={5} value={input} onChange={(e) => setInput(e.target.value)} autoFocus />
				</Field>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button
						variant="primary"
						disabled={busy}
						onClick={() => {
							setBusy(true);
							void onStart(input).finally(() => setBusy(false));
						}}
					>
						<Play className="size-4" /> {t("start")}
					</Button>
				</div>
			</div>
		</Dialog>
	);
}

function AiDialog({ onClose, onDraft }: { onClose: () => void; onDraft: (draft: FlowInput) => void }) {
	const t = useT(M);
	const workspaces = useStore((s) => s.workspaces);
	const [text, setText] = useState("");
	const [ws, setWs] = useState(workspaces[0]?.id ?? "");
	const [busy, setBusy] = useState(false);

	const token = useRef(0);
	const go = async () => {
		const mine = ++token.current;
		setBusy(true);
		const draft = await pluginCall<FlowInput>("flows", "generate", { description: text, workspaceId: ws });
		if (mine !== token.current) return; // cancelled meanwhile
		setBusy(false);
		if (draft) onDraft(draft);
	};
	const close = () => (token.current++, onClose());

	return (
		<Dialog title={t("aiTitle")} onClose={close}>
			<div className="space-y-3">
				<Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("aiPh")} autoFocus disabled={busy} />
				<Field label={t("workspace")} hint={t("aiHint")}>
					<Select value={ws} onChange={(e) => setWs(e.target.value)} disabled={busy}>
						{workspaces.map((w) => (
							<option key={w.id} value={w.id}>
								{w.name}
							</option>
						))}
					</Select>
				</Field>
				<div className="flex items-center justify-end gap-2">
					{busy && (
						<span className="mr-auto flex items-center gap-1.5 text-xs text-ink-400">
							<LoaderCircle className="size-3.5 animate-spin" /> {t("generating")}
						</span>
					)}
					<Button variant="ghost" onClick={close}>
						{t("cancel")}
					</Button>
					<Button variant="primary" onClick={() => void go()} disabled={busy || !text.trim() || !ws}>
						<Sparkles className="size-4" /> {t("generate")}
					</Button>
				</div>
			</div>
		</Dialog>
	);
}
