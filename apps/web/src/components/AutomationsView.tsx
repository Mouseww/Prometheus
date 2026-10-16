import clsx from "clsx";
import { AlarmClock, CircleAlert, CircleCheck, Clock, LoaderCircle, MessageSquare, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AutomationInput, AutomationRun, AutomationSchedule, AutomationTask, RunAccess } from "@prometheus/protocol";
import { defineMessages, relativeTime, useT } from "../lib/i18n.ts";
import { usePrefs } from "../lib/prefs.ts";
import { onPluginChange, openSession, pluginCall, toast, useStore } from "../lib/store.ts";
import { Badge, Button, Dialog, Empty, Field, Input, PageHeader, Select, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "自动化任务",
		subtitle: "按计划在后台让 Agent 自动完成工作，每次都会生成一个可查看的会话",
		add: "新建任务",
		edit: "编辑任务",
		emptyTitle: "还没有自动化任务",
		emptyBody: "例如：每天早上总结昨天的提交；每小时检查构建是否失败。",
		noWorkspace: "先在侧栏添加一个工作区，任务会在该工作区里运行",
		name: "名称",
		namePh: "例如：每日代码巡检",
		prompt: "要做的事",
		promptPh: "用自然语言描述，Agent 会在无人值守的情况下完成并给出报告",
		workspace: "工作区",
		schedule: "计划",
		every: "每隔",
		minutes: "分钟",
		daily: "每天固定时间",
		once: "仅一次",
		interval: "固定间隔",
		time: "时间",
		days: "重复",
		everyDay: "每天",
		dayNames: "日,一,二,三,四,五,六",
		at: "执行时间",
		access: "权限",
		readonly: "只读",
		readonlyDesc: "只能读取和检索，不会修改任何东西",
		edits: "可编辑",
		editsDesc: "可修改项目内的文件，不能执行命令",
		full: "完全",
		fullDesc: "可修改文件并执行命令；无人值守时风险较高",
		model: "模型",
		modelDefault: "默认模型",
		save: "保存",
		cancel: "取消",
		runNow: "立即运行",
		stop: "停止",
		started: "已开始运行",
		enable: "启用",
		disable: "停用",
		delete: "删除",
		confirmDelete: "删除任务「{name}」？",
		next: "下次 {when}",
		last: "上次 {when}",
		never: "尚未运行",
		paused: "已停用",
		runs: "运行记录",
		noRuns: "还没有运行记录",
		clear: "清空记录",
		openChat: "查看会话",
		running: "运行中",
		success: "成功",
		error: "失败",
		skipped: "已跳过",
		offline: "仅在应用运行期间执行。应用关闭时错过的任务，每日/单次任务会在下次启动时补跑（一天内），固定间隔任务会直接跳过。",
		unattended: "无人值守：任何超出所选权限的操作都会被直接拒绝，不会弹出确认。",
		needFields: "请填写名称、内容并选择工作区",
		saved: "已保存",
	},
	en: {
		title: "Automations",
		subtitle: "Let the agent do work in the background on a schedule. Every run leaves a chat you can open",
		add: "New task",
		edit: "Edit task",
		emptyTitle: "No automations yet",
		emptyBody: "For example: summarise yesterday's commits every morning; check for failing builds hourly.",
		noWorkspace: "Add a workspace in the sidebar first; tasks run inside one",
		name: "Name",
		namePh: "e.g. Daily code review",
		prompt: "What to do",
		promptPh: "Describe it in plain language. The agent works unattended and reports back",
		workspace: "Workspace",
		schedule: "Schedule",
		every: "Every",
		minutes: "minutes",
		daily: "Daily at a set time",
		once: "Once",
		interval: "Fixed interval",
		time: "Time",
		days: "Repeat",
		everyDay: "Every day",
		dayNames: "Sun,Mon,Tue,Wed,Thu,Fri,Sat",
		at: "Run at",
		access: "Access",
		readonly: "Read-only",
		readonlyDesc: "Can read and search, changes nothing",
		edits: "Edits",
		editsDesc: "Can edit files in the project, cannot run commands",
		full: "Full",
		fullDesc: "Can edit files and run commands; risky when unattended",
		model: "Model",
		modelDefault: "Default model",
		save: "Save",
		cancel: "Cancel",
		runNow: "Run now",
		stop: "Stop",
		started: "Run started",
		enable: "Enable",
		disable: "Disable",
		delete: "Delete",
		confirmDelete: "Delete task \"{name}\"?",
		next: "Next {when}",
		last: "Last {when}",
		never: "Never run",
		paused: "Disabled",
		runs: "Run history",
		noRuns: "No runs yet",
		clear: "Clear history",
		openChat: "Open chat",
		running: "Running",
		success: "Done",
		error: "Failed",
		skipped: "Skipped",
		offline: "Runs only while the app is open. A daily or one-off task missed while closed runs once on the next start (within a day); interval tasks are simply skipped.",
		unattended: "Unattended: anything beyond the chosen access is refused outright, never asked about.",
		needFields: "Fill in the name and task, and choose a workspace",
		saved: "Saved",
	},
});

