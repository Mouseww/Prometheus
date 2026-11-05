import clsx from "clsx";
import { ArrowUp, Brain, Check, ChevronDown, CornerDownRight, Cpu, File as FileIcon, FileText, Folder as FolderIcon, ListEnd, Maximize2, Paperclip, Pencil, Search, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandInfo, ImageContent, ThinkingLevel } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { Mentions, SlashCommands } from "./suggestions.tsx";
import { type Attachment, AttachmentError, fileToAttachment, formatSize, isPicture, MAX_FILE_MB, MAX_FILES } from "../lib/attachments.ts";
import { fileToImage, ImageError, imageSrc, MAX_IMAGES } from "../lib/images.ts";
import { inputAt, rememberInput } from "../lib/inputHistory.ts";
import { loadDraft, NEW_CHAT_DRAFT, newChatDraft, saveDraft, switchDraft } from "../lib/drafts.ts";
import { aliasKey, type SendMode, setPrefs, usePrefs } from "../lib/prefs.ts";
import { abortRun, openSettings, pluginCall, sendPrompt, setModel, setPermissionMode, setThinking, toast, unqueue, useSpace, useStore } from "../lib/store.ts";
import { BACK_LAYER, useBackLayer } from "../lib/back.ts";
import { useVisualViewport } from "../lib/viewport.ts";
import { ComposerSheet, isSheetSendChord } from "./ComposerSheet.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import { ModePicker } from "./ModePicker.tsx";
import { RuntimeMenu } from "./RuntimeMenu.tsx";
import { GoalBar } from "./GoalBar.tsx";
import { nextPermissionMode, PermissionPicker } from "./PermissionPicker.tsx";
import { VoiceButton } from "./VoiceButton.tsx";
import { usePopover } from "./TitleBar.tsx";
import { BranchPicker } from "./BranchPicker.tsx";
import { SessionChanges } from "./SessionChanges.tsx";
import { WorktreePanel, WorktreeSwitch } from "./WorktreePanel.tsx";
import { PersonalChip, WorkspaceChip, WorkspacePicker } from "./WorkspacePicker.tsx";
import { useReadOnlyCopy } from "../team/execStore.ts";

const M = defineMessages({
	zh: {
		placeholder: "向 Agent 下达任务，输入 / 查看命令",
		placeholderStreaming: "回复中… 按“{mode}”发送  (Esc 中断)",
		placeholderMirror: "这个会话已移交到另一端执行，请在那一端继续对话",
		steer: "插队",
		followUp: "排队",
		steerHint: "在当前工具调用结束后立即插入",
		followUpHint: "等本轮结束后再发送",
		sendMode: "回复中发送时",
		sendModeTitle: "回复中发送：{mode}（点击更改）",
		sendAs: "发送（{mode}）",
		queued: "排队中 · {q}",
		steered: "插队中 · {q}",
		editQueued: "编辑（取回输入框）",
		withdraw: "撤回",
		abort: "中断",
		send: "发送",
		needWorkspace: "请先选择工作区",
		pickModel: "选择模型",
		searchModel: "搜索模型或渠道…",
		alias: "设置显示别名",
		aliasFor: "{name} 的别名",
		aliasSave: "保存（留空则恢复原名）",
		aliasCancel: "取消",
		noModels: "没有可用模型",
		ownLogin: "自带登录",
		addGateway: "去添加 AI 网关",
		thinking: "思考",
		vision: "视觉",
		effort: "思考力度",
		effortHint: "越高越深入，但更慢、更耗 token",
		off: "关闭",
		minimal: "极简",
		low: "低",
		medium: "中",
		high: "高",
		xhigh: "超高",
		max: "极限",
		attach: "添加文件或图片",
		removeImage: "移除图片",
		removeFile: "移除文件",
		filesTooMany: "一条消息最多 {n} 个文件",
		fileTooBig: "「{name}」超过 {n} MB，无法上传",
		filesTotal: "文件总大小不能超过 {n} MB",
		fileRead: "无法读取「{name}」",
		tooMany: "一条消息最多 {n} 张图片",
		badType: "只支持 PNG、JPEG、GIF、WebP 图片",
		tooBig: "图片超过 25 MB，请压缩后再试",
		badImage: "无法读取这张图片",
		noVision: "当前模型不支持图片，图片可能被忽略或报错，请换用带“视觉”标记的模型",
		dropHere: "松开即可添加文件或图片",
		expand: "放大输入",
		collapse: "收起",
	},
	en: {
		placeholder: "Give the agent a task, type / for commands",
		placeholderStreaming: "Replying… sends as \"{mode}\"  (Esc to stop)",
		placeholderMirror: "This session moved to the other side. Continue the conversation there.",
		steer: "Steer",
		followUp: "Queue",
		steerHint: "Insert right after the current tool call",
		followUpHint: "Send after this turn ends",
		sendMode: "When sending during a reply",
		sendModeTitle: "Sending during a reply: {mode} (click to change)",
		sendAs: "Send ({mode})",
		queued: "Queued · {q}",
		steered: "Steering · {q}",
		editQueued: "Edit (move back to the composer)",
		withdraw: "Withdraw",
		abort: "Stop",
		send: "Send",
		needWorkspace: "Choose a workspace first",
		pickModel: "Choose model",
		searchModel: "Search models or channels…",
		alias: "Set a display alias",
		aliasFor: "Alias for {name}",
		aliasSave: "Save (leave empty to restore the name)",
		aliasCancel: "Cancel",
		noModels: "No models available",
		ownLogin: "Own login",
		addGateway: "Add an AI gateway",
		thinking: "reasoning",
		vision: "vision",
		effort: "Thinking effort",
		effortHint: "Higher is deeper but slower and uses more tokens",
		off: "Off",
		minimal: "Minimal",
		low: "Low",
		medium: "Medium",
		high: "High",
		xhigh: "X-High",
		max: "Max",
		attach: "Add files or images",
		removeImage: "Remove image",
		removeFile: "Remove file",
		filesTooMany: "At most {n} files per message",
		fileTooBig: "\"{name}\" is over {n} MB and cannot be uploaded",
		filesTotal: "The files may not exceed {n} MB in total",
		fileRead: "Could not read \"{name}\"",
		tooMany: "At most {n} images per message",
		badType: "Only PNG, JPEG, GIF and WebP images are supported",
		tooBig: "That image is over 25 MB; shrink it and try again",
		badImage: "Could not read that image",
		noVision: "This model does not accept images, so they may be ignored or rejected. Pick a model marked \"vision\"",
		dropHere: "Drop to add images",
		expand: "Expand the composer",
		collapse: "Collapse",
	},
});

