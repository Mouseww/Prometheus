import { copyToClipboard } from "../lib/clipboard.ts";
import clsx from "clsx";
import { Collapse } from "./ui.tsx";
import { confirmDialog } from "../lib/dialogs.ts";
import { Brain, Check, Eye, ChevronDown, ChevronRight, CircleAlert, Copy, GitBranch, LoaderCircle, Pencil, RotateCcw, Target, Trash2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type AssistantMessage, type ChatMessage, type ImageContent, parseGoalDirective, type SavedAttachment, splitAttachmentNote, stripGoalStatus, type ToolCallContent, type ToolResultMessage, type UserMessage, withAttachmentNote } from "@prometheus/protocol";
import { FileText } from "lucide-react";
import { DownloadButton } from "./FileDownloadButton.tsx";
import { formatSize } from "../lib/attachments.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { imagesOf } from "../lib/images.ts";
import { deleteMessage, editMessage, fetchToolResult, forkMessage, openFile, pluginActive, retryMessage, type ToolRun, toast, useStore } from "../lib/store.ts";
import { ImageStrip } from "./ImageStrip.tsx";
import { Markdown } from "./Markdown.tsx";
import { SubagentCard } from "./SubagentCard.tsx";

/** Turns rendered when a conversation opens, and how many more each step adds. Earlier ones load as the user scrolls up. */
const INITIAL_TURNS = 8;
/** Browsers without scroll anchoring (Safari) skip `content-visibility`, whose size estimates they cannot absorb. */
const ANCHORING = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("overflow-anchor", "auto");
const MORE_TURNS = 10;

const M = defineMessages({
	zh: {
		thinkingLive: "思考中…",
		thinking: "思考过程",
		stepsDone: "已完成 {n} 个步骤",
		chars: "{n} 字",
		aborted: "— 已中断",
		compacted: "上下文已压缩",
		copy: "复制",
		copied: "已复制",
		retry: "重试",
		fork: "从此处 Fork 新会话",
		delete: "删除",
		edit: "编辑后重新发送",
		cancel: "取消",
		resend: "重新发送",
		confirmDelete: "从上下文中删除这条消息？",
		cut: "输出已截断，共 {n} 字",
		loadFull: "加载完整输出",
		loadingFull: "加载中…",
		earlier: "加载更早的 {n} 轮对话",
		earlierMore: "加载更早的对话",
		goalTurn: "目标自动推进 · 第 {n}/{max} 轮",
	},
	en: {
		thinkingLive: "Thinking…",
		thinking: "Thoughts",
		stepsDone: "{n} steps completed",
		chars: "{n} chars",
		aborted: "— Stopped",
		compacted: "Context compacted",
		copy: "Copy",
		copied: "Copied",
		retry: "Retry",
		fork: "Fork a new chat from here",
		delete: "Delete",
		edit: "Edit and resend",
		cancel: "Cancel",
		resend: "Resend",
		confirmDelete: "Remove this message from the context?",
		cut: "Output cut, {n} chars in all",
		loadFull: "Load full output",
		loadingFull: "Loading…",
		earlier: "Load {n} earlier turns",
		earlierMore: "Load earlier turns",
		goalTurn: "Working toward the goal · turn {n}/{max}",
	},
});

function rawUserText(m: UserMessage): string {
	return typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** What the user typed and the files they attached; the note that tells the model where the files are is not shown as text. */
function userParts(m: UserMessage): { text: string; files: SavedAttachment[]; skill?: { name: string; raw: string } } {
	const { text, files } = splitAttachmentNote(rawUserText(m));
	// /skill:name expands to a <skill> block ahead of the user's words; show it as a chip instead of the whole SKILL.md.
	const hit = /^<skill name="([^"]*)"[^>]*>[\s\S]*?<\/skill>(?:\r?\n){0,2}/.exec(text);
	if (!hit) return { text, files };
	return { text: text.slice(hit[0].length), files, skill: { name: hit[1] ?? "", raw: hit[0] } };
}

