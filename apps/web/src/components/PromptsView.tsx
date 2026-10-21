import clsx from "clsx";
import { Bot, Check, ClipboardList, FilePen, Hand, RotateCcw, Save, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { PERMISSION_MODES, type PermissionMode, type ProfileSummary } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginCall, toast } from "../lib/store.ts";
import { Badge, Button, Field, Input, PageHeader, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "提示词模式",
		subtitle: "每个权限模式配一份系统提示词，切模式即换提示词。模式本身由权限门强制，提示词只是告诉模型这个模式要怎么做。",
		modeLabel: "模式",
		modes: "模式",
		custom: "自定义",
		enabled: "启用",
		disabled: "已停用",
		edit: "编辑",
		save: "保存",
		reset: "恢复默认",
		remove: "删除",
		newPrompt: "新增提示词",
		noPrompt: "该模式没有提示词",
		noPromptBody: "新增一份，或从其他模式复制。没有提示词时，这个模式就用宿主自己的默认提示。",
		name: "名称",
		description: "说明",
		descriptionPlaceholder: "一句话说明这个模式怎么工作",
		body: "系统提示词（Markdown）",
		loading: "加载中…",
		saved: "已保存，下一轮对话生效",
		resetDone: "已恢复内置提示词",
		deleted: "已删除提示词",
		confirmDelete: "删除「{name}」的提示词？",
		confirmReset: "恢复内置提示词？你改过的内容会丢失。",
		how: "注入方式",
		howReplace: "替换系统提示词段落",
		howAppend: "追加在宿主默认提示之后",
		dropPersona: "同时去掉宿主默认的身份介绍",
		chars: "{n} 字",
		default: "默认",
		acceptEdits: "自动编辑",
		plan: "计划模式",
		bypassPermissions: "白帽子",
		auto: "Auto",
		default_desc: "标准助手：正常帮忙，正常谨慎",
		acceptEdits_desc: "项目内编辑免确认，命令仍需确认",
		plan_desc: "只读调研，给出计划待批准",
		bypassPermissions_desc: "白帽子：授权攻防，直接交付",
		auto_desc: "全放开，遇事由 AI 自己决定",
		gateNote: "模式由底部的权限选择器切换（Shift+Tab 也可）。这里改的是该模式说什么，不是它能做什么。",
	},
	en: {
		title: "Prompt modes",
		subtitle: "Every permission mode carries a system prompt, so switching mode switches the prompt. The gate enforces the mode; the prompt only tells the model how to work inside it.",
		modeLabel: "Mode",
		modes: "Modes",
		custom: "Custom",
		enabled: "Enabled",
		disabled: "Disabled",
		edit: "Edit",
		save: "Save",
		reset: "Restore default",
		remove: "Delete",
		newPrompt: "New prompt",
		noPrompt: "No prompt for this mode",
		noPromptBody: "Add one, or copy another mode's. Without a prompt the mode falls back to the host's own default.",
		name: "Name",
		description: "Description",
		descriptionPlaceholder: "One line on how this mode works",
		body: "System prompt (Markdown)",
		loading: "Loading…",
		saved: "Saved; applies from the next turn",
		resetDone: "Bundled prompt restored",
		deleted: "Prompt deleted",
		confirmDelete: "Delete the prompt for \"{name}\"?",
		confirmReset: "Restore the bundled prompt? Your edits are lost.",
		how: "Injection",
		howReplace: "Replace the system prompt section",
		howAppend: "Append after the host's default prompt",
		dropPersona: "Also drop the host's identity preamble",
		chars: "{n} chars",
		default: "Default",
		acceptEdits: "Accept edits",
		plan: "Plan",
		bypassPermissions: "White hat",
		auto: "Auto",
		default_desc: "Standard assistant: normal help, normal caution",
		acceptEdits_desc: "Project edits pass; commands still confirm",
		plan_desc: "Read-only research and a plan for approval",
		bypassPermissions_desc: "White hat: authorized security work, deliver first",
		auto_desc: "Everything allowed; the agent decides on its own",
		gateNote: "The mode itself is switched from the permission picker at the bottom (Shift+Tab also works). This page edits what the mode says, not what it may do.",
	},
});

const ICONS = { default: Hand, acceptEdits: FilePen, plan: ClipboardList, bypassPermissions: ShieldAlert, auto: Bot } as const;

