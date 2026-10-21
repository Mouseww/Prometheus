import clsx from "clsx";
import { Check, Copy, Layers, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ModeSummary } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginCall, toast } from "../lib/store.ts";
import { Badge, Button, Empty, Field, Input, PageHeader, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "模式",
		subtitle: "一个模式 = 一套系统提示词 + 该模式可用的工具。切换模式就是换一个 Agent。权限模式仍然单独控制每次调用要不要确认。",
		newMode: "新建模式",
		duplicate: "复制",
		active: "使用中",
		disabled: "已停用",
		builtin: "内置",
		custom: "自定义",
		emptyTitle: "还没有模式",
		emptyBody: "新建一个模式，写它的系统提示词、挑它的工具，然后设为当前模式。",
		none: "不使用模式",
		noneHint: "使用宿主自带的默认提示词与全部工具。",
		loading: "加载中…",
		name: "名称",
		description: "说明",
		descriptionPlaceholder: "一句话说明这个模式怎么工作",
		body: "系统提示词（Markdown）",
		how: "注入方式",
		howReplace: "替换系统提示词段落",
		howAppend: "追加在宿主默认提示之后",
		dropPersona: "同时去掉宿主默认的身份介绍",
		tools: "可用工具",
		toolsAll: "全部工具（不限制）",
		toolsSome: "仅限 {n} 个",
		toolsHint: "留空表示不限制。模式只能收窄工具，不能给出宿主没有登记的工具。",
		toolSearch: "筛选工具…",
		noToolMatch: "没有匹配的工具",
		addTool: "添加工具名",
		enable: "使用这个模式",
		disable: "取消使用",
		save: "保存",
		reset: "恢复内置",
		delete: "删除",
		enabled: "启用",
		chars: "{n} 字",
		saved: "已保存，下一轮对话生效",
		resetDone: "已恢复内置内容",
		deleted: "已删除",
		activated: "已设为当前模式",
		deactivated: "已取消当前模式",
		confirmDelete: "删除模式「{name}」？",
		confirmReset: "恢复内置内容？你改过的部分会丢失。",
		permissionNote: "权限（是否确认每次调用）在输入框底部单独切换，与模式无关。",
	},
	en: {
		title: "Modes",
		subtitle: "A mode is a system prompt plus the tools it may use: switching mode switches the agent. The permission mode still decides, separately, whether each call is confirmed.",
		newMode: "New mode",
		duplicate: "Duplicate",
		active: "In use",
		disabled: "Disabled",
		builtin: "Built in",
		custom: "Custom",
		emptyTitle: "No modes yet",
		emptyBody: "Create a mode, write its system prompt, pick its tools, then make it current.",
		none: "No mode",
		noneHint: "Use the host's own default prompt and every tool.",
		loading: "Loading…",
		name: "Name",
		description: "Description",
		descriptionPlaceholder: "One line on how this mode works",
		body: "System prompt (Markdown)",
		how: "Injection",
		howReplace: "Replace the system prompt section",
		howAppend: "Append after the host's default prompt",
		dropPersona: "Also drop the host's identity preamble",
		tools: "Tools",
		toolsAll: "All tools (no restriction)",
		toolsSome: "{n} selected",
		toolsHint: "Empty means no restriction. A mode can only narrow tools, never add one the host did not register.",
		toolSearch: "Filter tools…",
		noToolMatch: "No matching tool",
		addTool: "Add a tool name",
		enable: "Use this mode",
		disable: "Stop using",
		save: "Save",
		reset: "Restore bundled",
		delete: "Delete",
		enabled: "Enabled",
		chars: "{n} chars",
		saved: "Saved; applies from the next turn",
		resetDone: "Bundled content restored",
		deleted: "Deleted",
		activated: "Set as the current mode",
		deactivated: "Current mode cleared",
		confirmDelete: "Delete mode \"{name}\"?",
		confirmReset: "Restore the bundled text? Your edits are lost.",
		permissionNote: "Permissions (whether each call is confirmed) are switched separately at the bottom of the composer.",
	},
});

const keyOf = (m: ModeSummary) => m.id;

