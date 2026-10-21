import clsx from "clsx";
import { Check, Copy, MessageSquareCode, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProfileSummary } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginCall, toast } from "../lib/store.ts";
import { Badge, Button, Empty, Field, Input, PageHeader, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "系统提示词",
		subtitle: "提示词决定模型怎么回答问题，权限模式决定它能执行什么。两者相互独立：选白帽子只换说话方式，不会放开工具确认。",
		newProfile: "新建",
		duplicate: "复制",
		selected: "使用中",
		disabled: "已停用",
		builtin: "内置",
		custom: "自定义",
		emptyTitle: "还没有提示词",
		emptyBody: "新建一份并写下系统提示词，然后点“在所有会话使用”启用。",
		none: "未启用任何提示词",
		noneHint: "当前所有会话都使用宿主自带的默认提示。",
		loading: "加载中…",
		name: "名称",
		description: "说明",
		descriptionPlaceholder: "一句话说明这份提示词怎么工作",
		body: "系统提示词（Markdown）",
		how: "注入方式",
		howReplace: "替换系统提示词段落",
		howAppend: "追加在宿主默认提示之后",
		dropPersona: "同时去掉宿主默认的身份介绍",
		enable: "在所有会话使用",
		disable: "取消使用",
		save: "保存",
		reset: "恢复内置",
		delete: "删除",
		enabled: "启用",
		chars: "{n} 字",
		saved: "已保存，下一轮对话生效",
		resetDone: "已恢复内置提示词",
		deleted: "已删除",
		activated: "已设为所有会话的默认提示词",
		deactivated: "已取消默认提示词",
		confirmDelete: "删除「{name}」？",
		confirmReset: "恢复内置内容？你改过的部分会丢失。",
		permissionNote: "权限仍在输入框底部单独切换。",
	},
	en: {
		title: "System prompt",
		subtitle: "The prompt decides how the model answers; the permission mode decides what it may run. They are independent: picking White hat changes how it talks, not what it is allowed to do.",
		newProfile: "New",
		duplicate: "Duplicate",
		selected: "In use",
		disabled: "Disabled",
		builtin: "Built in",
		custom: "Custom",
		emptyTitle: "No prompts yet",
		emptyBody: "Create one, write the system prompt, then use it for all chats.",
		none: "No prompt in use",
		noneHint: "Every chat uses the host's own default prompt.",
		loading: "Loading…",
		name: "Name",
		description: "Description",
		descriptionPlaceholder: "One line on how this prompt works",
		body: "System prompt (Markdown)",
		how: "Injection",
		howReplace: "Replace the system prompt section",
		howAppend: "Append after the host's default prompt",
		dropPersona: "Also drop the host's identity preamble",
		enable: "Use for all chats",
		disable: "Stop using",
		save: "Save",
		reset: "Restore bundled",
		delete: "Delete",
		enabled: "Enabled",
		chars: "{n} chars",
		saved: "Saved; applies from the next turn",
		resetDone: "Bundled prompt restored",
		deleted: "Deleted",
		activated: "Set as the default for all chats",
		deactivated: "Default prompt cleared",
		confirmDelete: "Delete \"{name}\"?",
		confirmReset: "Restore the bundled text? Your edits are lost.",
		permissionNote: "Permissions are still switched separately at the bottom of the composer.",
	},
});

const keyOf = (p: ProfileSummary) => p.id;