/**
 * The "/command" suggestions. Rendered twice: above the inline composer, and inside the expanded sheet — that one covers
 * the page, so the inline copy would sit behind it and typing "/" there showed nothing.
 */
/**
 * Attached pictures and documents, shown above the input. The expanded sheet renders the same strip: attachments are
 * shared state, so without it a file added in the inline composer would be invisible (and unremovable) there.
 */
function Attachments({
	docs,
	images,
	reading,
	onRemoveDoc,
	onRemoveImage,
	className,
}: {
	docs: Attachment[];
	images: ImageContent[];
	reading: number;
	onRemoveDoc: (index: number) => void;
	onRemoveImage: (index: number) => void;
	className?: string;
}) {
	const t = useT(M);
	return (
		<div className={clsx("flex flex-wrap gap-2", className)}>
			{docs.map((d, i) => (
				<div key={`d${i}`} className="flex h-16 max-w-56 items-center gap-2 rounded-lg border border-ink-700 bg-ink-950 py-1 pr-1.5 pl-2.5" title={d.name}>
					<FileText className="size-5 shrink-0 text-ember-300" />
					<span className="min-w-0">
						<span className="block truncate text-xs text-ink-200">{d.name}</span>
						<span className="block font-mono text-[10.5px] text-ink-500">{formatSize(d.size)}</span>
					</span>
					<button
						type="button"
						onClick={() => onRemoveDoc(i)}
						className="grid size-5 shrink-0 place-items-center rounded-full text-ink-400 hover:bg-rose-500 hover:text-white"
						title={t("removeFile")}
						aria-label={t("removeFile")}
					>
						<X className="size-3" />
					</button>
				</div>
			))}
			{images.map((img, i) => (
				<div key={i} className="group/thumb relative size-16 overflow-hidden rounded-lg border border-ink-700 bg-ink-950">
					<img src={imageSrc(img)} alt="" className="size-full object-cover" />
					<button
						type="button"
						onClick={() => onRemoveImage(i)}
						className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-ink-950/80 text-ink-200 opacity-0 transition-opacity group-hover/thumb:opacity-100 nohover:opacity-100 hover:bg-rose-500 hover:text-white focus-visible:opacity-100"
						title={t("removeImage")}
						aria-label={t("removeImage")}
					>
						<X className="size-3" />
					</button>
				</div>
			))}
			{Array.from({ length: reading }, (_, i) => (
				<div key={`r${i}`} className="size-16 animate-pulse rounded-lg border border-ink-800 bg-ink-850" />
			))}
		</div>
	);
}