/** A turn the host sent for /goal: the objective once, then a thin divider per continuation, never the instructions. */
function GoalMarker({ turn, maxTurns, objective }: { turn: number; maxTurns: number; objective: string }) {
	const t = useT(M);
	if (turn <= 1) {
		return (
			<div className="flex justify-end animate-rise">
				<div className="flex max-w-[85%] flex-col items-end gap-1.5">
					<div className="flex items-center gap-1.5 font-mono text-[11px] text-ember-300">
						<Target className="size-3.5" /> /goal
					</div>
					<div className="rounded-2xl rounded-br-md border border-ember-500/30 bg-gradient-to-b from-ink-800 to-ink-850 px-4 py-2.5 text-[15px] whitespace-pre-wrap text-ink-100">{objective}</div>
				</div>
			</div>
		);
	}
	return (
		<div className="flex items-center gap-3 text-[11px] text-ink-500" title={objective}>
			<span className="h-px flex-1 bg-ink-800" />
			<span className="flex items-center gap-1.5">
				<Target className="size-3 text-ember-400/70" /> {t("goalTurn", { n: turn, max: maxTurns })}
			</span>
			<span className="h-px flex-1 bg-ink-800" />
		</div>
	);
}

/** Attached documents as small cards. */
function FileChips({ files }: { files: { name: string; size: number; path?: string }[] }) {
	const viewer = useStore((s) => pluginActive(s.plugins, "workbench"));
	const cwd = useStore((s) => s.session?.cwd ?? "");
	if (!files.length) return null;
	return (
		<div className="flex flex-wrap justify-end gap-1.5">
			{files.map((f, i) => (
				<div key={i} className={`flex max-w-60 items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 ${viewer && f.path ? "cursor-pointer hover:border-ink-600" : ""}`} title={f.name} onClick={viewer && f.path ? () => openFile(f.path!, cwd) : undefined}>
					<FileText className="size-4 shrink-0 text-ember-300" />
					<span className="min-w-0 truncate text-xs text-ink-200">{f.name}</span>
					<span className="shrink-0 font-mono text-[10.5px] text-ink-500">{formatSize(f.size)}</span>
					{f.path && <DownloadButton path={f.path} name={f.name} />}
				</div>
			))}
		</div>
	);
}

function userImages(m: UserMessage): ImageContent[] {
	return typeof m.content === "string" ? [] : m.content.filter((c): c is ImageContent => c.type === "image");
}

/** The bubble of a sent message: pictures above the words, either part optional. */
function UserBubble({ text, images, files = [], skill }: { text: string; images: ImageContent[]; files?: { name: string; size: number; path?: string }[]; skill?: string }) {
	return (
		<div className="flex max-w-[85%] flex-col items-end gap-2">
			{skill && <div className="rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1 font-mono text-xs text-ember-300">/skill:{skill}</div>}
			<ImageStrip images={images} align="end" />
			<FileChips files={files} />
			{text && <div className="rounded-2xl rounded-br-md border border-ember-500/20 bg-gradient-to-b from-ink-800 to-ink-850 px-4 py-2.5 text-[15px] whitespace-pre-wrap text-ink-100">{text}</div>}
		</div>
	);
}

/** Inline editor for a sent message; resending branches the chat from before it. */
function UserEditor({ index, initial, files, skillRaw = "", onClose }: { index: number; initial: string; files: SavedAttachment[]; skillRaw?: string; onClose: () => void }) {
	const t = useT(M);
	const [value, setValue] = useState(initial);
	const [busy, setBusy] = useState(false);
	const send = async () => {
		if (busy || (!value.trim() && !files.length)) return;
		setBusy(true);
		// The files stay attached: the note that points the model at them goes back after the edited words.
		const ok = await editMessage(index, withAttachmentNote(skillRaw + value, files));
		setBusy(false);
		if (ok) onClose();
	};
	return (
		<div className="flex w-full max-w-[85%] flex-col items-end gap-2">
			<textarea
				autoFocus
				value={value}
				rows={Math.min(10, Math.max(2, value.split("\n").length))}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") onClose();
					else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault();
						void send();
					}
				}}
				className="w-full resize-none rounded-2xl border border-ember-500/40 bg-ink-900 px-4 py-2.5 text-[15px] text-ink-100 outline-none focus:border-ember-400"
			/>
			<div className="flex gap-2 text-xs">
				<button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100">
					{t("cancel")}
				</button>
				<button type="button" disabled={busy || (!value.trim() && !files.length)} onClick={() => void send()} className="rounded-md bg-ember-500 px-3 py-1.5 font-medium text-ink-950 hover:bg-ember-400 disabled:opacity-40">
					{t("resend")}
				</button>
			</div>
		</div>
	);
}

