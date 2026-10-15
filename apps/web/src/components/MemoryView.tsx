import clsx from "clsx";
import { Brain, Pencil, Pin, PinOff, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { MemoryEntry, MemoryScope } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginCall, toast } from "../lib/store.ts";
import { Badge, Button, Dialog, Empty, Input, PageHeader, Select, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		all: "全部",
		user: "全局",
		project: "项目",
		pinned: "置顶",
		agent: "Agent 写入",
		justNow: "刚刚",
		minutesAgo: "{n} 分钟前",
		hoursAgo: "{n} 小时前",
		daysAgo: "{n} 天前",
		added: "已添加记忆",
		confirmDeleteSelected: "删除所选 {n} 条记忆？",
		deletedSelected: "已删除 {n} 条记忆",
		title: "记忆",
		subtitle: "跨会话的长期记忆：Agent 通过 memory_save 工具保存，相关记忆会自动注入系统提示词",
		injectOn: "已开启自动注入",
		injectOff: "已关闭自动注入",
		autoInject: "自动注入",
		draftPlaceholder: "记下一条希望 Agent 长期记住的信息，例如：我偏好使用 pnpm 与 TypeScript 严格模式",
		tagsPlaceholder: "标签，逗号分隔",
		currentProject: "当前项目",
		add: "添加",
		newMemory: "新增记忆",
		searchPlaceholder: "搜索内容或标签",
		deleteSelected: "删除所选 ({n})",
		emptyTitle: "还没有记忆",
		noMatchTitle: "没有匹配的记忆",
		emptyBody: "手动添加，或让 Agent 在对话中通过 memory_save 保存。",
		noMatchBody: "换个关键词或筛选条件试试。",
		updated: "已更新记忆",
		select: "选择",
		cancel: "取消",
		save: "保存",
		manual: "手动",
		unpin: "取消置顶",
		edit: "编辑",
		delete: "删除",
		confirmDelete: "删除这条记忆？",
		deleted: "已删除记忆",
	},
	en: {
		all: "All",
		user: "Global",
		project: "Project",
		pinned: "Pinned",
		agent: "By agent",
		justNow: "just now",
		minutesAgo: "{n} min ago",
		hoursAgo: "{n} h ago",
		daysAgo: "{n} d ago",
		added: "Memory added",
		confirmDeleteSelected: "Delete {n} selected memories?",
		deletedSelected: "Deleted {n} memories",
		title: "Memory",
		subtitle: "Long-term memory across sessions: the agent saves via the memory_save tool, and relevant memories are injected into the system prompt",
		injectOn: "Auto-inject enabled",
		injectOff: "Auto-inject disabled",
		autoInject: "Auto-inject",
		draftPlaceholder: "Note something the agent should remember long-term, e.g. I prefer pnpm and TypeScript strict mode",
		tagsPlaceholder: "Tags, comma-separated",
		currentProject: "This project",
		add: "Add",
		newMemory: "New memory",
		searchPlaceholder: "Search content or tags",
		deleteSelected: "Delete selected ({n})",
		emptyTitle: "No memories yet",
		noMatchTitle: "No matching memories",
		emptyBody: "Add one manually, or let the agent save one with memory_save during a chat.",
		noMatchBody: "Try a different keyword or filter.",
		updated: "Memory updated",
		select: "Select",
		cancel: "Cancel",
		save: "Save",
		manual: "Manual",
		unpin: "Unpin",
		edit: "Edit",
		delete: "Delete",
		confirmDelete: "Delete this memory?",
		deleted: "Memory deleted",
	},
});
type MsgKey = keyof typeof M.zh;
type T = (key: MsgKey, vars?: Record<string, string | number>) => string;

const MAX = 2000;
type Filter = "all" | "user" | "project" | "pinned" | "agent";
const FILTERS: { value: Filter; label: MsgKey }[] = [
	{ value: "all", label: "all" },
	{ value: "user", label: "user" },
	{ value: "project", label: "project" },
	{ value: "pinned", label: "pinned" },
	{ value: "agent", label: "agent" },
];

const parseTags = (s: string) => [...new Set(s.split(/[,，]/).map((t) => t.trim()).filter(Boolean))];

function ago(iso: string, t: T): string {
	const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
	if (sec < 60) return t("justNow");
	if (sec < 3600) return t("minutesAgo", { n: Math.floor(sec / 60) });
	if (sec < 86400) return t("hoursAgo", { n: Math.floor(sec / 3600) });
	if (sec < 86400 * 30) return t("daysAgo", { n: Math.floor(sec / 86400) });
	return new Date(iso).toLocaleDateString("zh-CN");
}