type Row = AutomationTask & { scheduleText: string };
type Kind = AutomationSchedule["type"];

const blank = (workspaceId: string): AutomationInput => ({ name: "", prompt: "", workspaceId, schedule: { type: "daily", time: "09:00" }, access: "readonly", enabled: true });

/** `<input type="datetime-local">` speaks local time without a zone. */
const toLocalInput = (iso: string) => {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function TaskDialog({ initial, onClose, onSaved }: { initial: (AutomationInput & { id?: string }) | null; onClose: () => void; onSaved: () => void }) {
	const t = useT(M);
	const workspaces = useStore((s) => s.workspaces);
	const models = useStore((s) => s.models);
	const [draft, setDraft] = useState<AutomationInput & { id?: string }>(initial ?? blank(workspaces[0]?.id ?? ""));
	const [busy, setBusy] = useState(false);
	const sch = draft.schedule;
	const set = (patch: Partial<AutomationInput>) => setDraft((d) => ({ ...d, ...patch }));
	const dayNames = t("dayNames").split(",");

	const setKind = (kind: Kind) =>
		set({
			schedule:
				kind === "interval" ? { type: "interval", minutes: 60 } : kind === "daily" ? { type: "daily", time: "09:00" } : { type: "once", at: new Date(Date.now() + 3_600_000).toISOString() },
		});

	const save = async () => {
		if (!draft.name.trim() || !draft.prompt.trim() || !draft.workspaceId) return toast(t("needFields"), "warning");
		setBusy(true);
		const res = await pluginCall<unknown>("automations", draft.id ? "update" : "create", { ...draft });
		setBusy(false);
		if (res === undefined) return;
		toast(t("saved"));
		onSaved();
		onClose();
	};

	return (
		<Dialog title={draft.id ? t("edit") : t("add")} onClose={onClose}>
			<div className="max-h-[70dvh] space-y-4 overflow-y-auto pr-1">
				<Field label={t("name")}>
					<Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder={t("namePh")} maxLength={80} autoFocus />
				</Field>
				<Field label={t("prompt")}>
					<Textarea rows={4} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder={t("promptPh")} />
				</Field>
				<Field label={t("workspace")}>
					<Select value={draft.workspaceId} onChange={(e) => set({ workspaceId: e.target.value })}>
						{workspaces.map((w) => (
							<option key={w.id} value={w.id}>
								{w.name}
							</option>
						))}
					</Select>
				</Field>

				<div className="space-y-2">
					<span className="text-xs font-medium tracking-wide text-ink-300">{t("schedule")}</span>
					<div className="flex flex-wrap gap-2">
						<Select value={sch.type} onChange={(e) => setKind(e.target.value as Kind)} className="w-44 max-sm:w-full">
							<option value="daily">{t("daily")}</option>
							<option value="interval">{t("interval")}</option>
							<option value="once">{t("once")}</option>
						</Select>
						{sch.type === "interval" && (
							<div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink-400">
								{t("every")}
								<Input type="number" min={5} max={10080} value={sch.minutes} onChange={(e) => set({ schedule: { type: "interval", minutes: Number(e.target.value) } })} className="w-24" />
								{t("minutes")}
							</div>
						)}
						{sch.type === "daily" && <Input type="time" value={sch.time} onChange={(e) => set({ schedule: { ...sch, time: e.target.value } })} className="w-32" aria-label={t("time")} />}
						{sch.type === "once" && <Input type="datetime-local" value={toLocalInput(sch.at)} onChange={(e) => e.target.value && set({ schedule: { type: "once", at: new Date(e.target.value).toISOString() } })} aria-label={t("at")} />}
					</div>
					{sch.type === "daily" && (
						<div className="flex flex-wrap items-center gap-1.5">
							{dayNames.map((name, d) => {
								const on = !sch.days?.length || sch.days.includes(d);
								return (
									<button
										key={d}
										type="button"
										onClick={() => {
											const current = sch.days?.length ? sch.days : [0, 1, 2, 3, 4, 5, 6];
											const next = current.includes(d) ? current.filter((x) => x !== d) : [...current, d];
											set({ schedule: { type: "daily", time: sch.time, ...(next.length && next.length < 7 ? { days: next.sort() } : {}) } });
										}}
										className={clsx("size-8 rounded-lg border text-xs transition-colors", on ? "border-ember-500/60 bg-ember-500/10 text-ember-200" : "border-ink-700 text-ink-500 hover:border-ink-500")}
									>
										{name}
									</button>
								);
							})}
						</div>
					)}
				</div>

				<div className="space-y-2">
					<span className="text-xs font-medium tracking-wide text-ink-300">{t("access")}</span>
					<div className="grid gap-2 sm:grid-cols-3">
						{(["readonly", "edits", "full"] as RunAccess[]).map((a) => (
							<button
								key={a}
								type="button"
								onClick={() => set({ access: a })}
								className={clsx("rounded-xl border p-3 text-left transition-colors", draft.access === a ? "border-ember-500/60 bg-ember-500/10" : "border-ink-700 hover:border-ink-500", a === "full" && draft.access === a && "border-rose-400/60 bg-rose-400/10")}
							>
								<span className="block text-sm font-medium text-ink-100">{t(a)}</span>
								<span className="mt-0.5 block text-[11px] leading-snug text-ink-500">{t(`${a}Desc`)}</span>
							</button>
						))}
					</div>
					<p className="text-[11px] text-ink-500">{t("unattended")}</p>
				</div>

				<Field label={t("model")}>
					<Select
						value={draft.model ? `${draft.model.provider}/${draft.model.id}` : ""}
						onChange={(e) => {
							const m = models.find((x) => `${x.provider}/${x.id}` === e.target.value);
							setDraft((d) => {
								const { model: _drop, ...rest } = d;
								return m ? { ...rest, model: { provider: m.provider, id: m.id } } : rest;
							});
						}}
					>
						<option value="">{t("modelDefault")}</option>
						{models.map((m) => (
							<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
								{m.provider} / {m.name}
							</option>
						))}
					</Select>
				</Field>
			</div>
			<div className="flex justify-end gap-2 pt-1">
				<Button variant="ghost" onClick={onClose}>
					{t("cancel")}
				</Button>
				<Button variant="primary" onClick={() => void save()} disabled={busy}>
					{t("save")}
				</Button>
			</div>
		</Dialog>
	);
}

function RunBadge({ status }: { status: AutomationRun["status"] }) {
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
	if (status === "skipped") return <Badge>{t("skipped")}</Badge>;
	return (
		<Badge tone="rose">
			<CircleAlert className="mr-1 size-3" />
			{t("error")}
		</Badge>
	);
}

export function AutomationsView() {
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const workspaces = useStore((s) => s.workspaces);
	const [data, setData] = useState<{ tasks: Row[]; runs: AutomationRun[] } | null>(null);
	const [editing, setEditing] = useState<(AutomationInput & { id?: string }) | "new" | null>(null);

	const load = useCallback(async () => {
		const res = await pluginCall<{ tasks: Row[]; runs: AutomationRun[] }>("automations", "list");
		if (res) setData(res);
	}, []);
	useEffect(() => {
		void load();
		return onPluginChange("automations", () => void load());
	}, [load]);

	const call = async (method: string, params: Record<string, unknown>, ok?: string) => {
		const res = await pluginCall<unknown>("automations", method, params);
		if (res !== undefined) {
			if (ok) toast(ok);
			await load();
		}
	};

	const running = new Set((data?.runs ?? []).filter((r) => r.status === "running").map((r) => r.taskId));
	const when = (iso?: string) => (iso ? relativeTime(iso, lang) : "");
	const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "?";

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<Button variant="primary" disabled={workspaces.length === 0} onClick={() => setEditing("new")} title={workspaces.length === 0 ? t("noWorkspace") : undefined}>
						<Plus className="size-4" /> {t("add")}
					</Button>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
				<div className="mx-auto max-w-4xl space-y-8">
					{!data ? (
						<div className="grid place-items-center py-16 text-ink-500">
							<LoaderCircle className="size-5 animate-spin" />
						</div>
					) : data.tasks.length === 0 ? (
						<Empty icon={<AlarmClock className="size-5" />} title={t("emptyTitle")}>
							{workspaces.length === 0 ? t("noWorkspace") : t("emptyBody")}
						</Empty>
					) : (
						<ul className="space-y-3">
							{data.tasks.map((task) => {
								const busy = running.has(task.id);
								return (
									<li key={task.id} className={clsx("animate-rise rounded-xl border bg-ink-900/60 p-4", task.enabled ? "border-ink-800" : "border-ink-800/60 opacity-70")}>
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium text-ink-100">{task.name}</span>
											<Badge tone={task.access === "full" ? "rose" : task.access === "edits" ? "ember" : "muted"}>{t(task.access)}</Badge>
											{!task.enabled && <Badge>{t("paused")}</Badge>}
											<span className="flex-1" />
											{busy ? (
												<Button variant="outline" onClick={() => void call("cancel", { id: task.id })}>
													<Square className="size-3.5 fill-current" /> {t("stop")}
												</Button>
											) : (
												<Button variant="outline" onClick={() => void call("runNow", { id: task.id }, t("started"))}>
													<Play className="size-3.5" /> {t("runNow")}
												</Button>
											)}
											<Button variant="ghost" onClick={() => void call("setEnabled", { id: task.id, enabled: !task.enabled })}>
												{task.enabled ? t("disable") : t("enable")}
											</Button>
											<Button variant="ghost" aria-label={t("edit")} onClick={() => setEditing({ id: task.id, name: task.name, prompt: task.prompt, workspaceId: task.workspaceId, schedule: task.schedule, access: task.access, enabled: task.enabled, model: task.model })}>
												<Pencil className="size-4" />
											</Button>
											<Button variant="danger" aria-label={t("delete")} onClick={() => confirm(t("confirmDelete", { name: task.name })) && void call("remove", { id: task.id })}>
												<Trash2 className="size-4" />
											</Button>
										</div>
										<p className="mt-2 line-clamp-2 text-sm text-ink-400">{task.prompt}</p>
										<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
											<span className="flex items-center gap-1">
												<Clock className="size-3.5" /> {task.scheduleText}
											</span>
											<span>{wsName(task.workspaceId)}</span>
											{task.enabled && task.nextRunAt && <span>{t("next", { when: when(task.nextRunAt) })}</span>}
											<span>{task.lastRunAt ? t("last", { when: when(task.lastRunAt) }) : t("never")}</span>
										</div>
									</li>
								);
							})}
						</ul>
					)}

					{data && (
						<section>
							<div className="mb-2 flex items-center justify-between">
								<h2 className="font-mono text-[10.5px] tracking-[0.18em] text-ink-500 uppercase">{t("runs")}</h2>
								{data.runs.some((r) => r.status !== "running") && (
									<button type="button" className="text-xs text-ink-500 hover:text-ink-200" onClick={() => void call("clearRuns", {})}>
										{t("clear")}
									</button>
								)}
							</div>
							{data.runs.length === 0 ? (
								<p className="rounded-xl border border-dashed border-ink-800 px-4 py-6 text-center text-sm text-ink-500">{t("noRuns")}</p>
							) : (
								<ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-800 bg-ink-900/40">
									{data.runs.map((r) => (
										<li key={r.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
											<span className="mt-0.5 shrink-0">
												<RunBadge status={r.status} />
											</span>
											<span className="min-w-0 flex-1">
												<span className="block text-ink-200">
													{r.taskName} <span className="text-xs text-ink-500">· {when(r.startedAt)}</span>
												</span>
												{(r.error || r.summary) && <span className={clsx("mt-0.5 line-clamp-2 block text-xs", r.error ? "text-rose-400" : "text-ink-500")}>{r.error ?? r.summary}</span>}
											</span>
											{r.sessionId && (
												<button type="button" className="flex shrink-0 items-center gap-1 text-xs text-ember-300 hover:underline" onClick={() => void openSession(r.sessionId!)}>
													<MessageSquare className="size-3.5" /> {t("openChat")}
												</button>
											)}
										</li>
									))}
								</ul>
							)}
						</section>
					)}
					<p className="text-xs leading-relaxed text-ink-500">{t("offline")}</p>
				</div>
			</div>
			{editing && <TaskDialog initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => void load()} />}
		</div>
	);
}
