import clsx from "clsx";
import { ArrowUp, Brain, Check, ChevronDown, Cpu, Search, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ThinkingLevel } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { abortRun, openSettings, sendPrompt, setModel, setThinking, toast, useStore } from "../lib/store.ts";
import { ContextMeter } from "./ContextMeter.tsx";
import { usePopover } from "./TitleBar.tsx";
import { WorkspacePicker } from "./WorkspacePicker.tsx";

const M = defineMessages({
	zh: {
		placeholder: "向 Agent 下达任务，输入 / 查看命令",
		placeholderStreaming: "继续输入以插队或排队…  (Esc 中断)",
		steer: "插队",
		followUp: "排队",
		steerHint: "在当前工具调用结束后立即插入",
		followUpHint: "等本轮结束后再发送",
		queued: "排队中 · {q}",
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
	},
	en: {
		placeholder: "Give the agent a task, type / for commands",
		placeholderStreaming: "Keep typing to steer or queue…  (Esc to stop)",
		steer: "Steer",
		followUp: "Queue",
		steerHint: "Insert right after the current tool call",
		followUpHint: "Send after this turn ends",
		queued: "Queued · {q}",
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
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className={clsx(
					"flex max-w-60 items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors",
					current ? "text-ink-300 hover:bg-ink-800 hover:text-ink-100" : "bg-ember-500/10 text-ember-300 hover:bg-ember-500/15",
				)}
				title={current ? `${current.provider}/${current.id}` : undefined}
			>
				<Cpu className="size-3.5 shrink-0" />
				<span className="truncate">{label}</span>
				<ChevronDown className="size-3 shrink-0 opacity-60" />
			</button>
			{open && (
				<div className="absolute bottom-full left-0 z-40 mb-2 w-80 animate-rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="flex items-center gap-2 border-b border-ink-800 px-3">
						<Search className="size-3.5 text-ink-500" />
						<input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchModel")} className="w-full bg-transparent py-2.5 text-sm focus:outline-none" />
					</div>
					<div className="max-h-80 overflow-y-auto py-1">
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
		<div ref={ref} className="relative">
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
				<div className="absolute bottom-full left-0 z-40 mb-2 w-80 animate-rise rounded-xl border border-ink-700 bg-ink-900/97 px-4 pt-3.5 pb-3 shadow-2xl shadow-black/40 backdrop-blur">
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
	const [delivery, setDelivery] = useState<"steer" | "followUp">("followUp");
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
		if (!value) return;
		if (!session) {
			toast(t("needWorkspace"), "warning");
			return;
		}
		setText("");
		const ok = await sendPrompt(value, streaming ? delivery : undefined);
		if (!ok) setText(value);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

	const queued = [...(session?.queue.steering ?? []), ...(session?.queue.followUp ?? [])];

	return (
		<div className="relative mx-auto w-full max-w-3xl px-5 pb-5">
			{matches.length > 0 && (
				<div className="absolute right-5 bottom-full left-5 z-30 mb-2 overflow-hidden rounded-xl border border-ink-700 bg-ink-900/95 shadow-2xl shadow-black/40 backdrop-blur">
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
				<div className="mb-2 flex flex-wrap gap-1.5">
					{queued.map((q, i) => (
						<span key={i} className="max-w-xs truncate rounded-full border border-ink-700 bg-ink-900 px-2.5 py-1 text-xs text-ink-400">
							{t("queued", { q })}
						</span>
					))}
				</div>
			)}

			<div
				className={clsx(
					"rounded-2xl border bg-ink-900/85 shadow-[0_10px_40px_-12px_rgb(0_0_0/0.45)] backdrop-blur transition-colors",
					streaming ? "border-ember-500/35" : "border-ink-700 focus-within:border-ink-500",
				)}
			>
				<textarea
					ref={ref}
					autoFocus
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={onKeyDown}
					rows={1}
					placeholder={streaming ? t("placeholderStreaming") : t("placeholder")}
					className="block max-h-64 w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] text-ink-100 placeholder:text-ink-500 focus:outline-none"
				/>
				<div className="flex items-center gap-1 px-2 pb-2">
					{newChat && <WorkspacePicker />}
					<ModelPicker />
					<EffortPicker />
					<div className="flex-1" />
					<ContextMeter />
					{streaming && (
						<div className="mr-1 flex rounded-lg bg-ink-950 p-0.5 text-xs">
							{(["steer", "followUp"] as const).map((d) => (
								<button
									key={d}
									type="button"
									onClick={() => setDelivery(d)}
									className={clsx("rounded-md px-2 py-1 transition-colors", delivery === d ? "bg-ink-800 text-ink-100" : "text-ink-500 hover:text-ink-300")}
									title={d === "steer" ? t("steerHint") : t("followUpHint")}
								>
									{t(d)}
								</button>
							))}
						</div>
					)}
					{streaming && (
						<button type="button" onClick={() => void abortRun()} className="grid size-8 place-items-center rounded-lg bg-ink-800 text-ink-200 hover:bg-ink-700" aria-label={t("abort")}>
							<Square className="size-3.5 fill-current" />
						</button>
					)}
					<button
						type="button"
						onClick={() => void submit()}
						disabled={!text.trim() || !session}
						title={session ? undefined : t("needWorkspace")}
						className="grid size-8 place-items-center rounded-lg bg-ember-500 text-white transition hover:bg-ember-400 disabled:bg-ink-800 disabled:text-ink-600"
						aria-label={t("send")}
					>
						<ArrowUp className="size-4" strokeWidth={2.5} />
					</button>
				</div>
			</div>
		</div>
	);
}
