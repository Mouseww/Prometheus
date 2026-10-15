import clsx from "clsx";
import { Plus, Power, Save, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { SkillDocument, SkillInfo } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginCall, toast } from "../lib/store.ts";
import { Badge, Button, Empty, Field, Input, PageHeader, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		scopePrometheus: "Prometheus 技能库",
		scopeUser: "用户（~/.pi/agent/skills）",
		scopeProject: "项目（.pi/skills）",
		title: "技能",
		subtitle: "Agent Skills（SKILL.md）：模型依据描述按需加载，也可通过 /skill:名称 手动调用",
		newSkill: "新建技能",
		disabled: "已停用",
		manualOnly: "仅手动",
		noSkills: "暂无技能",
		emptyTitle: "还没有技能",
		emptyBody: "技能是一份 SKILL.md 说明书，模型会在需要时依据描述自动加载。",
		user: "用户",
		project: "项目",
		noDescription: "（无描述）",
		path: "路径",
		readOnlyHint: "该技能由 PI 的技能文件管理，请直接编辑上述文件。",
		saved: "已保存技能 {name}",
		confirmDelete: "删除技能「{name}」？",
		deleted: "已删除技能 {name}",
		loading: "加载中…",
		delete: "删除",
		disabledToast: "已停用 {name}",
		enabledToast: "已启用 {name}",
		disable: "停用",
		enable: "启用",
		save: "保存",
		created: "已创建技能 {name}",
		name: "名称",
		nameInvalid: "仅限小写字母、数字与单个连字符，最长 64 字符",
		nameHint: "小写字母、数字与连字符，如 pdf-tools",
		description: "描述",
		descriptionHint: "模型依据描述决定何时调用",
		descriptionPlaceholder: "处理 PDF：提取文本、合并、拆分。当用户提到 PDF 文件时使用。",
		body: "正文（Markdown）",
		bodyPlaceholder: "# 使用说明",
		allowModel: "允许模型自动调用",
		cancel: "取消",
		create: "创建",
	},
	en: {
		scopePrometheus: "Prometheus skills",
		scopeUser: "User (~/.pi/agent/skills)",
		scopeProject: "Project (.pi/skills)",
		title: "Skills",
		subtitle: "Agent Skills (SKILL.md): loaded on demand based on their description, or invoked manually with /skill:name",
		newSkill: "New skill",
		disabled: "Disabled",
		manualOnly: "Manual only",
		noSkills: "No skills",
		emptyTitle: "No skills yet",
		emptyBody: "A skill is a SKILL.md guide the model loads automatically when its description matches the task.",
		user: "User",
		project: "Project",
		noDescription: "(No description)",
		path: "Path",
		readOnlyHint: "This skill is managed by PI's skill files. Edit the file above directly.",
		saved: "Saved skill {name}",
		confirmDelete: "Delete skill \"{name}\"?",
		deleted: "Deleted skill {name}",
		loading: "Loading…",
		delete: "Delete",
		disabledToast: "Disabled {name}",
		enabledToast: "Enabled {name}",
		disable: "Disable",
		enable: "Enable",
		save: "Save",
		created: "Created skill {name}",
		name: "Name",
		nameInvalid: "Lowercase letters, digits and single hyphens only, up to 64 characters",
		nameHint: "Lowercase letters, digits and hyphens, e.g. pdf-tools",
		description: "Description",
		descriptionHint: "The model uses this to decide when to invoke the skill",
		descriptionPlaceholder: "Work with PDFs: extract text, merge, split. Use when the user mentions PDF files.",
		body: "Body (Markdown)",
		bodyPlaceholder: "# Instructions",
		allowModel: "Allow the model to invoke automatically",
		cancel: "Cancel",
		create: "Create",
	},
});

const NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;
const SCOPES: { scope: SkillInfo["scope"]; title: keyof typeof M.zh }[] = [
	{ scope: "prometheus", title: "scopePrometheus" },
	{ scope: "user", title: "scopeUser" },
	{ scope: "project", title: "scopeProject" },
];
const keyOf = (s: SkillInfo) => `${s.scope}:${s.name}`;

