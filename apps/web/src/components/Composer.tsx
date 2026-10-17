import clsx from "clsx";
import { ArrowUp, Brain, Check, ChevronDown, CornerDownRight, Cpu, ListEnd, Paperclip, Search, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ImageContent, ThinkingLevel } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { fileToImage, IMAGE_ACCEPT, ImageError, imageSrc, isImageFile, MAX_IMAGES } from "../lib/images.ts";
import { type SendMode, setPrefs, usePrefs } from "../lib/prefs.ts";
import { abortRun, openSettings, sendPrompt, setModel, setPermissionMode, setThinking, toast, useStore } from "../lib/store.ts";
import { ContextMeter } from "./ContextMeter.tsx";
import { nextPermissionMode, PermissionPicker } from "./PermissionPicker.tsx";
import { VoiceButton } from "./VoiceButton.tsx";
import { usePopover } from "./TitleBar.tsx";
import { WorkspacePicker } from "./WorkspacePicker.tsx";

const M = defineMessages({
	zh: {
		placeholder: "向 Agent 下达任务，输入 / 查看命令",
		placeholderStreaming: "回复中… 按“{mode}”发送  (Esc 中断)",
		steer: "插队",
		followUp: "排队",
		steerHint: "在当前工具调用结束后立即插入",
		followUpHint: "等本轮结束后再发送",
		sendMode: "回复中发送时",
		sendModeTitle: "回复中发送：{mode}（点击更改）",
		sendAs: "发送（{mode}）",
		queued: "排队中 · {q}",
		steered: "插队中 · {q}",
		abort: "中断",
		send: "发送",
		needWorkspace: "请先选择工作区",
		pickModel: "选择模型",
		searchModel: "搜索模型…",
		noModels: "没有可用模型",
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
		attach: "添加图片",
		removeImage: "移除图片",
		tooMany: "一条消息最多 {n} 张图片",
		badType: "只支持 PNG、JPEG、GIF、WebP 图片",
		tooBig: "图片超过 25 MB，请压缩后再试",
		badImage: "无法读取这张图片",
		noVision: "当前模型不支持图片，图片可能被忽略或报错，请换用带“视觉”标记的模型",
		dropHere: "松开即可添加图片",
	},
	en: {
		placeholder: "Give the agent a task, type / for commands",
		placeholderStreaming: "Replying… sends as \"{mode}\"  (Esc to stop)",
		steer: "Steer",
		followUp: "Queue",
		steerHint: "Insert right after the current tool call",
		followUpHint: "Send after this turn ends",
		sendMode: "When sending during a reply",
		sendModeTitle: "Sending during a reply: {mode} (click to change)",
		sendAs: "Send ({mode})",
		queued: "Queued · {q}",
		steered: "Steering · {q}",
		abort: "Stop",
		send: "Send",
		needWorkspace: "Choose a workspace first",
		pickModel: "Choose model",
		searchModel: "Search models…",
		noModels: "No models available",
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
		attach: "Add images",
		removeImage: "Remove image",
		tooMany: "At most {n} images per message",
		badType: "Only PNG, JPEG, GIF and WebP images are supported",
		tooBig: "That image is over 25 MB; shrink it and try again",
		badImage: "Could not read that image",
		noVision: "This model does not accept images, so they may be ignored or rejected. Pick a model marked \"vision\"",
		dropHere: "Drop to add images",
	},
});