export function ModesView() {
	const t = useT(M);
	const [modes, setModes] = useState<ModeSummary[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [picked, setPicked] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);

	const load = async () => {
		const res = await pluginCall<{ selected: string | null; modes: ModeSummary[] }>("modes", "list");
		if (!res) return;
		setModes(res.modes);
		setSelected(res.selected);
		setPicked((s) => (s && res.modes.some((x) => keyOf(x) === s) ? s : (res.selected ?? res.modes[0]?.id ?? null)));
		setLoaded(true);
	};
	useEffect(() => {
		void load();
	}, []);

	const current = modes.find((m) => keyOf(m) === picked);

	const setDefault = async (id: string | null) => {
		const res = await pluginCall<{ selected: string | null }>("modes", "select", { id });
		if (res === undefined) return;
		setSelected(res.selected);
		toast(id ? t("activated") : t("deactivated"));
		await load();
	};

	const duplicate = async () => {
		if (!current) return;
		const res = await pluginCall<{ id: string }>("modes", "create", { from: current.id });
		if (!res) return;
		await load();
		setPicked(res.id);
	};

	const create = async () => {
		const res = await pluginCall<{ id: string }>("modes", "create", {});
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
							<Plus className="size-4" /> {t("newMode")}
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
					{modes.map((m) => (
						<button
							key={keyOf(m)}
							type="button"
							onClick={() => setPicked(keyOf(m))}
							className={clsx("w-full rounded-lg px-3 py-2.5 text-left transition-colors", keyOf(m) === picked ? "bg-ink-850" : "hover:bg-ink-900")}
						>
							<div className="flex items-center gap-2">
								<span className={clsx("truncate text-sm", m.enabled ? "text-ink-100" : "text-ink-500")}>{m.title}</span>
								{selected === m.id && <Badge tone="moss">{t("active")}</Badge>}
								{!m.enabled && <Badge tone="rose">{t("disabled")}</Badge>}
							</div>
							<div className="mt-0.5 line-clamp-2 text-xs text-ink-500">{m.description || t("chars", { n: m.bodyLength })}</div>
						</button>
					))}
					{loaded && modes.length === 0 && <p className="px-3 py-4 text-sm text-ink-500">{t("emptyTitle")}</p>}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{current ? (
						<ModeEditor
							key={keyOf(current)}
							mode={current}
							isCurrent={selected === current.id}
							onChanged={load}
							onToggleDefault={() => void setDefault(selected === current.id ? null : current.id)}
						/>
					) : (
						<Empty icon={<Layers className="size-5" />} title={t("emptyTitle")}>
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
	tools: string[];
}

const draftOf = (m: ModeSummary, body: string): Draft => ({
	title: m.title,
	description: m.description,
	body,
	enabled: m.enabled,
	how: m.how,
	dropPersona: m.dropPersona,
	tools: [...m.tools],
});

function ModeEditor({ mode, isCurrent, onChanged, onToggleDefault }: { mode: ModeSummary; isCurrent: boolean; onChanged: () => Promise<void>; onToggleDefault: () => void }) {
	const t = useT(M);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saved, setSaved] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);
	/** Tools PI and the plugins actually provide, listed statically by the plugin. */
	const [known, setKnown] = useState<string[]>([]);
	const [filter, setFilter] = useState("");
	const [adding, setAdding] = useState("");
	const builtin = Boolean(mode.file);

	useEffect(() => {
		void pluginCall<ModeSummary & { body: string }>("modes", "get", { id: mode.id }).then((full) => {
			if (!full) return;
			const next = draftOf(full, full.body);
			setDraft(next);
			setSaved(next);
		});
	}, [mode.id]);

	useEffect(() => {
		void pluginCall<{ known: string[] }>("modes", "tools").then((res) => {
			if (res) setKnown(res.known);
		});
	}, [mode.id]);

	const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
	const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));

	const toggleTool = (name: string) => {
		if (!draft) return;
		const has = draft.tools.includes(name);
		set("tools", has ? draft.tools.filter((n) => n !== name) : [...draft.tools, name]);
	};

	const save = async () => {
		if (!draft) return;
		setBusy(true);
		const res = await pluginCall<{ id: string }>("modes", "save", { mode: { ...mode, ...draft } });
		setBusy(false);
		if (res === undefined) return;
		toast(t("saved"));
		await onChanged();
	};

	const reset = async () => {
		if (!window.confirm(t("confirmReset"))) return;
		setBusy(true);
		const res = await pluginCall<null>("modes", "reset", { id: mode.id });
		setBusy(false);
		if (res === undefined) return;
		toast(t("resetDone"));
		await onChanged();
	};

	const remove = async () => {
		if (!window.confirm(t("confirmDelete", { name: mode.title }))) return;
		setBusy(true);
		const res = await pluginCall<null>("modes", "delete", { id: mode.id });
		setBusy(false);
		if (res === undefined) return;
		toast(t("deleted"));
		await onChanged();
	};

	const pool = [...new Set([...known, ...(draft?.tools ?? [])])].sort();
	const shown = pool.filter((n) => !filter || n.toLowerCase().includes(filter.toLowerCase()));

	return (
		<div className="mx-auto max-w-4xl animate-rise space-y-4 p-4 md:p-6">
			<div className="flex flex-wrap items-center gap-2">
				<h2 className="font-display text-xl font-semibold">{mode.title}</h2>
				<Badge tone={builtin ? "sky" : "muted"}>{builtin ? t("builtin") : t("custom")}</Badge>
				{isCurrent && <Badge tone="moss">{t("active")}</Badge>}
				{!mode.enabled && <Badge tone="rose">{t("disabled")}</Badge>}
				<span className="ml-auto font-mono text-[11px] text-ink-500">{mode.file ?? ""}</span>
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

			<Field label={`${t("tools")} · ${draft?.tools.length ? t("toolsSome", { n: draft.tools.length }) : t("toolsAll")}`} hint={t("toolsHint")}>
				<div className="space-y-2">
					<div className="flex flex-wrap gap-1.5">
						{(draft?.tools ?? []).map((name) => (
							<button
								key={name}
								type="button"
								onClick={() => toggleTool(name)}
								className="inline-flex items-center gap-1 rounded-md bg-ember-500/12 px-1.5 py-0.5 font-mono text-[11px] text-ember-300 hover:bg-ember-500/20"
								title={t("delete")}
							>
								{name} ×
							</button>
						))}
						{(draft?.tools ?? []).length === 0 && <span className="text-xs text-ink-500">{t("toolsAll")}</span>}
					</div>
					<div className="flex gap-2">
						<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("toolSearch")} className="max-w-52" />
						<Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={t("addTool")} className="max-w-44 font-mono" />
						<Button
							variant="outline"
							disabled={!adding.trim() || (draft?.tools.includes(adding.trim()) ?? false)}
							onClick={() => {
								toggleTool(adding.trim());
								setAdding("");
							}}
						>
							<Plus className="size-4" />
						</Button>
					</div>
					<div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-ink-800 p-2">
						{shown.map((name) => {
							const on = draft?.tools.includes(name) ?? false;
							return (
								<button
									key={name}
									type="button"
									onClick={() => toggleTool(name)}
									className={clsx(
										"rounded-md px-1.5 py-0.5 font-mono text-[11px] transition-colors",
										on ? "bg-ember-500/20 text-ember-200" : "bg-ink-800 text-ink-400 hover:bg-ink-700",
									)}
								>
									{name}
								</button>
							);
						})}
						{shown.length === 0 && <span className="text-xs text-ink-600">{t("noToolMatch")}</span>}
					</div>
				</div>
			</Field>

			<Field label={t("body")}>
				<Textarea
					value={draft?.body ?? ""}
					disabled={!draft}
					onChange={(e) => set("body", e.target.value)}
					spellCheck={false}
					className="min-h-[42vh] font-mono text-[13px] leading-relaxed"
					placeholder={draft ? "" : t("loading")}
				/>
			</Field>

			<div className="flex flex-wrap items-center gap-2">
				<Button variant="danger" disabled={busy} onClick={() => void remove()}>
					<Trash2 className="size-4" /> {t("delete")}
				</Button>
				<div className="flex-1" />
				<Button variant="outline" disabled={busy} onClick={onToggleDefault}>
					<Check className="size-4" /> {isCurrent ? t("disable") : t("enable")}
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