function resultText(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	const v = value as { content?: { type: string; text?: string }[]; preview?: string };
	if (Array.isArray(v.content)) return v.content.map((c) => c.text ?? `[${c.type}]`).join("\n");
	if (typeof v.preview === "string") return `${v.preview}\n…（已截断）`;
	return JSON.stringify(value, null, 2);
}

function argSummary(name: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const key = ["command", "path", "file_path", "pattern", "query", "url"].find((k) => typeof args[k] === "string");
	const raw = key ? String(args[key]) : JSON.stringify(args);
	return raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
}

function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
	const t = useT(M);
	const [open, setOpen] = useState(false);
	return (
		<div className="rounded-xl border border-ink-800 bg-ink-900/50">
			<button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-xs text-ink-400 hover:text-ink-200">
				<Brain className={clsx("size-3.5", live && "animate-pulse text-ember-300")} />
				<span>{live ? t("thinkingLive") : t("thinking")}</span>
				<span className="font-mono text-ink-600">{t("chars", { n: text.length })}</span>
				{open ? <ChevronDown className="ml-auto size-3.5" /> : <ChevronRight className="ml-auto size-3.5" />}
			</button>
			<Collapse open={open}>
				<div className="border-t border-ink-800 px-3.5 py-3 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-400 italic">{text}</div>
			</Collapse>
		</div>
	);
}

/** Shown from the moment a prompt is sent until the first token arrives, so the UI never looks idle. */
function Pondering() {
	const t = useT(M);
	return (
		<div role="status" className="flex items-center gap-2 text-sm">
			<LoaderCircle className="size-3.5 animate-spin text-ember-400" />
			<span className="thinking-shimmer">{t("thinkingLive")}</span>
		</div>
	);
}

function Avatar() {
	return (
		<div className="mt-1 grid size-6 shrink-0 place-items-center rounded-md bg-ember-500/12">
			<span className="size-2 rounded-full bg-ember-400 shadow-[0_0_10px_2px_rgb(var(--glow)/0.6)]" />
		</div>
	);
}

