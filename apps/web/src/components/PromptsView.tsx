import clsx from "clsx";
import { Check, Copy, MessageSquareCode, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProfileSummary } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginCall, toast } from "../lib/store.ts";
import { Badge, Button, Empty, Field, Input, PageHeader, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "系统提示词",
		subtitle: "预设的提示词配置：选中一份后注入每次对话的系统提示，可随时切换或关闭",
		newProfile: "新建",
		duplicate: "复制",
		active: "生效中",
		disabled: "已停用",
		builtin: "内置",
		inline: "自定义",
		noProfiles: "还没有配置",
		emptyTitle: "还没有提示词配置",
		emptyBody: "新建一份，把要注入的系统提示写进去。保存后选中它，下一轮对话就生效。",
		loading: "加载中…",
		delete: "删除",
		save: "保存",
		activate: "用于所有会话",
		deactivated: "已取消默认配置",
		activatedToast: "已设为所有会话的默认配置",
		saved: "已保存，下一轮对话生效",
		deleted: "已删除配置",
		confirmDelete: "删除「{name}」？",
		name: "名称",
		description: "说明",
		descriptionPlaceholder: "一句话说明这份配置干什么用",
		body: "提示词（Markdown）",
		bodyPlaceholder: "# 工作模式\n\n…",
		enabled: "启用",
		injectMode: "注入方式",
		modeReplace: "替换系统提示的一部分（推荐）",
		modeAppend: "追加在默认提示之后",
		modeCustom: "整体替换系统提示（最强，会遮住其他插件注入的内容）",
		builtinHint: "内置文件每轮从随包文件读取，保存会另存为你自己的可编辑副本。",
		sourceFile: "来源文件",
		chars: "{n} 字",
		featureOff: "该插件已在设置中停用",
	},
	en: {
		title: "System prompt",
		subtitle: "Saved prompt profiles: the selected one is injected into every chat's system prompt, and can be switched or turned off at any time",
		newProfile: "New",
		duplicate: "Duplicate",
		active: "Active",
		disabled: "Disabled",
		builtin: "Built in",
		inline: "Custom",
		noProfiles: "No profiles",
		emptyTitle: "No prompt profiles yet",
		emptyBody: "Create one and write the system prompt to inject. Save it, select it, and it applies from the next turn.",
		loading: "Loading…",
		delete: "Delete",
		save: "Save",
		activate: "Use for all chats",
		deactivated: "Default profile cleared",
		activatedToast: "Set as the default for all chats",
		saved: "Saved; applies from the next turn",
		deleted: "Profile deleted",
		confirmDelete: "Delete \"{name}\"?",
		name: "Name",
		description: "Description",
		descriptionPlaceholder: "One line on what this profile is for",
		body: "Prompt (Markdown)",
		bodyPlaceholder: "# Working mode\n\n…",
		enabled: "Enabled",
		injectMode: "Injection",
		modeReplace: "Replace part of the system prompt (recommended)",
		modeAppend: "Append after the default prompt",
		modeCustom: "Replace the whole system prompt (strongest; hides what other plugins inject)",
		builtinHint: "A bundled file is read from the package every turn. Saving stores your own editable copy.",
		sourceFile: "Source file",
		chars: "{n} chars",
		featureOff: "This plugin is switched off in Settings",
	},
});

const keyOf = (p: ProfileSummary) => p.id;

export function PromptsView() {
	const t = useT(M);
	const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
	const [active, setActive] = useState<string | null>(null);
	const [enabled, setEnabled] = useState(true);
	const [selected, setSelected] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);

	const load = async () => {
		const res = await pluginCall<{ enabled: boolean; active: string | null; profiles: ProfileSummary[] }>("prompts", "list");
		if (!res) return;
		setProfiles(res.profiles);
		setActive(res.active);
		setEnabled(res.enabled);
		setSelected((s) => (s && res.profiles.some((x) => keyOf(x) === s) ? s : res.profiles[0] ? keyOf(res.profiles[0]) : null));
		setLoaded(true);
	};
	useEffect(() => {
		void load();
	}, []);

	const current = profiles.find((p) => keyOf(p) === selected);

	const activate = async (id: string | null) => {
		const res = await pluginCall<{ active: string | null }>("prompts", "activate", { id });
		if (res === undefined) return;
		setActive(res.active);
		toast(id ? t("activatedToast") : t("deactivated"));
		await load();
	};

	const duplicate = async () => {
		if (!current) return;
		const res = await pluginCall<{ id: string }>("prompts", "create", { from: current.id });
		if (!res) return;
		await load();
		setSelected(res.id);
	};

	const create = async () => {
		const res = await pluginCall<{ id: string }>("prompts", "create", {});
		if (!res) return;
		await load();
		setSelected(res.id);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<div className="flex gap-2">
						<Button variant="outline" disabled={!current} onClick={() => void duplicate()}>
							<Copy className="size-4" /> {t("duplicate")}
						</Button>
						<Button variant="primary" onClick={() => void create()}>
							<Plus className="size-4" /> {t("newProfile")}
						</Button>
					</div>
				}
			/>
			{!enabled && (
				<div className="border-b hairline bg-ink-900 px-4 py-2 text-xs text-ember-300">{t("featureOff")}</div>
			)}
			<div className="flex min-h-0 flex-1 flex-col md:flex-row">
				<div className="max-h-[38%] w-full shrink-0 space-y-1 overflow-y-auto border-b hairline p-3 md:max-h-none md:w-80 md:border-r md:border-b-0">
					{profiles.map((p) => (
						<button
							key={keyOf(p)}
							type="button"
							onClick={() => setSelected(keyOf(p))}
							className={clsx("w-full rounded-lg px-3 py-2.5 text-left transition-colors", keyOf(p) === selected ? "bg-ink-850" : "hover:bg-ink-900")}
						>
							<div className="flex items-center gap-2">
								<div className={clsx("truncate text-sm", p.enabled ? "text-ink-100" : "text-ink-500")}>{p.title}</div>
								{active === p.id && <Badge tone="moss">{t("active")}</Badge>}
							</div>
							<div className="mt-0.5 line-clamp-2 text-xs text-ink-500">{p.description || t("chars", { n: p.bodyLength })}</div>
							{!p.enabled && (
								<div className="mt-1.5">
									<Badge tone="rose">{t("disabled")}</Badge>
								</div>
							)}
						</button>
					))}
					{loaded && profiles.length === 0 && <p className="px-3 py-4 text-sm text-ink-500">{t("noProfiles")}</p>}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{current ? (
						<ProfileEditor
							key={keyOf(current)}
							profile={current}
							active={active === current.id}
							onChanged={load}
							onActivate={() => void activate(current.id === active ? null : current.id)}
						/>
					) : (
						<Empty icon={<MessageSquareCode className="size-5" />} title={t("emptyTitle")}>
							{t("emptyBody")}
						</Empty>
					)}
				</div>
			</div>
		</div>
	);
}

