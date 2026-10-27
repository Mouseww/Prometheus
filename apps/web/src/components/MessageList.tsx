import { copyToClipboard } from "../lib/clipboard.ts";
import clsx from "clsx";
import { Collapse } from "./ui.tsx";
import { confirmDialog } from "../lib/dialogs.ts";
import { Brain, Check, Eye, ChevronDown, ChevronRight, CircleAlert, Copy, GitBranch, LoaderCircle, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import type { AssistantMessage, ChatMessage, ImageContent, ToolCallContent, ToolResultMessage, UserMessage } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { imagesOf } from "../lib/images.ts";
import { deleteMessage, editMessage, forkMessage, openFile, pluginActive, retryMessage, type ToolRun, toast, useStore } from "../lib/store.ts";
import { ImageStrip } from "./ImageStrip.tsx";
import { Markdown } from "./Markdown.tsx";
import { SubagentCard } from "./SubagentCard.tsx";

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
	},
});

function userText(m: UserMessage): string {
	return typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

function userImages(m: UserMessage): ImageContent[] {
	return typeof m.content === "string" ? [] : m.content.filter((c): c is ImageContent => c.type === "image");
}

/** The bubble of a sent message: pictures above the words, either part optional. */
function UserBubble({ text, images }: { text: string; images: ImageContent[] }) {
	return (
		<div className="flex max-w-[85%] flex-col items-end gap-2">
			<ImageStrip images={images} align="end" />
			{text && <div className="rounded-2xl rounded-br-md border border-ember-500/20 bg-gradient-to-b from-ink-800 to-ink-850 px-4 py-2.5 text-[15px] whitespace-pre-wrap text-ink-100">{text}</div>}
		</div>
	);
}

/** Inline editor for a sent message; resending branches the chat from before it. */
function UserEditor({ index, initial, onClose }: { index: number; initial: string; onClose: () => void }) {
	const t = useT(M);
	const [value, setValue] = useState(initial);
	const [busy, setBusy] = useState(false);
	const send = async () => {
		if (busy || !value.trim()) return;
		setBusy(true);
		const ok = await editMessage(index, value);
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
				<button type="button" disabled={busy || !value.trim()} onClick={() => void send()} className="rounded-md bg-ember-500 px-3 py-1.5 font-medium text-ink-950 hover:bg-ember-400 disabled:opacity-40">
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
	const output = result ? resultText(result) : resultText(run?.result ?? run?.partial);
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
						<Markdown text={block.text} />
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
		.map((c) => (c?.type === "text" ? c.text : ""))
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
	tools,
	streaming,
	pending,
}: {
	messages: ChatMessage[];
	tools: Record<string, ToolRun>;
	streaming: boolean;
	pending: { text: string; images?: ImageContent[] } | null;
}) {
	const t = useT(M);
	const [editingAt, setEditingAt] = useState<number | null>(null);
	const results = new Map<string, ToolResultMessage>();
	for (const m of messages) if (m.role === "toolResult") results.set(m.toolCallId, m);
	const lastIndex = messages.length - 1;
	const waitingOnReply = Boolean(pending) || (streaming && messages[lastIndex]?.role === "user");

	return (
		<div className="chat-col mx-auto w-full space-y-5 px-3 py-5 md:px-5 md:py-8">
			{messages.map((m, i) => {
				if (m.role === "user") {
					const text = userText(m);
					const editing = editingAt === i && !streaming;
					return (
						<div key={i} className="group/msg animate-rise">
							<div className="flex justify-end">
								{editing ? <UserEditor index={i} initial={text} onClose={() => setEditingAt(null)} /> : <UserBubble text={text} images={userImages(m)} />}
							</div>
							{!editing && <Actions index={i} text={text} canRetry={!streaming} align="end" onEdit={() => setEditingAt(i)} />}
						</div>
					);
				}
				if (m.role === "assistant") {
					// Each tool round is its own assistant message; render a whole turn as one block.
					const prev = messages.slice(0, i).findLast((p) => p.role !== "toolResult");
					if (prev?.role === "assistant") return null;
					const group: { message: AssistantMessage; index: number }[] = [];
					for (let j = i; j < messages.length; j++) {
						const g = messages[j];
						if (g?.role === "assistant") group.push({ message: g, index: j });
						else if (g?.role !== "toolResult") break;
					}
					const lastInGroup = group[group.length - 1]?.index ?? i;
					// Tool results after the last assistant message mean the next model call is still pending.
					const awaitingNext = lastInGroup < lastIndex && messages.slice(lastInGroup + 1).every((x) => x.role === "toolResult");
					const live = streaming && (lastInGroup === lastIndex || awaitingNext);
					return (
						<div key={i} className="group/msg flex gap-3">
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
						<div key={i} className="flex items-center gap-3 text-xs text-ink-500">
							<span className="h-px flex-1 bg-ink-800" /> {t("compacted")} <span className="h-px flex-1 bg-ink-800" />
						</div>
					);
				}
				return null;
			})}
			{pending && (
				// Same key as the real message will get, so the bubble is reused instead of replayed when the server echoes it.
				<div key={messages.length} className="group/msg animate-rise">
					<div className="flex justify-end">
						<UserBubble text={pending.text} images={pending.images ?? []} />
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