function ToolCard({ call, run, result }: { call: ToolCallContent; run?: ToolRun; result?: ToolResultMessage }) {
	const [open, setOpen] = useState(false);
	const status = run?.status ?? (result ? (result.isError ? "error" : "done") : "running");
	const t = useT(M);
	const [full, setFull] = useState<string | null>(null);
	const [loadingFull, setLoadingFull] = useState(false);
	const cut = result?.truncatedChars && full === null ? result.truncatedChars : 0;
	const output = full ?? (result ? resultText(result) : resultText(run?.result ?? run?.partial));
	const pictures = result ? imagesOf(result) : imagesOf(run?.result ?? run?.partial);
	const viewer = useStore((s) => pluginActive(s.plugins, "workbench"));
	const cwd = useStore((s) => s.session?.cwd ?? "");
	const filePath = ["read", "write", "edit"].includes(call.name) && typeof call.arguments?.path === "string" ? call.arguments.path : undefined;
	return (
		<div className={clsx("overflow-hidden rounded-xl border bg-ink-900/70", status === "error" ? "border-rose-400/25" : "border-ink-800")}>
			<button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
				<span
					className={clsx(
						"grid size-6 shrink-0 place-items-center rounded-md",
						status === "running" && "bg-ember-500/15 text-ember-300",
						status === "done" && "bg-moss-400/12 text-moss-400",
						status === "error" && "bg-rose-400/12 text-rose-400",
					)}
				>
					{status === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : status === "error" ? <CircleAlert className="size-3.5" /> : <Check className="size-3.5" />}
				</span>
				<span className="shrink-0 font-mono text-[13px] font-medium text-ink-100">{call.name || run?.toolName}</span>
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-500">{argSummary(call.name, call.arguments)}</span>
				{filePath && status === "done" && <DownloadButton path={filePath} />}
				{viewer && filePath && (
					<span
						role="button"
						tabIndex={0}
						onClick={(e) => {
							e.stopPropagation();
							openFile(filePath, cwd);
						}}
						onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), openFile(filePath, cwd))}
						className="grid size-5 shrink-0 place-items-center rounded text-ink-500 hover:bg-ink-800 hover:text-ink-100"
						title="View"
					>
						<Eye className="size-3.5" />
					</span>
				)}
				{run?.durationMs !== undefined && <span className="shrink-0 font-mono text-[11px] text-ink-600">{(run.durationMs / 1000).toFixed(1)}s</span>}
				{open ? <ChevronDown className="size-3.5 shrink-0 text-ink-500" /> : <ChevronRight className="size-3.5 shrink-0 text-ink-500" />}
			</button>
			<Collapse open={open}>
				<div className="space-y-2 border-t border-ink-800 px-3 py-3">
					<pre className="max-h-[35dvh] overflow-auto rounded-lg bg-ink-950 p-2.5 font-mono text-[11.5px] text-ink-300 md:max-h-48">{JSON.stringify(call.arguments, null, 2)}</pre>
					{output && <pre className="max-h-[45dvh] overflow-auto rounded-lg bg-ink-950 p-2.5 font-mono text-[11.5px] break-words whitespace-pre-wrap text-ink-300 md:max-h-80">{output}</pre>}
					{cut > 0 && (
						<div className="flex items-center gap-2 text-xs text-ink-500">
							<span>{t("cut", { n: cut })}</span>
							<button
								type="button"
								disabled={loadingFull}
								onClick={async () => {
									setLoadingFull(true);
									const content = await fetchToolResult(call.id);
									setLoadingFull(false);
									if (content) setFull(content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(String.fromCharCode(10)));
								}}
								className="rounded px-2 py-0.5 text-ember-300 hover:bg-ink-800 disabled:opacity-50"
							>
								{t(loadingFull ? "loadingFull" : "loadFull")}
							</button>
						</div>
					)}
					<ImageStrip images={pictures} />
				</div>
			</Collapse>
		</div>
	);
}

type BlockMode = "all" | "steps" | "final";

function AssistantBlock({
	message,
	live,
	tools,
	results,
	mode = "all",
	finalAt = -1,
}: {
	message: AssistantMessage;
	live: boolean;
	tools: Record<string, ToolRun>;
	results: Map<string, ToolResultMessage>;
	mode?: BlockMode;
	finalAt?: number;
}) {
	const t = useT(M);
	const last = message.content.length - 1;
	return (
		<div className="space-y-3">
			{message.content.map((block, i) => {
				if (!block) return null;
				if (mode === "steps" && i === finalAt) return null;
				if (mode === "final" && i !== finalAt) return null;
				if (block.type === "thinking") return block.thinking.trim() ? <ThinkingBlock key={i} text={block.thinking} live={live && i === last} /> : null;
				if (block.type === "toolCall") {
					const card = <ToolCard key={block.id || i} call={block} run={tools[block.id]} result={results.get(block.id)} />;
					return block.name === "subagent" ? <SubagentCard key={block.id || i} callId={block.id} fallback={card} /> : card;
				}
				return (
					<div key={i} className={clsx(live && i === last && "caret")}>
						<Markdown text={stripGoalStatus(block.text)} />
					</div>
				);
			})}
			{live && message.content.length === 0 && <Pondering />}
			{mode !== "steps" && message.stopReason === "error" && message.errorMessage && (
				<div className="rounded-lg border border-rose-400/25 bg-rose-400/8 px-3 py-2 min-w-0 text-sm break-words whitespace-pre-wrap text-rose-400 [overflow-wrap:anywhere]">{message.errorMessage}</div>
			)}
			{mode !== "steps" && message.stopReason === "aborted" && <div className="text-xs text-ink-500">{t("aborted")}</div>}
		</div>
	);
}

function assistantText(m: AssistantMessage): string {
	return m.content
		.map((c) => (c?.type === "text" ? stripGoalStatus(c.text) : ""))
		.filter(Boolean)
		.join("\n\n");
}

async function copyText(text: string, done: string): Promise<void> {
	try {
		await copyToClipboard(text);
		toast(done);
	} catch (err) {
		toast(err instanceof Error ? err.message : String(err), "error");
	}
}