interface Draft {
	title: string;
	description: string;
	body: string;
	enabled: boolean;
	mode: "replace" | "append" | "custom";
}

const draftOf = (p: ProfileSummary, body: string): Draft => ({
	title: p.title,
	description: p.description,
	body,
	enabled: p.enabled,
	mode: p.dropPersona ? "custom" : p.mode,
});

function ProfileEditor({ profile, active, onChanged, onActivate }: { profile: ProfileSummary; active: boolean; onChanged: () => Promise<void>; onActivate: () => void }) {
	const t = useT(M);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saved, setSaved] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void pluginCall<ProfileSummary & { body: string }>("prompts", "get", { id: profile.id }).then((full) => {
			if (!full) return;
			const next = draftOf(full, full.body);
			setDraft(next);
			setSaved(next);
		});
	}, [profile.id]);

	const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
	const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
	const builtin = profile.source === "builtin";

	const save = async () => {
		if (!draft) return;
		setBusy(true);
		const res = await pluginCall<{ id: string }>("prompts", "save", {
			profile: {
				...profile,
				title: draft.title,
				description: draft.description,
				body: draft.body,
				enabled: draft.enabled,
				mode: draft.mode === "custom" ? "replace" : draft.mode,
				dropPersona: draft.mode === "custom",
			},
		});
		setBusy(false);
		if (res === undefined) return;
		toast(t("saved"));
		await onChanged();
	};

	const remove = async () => {
		if (!window.confirm(t("confirmDelete", { name: profile.title }))) return;
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
				<h2 className="font-display text-xl font-semibold">{profile.title}</h2>
				<Badge tone={builtin ? "sky" : "muted"}>{builtin ? t("builtin") : t("inline")}</Badge>
				{active ? <Badge tone="moss">{t("active")}</Badge> : null}
				{builtin && profile.file && (
					<span className="ml-auto truncate font-mono text-[11px] text-ink-500" title={profile.file}>
						{t("sourceFile")}: {profile.file}
					</span>
				)}
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				<Field label={t("name")}>
					<Input value={draft?.title ?? ""} disabled={!draft} onChange={(e) => set("title", e.target.value)} />
				</Field>
				<Field label={t("description")}>
					<Input
						value={draft?.description ?? ""}
						disabled={!draft}
						onChange={(e) => set("description", e.target.value)}
						placeholder={t("descriptionPlaceholder")}
					/>
				</Field>
			</div>

			<div>
				<Field label={t("injectMode")}>
					<select
						value={draft?.mode ?? "replace"}
						disabled={!draft}
						onChange={(e) => set("mode", e.target.value as Draft["mode"])}
						className="w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm"
					>
						<option value="replace">{t("modeReplace")}</option>
						<option value="append">{t("modeAppend")}</option>
						<option value="custom">{t("modeCustom")}</option>
					</select>
				</Field>
			</div>

			<label className="flex items-center gap-2 text-sm text-ink-300">
				<input type="checkbox" checked={draft?.enabled ?? false} disabled={!draft} onChange={(e) => set("enabled", e.target.checked)} className="accent-ember-500" />
				{t("enabled")}
			</label>

			<Field label={t("body")}>
				<Textarea
					value={draft?.body ?? ""}
					disabled={!draft}
					onChange={(e) => set("body", e.target.value)}
					spellCheck={false}
					className="min-h-[50vh] font-mono text-[13px] leading-relaxed"
					placeholder={draft ? t("bodyPlaceholder") : t("loading")}
				/>
			</Field>
			{builtin && <p className="text-xs text-ink-500">{t("builtinHint")}</p>}

			<div className="flex flex-wrap items-center gap-2">
				<Button variant="danger" disabled={busy} onClick={() => void remove()}>
					<Trash2 className="size-4" /> {t("delete")}
				</Button>
				<div className="flex-1" />
				<Button variant="outline" disabled={busy} onClick={onActivate}>
					<Check className="size-4" /> {t("activate")}
				</Button>
				<Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
					<Save className="size-4" /> {t("save")}
				</Button>
			</div>
		</div>
	);
}