export function MemoryView() {
	const t = useT(M);
	const [entries, setEntries] = useState<MemoryEntry[]>([]);
	const [autoInject, setAutoInject] = useState(true);
	const [busy, setBusy] = useState(false);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState({ content: "", tags: "", scope: "user" as MemoryScope, pinned: false });

	const load = async () => {
		const res = await pluginCall<{ entries: MemoryEntry[]; autoInject: boolean }>("memory", "list");
		if (!res) return;
		setEntries(res.entries);
		setAutoInject(res.autoInject);
		setPicked((p) => new Set([...p].filter((id) => res.entries.some((e) => e.id === id))));
	};
	useEffect(() => {
		void load();
	}, []);

	const mutate = async (method: string, params: Record<string, unknown>, msg?: string) => {
		setBusy(true);
		const res = await pluginCall<unknown>("memory", method, params);
		setBusy(false);
		if (res === undefined) return false;
		if (msg) toast(msg);
		await load();
		return true;
	};

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return entries
			.filter((e) => {
				if (filter === "user" && e.scope !== "user") return false;
				if (filter === "project" && e.scope !== "project") return false;
				if (filter === "pinned" && !e.pinned) return false;
				if (filter === "agent" && e.source !== "agent") return false;
				return !q || e.content.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q));
			})
			.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
	}, [entries, query, filter]);

	const add = async () => {
		const content = draft.content.trim();
		if (!content || content.length > MAX) return;
		const ok = await mutate("add", { content, tags: parseTags(draft.tags), scope: draft.scope, pinned: draft.pinned }, t("added"));
		if (ok) {
			setDraft({ content: "", tags: "", scope: draft.scope, pinned: false });
			setAdding(false);
		}
	};

	const removeSelected = async () => {
		if (!window.confirm(t("confirmDeleteSelected", { n: picked.size }))) return;
		if (await mutate("delete", { ids: [...picked] }, t("deletedSelected", { n: picked.size }))) setPicked(new Set());
	};

	const togglePick = (id: string) =>
		setPicked((p) => {
			const next = new Set(p);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<>
						<label className="flex items-center gap-2 text-sm text-ink-300">
							<input
								type="checkbox"
								checked={autoInject}
								disabled={busy}
								onChange={(e) => void mutate("settings", { autoInject: e.target.checked }, e.target.checked ? t("injectOn") : t("injectOff"))}
								className="accent-ember-500"
							/>
							{t("autoInject")}
						</label>
						<Button variant="primary" onClick={() => setAdding(true)}>
							<Plus className="size-4" /> {t("newMemory")}
						</Button>
					</>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-3xl space-y-5 p-6">
					<div className="flex flex-wrap items-center gap-2">
						<div className="relative min-w-48 flex-1">
							<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-500" />
							<Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="pl-9" />
						</div>
						{FILTERS.map((f) => (
							<button
								key={f.value}
								type="button"
								onClick={() => setFilter(f.value)}
								className={clsx(
									"rounded-full border px-3 py-1 text-xs transition-colors",
									filter === f.value ? "border-ember-500/60 bg-ember-500/8 text-ember-300" : "border-ink-700 text-ink-400 hover:border-ink-500",
								)}
							>
								{t(f.label)}
							</button>
						))}
						{picked.size > 0 && (
							<Button variant="danger" disabled={busy} onClick={() => void removeSelected()}>
								<Trash2 className="size-4" /> {t("deleteSelected", { n: picked.size })}
							</Button>
						)}
					</div>

					{visible.length === 0 ? (
						<Empty icon={<Brain className="size-5" />} title={entries.length === 0 ? t("emptyTitle") : t("noMatchTitle")}>
							{entries.length === 0 ? t("emptyBody") : t("noMatchBody")}
						</Empty>
					) : (
						<div className="space-y-2.5">
							{visible.map((e) => (
								<MemoryCard key={e.id} entry={e} busy={busy} picked={picked.has(e.id)} onPick={() => togglePick(e.id)} mutate={mutate} />
							))}
						</div>
					)}
				</div>
			</div>
			{adding && (
				<Dialog title={t("newMemory")} onClose={() => setAdding(false)}>
					<Textarea
						autoFocus
						rows={5}
						value={draft.content}
						maxLength={MAX}
						onChange={(e) => setDraft({ ...draft, content: e.target.value })}
						placeholder={t("draftPlaceholder")}
					/>
					<Input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder={t("tagsPlaceholder")} />
					<div className="flex flex-wrap items-center gap-3">
						<Select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as MemoryScope })} className="w-36">
							<option value="user">{t("user")}</option>
							<option value="project">{t("currentProject")}</option>
						</Select>
						<label className="flex items-center gap-1.5 text-sm text-ink-300">
							<input type="checkbox" checked={draft.pinned} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} className="accent-ember-500" />
							{t("pinned")}
						</label>
						<span className={clsx("ml-auto font-mono text-[11px]", draft.content.length >= MAX ? "text-rose-400" : "text-ink-500")}>
							{draft.content.length}/{MAX}
						</span>
					</div>
					<div className="flex justify-end gap-2">
						<Button onClick={() => setAdding(false)}>{t("cancel")}</Button>
						<Button variant="primary" disabled={busy || !draft.content.trim()} onClick={() => void add()}>
							<Plus className="size-4" /> {t("add")}
						</Button>
					</div>
				</Dialog>
			)}
		</div>
	);
}