async function removeAll(indices: number[]): Promise<void> {
	// Last to first so earlier indices stay valid after each reset.
	for (const i of [...indices].reverse()) await deleteMessage(i);
}

function Actions({ index, indices, text, canRetry, align, onEdit }: { index: number; indices?: number[]; text: string; canRetry: boolean; align: "start" | "end"; onEdit?: () => void }) {
	const t = useT(M);
	const [copied, setCopied] = useState(false);
	const btn = "rounded-md p-1.5 text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-100 disabled:pointer-events-none disabled:opacity-30";
	return (
		<div className={clsx("mt-1 flex gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 nohover:opacity-100", align === "end" && "justify-end")}>
			<button
				type="button"
				className={btn}
				title={t("copy")}
				disabled={!text}
				onClick={() => {
					void copyText(text, t("copied"));
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}}
			>
				{copied ? <Check className="size-3.5 text-moss-400" /> : <Copy className="size-3.5" />}
			</button>
			{onEdit && (
				<button type="button" className={btn} title={t("edit")} disabled={!canRetry} onClick={onEdit}>
					<Pencil className="size-3.5" />
				</button>
			)}
			<button type="button" className={btn} title={t("retry")} disabled={!canRetry} onClick={() => void retryMessage(index)}>
				<RotateCcw className="size-3.5" />
			</button>
			<button type="button" className={btn} title={t("fork")} disabled={!canRetry} onClick={() => void forkMessage(index)}>
				<GitBranch className="size-3.5" />
			</button>
			<button
				type="button"
				className={clsx(btn, "hover:text-rose-400")}
				title={t("delete")}
				disabled={!canRetry}
				onClick={() => void confirmDialog(t("confirmDelete")).then((ok) => { if (ok) void removeAll(indices ?? [index]); })}
			>
				<Trash2 className="size-3.5" />
			</button>
		</div>
	);
}

