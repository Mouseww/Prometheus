import clsx from "clsx";
import { Bot, Brain, Check, ChevronDown, ChevronRight, CircleAlert, Clock, ListTree, LoaderCircle, Square, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { sortSubagents, type SubagentDetail, type SubagentRun, type SubagentState, type SubagentStep } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { closeSubagentRegion, NO_SUBAGENTS, openSubagentList, selectSubagent, setSubagentSort, type SubagentSort, stopSubagent, useStore } from "../lib/store.ts";
import { Markdown } from "./Markdown.tsx";

const M = defineMessages({
	zh: {
		title: "子代理",
		running: "{n} 个运行中",
		sortBy: "排序",
		sortStatus: "状态",
		sortStarted: "开始时间",
		sortEnded: "完成时间",
		stop: "停止该子代理",
		stopping: "正在停止…",
		close: "关闭",
		showList: "显示子代理列表",
		empty: "当前对话还没有子代理",
		pick: "点击上方列表中的子代理，查看它的执行过程",
		process: "执行过程",
		task: "任务",
		output: "最终结果",
		noSteps: "暂无记录",
		loading: "加载中…",
		partial: "运行中只显示最近的工具调用，结束后可查看完整过程",
		background: "后台",
		tools: "{n} 次工具",
		args: "参数",
		result: "结果",
		queued: "排队中",
		runningState: "运行中",
		completed: "已完成",
		failed: "失败",
		stopped: "已停止",
	},
	en: {
		title: "Subagents",
		running: "{n} running",
		sortBy: "Sort",
		sortStatus: "Status",
		sortStarted: "Started",
		sortEnded: "Finished",
		stop: "Stop this subagent",
		stopping: "Stopping…",
		close: "Close",
		showList: "Show subagent list",
		empty: "No subagents in this chat yet",
		pick: "Pick a subagent above to see what it is doing",
		process: "Process",
		task: "Task",
		output: "Final report",
		noSteps: "Nothing recorded yet",
		loading: "Loading…",
		partial: "Only recent tool calls show while it runs; the full process is available once it finishes",
		background: "Background",
		tools: "{n} tool calls",
		args: "Arguments",
		result: "Result",
		queued: "Queued",
		runningState: "Running",
		completed: "Completed",
		failed: "Failed",
		stopped: "Stopped",
	},
});

export const isLive = (r: Pick<SubagentRun, "state">) => r.state === "running" || r.state === "queued";

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

export function StateIcon({ state, className }: { state: SubagentState; className?: string }) {
	const box = clsx("grid size-5 shrink-0 place-items-center rounded-md", className);
	switch (state) {
		case "running":
			return (
				<span className={clsx(box, "bg-ember-500/15 text-ember-300")}>
					<LoaderCircle className="size-3 animate-spin" />
				</span>
			);
		case "queued":
			return (
				<span className={clsx(box, "bg-ink-800 text-ink-400")}>
					<Clock className="size-3" />
				</span>
			);
		case "completed":
			return (
				<span className={clsx(box, "bg-moss-400/12 text-moss-400")}>
					<Check className="size-3" strokeWidth={3} />
				</span>
			);
		case "failed":
			return (
				<span className={clsx(box, "bg-rose-400/12 text-rose-400")}>
					<CircleAlert className="size-3" />
				</span>
			);
		case "stopped":
			return (
				<span className={clsx(box, "bg-ink-800 text-ink-400")}>
					<Square className="size-2.5 fill-current" />
				</span>
			);
	}
}

function useStateLabel() {
	const t = useT(M);
	return (s: SubagentState) => t(s === "running" ? "runningState" : s);
}

function RegionHeader({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
	const t = useT(M);
	return (
		<div className="flex h-9 shrink-0 items-center gap-2 border-b hairline px-3">
			{children}
			<button type="button" onClick={onClose} className="ml-auto rounded-md p-1 text-ink-500 hover:bg-ink-800 hover:text-ink-100" title={t("close")} aria-label={t("close")}>
				<X className="size-3.5" />
			</button>
		</div>
	);
}

function Row({ run, selected, now }: { run: SubagentRun; selected: boolean; now: number }) {
	const t = useT(M);
	const label = useStateLabel();
	const [stopping, setStopping] = useState(false);
	const elapsed = formatElapsed((run.endedAt ?? now) - run.startedAt);
	const stats = [run.toolCount ? t("tools", { n: run.toolCount }) : "", run.tokens ? `${formatTokens(run.tokens)} tok` : ""].filter(Boolean).join(" · ");
	return (
		<li className={clsx("group flex items-stretch border-b hairline last:border-b-0", selected ? "bg-ember-500/8" : "hover:bg-ink-850")}>
			<button type="button" onClick={() => selectSubagent(run.id)} className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left" aria-current={selected}>
				<StateIcon state={run.state} className="mt-0.5" />
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-2">
						<span className="truncate font-mono text-[13px] font-medium text-ink-100">{run.agent}</span>
						{run.background && <span className="shrink-0 rounded bg-sky-400/12 px-1.5 py-px text-[10px] text-sky-400">{t("background")}</span>}
						<span className="ml-auto shrink-0 font-mono text-[11px] text-ink-500 tabular-nums">{elapsed}</span>
					</span>
					<span className="mt-0.5 line-clamp-2 text-xs break-words text-ink-400">{run.task || "—"}</span>
					<span className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-ink-500">
						<span className={clsx(run.state === "failed" && "text-rose-400", run.state === "running" && "text-ember-300")}>{label(run.state)}</span>
						{run.state === "running" && run.currentTool && <span className="truncate font-mono text-ink-400">· {run.currentTool}</span>}
						{stats && <span className="truncate">· {stats}</span>}
					</span>
					{run.error && run.state !== "completed" && <span className="mt-1 line-clamp-2 block text-[11px] text-rose-400/90">{run.error}</span>}
				</span>
			</button>
			{run.stoppable && (
				<button
					type="button"
					disabled={stopping}
					onClick={() => {
						setStopping(true);
						void stopSubagent(run.id).finally(() => setStopping(false));
					}}
					className="my-2 mr-2 grid size-7 shrink-0 place-items-center self-start rounded-md text-ink-400 transition-colors hover:bg-rose-400/12 hover:text-rose-400 disabled:opacity-50"
					title={stopping ? t("stopping") : t("stop")}
					aria-label={t("stop")}
				>
					{stopping ? <LoaderCircle className="size-3.5 animate-spin" /> : <Square className="size-3.5 fill-current" />}
				</button>
			)}
		</li>
	);
}

function ListRegion({ runs, selected }: { runs: SubagentRun[]; selected: string | null }) {
	const t = useT(M);
	const sort = useStore((s) => s.subagentUi.sort);
	const live = runs.filter(isLive).length;
	const now = useNow(live > 0);
	const sorted = useMemo(() => sortSubagents(runs, sort), [runs, sort]);
	const options: { id: SubagentSort; label: string }[] = [
		{ id: "status", label: t("sortStatus") },
		{ id: "started", label: t("sortStarted") },
		{ id: "ended", label: t("sortEnded") },
	];
	return (
		<>
			<RegionHeader onClose={() => closeSubagentRegion("list")}>
				<Bot className="size-3.5 text-ember-400" />
				<span className="text-xs font-medium text-ink-200">{t("title")}</span>
				{live > 0 && <span className="font-mono text-[11px] text-ember-300">{t("running", { n: live })}</span>}
			</RegionHeader>
			<div className="flex shrink-0 items-center gap-1 border-b hairline px-3 py-1.5" role="radiogroup" aria-label={t("sortBy")}>
				<span className="mr-1 text-[11px] text-ink-500">{t("sortBy")}</span>
				{options.map((o) => (
					<button
						key={o.id}
						type="button"
						role="radio"
						aria-checked={sort === o.id}
						onClick={() => setSubagentSort(o.id)}
						className={clsx("rounded-md px-2 py-0.5 text-[11px] transition-colors", sort === o.id ? "bg-ember-500/15 text-ember-300" : "text-ink-400 hover:bg-ink-800 hover:text-ink-100")}
					>
						{o.label}
					</button>
				))}
			</div>
			{sorted.length === 0 ? (
				<div className="grid flex-1 place-items-center px-6 text-center text-xs text-ink-500">{t("empty")}</div>
			) : (
				<ul className="min-h-0 flex-1 overflow-y-auto">
					{sorted.map((r) => (
						<Row key={r.id} run={r} selected={r.id === selected} now={now} />
					))}
				</ul>
			)}
		</>
	);
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function StepView({ step }: { step: SubagentStep }) {
	const t = useT(M);
	const [open, setOpen] = useState(false);
	if (step.kind === "text") {
		return (
			<div className="text-[13px] leading-relaxed text-ink-200">
				<Markdown text={step.text} />
			</div>
		);
	}
	if (step.kind === "thinking") {
		return (
			<button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 text-left text-xs text-ink-500 hover:text-ink-300">
				<Brain className="mt-0.5 size-3.5 shrink-0" />
				<span className={clsx("min-w-0 flex-1 italic whitespace-pre-wrap", !open && "line-clamp-2")}>{step.text}</span>
			</button>
		);
	}
	const hasMore = Boolean(step.args || step.result);
	return (
		<div className={clsx("overflow-hidden rounded-lg border bg-ink-950/50", step.isError ? "border-rose-400/25" : "border-ink-800")}>
			<button type="button" onClick={() => hasMore && setOpen(!open)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" disabled={!hasMore}>
				<Wrench className={clsx("size-3 shrink-0", step.isError ? "text-rose-400" : "text-ink-500")} />
				<span className="shrink-0 font-mono text-[12px] font-medium text-ink-200">{step.tool}</span>
				<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-500">{oneLine(step.args ?? "")}</span>
				{hasMore && (open ? <ChevronDown className="size-3 shrink-0 text-ink-500" /> : <ChevronRight className="size-3 shrink-0 text-ink-500" />)}
			</button>
			{open && (
				<div className="space-y-1.5 border-t border-ink-800 px-2.5 py-2">
					{step.args && (
						<div>
							<div className="mb-0.5 text-[10px] tracking-wide text-ink-600 uppercase">{t("args")}</div>
							<pre className="max-h-32 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-ink-400">{step.args}</pre>
						</div>
					)}
					{step.result && (
						<div>
							<div className="mb-0.5 text-[10px] tracking-wide text-ink-600 uppercase">{t("result")}</div>
							<pre className={clsx("max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap", step.isError ? "text-rose-400" : "text-ink-300")}>{step.result}</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function DetailBody({ run }: { run: SubagentRun }) {
	const t = useT(M);
	const sessionId = useStore((s) => s.session?.id);
	const [detail, setDetail] = useState<SubagentDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const live = isLive(run);
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);

	// Reload on every visible change; keep polling while it runs so the process stays current.
	useEffect(() => {
		let dead = false;
		const load = async () => {
			const client = useStore.getState().client;
			if (!client || !sessionId) return;
			try {
				const next = await client.rpc("subagent.detail", { sessionId, id: run.id });
				if (dead) return;
				setDetail(next);
				setError(null);
			} catch (err) {
				if (!dead) setError(err instanceof Error ? err.message : String(err));
			}
		};
		void load();
		if (!live) return () => void (dead = true);
		const timer = setInterval(() => void load(), 2500);
		return () => {
			dead = true;
			clearInterval(timer);
		};
	}, [sessionId, run.id, run.state, run.toolCount, live]);

	useEffect(() => {
		// Follow the tail only while it is still writing; a finished run reads from the top.
		const el = scroller.current;
		if (el && live && pinned.current) el.scrollTop = el.scrollHeight;
	}, [detail, live]);

	const steps = detail?.steps ?? [];
	// The child's last message already is its report; show the saved report only when the process has no text.
	const showOutput = Boolean(detail?.output) && !live && !steps.some((s) => s.kind === "text");
	return (
		<div
			ref={scroller}
			onScroll={(e) => {
				const el = e.currentTarget;
				pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
			}}
			className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
		>
			<section>
				<div className="mb-1 text-[10px] tracking-wide text-ink-600 uppercase">{t("task")}</div>
				<p className="max-h-28 overflow-y-auto text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-300">{detail?.task || run.task || "—"}</p>
			</section>
			<section className="space-y-2">
				<div className="flex items-center gap-2">
					<span className="text-[10px] tracking-wide text-ink-600 uppercase">{t("process")}</span>
					{live && <LoaderCircle className="size-3 animate-spin text-ember-400" />}
				</div>
				{error && <div className="rounded-lg border border-rose-400/25 bg-rose-400/8 px-2.5 py-1.5 text-xs text-rose-400">{error}</div>}
				{!detail && !error && <div className="text-xs text-ink-500">{t("loading")}</div>}
				{detail && steps.length === 0 && !error && <div className="text-xs text-ink-500">{t("noSteps")}</div>}
				{steps.map((s, i) => (
					<StepView key={i} step={s} />
				))}
				{detail && !detail.complete && live && steps.length > 0 && <div className="text-[11px] text-ink-600">{t("partial")}</div>}
			</section>
			{showOutput && detail?.output && (
				<section>
					<div className="mb-1 text-[10px] tracking-wide text-ink-600 uppercase">{t("output")}</div>
					<div className="rounded-lg border border-ink-800 bg-ink-950/50 px-3 py-2 text-[13px]">
						<Markdown text={detail.output} />
					</div>
				</section>
			)}
		</div>
	);
}

function DetailRegion({ run, listOpen }: { run: SubagentRun | undefined; listOpen: boolean }) {
	const t = useT(M);
	const label = useStateLabel();
	const live = run ? isLive(run) : false;
	const now = useNow(live);
	return (
		<>
			<RegionHeader onClose={() => closeSubagentRegion("detail")}>
				{run ? (
					<>
						<StateIcon state={run.state} />
						<span className="truncate font-mono text-xs font-medium text-ink-100">{run.agent}</span>
						<span className={clsx("shrink-0 text-[11px]", run.state === "failed" ? "text-rose-400" : run.state === "running" ? "text-ember-300" : "text-ink-500")}>{label(run.state)}</span>
						<span className="shrink-0 font-mono text-[11px] text-ink-500 tabular-nums">{formatElapsed((run.endedAt ?? now) - run.startedAt)}</span>
					</>
				) : (
					<span className="text-xs font-medium text-ink-200">{t("process")}</span>
				)}
				{!listOpen && (
					<button type="button" onClick={openSubagentList} className="ml-auto rounded-md p-1 text-ink-500 hover:bg-ink-800 hover:text-ink-100" title={t("showList")} aria-label={t("showList")}>
						<ListTree className="size-3.5" />
					</button>
				)}
			</RegionHeader>
			{run ? (
				<DetailBody key={run.id} run={run} />
			) : (
				<div className="grid flex-1 place-items-center px-6 text-center text-xs text-ink-500">{t("pick")}</div>
			)}
		</>
	);
}

/** Right-hand panel of the conversation: every subagent it used, and the process of the one picked. */
export function SubagentPanel() {
	const t = useT(M);
	const open = useStore((s) => s.subagentUi.open);
	const listOpen = useStore((s) => s.subagentUi.listOpen);
	const detailOpen = useStore((s) => s.subagentUi.detailOpen);
	const selected = useStore((s) => s.subagentUi.selected);
	const runs = useStore((s) => s.session?.subagents ?? NO_SUBAGENTS);
	const hasSession = useStore((s) => s.session !== null);
	if (!open || !hasSession) return null;
	const run = runs.find((r) => r.id === selected);
	return (
		<aside
			className="flex w-[22rem] shrink-0 flex-col border-l hairline bg-ink-900/80 backdrop-blur max-md:bg-ink-900 max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:w-[min(24rem,100%)] max-md:shadow-2xl lg:w-[26rem]"
			aria-label={t("title")}
		>
			{listOpen && (
				<div className={clsx("flex min-h-0 flex-col", detailOpen ? "basis-2/5" : "flex-1")}>
					<ListRegion runs={runs} selected={selected} />
				</div>
			)}
			{detailOpen && (
				<div className={clsx("flex min-h-0 flex-1 flex-col", listOpen && "border-t hairline")}>
					<DetailRegion run={run} listOpen={listOpen} />
				</div>
			)}
		</aside>
	);
}