function MemoryCard({
	entry: e,
	busy,
	picked,
	onPick,
	mutate,
}: {
	entry: MemoryEntry;
	busy: boolean;
	picked: boolean;
	onPick: () => void;
	mutate: (method: string, params: Record<string, unknown>, msg?: string) => Promise<boolean>;
}) {
	const t = useT(M);
	const [edit, setEdit] = useState<{ content: string; tags: string } | null>(null);

	const save = async () => {
		if (!edit) return;
		const content = edit.content.trim();
		if (!content || content.length > MAX) return;
		if (await mutate("update", { id: e.id, content, tags: parseTags(edit.tags) }, t("updated"))) setEdit(null);
	};

	return (
		<div className={clsx("animate-rise rounded-xl border bg-ink-900/60 p-4 transition-colors", picked ? "border-ember-500/50" : e.pinned ? "border-ember-500/25" : "border-ink-800")}>
			<div className="flex gap-3">
				<input type="checkbox" checked={picked} onChange={onPick} className="mt-1 accent-ember-500" aria-label={t("select")} />
				<div className="min-w-0 flex-1">
					{edit ? (
						<div className="space-y-2">
							<Textarea rows={4} maxLength={MAX} value={edit.content} onChange={(ev) => setEdit({ ...edit, content: ev.target.value })} />
							<Input value={edit.tags} onChange={(ev) => setEdit({ ...edit, tags: ev.target.value })} placeholder={t("tagsPlaceholder")} />
							<div className="flex justify-end gap-2">
								<Button onClick={() => setEdit(null)}>{t("cancel")}</Button>
								<Button variant="primary" disabled={busy || !edit.content.trim()} onClick={() => void save()}>
									{t("save")}
								</Button>
							</div>
						</div>
					) : (
						<p className="text-sm whitespace-pre-wrap break-words text-ink-100">{e.content}</p>
					)}
					<div className="mt-2.5 flex flex-wrap items-center gap-1.5">
						{e.pinned && <Badge tone="ember">{t("pinned")}</Badge>}
						<span title={e.scope === "project" ? e.project : undefined}>
							<Badge tone={e.scope === "project" ? "moss" : "muted"}>{e.scope === "project" ? t("project") : t("user")}</Badge>
						</span>
						<Badge tone={e.source === "agent" ? "sky" : "muted"}>{e.source === "agent" ? "Agent" : t("manual")}</Badge>
						{e.tags.map((t) => (
							<Badge key={t}>#{t}</Badge>
						))}
						<span className="ml-auto text-[11px] text-ink-500" title={new Date(e.updatedAt).toLocaleString("zh-CN")}>
							{ago(e.updatedAt, t)}
						</span>
					</div>
				</div>
				{!edit && (
					<div className="flex shrink-0 flex-col gap-0.5">
						<Button disabled={busy} title={e.pinned ? t("unpin") : t("pinned")} aria-label={e.pinned ? t("unpin") : t("pinned")} onClick={() => void mutate("update", { id: e.id, pinned: !e.pinned })}>
							{e.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
						</Button>
						<Button disabled={busy} title={t("edit")} aria-label={t("edit")} onClick={() => setEdit({ content: e.content, tags: e.tags.join(", ") })}>
							<Pencil className="size-4" />
						</Button>
						<Button
							variant="danger"
							disabled={busy}
							title={t("delete")}
							aria-label={t("delete")}
							onClick={() => {
								if (window.confirm(t("confirmDelete"))) void mutate("delete", { id: e.id }, t("deleted"));
							}}
						>
							<Trash2 className="size-4" />
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