/** A finished turn: intermediate steps fold away, only the closing answer stays visible. */
function TurnBody({
	group,
	live,
	awaitingNext,
	streaming,
	lastIndex,
	tools,
	results,
}: {
	group: { message: AssistantMessage; index: number }[];
	live: boolean;
	awaitingNext: boolean;
	streaming: boolean;
	lastIndex: number;
	tools: Record<string, ToolRun>;
	results: Map<string, ToolResultMessage>;
}) {
	const t = useT(M);
	const [open, setOpen] = useState(false);
	const lastMsg = group[group.length - 1]?.message;
	let finalAt = -1;
	if (lastMsg && lastMsg.stopReason !== "error" && lastMsg.stopReason !== "aborted") {
		for (let i = lastMsg.content.length - 1; i >= 0; i--) {
			const b = lastMsg.content[i];
			if (b?.type === "text" && b.text.trim()) finalAt = i;
			if (b?.type === "text" || !b) continue;
			break;
		}
	}
	let steps = 0;
	group.forEach((g) =>
		g.message.content.forEach((b, i) => {
			if (!b || (g === group[group.length - 1] && i === finalAt)) return;
			if (b.type === "toolCall" || (b.type === "thinking" && b.thinking.trim()) || (b.type === "text" && b.text.trim())) steps++;
		}),
	);
	const render = (mode: BlockMode) =>
		// In "final" mode only the last message holds the reply; the others would be empty boxes that each add a flex gap.
		(mode === "final" ? group.slice(-1) : group).map((g) => (
			<AssistantBlock
				key={`${mode}${g.index}`}
				message={g.message}
				live={streaming && g.index === lastIndex}
				tools={tools}
				results={results}
				mode={mode}
				finalAt={g === group[group.length - 1] ? finalAt : -1}
			/>
		));
	if (live || finalAt < 0 || steps === 0) {
		return (
			<div className="flex flex-col gap-3">
				{render("all")}
				{live && awaitingNext && <Pondering />}
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			<div>
				<button
					type="button"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
					className="flex w-full items-center gap-2 rounded-xl border border-ink-800 bg-ink-900/50 px-3.5 py-2 text-left text-xs text-ink-400 transition-colors hover:text-ink-200"
				>
					<Check className="size-3.5 text-moss-400" />
					<span>{t("stepsDone", { n: steps })}</span>
					<ChevronRight className={clsx("ml-auto size-3.5 transition-transform", open && "rotate-90")} />
				</button>
				<Collapse open={open}>
					<div className="flex flex-col gap-3 pt-3">{render("steps")}</div>
				</Collapse>
			</div>
			{render("final")}
		</div>
	);
}

export function MessageList({
	messages,
	offset,
	onLoadEarlier,
	tools,
	streaming,
	pending,
}: {
	messages: ChatMessage[];
	/** Messages of the conversation before `messages[0]` that the server still holds. */
	offset: number;
	onLoadEarlier: () => Promise<void>;
	tools: Record<string, ToolRun>;
	streaming: boolean;
	pending: { text: string; images?: ImageContent[]; files?: { name: string; size: number }[] } | null;
}) {
	const t = useT(M);
	const [editingAt, setEditingAt] = useState<number | null>(null);
	// Absolute index (in the whole conversation) of the first message shown; null until the first render picks the latest turns.
	const [shownFrom, setShownFrom] = useState<number | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const userAt = useMemo(() => messages.flatMap((m, i) => (m.role === "user" ? [i] : [])), [messages]);
	const start = shownFrom === null ? (userAt.length > INITIAL_TURNS ? (userAt[userAt.length - INITIAL_TURNS] ?? 0) : 0) : Math.max(0, shownFrom - offset);
	const hiddenLocal = userAt.filter((i) => i < start).length;
	const results = new Map<string, ToolResultMessage>();
	for (let i = start; i < messages.length; i++) {
		const m = messages[i];
		if (m?.role === "toolResult") results.set(m.toolCallId, m);
	}
	const lastIndex = messages.length - 1;
	// One pass instead of re-slicing the history per message: the role before each message, ignoring tool results.
	let lastNonResult = -1;
	const roleBefore: (string | undefined)[] = [];
	let seen: string | undefined;
	for (let i = 0; i < messages.length; i++) {
		roleBefore[i] = seen;
		const role = messages[i]?.role;
		if (role !== "toolResult") {
			seen = role;
			lastNonResult = i;
		}
	}
	const waitingOnReply = Boolean(pending) || (streaming && messages[lastIndex]?.role === "user");
	const more = start > 0 || offset > 0;
	// Far from the end the browser may skip rendering a message until it scrolls near (the last ones stay live for streaming).
	// Only where the browser keeps the reading position when skipped messages take their real height (scroll anchoring); elsewhere the estimate would make the page jump.
	const far = (i: number) => ANCHORING && i < lastIndex - 12;

	// Earlier turns appear above what the user is reading: keep that in place by adding the height they brought.
	const first = start + offset;
	// Native scroll anchoring stays on for everything else (it absorbs the size changes of skipped messages) and is switched off
	// only while earlier turns are inserted, when the compensation below does the same job.
	const last = useRef({ first, height: 0 });
	const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const holdAnchoring = useCallback(() => {
		const scroller = root.current?.parentElement;
		if (!scroller) return;
		scroller.style.overflowAnchor = "none";
		clearTimeout(releaseTimer.current);
		// If nothing ends up being inserted, give anchoring back anyway.
		releaseTimer.current = setTimeout(() => (scroller.style.overflowAnchor = ""), 1500);
	}, []);
	useLayoutEffect(() => {
		const scroller = root.current?.parentElement;
		if (scroller && first < last.current.first && last.current.height > 0) {
			scroller.scrollTop += scroller.scrollHeight - last.current.height;
			clearTimeout(releaseTimer.current);
			scroller.style.overflowAnchor = "";
		}
		last.current = { first, height: scroller?.scrollHeight ?? 0 };
	});
	useEffect(() => () => clearTimeout(releaseTimer.current), []);

	const loading = useRef(false);
	const showMore = useCallback(async () => {
		if (loading.current) return;
		holdAnchoring();
		if (start > 0) {
			// Step back over MORE_TURNS user messages already in memory.
			let seenUsers = 0;
			let i = start - 1;
			for (; i > 0; i--) if (messages[i]?.role === "user" && ++seenUsers === MORE_TURNS) break;
			setShownFrom(offset + Math.max(0, i));
			return;
		}
		loading.current = true;
		try {
			await onLoadEarlier();
			setShownFrom(0);
		} finally {
			loading.current = false;
		}
	}, [start, messages, offset, onLoadEarlier, holdAnchoring]);
	const sentinel = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = sentinel.current;
		const scroller = root.current?.parentElement;
		if (!el || !scroller || typeof IntersectionObserver === "undefined") return;
		const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void showMore(), { root: scroller, rootMargin: "400px 0px 0px 0px" });
		io.observe(el);
		return () => io.disconnect();
	}, [more, showMore]);

	return (
		<div ref={root} className="chat-col mx-auto w-full space-y-5 px-3 py-5 md:px-5 md:py-8">
			{more && (
				<div ref={sentinel} className="flex justify-center">
					<button type="button" onClick={() => void showMore()} className="rounded-md px-3 py-1 text-xs text-ink-500 hover:bg-ink-800 hover:text-ink-200">
						{offset > 0 ? t("earlierMore") : t("earlier", { n: hiddenLocal })}
					</button>
				</div>
			)}
			{messages.map((m, i) => {
				if (i < start) return null;
				if (m.role === "user") {
					const goal = parseGoalDirective(rawUserText(m));
					if (goal) return <GoalMarker key={i + offset} turn={goal.turn} maxTurns={goal.maxTurns} objective={goal.objective} />;
					const { text, files: attachedFiles, skill } = userParts(m);
					const editing = editingAt === i && !streaming;
					return (
						<div key={i + offset} className={clsx("group/msg animate-rise", far(i) && "msg-far")}>
							<div className="flex justify-end">
								{editing ? <UserEditor index={i} initial={text} files={attachedFiles} skillRaw={skill?.raw} onClose={() => setEditingAt(null)} /> : <UserBubble text={text} images={userImages(m)} files={attachedFiles} skill={skill?.name} />}
							</div>
							{!editing && <Actions index={i} text={text} canRetry={!streaming} align="end" onEdit={() => setEditingAt(i)} />}
						</div>
					);
				}
				if (m.role === "assistant") {
					// Each tool round is its own assistant message; render a whole turn as one block.
					if (roleBefore[i] === "assistant") return null;
					const group: { message: AssistantMessage; index: number }[] = [];
					for (let j = i; j < messages.length; j++) {
						const g = messages[j];
						if (g?.role === "assistant") group.push({ message: g, index: j });
						else if (g?.role !== "toolResult") break;
					}
					const lastInGroup = group[group.length - 1]?.index ?? i;
					// Tool results after the last assistant message mean the next model call is still pending.
					const awaitingNext = lastInGroup < lastIndex && lastNonResult === lastInGroup;
					const live = streaming && (lastInGroup === lastIndex || awaitingNext);
					return (
						<div key={i + offset} className={clsx("group/msg flex gap-3", far(i) && "msg-far")}>
							<Avatar />
							<div className="min-w-0 flex-1">
								<TurnBody group={group} live={live} awaitingNext={awaitingNext} streaming={streaming} lastIndex={lastIndex} tools={tools} results={results} />
								{!live && (
									<Actions
										index={lastInGroup}
										indices={group.map((g) => g.index)}
										text={group.map((g) => assistantText(g.message)).filter(Boolean).join("\n\n")}
										canRetry={!streaming}
										align="start"
									/>
								)}
							</div>
						</div>
					);
				}
				if (m.role === "compactionSummary") {
					return (
						<div key={i + offset} className="flex items-center gap-3 text-xs text-ink-500">
							<span className="h-px flex-1 bg-ink-800" /> {t("compacted")} <span className="h-px flex-1 bg-ink-800" />
						</div>
					);
				}
				return null;
			})}
			{pending && (
				// Same key as the real message will get, so the bubble is reused instead of replayed when the server echoes it.
				<div key={messages.length + offset} className="group/msg animate-rise">
					<div className="flex justify-end">
						<UserBubble text={pending.text} images={pending.images ?? []} files={pending.files ?? []} />
					</div>
				</div>
			)}
			{waitingOnReply && (
				<div className="flex gap-3">
					<Avatar />
					<div className="min-w-0 flex-1 pt-0.5">
						<Pondering />
					</div>
				</div>
			)}
		</div>
	);
}
