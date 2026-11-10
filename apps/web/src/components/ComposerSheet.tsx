import clsx from "clsx";
import { ArrowUp, Eraser, Minimize2, Paperclip, PenLine, X } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { defineMessages, useT } from "../lib/i18n.ts";

const M = defineMessages({
	zh: {
		title: "撰写消息",
		subtitle: "适合长文本、粘贴大段内容或整理需求",
		close: "收起",
		clear: "清空",
		attach: "添加图片或文件",
		send: "发送",
		chars: "{n} 字",
		lines: "{n} 行",
		dropHere: "松开即可添加文件或图片",
		hintEnter: "Enter 发送 · Shift+Enter 换行",
		hintMod: "{mod}+Enter 发送 · Esc 收起",
		hintEsc: "Esc 收起",
	},
	en: {
		title: "Compose message",
		subtitle: "For long prompts, pasted content and detailed requirements",
		close: "Collapse",
		clear: "Clear",
		attach: "Add images or files",
		send: "Send",
		chars: "{n} chars",
		lines: "{n} lines",
		dropHere: "Drop to add files or images",
		hintEnter: "Enter to send · Shift+Enter for newline",
		hintMod: "{mod}+Enter to send · Esc to close",
		hintEsc: "Esc to close",
	},
});

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** Whether the send chord for the sheet is held: Ctrl/Cmd+Enter always sends here, whatever the Enter preference. */
export function isSheetSendChord(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">): boolean {
	return e.key === "Enter" && (e.ctrlKey || e.metaKey);
}

export interface ComposerSheetProps {
	value: string;
	onChange: (value: string, caret: number) => void;
	onCaret: (caret: number) => void;
	onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
	onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	placeholder: string;
	/** Shared attachment strip, rendered by the owner because the state lives there. */
	attachments?: ReactNode;
	/** @file / slash suggestions, shown under the editor. */
	suggestions?: ReactNode;
	/** Pickers (model, effort, permission, mode...) so the sheet is not a downgrade from the inline box. */
	toolbar?: ReactNode;
	/** Extra tool buttons next to the attach button, e.g. dictation. */
	tools?: ReactNode;
	onFiles: (files: File[]) => void;
	enterToSend: boolean;
	canSend: boolean;
	sendIcon?: ReactNode;
	sendTitle?: string;
	streaming: boolean;
	onSend: () => void;
	onClose: () => void;
	viewport: { top: number; height: number };
}

/**
 * The expanded editor: a centred card on desktop, a full-height sheet on phones. It owns only presentation (layout,
 * drag-and-drop highlight, counters, backdrop); the draft, the suggestions and every action stay with the composer so
 * the inline box and this one can never disagree.
 */