export function SkillsView() {
	const t = useT(M);
	const [skills, setSkills] = useState<SkillInfo[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const load = async () => {
		const list = await pluginCall<SkillInfo[]>("skills", "list");
		if (!list) return;
		setSkills(list);
		setSelected((s) => (s && list.some((x) => keyOf(x) === s) ? s : list[0] ? keyOf(list[0]) : null));
	};
	useEffect(() => {
		void load();
	}, []);

	const current = skills.find((s) => keyOf(s) === selected);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<Button variant="primary" onClick={() => setCreating(true)}>
						<Plus className="size-4" /> {t("newSkill")}
					</Button>
				}
			/>
			<div className="flex min-h-0 flex-1">
				<div className="w-80 shrink-0 space-y-4 overflow-y-auto border-r hairline p-3">
					{SCOPES.map(({ scope, title }) => {
						const items = skills.filter((s) => s.scope === scope);
						if (items.length === 0) return null;
						return (
							<div key={scope} className="space-y-1">
								<div className="px-3 pt-1 pb-1 text-[11px] font-medium tracking-wide text-ink-500">{t(title)}</div>
								{items.map((s) => (
									<button
										key={keyOf(s)}
										type="button"
										onClick={() => {
											setSelected(keyOf(s));
											setCreating(false);
										}}
										className={clsx("w-full rounded-lg px-3 py-2.5 text-left transition-colors", keyOf(s) === selected && !creating ? "bg-ink-850" : "hover:bg-ink-900")}
									>
										<div className={clsx("truncate font-mono text-sm", s.enabled ? "text-ink-100" : "text-ink-500")}>{s.name}</div>
										{s.description && <div className="mt-0.5 line-clamp-2 text-xs text-ink-500">{s.description}</div>}
										{(!s.enabled || !s.modelInvocation) && (
											<div className="mt-1.5 flex flex-wrap gap-1">
												{!s.enabled && <Badge tone="rose">{t("disabled")}</Badge>}
												{!s.modelInvocation && <Badge>{t("manualOnly")}</Badge>}
											</div>
										)}
									</button>
								))}
							</div>
						);
					})}
					{skills.length === 0 && <p className="px-3 py-4 text-sm text-ink-500">{t("noSkills")}</p>}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{creating ? (
						<CreateSkill
							onDone={async (name) => {
								setCreating(false);
								await load();
								if (name) setSelected(`prometheus:${name}`);
							}}
						/>
					) : current ? (
						current.editable && current.scope === "prometheus" ? (
							<SkillEditor key={keyOf(current)} skill={current} onChanged={load} />
						) : (
							<ReadOnlySkill skill={current} />
						)
					) : (
						<Empty icon={<Sparkles className="size-5" />} title={t("emptyTitle")}>
							{t("emptyBody")}
						</Empty>
					)}
				</div>
			</div>
		</div>
	);
}

function ReadOnlySkill({ skill }: { skill: SkillInfo }) {
	const t = useT(M);
	return (
		<div className="mx-auto max-w-2xl animate-rise space-y-5 p-8">
			<div className="flex items-center gap-2">
				<h2 className="font-mono text-xl font-semibold">{skill.name}</h2>
				<Badge tone="sky">{skill.scope === "user" ? t("user") : t("project")}</Badge>
				{!skill.modelInvocation && <Badge>{t("manualOnly")}</Badge>}
			</div>
			<p className="text-sm whitespace-pre-wrap text-ink-300">{skill.description || t("noDescription")}</p>
			<Field label={t("path")}>
				<div className="rounded-lg border border-ink-800 bg-ink-900/60 px-3 py-2 font-mono text-xs break-all text-ink-400">{skill.path}</div>
			</Field>
			<p className="text-xs text-ink-500">{t("readOnlyHint")}</p>
		</div>
	);
}