function ModelPicker() {
	const t = useT(M);
	const models = useStore((s) => s.models);
	const gateways = useStore((s) => s.gateways);
	const current = useStore((s) => s.session?.model ?? s.draftModel);
	const { open, setOpen, ref } = usePopover();
	const [q, setQ] = useState("");
	const aliases = usePrefs((p) => p.modelAliases);
	/** `provider/id` of the model whose alias is being edited. */
	const [editing, setEditing] = useState<string | null>(null);
	const [draftAlias, setDraftAlias] = useState("");
	const saveAlias = (key: string) => {
		const next = { ...aliases };
		const v = draftAlias.trim();
		if (v) next[key] = v;
		else delete next[key];
		setPrefs({ modelAliases: next });
		setEditing(null);
	};
	/** Heading of a model group: the agent's own login, or the gateway the models come from. */
	const groupName = (provider: string) => (provider === "claude-code" || provider === "codex" || provider === "opencode" || provider === "acp" ? t("ownLogin") : (gateways.find((g) => g.id === provider)?.name ?? provider));
	const groups = useMemo(() => {
		const filtered = models.filter((m) => `${groupName(m.provider)} ${m.provider} ${m.id} ${m.name} ${aliases[aliasKey(m.provider, m.id)] ?? ""}`.toLowerCase().includes(q.toLowerCase()));
		const map = new Map<string, typeof models>();
		for (const m of filtered) map.set(m.provider, [...(map.get(m.provider) ?? []), m]);
		return [...map.entries()];
		// biome-ignore lint/correctness/useExhaustiveDependencies: groupName only depends on gateways and the language
	}, [models, q, aliases, gateways]);
	const info = current && models.find((m) => m.provider === current.provider && m.id === current.id);
	const label = current ? ((current && aliases[aliasKey(current.provider, current.id)]) || info?.name || current.id) : t("pickModel");
	const channel = current ? groupName(current.provider) : "";

	return (
		<div ref={ref} className="min-w-0 max-w-full md:relative md:max-w-80">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className={clsx(
					"flex w-full min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors",
					current ? "text-ink-300 hover:bg-ink-800 hover:text-ink-100" : "bg-ember-500/10 text-ember-300 hover:bg-ember-500/15",
				)}
				title={current ? `${channel} / ${info?.name ?? current.id}
${current.provider}/${current.id}` : undefined}
			>
				<Cpu className="size-3.5 shrink-0" />
				{/* The channel first and kept short, so a long model name cannot push it out of sight. */}
				{current && <span className="max-w-24 shrink-0 truncate rounded bg-ink-800 px-1 py-px text-[10.5px] text-ink-400 @max-[28rem]:hidden">{channel}</span>}
				<span className="min-w-0 truncate">{label}</span>
				<ChevronDown className="size-3 shrink-0 opacity-60" />
			</button>
			{open && (
				<div className="absolute bottom-full left-3 right-3 z-40 mb-2 md:left-0 md:right-auto md:w-[26rem] animate-rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="flex items-center gap-2 border-b border-ink-800 px-3">
						<Search className="size-3.5 text-ink-500" />
						<input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchModel")} className="w-full bg-transparent py-2.5 text-sm focus:outline-none" />
					</div>
					<div className="max-h-[min(20rem,45dvh)] overflow-y-auto py-1">
						{groups.length === 0 && (
							<div className="px-3.5 py-6 text-center text-sm text-ink-500">
								<p>{t("noModels")}</p>
								<button
									type="button"
									className="mt-2 text-ember-300 underline-offset-2 hover:underline"
									onClick={() => {
										setOpen(false);
										openSettings("gateways");
									}}
								>
									{t("addGateway")}
								</button>
							</div>
						)}
						{groups.map(([provider, list]) => (
							<div key={provider}>
								<div className="sticky top-0 z-10 bg-ink-900/97 px-3.5 pt-2.5 pb-1 font-mono text-[10.5px] tracking-widest text-ink-500 uppercase backdrop-blur">{groupName(provider)}</div>
								{list.map((m) => {
									const active = current?.provider === m.provider && current.id === m.id;
									const key = aliasKey(m.provider, m.id);
									const alias = aliases[key];
									if (editing === key) {
										return (
											<form
												key={m.id}
												className="flex items-center gap-1.5 px-3.5 py-1.5"
												onSubmit={(e) => {
													e.preventDefault();
													saveAlias(key);
												}}
											>
												<input
													autoFocus
													value={draftAlias}
													onChange={(e) => setDraftAlias(e.target.value)}
													onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setEditing(null))}
													placeholder={m.name}
													aria-label={t("aliasFor", { name: m.name })}
													className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-sm focus:border-ember-500 focus:outline-none"
												/>
												<button type="submit" className="rounded-md p-1 text-ember-300 hover:bg-ink-800" title={t("aliasSave")} aria-label={t("aliasSave")}>
													<Check className="size-4" />
												</button>
												<button type="button" onClick={() => setEditing(null)} className="rounded-md p-1 text-ink-400 hover:bg-ink-800" title={t("aliasCancel")} aria-label={t("aliasCancel")}>
													<X className="size-4" />
												</button>
											</form>
										);
									}
									return (
										<div key={m.id} className={clsx("group/model flex items-start", active ? "bg-ember-500/10 text-ember-200" : "text-ink-200 hover:bg-ink-800")}>
											<button
												type="button"
												onClick={() => {
													setOpen(false);
													void setModel({ provider: m.provider, id: m.id });
												}}
												title={`${m.name}
${m.provider}/${m.id}`}
												className="flex min-w-0 flex-1 items-start gap-2 py-1.5 pr-1 pl-3.5 text-left text-sm"
											>
												<span className="mt-0.5 w-3.5 shrink-0">{active && <Check className="size-3.5" />}</span>
												<span className="min-w-0 flex-1">
													{/* Long names wrap (two lines at most) instead of being cut off. */}
													<span className="line-clamp-2 break-all">{alias || m.name}</span>
													{alias && <span className="block truncate font-mono text-[10.5px] text-ink-500">{m.name}</span>}
												</span>
												<span className="mt-0.5 flex shrink-0 items-center gap-1.5">
													{m.reasoning && <span className="font-mono text-[10px] text-sky-400">{t("thinking")}</span>}
													{m.vision && <span className="font-mono text-[10px] text-moss-400">{t("vision")}</span>}
													<span className="font-mono text-[10px] text-ink-600">{Math.round(m.contextWindow / 1000)}k</span>
												</span>
											</button>
											<button
												type="button"
												onClick={() => {
													setDraftAlias(alias ?? "");
													setEditing(key);
												}}
												className="mt-1 mr-2 shrink-0 rounded-md p-1 text-ink-500 opacity-0 transition-opacity hover:bg-ink-700 hover:text-ink-100 group-hover/model:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
												title={t("alias")}
												aria-label={t("alias")}
											>
												<Pencil className="size-3" />
											</button>
										</div>
									);
								})}
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

/** Chevron beside the send button: what a message sent mid-reply does. The choice is remembered. */
function SendModePicker() {
	const t = useT(M);
	const mode = usePrefs((p) => p.sendMode);
	const { open, setOpen, ref } = usePopover();
	const options: { value: SendMode; icon: typeof ListEnd }[] = [
		{ value: "followUp", icon: ListEnd },
		{ value: "steer", icon: CornerDownRight },
	];
	return (
		<div ref={ref} className="md:relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="grid h-8 w-5 place-items-center rounded-r-lg border-l border-ink-950/25 bg-ember-500 text-white transition hover:bg-ember-400"
				title={t("sendModeTitle", { mode: t(mode) })}
				aria-label={t("sendMode")}
				aria-expanded={open}
			>
				<ChevronDown className="size-3" />
			</button>
			{open && (
				<div className="absolute right-3 bottom-full left-3 z-40 mb-2 animate-rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur md:right-0 md:left-auto md:w-72">
					<div className="px-3.5 pt-3 pb-1.5 text-sm font-medium text-ink-100">{t("sendMode")}</div>
					<div className="pb-1.5">
						{options.map(({ value, icon: Icon }) => (
							<button
								key={value}
								type="button"
								onClick={() => {
									setPrefs({ sendMode: value });
									setOpen(false);
								}}
								className={clsx("flex w-full items-start gap-2.5 px-3.5 py-2 text-left", mode === value ? "bg-ember-500/10" : "hover:bg-ink-800")}
							>
								<Icon className={clsx("mt-0.5 size-4 shrink-0", mode === value ? "text-ember-300" : "text-ink-400")} />
								<span className="min-w-0 flex-1">
									<span className={clsx("block text-sm", mode === value ? "text-ember-200" : "text-ink-100")}>{t(value)}</span>
									<span className="block text-xs text-ink-500">{t(value === "steer" ? "steerHint" : "followUpHint")}</span>
								</span>
								{mode === value && <Check className="mt-0.5 size-3.5 shrink-0 text-ember-300" />}
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

/** Signal-bar glyph: one bar per non-off level, lit up to the current one. */
function EffortBars({ value, total }: { value: number; total: number }) {
	const bars = Math.max(total, 1);
	return (
		<span className="flex h-3.5 items-end gap-[2px]" aria-hidden>
			{Array.from({ length: bars }, (_, i) => (
				<span key={i} className={clsx("w-[3px] rounded-[1px] transition-colors", i < value ? "bg-ember-400" : "bg-ink-600")} style={{ height: `${35 + (65 * (i + 1)) / bars}%` }} />
			))}
		</span>
	);
}

// Selectors must return a stable reference: a fresh [] per call makes zustand re-render forever.
const NO_LEVELS: ThinkingLevel[] = [];

function EffortPicker() {
	const t = useT(M);
	const levels = useStore((s) => s.session?.availableThinkingLevels ?? NO_LEVELS);
	const level = useStore((s) => s.session?.thinkingLevel ?? "off");
	const { open, setOpen, ref } = usePopover();
	if (levels.length <= 1) return null;

	const steps: ThinkingLevel[] = levels.filter((l) => l !== "off");
	const lit = steps.indexOf(level) + 1;
	const index = Math.max(levels.indexOf(level), 0);
	const pos = (i: number) => (levels.length > 1 ? (i / (levels.length - 1)) * 100 : 0);

	return (
		<div ref={ref} className="shrink-0 md:relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className={clsx("flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-ink-800", level === "off" ? "text-ink-400 hover:text-ink-200" : "text-ember-300")}
				title={t("effort")}
			>
				<Brain className="size-3.5" />
				<EffortBars value={lit} total={steps.length} />
				<span className="@max-[28rem]:hidden">{t(level)}</span>
			</button>
			{open && (
				<div className="absolute bottom-full left-3 right-3 z-40 mb-2 md:left-0 md:right-auto md:w-80 animate-rise rounded-xl border border-ink-700 bg-ink-900/97 px-4 pt-3.5 pb-3 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="flex items-baseline justify-between">
						<span className="text-sm font-medium text-ink-100">{t("effort")}</span>
						<span className="font-mono text-xs text-ember-300">{t(level)}</span>
					</div>
					<p className="mt-0.5 text-[11px] text-ink-500">{t("effortHint")}</p>
					<div className="mx-3 mt-5">
						<div className="relative h-1.5 rounded-full bg-ink-800">
							<div className="effort-track absolute inset-y-0 left-0 rounded-full transition-all duration-300" style={{ width: `${pos(index)}%` }} />
							{levels.map((l, i) => (
								<button
									key={l}
									type="button"
									onClick={() => void setThinking(l)}
									style={{ left: `${pos(i)}%` }}
									className={clsx(
										"absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-transform hover:scale-125",
										l === level ? "scale-125 border-ember-300 bg-ember-500 shadow-[0_0_0_4px_rgb(var(--glow)/0.2)]" : i <= index ? "border-ember-500 bg-ink-900" : "border-ink-600 bg-ink-900",
									)}
									aria-label={t(l)}
								/>
							))}
						</div>
						<div className="relative mt-2.5 h-4">
							{levels.map((l, i) => (
								<button
									key={l}
									type="button"
									onClick={() => void setThinking(l)}
									style={{ left: `${pos(i)}%` }}
									className={clsx("absolute -translate-x-1/2 text-[10.5px] whitespace-nowrap", l === level ? "font-medium text-ember-300" : "text-ink-500 hover:text-ink-200")}
								>
									{t(l)}
								</button>
							))}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** Nonce of the last `editorText` a composer took in. */
let appliedEditorNonce = 0;

export function Composer({ newChat = false }: { newChat?: boolean }) {
	const t = useT(M);
	const personalSpace = useSpace() === "personal";
	const session = useStore((s) => s.session);
	// A team session whose brain moved to the other side only mirrors here: its prompts would be refused anyway.
	const mirrored = useReadOnlyCopy(session?.id) !== undefined;
	const commands = useStore((s) => s.commands);
	const editorText = useStore((s) => s.editorText);
	// The unsent text, pictures and files belong to the conversation on screen, not to this component (which is
	// rebuilt on some switches and kept on others): they are loaded from and saved to that conversation's draft. The
	// new-chat page is scoped to the workspace it is set up in, so one project's typing never lands in another's box.
	const draftKey = newChat ? newChatDraft(session?.workspaceId || session?.cwd) : session?.id ?? NEW_CHAT_DRAFT;
	const [text, setText] = useState(() => loadDraft(draftKey).text);
	const textRef = useRef(text);
	textRef.current = text;
	const [images, setImages] = useState<ImageContent[]>(() => loadDraft(draftKey).images);
	const [docs, setDocs] = useState<Attachment[]>(() => loadDraft(draftKey).docs);
	// ArrowUp history: position in the sent messages (-1: not browsing) and what was typed before browsing; per conversation too.
	const history = useRef(loadDraft(draftKey).history ?? { at: -1, draft: "" });
	const [shownKey, setShownKey] = useState(draftKey);
	if (shownKey !== draftKey) {
		// Another conversation while this component stays: keep what was typed with the one left, show the other's.
		const next = switchDraft(shownKey, draftKey, { text, images, docs, history: history.current });
		history.current = next.history ?? { at: -1, draft: "" };
		setShownKey(draftKey);
		setText(next.text);
		setImages(next.images);
		setDocs(next.docs);
	}
	// ArrowUp changes the text together with the history position, so saving on text changes keeps both.
	useEffect(() => saveDraft(shownKey, { text, images, docs, history: history.current }), [shownKey, text, images, docs]);
	const [reading, setReading] = useState(0);
	const [dragging, setDragging] = useState(false);
	const files = useRef<HTMLInputElement>(null);
	const models = useStore((s) => s.models);
	const model = useStore((s) => s.session?.model ?? s.draftModel);
	const sendMode = usePrefs((p) => p.sendMode);
	const enterToSend = usePrefs((p) => p.enterToSend);
	const [cursor, setCursor] = useState(0);
	const ref = useRef<HTMLTextAreaElement>(null);
	const streaming = session?.isStreaming ?? false;
	const view = useStore((s) => s.view);
	const [expanded, setExpanded] = useState(false);
	const expandedRef = useRef<HTMLTextAreaElement>(null);
	/** The textarea being typed into: the expanded sheet covers the inline one. */
	const activeInput = () => (expanded ? expandedRef.current : ref.current);
	const collapse = () => {
		setExpanded(false);
		requestAnimationFrame(() => ref.current?.focus());
	};
	const sheet = useVisualViewport();
	const canSend = (!!text.trim() || images.length > 0 || docs.length > 0) && reading === 0 && !!session && !session.preview && !mirrored;

	// A view (settings, git, ...) is drawn under the sheet's portal: step aside rather than hide it.
	useEffect(() => {
		if (view !== "chat") setExpanded(false);
	}, [view]);
	// Esc and the button close the sheet on a desktop; on a phone the back gesture has to as well.
	useBackLayer(BACK_LAYER.sheet, expanded, collapse);

	useEffect(() => {
		// Each request fills one composer once; a composer built later (another conversation) must not apply it again.
		if (editorText && editorText.nonce > appliedEditorNonce) {
			appliedEditorNonce = editorText.nonce;
			const { text: next, images: attached, append } = editorText;
			setText(append && textRef.current.trim() ? `${next}\n${textRef.current}` : next);
			if (attached?.length) setImages((cur) => [...cur, ...attached].slice(0, MAX_IMAGES));
			activeInput()?.focus();
		}
	}, [editorText]);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
	}, [text]);

	const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
	const matches = useMemo(() => {
		if (slashQuery === undefined) return [];
		const q = slashQuery.toLowerCase();
		return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
	}, [commands, slashQuery]);

	useEffect(() => setCursor(0), [slashQuery]);

	// @file mentions: `@query` right before the caret opens a workspace file list.
	const [caret, setCaret] = useState(0);
	const [mentionItems, setMentionItems] = useState<{ path: string; dir: boolean }[]>([]);
	const [mentionCursor, setMentionCursor] = useState(0);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const mention = useMemo(() => {
		const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
		if (!m) return null;
		const query = m[2] ?? "";
		return { query, start: caret - query.length - 1 };
	}, [text, caret]);
	const mentionQuery = mention && dismissed !== `${mention.start}:${mention.query}` ? mention.query : undefined;
	const cwd = session?.cwd;
	useEffect(() => {
		if (mentionQuery === undefined || !cwd) {
			setMentionItems([]);
			return;
		}
		let stale = false;
		const timer = setTimeout(() => {
			void pluginCall<{ items: { path: string; dir: boolean }[] }>("folder", "search", { query: mentionQuery, cwd })
				.then((res) => {
					if (stale) return;
					setMentionItems(res?.items ?? []);
					setMentionCursor(0);
				})
				.catch(() => !stale && setMentionItems([]));
		}, 80);
		return () => {
			stale = true;
			clearTimeout(timer);
		};
	}, [mentionQuery, cwd]);
	// A view (settings, git, ...) is drawn in a modal that these popups out-rank, so they step aside instead of
	// floating over it. The sheet is a portal above both and closes with the view, so it keeps its own copies.
	const suggesting = view === "chat";
	const showMention = suggesting && mentionQuery !== undefined && mentionItems.length > 0;
	const showCommands = suggesting && !showMention && matches.length > 0;

	const pickMention = (item: { path: string; dir: boolean }) => {
		if (!mention) return;
		const quoted = /\s/.test(item.path) ? `"${item.path}"` : item.path;
		const token = `@${quoted}${item.dir ? "/" : " "}`;
		const next = text.slice(0, mention.start) + token + text.slice(caret);
		const pos = mention.start + token.length;
		setText(next);
		setCaret(pos);
		requestAnimationFrame(() => {
			const el = activeInput();
			if (!el) return;
			el.focus();
			el.setSelectionRange(pos, pos);
		});
	};

	const pickSlash = (c: CommandInfo) => {
		const next = `/${c.name} `;
		setText(next);
		setCaret(next.length);
		activeInput()?.focus();
	};

	/** Sends the draft; resolves false when nothing went out, so the expanded sheet only closes on a real send. */
	const submit = async (): Promise<boolean> => {
		const value = text.trim();
		if ((!value && !images.length && !docs.length) || reading > 0) return false;
		// The copy from the last visit is on screen and not followed yet; sending waits the moment until the real one is in.
		if (session?.preview || mirrored) return false;
		if (!session) {
			toast(t("needWorkspace"), "warning");
			return false;
		}
		const attached = images;
		const attachedDocs = docs;
		rememberInput(value);
		history.current = { at: -1, draft: "" };
		setText("");
		setImages([]);
		setDocs([]);
		const mode = session?.capabilities && !session.capabilities.steering ? "followUp" : sendMode;
		const ok = await sendPrompt(value, streaming ? mode : undefined, attached, attachedDocs);
		if (!ok) {
			// This composer may be gone by now (the pending echo swaps the new-chat page for the chat): keep it as the draft too.
			saveDraft(shownKey, { text: value, images: attached, docs: attachedDocs });
			setText(value);
			setImages(attached);
			setDocs(attachedDocs);
		} else {
			// Went out: the sent text must not stay behind as this conversation's draft, or reopening it (or opening another
			// new chat in the same workspace) would show the message again. Explicit, because this composer is typically
			// unmounted by the pending echo before its save effect runs with the emptied box.
			saveDraft(shownKey, { text: "", images: [], docs: [] });
		}
		return ok;
	};

	/**
	 * Add picked, pasted or dropped files. Pictures go to the model as pictures (when the agent takes them); everything else
	 * (Word, Excel, PowerPoint, PDF, text, HTML, ...) is uploaded to a temporary folder and the model gets its path.
	 * What cannot be added is reported; the rest still go in.
	 */
	const addFiles = async (list: File[]) => {
		if (!list.length) return;
		const takesImages = session?.capabilities ? session.capabilities.images : true;
		const pictures = list.filter((f) => takesImages && isPicture(f));
		const documents = list.filter((f) => !pictures.includes(f));

		const room = MAX_IMAGES - images.length;
		if (pictures.length > Math.max(room, 0)) toast(t("tooMany", { n: MAX_IMAGES }), "warning");
		const docRoom = MAX_FILES - docs.length;
		if (documents.length > Math.max(docRoom, 0)) toast(t("filesTooMany", { n: MAX_FILES }), "warning");
		const takePictures = pictures.slice(0, Math.max(room, 0));
		const takeDocs = documents.slice(0, Math.max(docRoom, 0));
		if (!takePictures.length && !takeDocs.length) return;

		setReading((n) => n + takePictures.length + takeDocs.length);
		for (const file of takePictures) {
			try {
				const image = await fileToImage(file);
				setImages((cur) => (cur.length < MAX_IMAGES ? [...cur, image] : cur));
			} catch (err) {
				const reason = err instanceof ImageError ? err.reason : "decode";
				toast(t(reason === "type" ? "badType" : reason === "size" ? "tooBig" : "badImage"), "error");
			} finally {
				setReading((n) => n - 1);
			}
		}
		let bytes = docs.reduce((sum, d) => sum + d.size, 0);
		for (const file of takeDocs) {
			try {
				const doc = await fileToAttachment(file, bytes);
				bytes += doc.size;
				setDocs((cur) => (cur.length < MAX_FILES ? [...cur, doc] : cur));
			} catch (err) {
				const reason = err instanceof AttachmentError ? err.reason : "read";
				toast(reason === "size" ? t("fileTooBig", { name: file.name, n: MAX_FILE_MB }) : reason === "total" ? t("filesTotal", { n: MAX_FILE_MB }) : t("fileRead", { name: file.name }), "error");
			} finally {
				setReading((n) => n - 1);
			}
		}
	};

	const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const pasted = [...e.clipboardData.files];
		if (!pasted.length) return;
		// Screenshots arrive as files with no text; leave ordinary text pastes alone.
		e.preventDefault();
		void addFiles(pasted);
	};

	const lacksVision = images.length > 0 && Boolean(model) && models.find((m) => m.provider === model?.provider && m.id === model.id)?.vision === false;

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Tab" && e.shiftKey) {
			e.preventDefault();
			const { session: s, draftPermission } = useStore.getState();
			void setPermissionMode(nextPermissionMode(s?.permissionMode ?? draftPermission));
			return;
		}
		if (showMention && !e.nativeEvent.isComposing) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				setMentionCursor((c) => (c + (e.key === "ArrowDown" ? 1 : mentionItems.length - 1)) % mentionItems.length);
				return;
			}
			if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
				const pick = mentionItems[mentionCursor];
				if (pick) {
					e.preventDefault();
					pickMention(pick);
					return;
				}
			}
			if (e.key === "Escape" && mention) {
				e.preventDefault();
				setDismissed(`${mention.start}:${mention.query}`);
				return;
			}
		}
		if (showCommands) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				setCursor((c) => (c + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
				return;
			}
			if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
				const pick = matches[cursor];
				if (pick && `/${pick.name}` !== text) {
					e.preventDefault();
					pickSlash(pick);
					return;
				}
			}
		}
		if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
			const h = history.current;
			const browsing = h.at >= 0 && text === inputAt(h.at);
			let next: string | undefined;
			if (e.key === "ArrowUp" && (browsing || !text)) {
				const at = browsing ? h.at + 1 : 0;
				const found = inputAt(at);
				if (found !== undefined) {
					history.current = { at, draft: browsing ? h.draft : text };
					next = found;
				} else if (browsing) next = text; // already at the oldest
			} else if (e.key === "ArrowDown" && browsing) {
				const at = h.at - 1;
				history.current = { at, draft: h.draft };
				next = at < 0 ? h.draft : inputAt(at);
			}
			if (next !== undefined) {
				e.preventDefault();
				setText(next);
				requestAnimationFrame(() => ref.current?.setSelectionRange(next.length, next.length));
				return;
			}
		}
		// Esc leaves the expanded sheet first; while a reply is running it still stops that instead.
		if (e.key === "Escape" && expanded && !streaming) {
			e.preventDefault();
			collapse();
			return;
		}
		// Enter only sends when the user asked for it (the default on desktop). On a phone Enter breaks the line and the
		// send button sends, which is what touch keyboards expect.
		if (e.key === "Enter" && !e.shiftKey && (enterToSend || (expanded && isSheetSendChord(e))) && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void submit().then((sent) => sent && setExpanded(false));
		}
		if (e.key === "Escape" && streaming) {
			e.preventDefault();
			void abortRun();
		}
	};

	const queued = [
		...(session?.queue.steering ?? []).map((q, index) => ({ q, steer: true, index })),
		...(session?.queue.followUp ?? []).map((q, index) => ({ q, steer: false, index })),
	];

	// Dictation lands where the cursor was, spaced from what is already typed.
	// While speaking, drafts replace one another between `before` and `after`, captured when the take began.
	const dictation = useRef<{ before: string; after: string } | null>(null);
	const insertDictation = (spoken: string, final: boolean) => {
		// Whichever box is on screen: with the sheet open this used to read the inline one and land at its caret.
		const el = activeInput();
		if (!dictation.current) {
			if (!spoken) return;
			const current = textRef.current;
			const at = Math.min(el?.selectionStart ?? current.length, current.length);
			dictation.current = { before: current.slice(0, at), after: current.slice(at) };
		}
		const { before, after } = dictation.current;
		const glue = spoken && before && !/\s$/.test(before) && !/^[\u3000-\u9fff\uff00-\uffef]/.test(spoken) ? " " : "";
		setText(`${before}${glue}${spoken}${after}`);
		if (final) {
			dictation.current = null;
			el?.focus();
		}
	};

	return (
		<div
			className="chat-col relative mx-auto w-full px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-5 md:pb-5"
			onDragOver={(e) => {
				if (![...e.dataTransfer.types].includes("Files")) return;
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
			}}
			onDrop={(e) => {
				setDragging(false);
				if (![...e.dataTransfer.types].includes("Files")) return;
				e.preventDefault();
				void addFiles([...e.dataTransfer.files]);
			}}
		>
			{showMention && (
				<div className="absolute right-3 bottom-full left-3 z-30 mb-2 overflow-hidden rounded-xl border border-ink-700 bg-ink-900/95 shadow-2xl shadow-black/40 backdrop-blur md:right-5 md:left-5">
					<Mentions items={mentionItems} cursor={mentionCursor} onPick={pickMention} onHover={setMentionCursor} />
				</div>
			)}

			{showCommands && (
				<div className="absolute right-3 bottom-full left-3 z-30 mb-2 overflow-hidden rounded-xl border border-ink-700 bg-ink-900/95 shadow-2xl shadow-black/40 backdrop-blur md:right-5 md:left-5">
					<SlashCommands items={matches} cursor={cursor} onPick={pickSlash} />
				</div>
			)}

			{queued.length > 0 && (
				<div className="mb-2 flex flex-col gap-1 px-1">
					{queued.map(({ q, steer, index }, i) => (
						<div key={i} className="group/q flex min-w-0 items-center gap-1.5 text-xs text-ink-400" title={q}>
							{steer ? <CornerDownRight className="size-3 shrink-0 text-ember-300" /> : <ListEnd className="size-3 shrink-0 text-ink-500" />}
							<span className="min-w-0 flex-1 truncate">{t(steer ? "steered" : "queued", { q })}</span>
							<button type="button" title={t("editQueued")} onClick={() => void unqueue(steer ? "steer" : "followUp", index, q, true)} className="shrink-0 rounded p-1 text-ink-500 hover:bg-ink-800 hover:text-ink-100">
								<Pencil className="size-3" />
							</button>
							<button type="button" title={t("withdraw")} onClick={() => void unqueue(steer ? "steer" : "followUp", index, q, false)} className="shrink-0 rounded p-1 text-ink-500 hover:bg-ink-800 hover:text-rose-400">
								<X className="size-3" />
							</button>
						</div>
					))}
				</div>
			)}

			{!newChat && <GoalBar />}
			{session?.worktree ? <WorktreePanel /> : <SessionChanges />}

			<div className="mb-2 px-1">
				{newChat && personalSpace ? (
					<PersonalChip />
				) : newChat ? (
					<div className="flex min-w-0 items-center gap-2">
						<WorkspacePicker>
							<BranchPicker />
						</WorkspacePicker>
						{!session && <WorktreeSwitch />}
					</div>
				) : (
					<div className="flex min-w-0 items-center gap-2">
						<WorkspaceChip />
						{!session?.worktree && <BranchPicker />}
					</div>
				)}
			</div>

			<div
				className={clsx(
					"@container rounded-2xl border bg-ink-900/85 shadow-[0_10px_40px_-12px_rgb(0_0_0/0.45)] backdrop-blur transition-colors",
					streaming ? "border-ember-500/35" : "border-ink-700 focus-within:border-ink-500",
					dragging && "border-ember-400 ring-2 ring-ember-500/30",
				)}
			>
				{dragging && <div className="px-4 pt-3 text-xs text-ember-300">{t("dropHere")}</div>}
				{(images.length > 0 || docs.length > 0 || reading > 0) && (
					<Attachments
						docs={docs}
						images={images}
						reading={reading}
						onRemoveDoc={(i) => setDocs((cur) => cur.filter((_, j) => j !== i))}
						onRemoveImage={(i) => setImages((cur) => cur.filter((_, j) => j !== i))}
						className="px-3 pt-3"
					/>
				)}
				{lacksVision && <div className="px-4 pt-2 text-[11px] text-ember-300">{t("noVision")}</div>}
				<div className="group/ta relative">
				<button
					type="button"
					onClick={() => setExpanded(true)}
					className="absolute top-2 right-2 z-10 grid size-6 place-items-center rounded-md text-ink-500 opacity-60 transition hover:bg-ink-800 hover:text-ink-100 hover:opacity-100 group-focus-within/ta:opacity-100"
					title={t("expand")}
					aria-label={t("expand")}
				>
					<Maximize2 className="size-3.5" />
				</button>
				<textarea
					ref={ref}
					autoFocus
					value={text}
					onChange={(e) => {
						setText(e.target.value);
						setCaret(e.target.selectionStart);
					}}
					onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					rows={1}
					disabled={mirrored}
					placeholder={mirrored ? t("placeholderMirror") : streaming ? t("placeholderStreaming", { mode: t(sendMode) }) : t("placeholder")}
					className="block max-h-64 w-full resize-none bg-transparent py-3.5 pr-9 pb-2 pl-4 text-[15px] text-ink-100 placeholder:text-ink-500 focus:outline-none"
				/>
				</div>
				<div className="flex items-center gap-1 px-2 pb-2">
					<label
						className={clsx(
							"relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg text-ink-400 transition-colors",
							images.length + reading >= MAX_IMAGES && docs.length + reading >= MAX_FILES ? "pointer-events-none opacity-40" : "hover:bg-ink-800 hover:text-ink-100",
						)}
						title={t("attach")}
						aria-label={t("attach")}
					>
						<input
							ref={files}
							type="file"
							multiple
							className="absolute -inset-8 cursor-pointer opacity-0"
							style={{ fontSize: 64 }}
							onChange={(e) => {
								const list = [...(e.target.files ?? [])];
								void addFiles(list).finally(() => {
									e.target.value = "";
								});
							}}
						/>
						<Paperclip className="pointer-events-none size-4" />
					</label>
					<div className="flex min-w-0 flex-1 items-center gap-1">
						<ModelPicker />
						<EffortPicker />
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<VoiceButton onText={insertDictation} />
						{streaming && (
							<button type="button" onClick={() => void abortRun()} className="grid size-8 place-items-center rounded-lg bg-ink-800 text-ink-200 hover:bg-ink-700" aria-label={t("abort")} title={t("abort")}>
								<Square className="size-3.5 fill-current" />
							</button>
						)}
						<div className="flex items-stretch">
							<button
								type="button"
								onClick={() => void submit()}
								disabled={!canSend}
								title={session ? (streaming ? t("sendAs", { mode: t(sendMode) }) : undefined) : t("needWorkspace")}
								className={clsx(
									"grid h-8 place-items-center bg-ember-500 text-white transition hover:bg-ember-400 disabled:bg-ink-800 disabled:text-ink-600",
									streaming ? "w-8 rounded-l-lg" : "w-8 rounded-lg",
								)}
								aria-label={t("send")}
							>
								{streaming ? (sendMode === "steer" ? <CornerDownRight className="size-4" strokeWidth={2.5} /> : <ListEnd className="size-4" strokeWidth={2.5} />) : <ArrowUp className="size-4" strokeWidth={2.5} />}
							</button>
							{streaming && <SendModePicker />}
						</div>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-x-1 border-t border-ink-800/70 px-2 py-1">
					{newChat ? <RuntimeMenu mode="draft" /> : session ? <RuntimeMenu mode="session" /> : null}
					<PermissionPicker />
					<ModePicker />
					<div className="flex-1" />
					<ContextMeter />
				</div>
			</div>

			{/* The expanded editor owns only layout; the draft, suggestions and actions stay here so both boxes agree. It
			    follows the visual viewport so a phone keyboard cannot cover the suggestions at its bottom. */}
			{expanded && (
				<ComposerSheet
					value={text}
					onChange={(v, c) => {
						setText(v);
						setCaret(c);
					}}
					onCaret={setCaret}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					textareaRef={expandedRef}
					placeholder={streaming ? t("placeholderStreaming", { mode: t(sendMode) }) : t("placeholder")}
					attachments={
						images.length > 0 || docs.length > 0 || reading > 0 ? (
							<Attachments
								docs={docs}
								images={images}
								reading={reading}
								onRemoveDoc={(i) => setDocs((cur) => cur.filter((_, j) => j !== i))}
								onRemoveImage={(i) => setImages((cur) => cur.filter((_, j) => j !== i))}
								className="px-4 py-2.5 md:px-5"
							/>
						) : undefined
					}
					suggestions={
						showMention ? (
							<div className="max-h-56 shrink-0 overflow-y-auto border-t border-ink-800">
								<Mentions items={mentionItems} cursor={mentionCursor} onPick={pickMention} onHover={setMentionCursor} />
							</div>
						) : showCommands ? (
							<div className="max-h-56 shrink-0 overflow-y-auto border-t border-ink-800">
								<SlashCommands items={matches} cursor={cursor} onPick={pickSlash} />
							</div>
						) : undefined
					}
					tools={<VoiceButton onText={insertDictation} />}
					toolbar={
						<>
							<ModelPicker />
							<EffortPicker />
							<PermissionPicker />
							<ModePicker />
						</>
					}
					onFiles={(list) => void addFiles(list)}
					enterToSend={enterToSend}
					canSend={canSend}
					sendIcon={streaming ? (sendMode === "steer" ? <CornerDownRight className="size-4" strokeWidth={2.5} /> : <ListEnd className="size-4" strokeWidth={2.5} />) : undefined}
					sendTitle={streaming ? t("sendAs", { mode: t(sendMode) }) : undefined}
					streaming={streaming}
					onSend={() => void submit().then((sent) => sent && setExpanded(false))}
					onClose={collapse}
					viewport={sheet}
				/>
			)}
		</div>
	);
}