/** Mode names and their fallback descriptions, so the message keys stay statically typed. */
const LABEL = {
	default: "default",
	acceptEdits: "acceptEdits",
	plan: "plan",
	bypassPermissions: "bypassPermissions",
	auto: "auto",
} as const satisfies Record<PermissionMode, keyof typeof M.zh>;
const DESC = {
	default: "default_desc",
	acceptEdits: "acceptEdits_desc",
	plan: "plan_desc",
	bypassPermissions: "bypassPermissions_desc",
	auto: "auto_desc",
} as const satisfies Record<PermissionMode, keyof typeof M.zh>;
const TONE: Record<PermissionMode, string> = {
	default: "text-ink-400",
	acceptEdits: "text-moss-400",
	plan: "text-sky-400",
	bypassPermissions: "text-rose-400",
	auto: "text-amber-400",
};

export function PromptsView() {
	const t = useT(M);
	const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
	const [selected, setSelected] = useState<PermissionMode | null>(null);
	const [creating, setCreating] = useState<PermissionMode | null>(null);
	const [loaded, setLoaded] = useState(false);

	const load = async () => {
		const res = await pluginCall<{ profiles: ProfileSummary[] }>("prompts", "list");
		if (!res) return;
		setProfiles(res.profiles);
		setSelected((s) => s ?? "default");
		setLoaded(true);
	};
	useEffect(() => {
		void load();
	}, []);

	const current = profiles.find((p) => p.mode === selected && p.enabled) ?? profiles.find((p) => p.mode === selected);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<div className="flex min-h-0 flex-1 flex-col md:flex-row">
				<div className="w-full shrink-0 space-y-1 overflow-y-auto border-b hairline p-3 md:w-72 md:border-r md:border-b-0">
					<div className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-ink-500">{t("modes")}</div>
					{PERMISSION_MODES.map((mode) => {
						const Icon = ICONS[mode];
						const has = profiles.find((p) => p.mode === mode && p.enabled);
						return (
							<button
								key={mode}
								type="button"
								onClick={() => {
									setSelected(mode);
									setCreating(null);
								}}
								className={clsx("w-full rounded-lg px-3 py-2.5 text-left transition-colors", mode === selected && !creating ? "bg-ink-850" : "hover:bg-ink-900")}
							>
								<div className="flex items-center gap-2">
									<Icon className={clsx("size-4 shrink-0", TONE[mode])} />
									<span className="truncate text-sm text-ink-100">{t(LABEL[mode])}</span>
									{has ? <Check className="ml-auto size-3.5 shrink-0 text-moss-400" /> : <span className="ml-auto text-[10px] text-ink-600">{t("custom")}</span>}
								</div>
								<div className="mt-0.5 line-clamp-2 text-xs text-ink-500">{has?.description || t(DESC[mode])}</div>
							</button>
						);
					})}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{creating ? (
						<PromptEditor
							key={`new-${creating}`}
							mode={creating}
							profile={null}
							onChanged={async () => {
								setCreating(null);
								await load();
							}}
						/>
					) : selected ? (
						<PromptEditor key={`${selected}-${current?.id ?? "none"}`} mode={selected} profile={current ?? null} onChanged={load} />
					) : null}
					{!loaded && <p className="p-6 text-sm text-ink-500">{t("loading")}</p>}
				</div>
			</div>
			<div className="border-t hairline px-4 py-2 text-xs text-ink-500">{t("gateNote")}</div>
		</div>
	);
}

interface Draft {
	title: string;
	description: string;
	body: string;
	enabled: boolean;
	how: "replace" | "append";
	dropPersona: boolean;
}

const draftOf = (p: ProfileSummary, body: string): Draft => ({
	title: p.title,
	description: p.description,
	body,
	enabled: p.enabled,
	how: p.how,
	dropPersona: p.dropPersona,
});