function SkillEditor({ skill, onChanged }: { skill: SkillInfo; onChanged: () => Promise<void> }) {
	const t = useT(M);
	const [content, setContent] = useState<string | null>(null);
	const [saved, setSaved] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void pluginCall<SkillDocument>("skills", "get", { name: skill.name }).then((doc) => {
			if (!doc) return;
			setContent(doc.content);
			setSaved(doc.content);
		});
	}, [skill.name]);

	const run = async (method: string, params: Record<string, unknown>, msg: string) => {
		setBusy(true);
		const res = await pluginCall<null>("skills", method, params);
		setBusy(false);
		if (res === undefined) return false;
		toast(msg);
		await onChanged();
		return true;
	};

	const save = async () => {
		if (content === null) return;
		if (await run("save", { name: skill.name, content }, t("saved", { name: skill.name }))) setSaved(content);
	};

	const remove = async () => {
		if (!window.confirm(t("confirmDelete", { name: skill.name }))) return;
		await run("delete", { name: skill.name }, t("deleted", { name: skill.name }));
	};

	return (
		<div className="mx-auto max-w-4xl animate-rise space-y-4 p-6">
			<div className="flex items-center gap-2">
				<h2 className="font-mono text-xl font-semibold">{skill.name}</h2>
				{!skill.enabled && <Badge tone="rose">{t("disabled")}</Badge>}
				{!skill.modelInvocation && <Badge>{t("manualOnly")}</Badge>}
				<span className="ml-auto truncate font-mono text-[11px] text-ink-500" title={skill.path}>
					{skill.path}
				</span>
			</div>
			<Textarea
				value={content ?? ""}
				disabled={content === null}
				onChange={(e) => setContent(e.target.value)}
				spellCheck={false}
				className="min-h-[60vh] font-mono text-[13px] leading-relaxed"
				placeholder={t("loading")}
			/>
			<div className="flex items-center gap-2">
				<Button variant="danger" disabled={busy} onClick={() => void remove()}>
					<Trash2 className="size-4" /> {t("delete")}
				</Button>
				<div className="flex-1" />
				<Button
					variant="outline"
					disabled={busy}
					onClick={() => void run("toggle", { name: skill.name, enabled: !skill.enabled }, skill.enabled ? t("disabledToast", { name: skill.name }) : t("enabledToast", { name: skill.name }))}
				>
					<Power className="size-4" /> {skill.enabled ? t("disable") : t("enable")}
				</Button>
				<Button variant="primary" disabled={busy || content === null || content === saved} onClick={() => void save()}>
					<Save className="size-4" /> {t("save")}
				</Button>
			</div>
		</div>
	);
}

function CreateSkill({ onDone }: { onDone: (name?: string) => Promise<void> }) {
	const t = useT(M);
	const [form, setForm] = useState({ name: "", description: "", body: "", modelInvocation: true });
	const [busy, setBusy] = useState(false);
	const nameOk = NAME_RE.test(form.name);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!nameOk || !form.description.trim()) return;
		setBusy(true);
		const res = await pluginCall<null>("skills", "create", {
			name: form.name,
			description: form.description.trim(),
			body: form.body || undefined,
			modelInvocation: form.modelInvocation,
		});
		setBusy(false);
		if (res === undefined) return;
		toast(t("created", { name: form.name }));
		await onDone(form.name);
	};

	return (
		<form onSubmit={submit} className="mx-auto max-w-2xl animate-rise space-y-5 p-8">
			<h2 className="font-display text-xl font-semibold">{t("newSkill")}</h2>
			<Field label={t("name")} hint={form.name && !nameOk ? <span className="text-rose-400">{t("nameInvalid")}</span> : t("nameHint")}>
				<Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="pdf-tools" className="font-mono" />
			</Field>
			<Field label={t("description")} hint={t("descriptionHint")}>
				<Textarea required rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t("descriptionPlaceholder")} />
			</Field>
			<Field label={t("body")}>
				<Textarea rows={12} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder={t("bodyPlaceholder")} className="font-mono text-[13px]" />
			</Field>
			<label className="flex items-center gap-2 text-sm text-ink-300">
				<input type="checkbox" checked={form.modelInvocation} onChange={(e) => setForm({ ...form, modelInvocation: e.target.checked })} className="accent-ember-500" />
				{t("allowModel")}
			</label>
			<div className="flex justify-end gap-2">
				<Button variant="outline" onClick={() => void onDone()}>
					{t("cancel")}
				</Button>
				<Button type="submit" variant="primary" disabled={busy || !nameOk || !form.description.trim()}>
					{t("create")}
				</Button>
			</div>
		</form>
	);
}