function ModelPicker() {
	const t = useT(M);
	const models = useStore((s) => s.models);
	const current = useStore((s) => s.session?.model ?? s.draftModel);
	const { open, setOpen, ref } = usePopover();
	const [q, setQ] = useState("");
	const groups = useMemo(() => {
		const filtered = models.filter((m) => `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(q.toLowerCase()));
		const map = new Map<string, typeof models>();
		for (const m of filtered) map.set(m.provider, [...(map.get(m.provider) ?? []), m]);
		return [...map.entries()];
	}, [models, q]);
	const info = current && models.find((m) => m.provider === current.provider && m.id === current.id);
	const label = current ? (info?.name ?? current.id) : t("pickModel");

	return (
		<div ref={ref} className="min-w-0 max-w-full overflow-hidden md:relative md:max-w-60">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className={clsx(
					"flex w-full min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors",
					current ? "text-ink-300 hover:bg-ink-800 hover:text-ink-100" : "bg-ember-500/10 text-ember-300 hover:bg-ember-500/15",
				)}
				title={current ? `${current.provider}/${current.id}` : undefined}
			>
				<Cpu className="size-3.5 shrink-0" />
				<span className="min-w-0 truncate">{label}</span>
				<ChevronDown className="size-3 shrink-0 opacity-60" />
			</button>
			{open && (
				<div className="absolute bottom-full left-3 right-3 z-40 mb-2 md:left-0 md:right-auto md:w-80 animate-rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur">
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
								<div className="px-3.5 pt-2.5 pb-1 font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">{provider}</div>
								{list.map((m) => {
									const active = current?.provider === m.provider && current.id === m.id;
									return (
										<button
											key={m.id}
											type="button"
											onClick={() => {
												setOpen(false);
												void setModel({ provider: m.provider, id: m.id });
											}}
											className={clsx("flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-sm", active ? "bg-ember-500/10 text-ember-200" : "text-ink-200 hover:bg-ink-800")}
										>
											<span className="w-3.5 shrink-0">{active && <Check className="size-3.5" />}</span>
											<span className="min-w-0 flex-1 truncate">{m.name}</span>
											{m.reasoning && <span className="font-mono text-[10px] text-sky-400">{t("thinking")}</span>}
											{m.vision && <span className="font-mono text-[10px] text-moss-400">{t("vision")}</span>}
											<span className="font-mono text-[10px] text-ink-600">{Math.round(m.contextWindow / 1000)}k</span>
										</button>
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
				<span>{t(level)}</span>
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

export function Composer({ newChat = false }: { newChat?: boolean }) {
	const t = useT(M);
	const session = useStore((s) => s.session);
	const commands = useStore((s) => s.commands);
	const editorText = useStore((s) => s.editorText);
	const [text, setText] = useState("");
	const [images, setImages] = useState<ImageContent[]>([]);
	const [reading, setReading] = useState(0);
	const [dragging, setDragging] = useState(false);
	const files = useRef<HTMLInputElement>(null);
	const models = useStore((s) => s.models);
	const model = useStore((s) => s.session?.model ?? s.draftModel);
	const sendMode = usePrefs((p) => p.sendMode);
	const [cursor, setCursor] = useState(0);
	const ref = useRef<HTMLTextAreaElement>(null);
	const streaming = session?.isStreaming ?? false;

	useEffect(() => {
		if (editorText) {
			setText(editorText.text);
			ref.current?.focus();
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

	const submit = async () => {
		const value = text.trim();
		if ((!value && !images.length) || reading > 0) return;
		if (!session) {
			toast(t("needWorkspace"), "warning");
			return;
		}
		const attached = images;
		setText("");
		setImages([]);
		const ok = await sendPrompt(value, streaming ? sendMode : undefined, attached);
		if (!ok) {
			setText(value);
			setImages(attached);
		}
	};

	/** Add picked, pasted or dropped files; anything that is not a usable image is reported, the rest still go in. */
	const addFiles = async (list: File[]) => {
		const picked = list.filter((f) => f.type.startsWith("image/") || f.type === "");
		if (!picked.length) return;
		const room = MAX_IMAGES - images.length - reading;
		if (picked.length > room) toast(t("tooMany", { n: MAX_IMAGES }), "warning");
		const take = picked.slice(0, Math.max(room, 0));
		setReading((n) => n + take.length);
		for (const file of take) {
			try {
				if (!isImageFile(file)) throw new ImageError("type");
				const image = await fileToImage(file);
				setImages((cur) => (cur.length < MAX_IMAGES ? [...cur, image] : cur));
			} catch (err) {
				const reason = err instanceof ImageError ? err.reason : "decode";
				toast(t(reason === "type" ? "badType" : reason === "size" ? "tooBig" : "badImage"), "error");
			} finally {
				setReading((n) => n - 1);
			}
		}
	};

	const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const pasted = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
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
		if (matches.length) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				setCursor((c) => (c + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
				return;
			}
			if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
				const pick = matches[cursor];
				if (pick && `/${pick.name}` !== text) {
					e.preventDefault();
					setText(`/${pick.name} `);
					return;
				}
			}
		}
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void submit();
		}
		if (e.key === "Escape" && streaming) {
			e.preventDefault();
			void abortRun();
		}
	};

	const queued = [
		...(session?.queue.steering ?? []).map((q) => ({ q, steer: true })),
		...(session?.queue.followUp ?? []).map((q) => ({ q, steer: false })),
	];

	// Dictation lands where the cursor was, spaced from what is already typed.
	const insertDictation = (spoken: string) => {
		const el = ref.current;
		setText((current) => {
			const at = Math.min(el?.selectionStart ?? current.length, current.length);
			const before = current.slice(0, at);
			const glue = before && !/\s$/.test(before) && !/^[\u3000-\u9fff\uff00-\uffef]/.test(spoken) ? " " : "";
			return `${before}${glue}${spoken}${current.slice(at)}`;
		});
		el?.focus();
	};

	return (
		<div
			className="relative mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-5 md:pb-5"
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
			{matches.length > 0 && (
				<div className="absolute right-3 bottom-full left-3 z-30 md:right-5 md:left-5 mb-2 overflow-hidden rounded-xl border border-ink-700 bg-ink-900/95 shadow-2xl shadow-black/40 backdrop-blur">
					{matches.map((c, i) => (
						<button
							key={`${c.source}:${c.name}`}
							type="button"
							onMouseDown={(e) => {
								e.preventDefault();
								setText(`/${c.name} `);
								ref.current?.focus();
							}}
							className={clsx("flex w-full items-baseline gap-3 px-3.5 py-2 text-left", i === cursor ? "bg-ink-800" : "hover:bg-ink-850")}
						>
							<span className="font-mono text-sm text-ember-300">/{c.name}</span>
							<span className="min-w-0 flex-1 truncate text-xs text-ink-400">{c.description}</span>
							<span className="font-mono text-[10px] text-ink-600 uppercase">{c.source}</span>
						</button>
					))}
				</div>
			)}

			{queued.length > 0 && (
				<div className="mb-2 flex flex-col gap-1 px-1">
					{queued.map(({ q, steer }, i) => (
						<div key={i} className="flex min-w-0 items-center gap-1.5 text-xs text-ink-400" title={q}>
							{steer ? <CornerDownRight className="size-3 shrink-0 text-ember-300" /> : <ListEnd className="size-3 shrink-0 text-ink-500" />}
							<span className="truncate">{t(steer ? "steered" : "queued", { q })}</span>
						</div>
					))}
				</div>
			)}

			{newChat && (
				<div className="mb-2 px-1">
					<WorkspacePicker />
				</div>
			)}

			<div
				className={clsx(
					"rounded-2xl border bg-ink-900/85 shadow-[0_10px_40px_-12px_rgb(0_0_0/0.45)] backdrop-blur transition-colors",
					streaming ? "border-ember-500/35" : "border-ink-700 focus-within:border-ink-500",
					dragging && "border-ember-400 ring-2 ring-ember-500/30",
				)}
			>
				{dragging && <div className="px-4 pt-3 text-xs text-ember-300">{t("dropHere")}</div>}
				{(images.length > 0 || reading > 0) && (
					<div className="flex flex-wrap gap-2 px-3 pt-3">
						{images.map((img, i) => (
							<div key={i} className="group/thumb relative size-16 overflow-hidden rounded-lg border border-ink-700 bg-ink-950">
								<img src={imageSrc(img)} alt="" className="size-full object-cover" />
								<button
									type="button"
									onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
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
				)}
				{lacksVision && <div className="px-4 pt-2 text-[11px] text-ember-300">{t("noVision")}</div>}
				<textarea
					ref={ref}
					autoFocus
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					rows={1}
					placeholder={streaming ? t("placeholderStreaming", { mode: t(sendMode) }) : t("placeholder")}
					className="block max-h-64 w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] text-ink-100 placeholder:text-ink-500 focus:outline-none"
				/>
				<div className="flex items-center gap-1 px-2 pb-2">
					<input
						ref={files}
						type="file"
						accept={IMAGE_ACCEPT}
						multiple
						hidden
						onChange={(e) => {
							void addFiles([...(e.target.files ?? [])]);
							e.target.value = "";
						}}
					/>
					<button
						type="button"
						onClick={() => files.current?.click()}
						disabled={images.length + reading >= MAX_IMAGES}
						className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100 disabled:opacity-40"
						title={t("attach")}
						aria-label={t("attach")}
					>
						<Paperclip className="size-4" />
					</button>
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
								disabled={(!text.trim() && images.length === 0) || reading > 0 || !session}
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
				<div className="flex items-center gap-1 border-t border-ink-800/70 px-2 py-1">
					<PermissionPicker />
					<div className="flex-1" />
					<ContextMeter />
				</div>
			</div>
		</div>
	);
}