export function ComposerSheet(p: ComposerSheetProps) {
	const t = useT(M);
	const [dragging, setDragging] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);

	// Land on the end of the draft rather than the start, so continuing to type is one keystroke away.
	useEffect(() => {
		const el = p.textareaRef.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const lines = p.value ? p.value.split("\n").length : 0;
	const mod = IS_MAC ? "⌘" : "Ctrl";
	const hint = p.enterToSend ? t("hintEnter") : t("hintMod", { mod });

	return createPortal(
		<div
			className="fixed right-0 left-0 z-[55] flex bg-ink-950 md:items-center md:justify-center md:bg-black/55 md:p-8 md:backdrop-blur-sm"
			style={{ top: p.viewport.top, height: p.viewport.height, paddingTop: "var(--safe-top)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
			onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t("title")}
				className={clsx(
					"relative flex min-h-0 w-full flex-col overflow-hidden bg-ink-950",
					"md:h-full md:max-h-[820px] md:max-w-4xl md:rounded-2xl md:border md:shadow-2xl md:shadow-black/60",
					dragging ? "md:border-ember-400" : "md:border-ink-700",
				)}
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
					p.onFiles([...e.dataTransfer.files]);
				}}
			>
				{/* Header */}
				<div className="flex items-center gap-3 border-b border-ink-800 px-4 py-3 md:px-5">
					<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-ember-500/25 to-ember-500/5 text-ember-300 ring-1 ring-ember-500/20">
						<PenLine className="size-4" />
					</span>
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm font-semibold text-ink-100">{t("title")}</div>
						<div className="hidden truncate text-xs text-ink-500 sm:block">{t("subtitle")}</div>
					</div>
					<button
						type="button"
						onClick={() => p.onChange("", 0)}
						disabled={!p.value}
						className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100 disabled:pointer-events-none disabled:opacity-30"
						title={t("clear")}
					>
						<Eraser className="size-3.5" />
						<span className="hidden sm:inline">{t("clear")}</span>
					</button>
					<button type="button" onClick={p.onClose} className="grid size-8 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100" title={t("close")} aria-label={t("close")}>
						<X className="size-4" />
					</button>
				</div>

				{p.attachments && <div className="shrink-0 border-b border-ink-800 bg-ink-900/30">{p.attachments}</div>}

				{/* Editor */}
				<div className="relative flex min-h-0 flex-1 flex-col">
					<textarea
						ref={p.textareaRef}
						value={p.value}
						onChange={(e) => p.onChange(e.target.value, e.target.selectionStart)}
						onSelect={(e) => p.onCaret(e.currentTarget.selectionStart)}
						onKeyDown={p.onKeyDown}
						onPaste={p.onPaste}
						placeholder={p.placeholder}
						spellCheck={false}
						className="min-h-0 w-full flex-1 resize-none bg-transparent px-5 py-4 text-[15px] leading-7 text-ink-100 placeholder:text-ink-500 focus:outline-none md:px-6 md:py-5"
					/>
					{p.suggestions}
					{dragging && (
						<div className="pointer-events-none absolute inset-3 grid place-items-center rounded-xl border-2 border-dashed border-ember-400/70 bg-ink-950/80 text-sm text-ember-300 backdrop-blur-[2px]">
							<span className="inline-flex items-center gap-2">
								<Paperclip className="size-4" />
								{t("dropHere")}
							</span>
						</div>
					)}
				</div>

				{/* Options: the same pickers as the inline box */}
				<div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-ink-800 px-3 py-1.5 md:px-4">
					<label className="relative grid size-8 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-lg text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100" title={t("attach")} aria-label={t("attach")}>
						<input
							ref={fileInput}
							type="file"
							multiple
							className="absolute -inset-8 cursor-pointer opacity-0"
							style={{ fontSize: 64 }}
							onChange={(e) => {
								const list = [...(e.target.files ?? [])];
								p.onFiles(list);
								e.target.value = "";
							}}
						/>
						<Paperclip className="pointer-events-none size-4" />
					</label>
					{p.tools}
					{p.toolbar}
				</div>

				{/* Footer */}
				<div className="flex items-center gap-3 border-t border-ink-800 bg-ink-900/40 px-4 py-3 md:px-5">
					<div className="flex min-w-0 flex-1 items-center gap-x-3 text-xs text-ink-500">
						<span className="shrink-0 tabular-nums">{t("chars", { n: p.value.length })}</span>
						<span className="hidden shrink-0 tabular-nums sm:inline">{t("lines", { n: lines })}</span>
						<span className="hidden min-w-0 truncate md:inline">{p.streaming ? t("hintEsc") : hint}</span>
					</div>
					<button type="button" onClick={p.onClose} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-ink-300 transition-colors hover:bg-ink-800">
						<Minimize2 className="size-3.5" />
						{t("close")}
					</button>
					<button
						type="button"
						onClick={p.onSend}
						disabled={!p.canSend}
						title={p.sendTitle}
						className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ember-500 px-4 text-sm font-medium text-white shadow-sm shadow-ember-500/20 transition hover:bg-ember-400 disabled:bg-ink-800 disabled:text-ink-600 disabled:shadow-none"
					>
						{p.sendIcon ?? <ArrowUp className="size-4" strokeWidth={2.5} />}
						{t("send")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