function PromptEditor({ mode, profile, onChanged }: { mode: PermissionMode; profile: ProfileSummary | null; onChanged: () => Promise<void> }) {
	const t = useT(M);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saved, setSaved] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);
	const Icon = ICONS[mode];

	useEffect(() => {
		if (!profile) {
			setDraft({ title: t(LABEL[mode]), description: "", body: "", enabled: true, how: "append", dropPersona: false });
			setSaved(null);
			return;
		}
		void pluginCall<ProfileSummary & { body: string }>("prompts", "get", { id: profile.id }).then((full) => {
			if (!full) return;
			const next = draftOf(full, full.body);
			setDraft(next);
			setSaved(next);
		});
	}, [profile?.id]);

	const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
	const dirty = draft !== null && (saved === null || JSON.stringify(draft) !== JSON.stringify(saved));

	const save = async () => {
		if (!draft) return;
		setBusy(true);
		const payload = { ...profile, mode, ...draft, body: draft.body };
		const res = profile
			? await pluginCall<{ id: string }>("prompts", "save", { profile: { ...payload, id: profile.id } })
			: await pluginCall<{ id: string }>("prompts", "create", { mode, profile: payload });
		setBusy(false);
		if (res === undefined) return;
		toast(t("saved"));
		await onChanged();
	};

	const reset = async () => {
		if (!profile || !window.confirm(t("confirmReset"))) return;
		setBusy(true);
		const res = await pluginCall<null>("prompts", "reset", { id: profile.id });
		setBusy(false);
		if (res === undefined) return;
		toast(t("resetDone"));
		await onChanged();
	};

	const remove = async () => {
		if (!profile || !window.confirm(t("confirmDelete", { name: profile.title }))) return;
		setBusy(true);
		const res = await pluginCall<null>("prompts", "delete", { id: profile.id });
		setBusy(false);
		if (res === undefined) return;
		toast(t("deleted"));
		await onChanged();
	};

	return (
		<div className="mx-auto max-w-4xl animate-rise space-y-4 p-4 md:p-6">
			<div className="flex flex-wrap items-center gap-2">
				<Icon className={clsx("size-5", TONE[mode])} />
				<h2 className="font-display text-xl font-semibold">{t(LABEL[mode])}</h2>
				{profile && <Badge tone="sky">{t("modeLabel")}</Badge>}
				{profile && !profile.enabled && <Badge tone="rose">{t("disabled")}</Badge>}
				{!profile && <Badge tone="muted">{t("noPrompt")}</Badge>}
				<span className="ml-auto font-mono text-[11px] text-ink-500">{profile?.file ?? (profile ? t("custom") : "")}</span>
			</div>

			{!profile && <p className="text-sm text-ink-400">{t("noPromptBody")}</p>}

			<div className="grid gap-3 sm:grid-cols-2">
				<Field label={t("name")}>
					<Input value={draft?.title ?? ""} disabled={!draft} onChange={(e) => set("title", e.target.value)} />
				</Field>
				<Field label={t("description")}>
					<Input value={draft?.description ?? ""} disabled={!draft} placeholder={t("descriptionPlaceholder")} onChange={(e) => set("description", e.target.value)} />
				</Field>
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				<Field label={t("how")}>
					<select
						value={draft?.how ?? "replace"}
						disabled={!draft}
						onChange={(e) => set("how", e.target.value as Draft["how"])}
						className="w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm"
					>
						<option value="replace">{t("howReplace")}</option>
						<option value="append">{t("howAppend")}</option>
					</select>
				</Field>
				<div className="flex flex-col justify-end gap-1.5 pb-1">
					<label className="flex items-center gap-2 text-sm text-ink-300">
						<input type="checkbox" checked={draft?.enabled ?? false} disabled={!draft} onChange={(e) => set("enabled", e.target.checked)} className="accent-ember-500" />
						{t("enabled")}
					</label>
					<label className="flex items-center gap-2 text-sm text-ink-300">
						<input type="checkbox" checked={draft?.dropPersona ?? false} disabled={!draft} onChange={(e) => set("dropPersona", e.target.checked)} className="accent-ember-500" />
						{t("dropPersona")}
					</label>
				</div>
			</div>

			<Field label={t("body")}>
				<Textarea
					value={draft?.body ?? ""}
					disabled={!draft}
					onChange={(e) => set("body", e.target.value)}
					spellCheck={false}
					className="min-h-[50vh] font-mono text-[13px] leading-relaxed"
					placeholder={draft ? "" : t("loading")}
				/>
			</Field>

			<div className="flex flex-wrap items-center gap-2">
				{profile && (
					<Button variant="danger" disabled={busy} onClick={() => void remove()}>
						<Trash2 className="size-4" /> {t("remove")}
					</Button>
				)}
				<div className="flex-1" />
				{profile?.file && (
					<Button variant="outline" disabled={busy} onClick={() => void reset()}>
						<RotateCcw className="size-4" /> {t("reset")}
					</Button>
				)}
				<Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
					<Save className="size-4" /> {t("save")}
				</Button>
			</div>
		</div>
	);
}