export function PromptsView() {
	const t = useT(M);
	const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [picked, setPicked] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);

	const load = async () => {
		const res = await pluginCall<{ selected: string | null; profiles: ProfileSummary[] }>("prompts", "list");
		if (!res) return;
		setProfiles(res.profiles);
		setSelected(res.selected);
		setPicked((s) => (s && res.profiles.some((x) => keyOf(x) === s) ? s : (res.selected ?? res.profiles[0]?.id ?? null)));
		setLoaded(true);
	};
	useEffect(() => {
		void load();
	}, []);

	const current = profiles.find((p) => keyOf(p) === picked);

	const setDefault = async (id: string | null) => {
		const res = await pluginCall<{ selected: string | null }>("prompts", "select", { id });
		if (res === undefined) return;
		setSelected(res.selected);
		toast(id ? t("activated") : t("deactivated"));
		await load();
	};

	const duplicate = async () => {
		if (!current) return;
		const res = await pluginCall<{ id: string }>("prompts", "create", { from: current.id });
		if (!res) return;
		await load();
		setPicked(res.id);
	};

	const create = async () => {
		const res = await pluginCall<{ id: string }>("prompts", "create", {});
		if (!res) return;
		await load();
		setPicked(res.id);
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
			<div className="flex min-h-0 flex-1 flex-col md:flex-row">
				<div className="max-h-[38%] w-full shrink-0 space-y-1 overflow-y-auto border-b hairline p-3 md:max-h-none md:w-80 md:border-r md:border-b-0">
					<button
						type="button"
						onClick={() => void setDefault(null)}
						className={clsx("w-full rounded-lg px-3 py-2.5 text-left transition-colors", selected === null ? "bg-ink-850" : "hover:bg-ink-900")}
					>
						<div className="flex items-center gap-2">
							<span className={clsx("truncate text-sm", selected === null ? "text-ink-100" : "text-ink-400")}>{t("none")}</span>
							{selected === null && <Check className="ml-auto size-3.5 shrink-0 text-moss-400" />}
						</div>
						<div className="mt-0.5 line-clamp-2 text-xs text-ink-500">{t("noneHint")}</div>
					</button>
					{profiles.map((p) => (
						<button
							key={keyOf(p)}
							type="button"
							onClick={() => setPicked(keyOf(p))}
							className={clsx("w-full rounded-lg px-3 py-2.5 text-left transition-colors", keyOf(p) === picked ? "bg-ink-850" : "hover:bg-ink-900")}
						>
							<div className="flex items-center gap-2">
								<span className={clsx("truncate text-sm", p.enabled ? "text-ink-100" : "text-ink-500")}>{p.title}</span>
								{selected === p.id && <Badge tone="moss">{t("selected")}</Badge>}
								{!p.enabled && <Badge tone="rose">{t("disabled")}</Badge>}
							</div>
							<div className="mt-0.5 line-clamp-2 text-xs text-ink-500">{p.description || t("chars", { n: p.bodyLength })}</div>
						</button>
					))}
					{loaded && profiles.length === 0 && <p className="px-3 py-4 text-sm text-ink-500">{t("emptyTitle")}</p>}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{current ? (
						<ProfileEditor
							key={keyOf(current)}
							profile={current}
							isDefault={selected === current.id}
							onChanged={load}
							onToggleDefault={() => void setDefault(selected === current.id ? null : current.id)}
						/>
					) : (
						<Empty icon={<MessageSquareCode className="size-5" />} title={t("emptyTitle")}>
							{t("emptyBody")}
						</Empty>
					)}
				</div>
			</div>
			<div className="border-t hairline px-4 py-2 text-xs text-ink-500">{t("permissionNote")}</div>
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

function ProfileEditor({
	profile,
	isDefault,
	onChanged,
	onToggleDefault,
}: {
	profile: ProfileSummary;
	isDefault: boolean;
	onChanged: () => Promise<void>;
	onToggleDefault: () => void;
}) {
	const t = useT(M);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saved, setSaved] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);
	const builtin = Boolean(profile.file);

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

	const save = async () => {
		if (!draft) return;
		setBusy(true);
		const res = await pluginCall<{ id: string }>("prompts", "save", { profile: { ...profile, ...draft } });
		setBusy(false);
		if (res === undefined) return;
		toast(t("saved"));
		await onChanged();
	};

	const reset = async () => {
		if (!window.confirm(t("confirmReset"))) return;
		setBusy(true);
		const res = await pluginCall<null>("prompts", "reset", { id: profile.id });
		setBusy(false);
		if (res === undefined) return;
		toast(t("resetDone"));
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
				<Badge tone={builtin ? "sky" : "muted"}>{builtin ? t("builtin") : t("custom")}</Badge>
				{isDefault && <Badge tone="moss">{t("selected")}</Badge>}
				{!profile.enabled && <Badge tone="rose">{t("disabled")}</Badge>}
				<span className="ml-auto font-mono text-[11px] text-ink-500">{profile.file ?? ""}</span>
			</div>

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
				<Button variant="danger" disabled={busy} onClick={() => void remove()}>
					<Trash2 className="size-4" /> {t("delete")}
				</Button>
				<div className="flex-1" />
				<Button variant="outline" disabled={busy} onClick={onToggleDefault}>
					<Check className="size-4" /> {isDefault ? t("disable") : t("enable")}
				</Button>
				{builtin && (
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
