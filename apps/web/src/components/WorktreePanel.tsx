import clsx from "clsx";
import { ChevronRight, GitBranch, GitMerge, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitChangedFile, GitDiff, WorktreeStatus, WorktreeStrategy } from "@prometheus/protocol";
import { confirmDialog } from "../lib/dialogs.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call, draftWorktreeOn, setDraftWorktree, useStore, worktreeDiscard, worktreeMerge, worktreeSync } from "../lib/store.ts";
import { DiffReview, LineCounts } from "./DiffReview.tsx";
import { Button, Collapse, Select } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "独立工作树",
		summary: "{n} 个文件 · 领先 {a}",
		behind: " · 落后 {b}",
		clean: "还没有改动",
		review: "审查全部",
		reviewTitle: "本对话在独立工作树里的改动",
		reviewSub: "相对本对话开始时的版本",
		sync: "同步基础分支",
		merge: "合并到项目",
		discard: "丢弃",
		strategy: "合并方式",
		squash: "压缩为一个提交",
		mergeKeep: "保留历史（merge 提交）",
		apply: "只应用改动，不提交",
		message: "提交说明（可留空）",
		overlap: "与另一个对话改了相同文件：{files}",
		blocked: "暂时不能合并",
		discardAsk: "丢弃这个对话的工作树？",
		discardBody: "{n} 个文件的改动和分支 {branch} 会被删除，项目文件夹不受影响。对话记录保留为只读历史。",
		discardYes: "丢弃",
		gone: "工作树已丢弃，对话只能查看",
		running: "对话正在运行，停止后才能合并或丢弃",
		conflicts: "同步基础分支时有冲突，在工作树里解决后再合并：{files}",
		moved: "项目文件夹当前在分支 {branch}，请切回 {base}",
		dirty: "项目文件夹里这些文件有未提交的改动：{files}",
		empty: "没有可合并的改动",
	},
	en: {
		title: "Own worktree",
		summary: "{n} files · {a} ahead",
		behind: " · {b} behind",
		clean: "No changes yet",
		review: "Review all",
		reviewTitle: "Changes in this chat's worktree",
		reviewSub: "Against where this chat started",
		sync: "Sync base branch",
		merge: "Merge into project",
		discard: "Discard",
		strategy: "Merge style",
		squash: "Squash into one commit",
		mergeKeep: "Keep history (merge commit)",
		apply: "Apply changes, do not commit",
		message: "Commit message (optional)",
		overlap: "Another chat changed the same files: {files}",
		blocked: "Cannot merge yet",
		discardAsk: "Discard this chat's worktree?",
		discardBody: "The changes in {n} files and branch {branch} are deleted; the project folder is untouched. The chat stays as read-only history.",
		discardYes: "Discard",
		gone: "The worktree was discarded; this chat is history only",
		running: "The chat is running; stop it before merging or discarding",
		conflicts: "Syncing the base branch conflicts; resolve it in the worktree, then merge: {files}",
		moved: "The project folder is on branch {branch}; switch back to {base}",
		dirty: "The project folder has uncommitted changes in: {files}",
		empty: "Nothing to merge",
	},
});

/** Strip over the composer of a chat that works in its own git worktree: what it changed, and the merge / discard controls. */
export function WorktreePanel() {
	const t = useT(M);
	const id = useStore((s) => s.session?.id);
	const wt = useStore((s) => s.session?.worktree);
	const streaming = useStore((s) => s.session?.isStreaming ?? false);
	const hostStrategy = useStore((s) => s.hostSettings?.worktreeStrategy ?? "squash");
	const [status, setStatus] = useState<WorktreeStatus | undefined>();
	const [open, setOpen] = useState(false);
	const [review, setReview] = useState<{ initial?: string } | null>(null);
	const [strategy, setStrategy] = useState<WorktreeStrategy | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const active = wt?.state === "active";

	const refresh = useCallback(async () => {
		if (!id || !active) return setStatus(undefined);
		const client = useStore.getState().client;
		if (!client) return;
		// Quiet: a failed poll (e.g. the checkout vanished) must not toast every few seconds.
		setStatus(await client.rpc("worktree.status", { sessionId: id }).catch(() => undefined));
	}, [id, active]);

	useEffect(() => {
		const timer = setTimeout(() => void refresh(), streaming ? 1500 : 0);
		return () => clearTimeout(timer);
	}, [refresh, streaming, wt?.baseCommit]);
	useEffect(() => {
		if (!open && !streaming) return;
		const timer = setInterval(() => void refresh(), 5000);
		return () => clearInterval(timer);
	}, [open, streaming, refresh]);

	const files = useMemo<GitChangedFile[]>(
		() => (status?.files ?? []).map((f) => ({ path: f.path, status: f.status, added: f.added ?? 0, deleted: f.deleted ?? 0, binary: f.binary ?? false })),
		[status],
	);
	const loadDiff = useCallback(
		(path: string): Promise<GitDiff | undefined> => (id ? call((c) => c.rpc("worktree.diff", { sessionId: id, path })) : Promise.resolve(undefined)),
		[id],
	);

	if (!wt) return null;
	if (!active) {
		return <div className="mb-2 rounded-xl border border-ink-800 bg-ink-900/60 px-3 py-1.5 text-xs text-ink-400">{t("gone")}</div>;
	}
	if (!status) return null;
	// Nothing to merge (no uncommitted changes, no commits ahead of the base): the strip would only be noise.
	if (files.length === 0 && status.ahead === 0) return null;

	const totals = files.reduce((a, f) => ({ added: a.added + f.added, deleted: a.deleted + f.deleted }), { added: 0, deleted: 0 });
	const chosen = strategy ?? hostStrategy;
	const reason = streaming
		? t("running")
		: status.blocked === "worktreeConflict"
			? t("conflicts", { files: status.blockedDetail ?? "" })
			: status.blocked === "worktreeBaseMoved"
				? t("moved", { branch: status.blockedDetail ?? "", base: wt.baseBranch })
				: status.blocked === "worktreeMainDirty"
					? t("dirty", { files: status.blockedDetail ?? "" })
					: status.blocked === "worktreeEmpty"
						? t("empty")
						: undefined;

	const act = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await fn();
		} finally {
			setBusy(false);
			void refresh();
		}
	};

	const discard = async () => {
		const ok = await confirmDialog(`${t("discardAsk")}
${t("discardBody", { n: files.length, branch: wt.branch })}`, { danger: true, confirmLabel: t("discardYes") });
		if (ok) await act(() => worktreeDiscard(id!));
	};

	return (
		<div className="mb-2 overflow-hidden rounded-xl border border-ink-800 bg-ink-900/60">
			<div className="flex items-center">
				<button
					type="button"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
					className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs text-ink-300 transition-colors hover:text-ink-100"
				>
					<ChevronRight className={clsx("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
					<GitBranch className="size-3.5 shrink-0 text-ember-400" />
					<span className="truncate font-mono">{wt.branch}</span>
					<span className="shrink-0 text-ink-500">
						{files.length ? t("summary", { n: files.length, a: status.ahead }) : t("clean")}
						{status.behind > 0 && t("behind", { b: status.behind })}
					</span>
					{files.length > 0 && <LineCounts {...totals} />}
				</button>
				{files.length > 0 && (
					<button type="button" onClick={() => setReview({})} className="shrink-0 px-3 py-1.5 text-xs text-ember-300 hover:underline">
						{t("review")}
					</button>
				)}
			</div>
			<Collapse open={open}>
				<div className="border-t border-ink-800">
					{files.length > 0 && (
						<ul className="max-h-40 overflow-y-auto p-1">
							{files.map((f) => (
								<li key={f.path}>
									<button
										type="button"
										onClick={() => setReview({ initial: f.path })}
										title={f.path}
										className={clsx(
											"flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-ink-800 hover:text-ink-100",
											status.conflicts.includes(f.path) ? "text-rose-400" : "text-ink-300",
										)}
									>
										<span className="w-3 shrink-0 font-mono text-[11px] text-ink-500">{f.status}</span>
										<span className="min-w-0 flex-1 truncate">{f.path}</span>
										<LineCounts added={f.added} deleted={f.deleted} binary={f.binary} />
									</button>
								</li>
							))}
						</ul>
					)}
					{status.overlaps.map((o) => (
						<p key={o.sessionId} className="px-3 py-1 text-xs text-amber-400">
							{t("overlap", { files: o.files.slice(0, 4).join(", ") })}
						</p>
					))}
					{reason && <p className="px-3 py-1 text-xs text-ink-400">{reason}</p>}
					<div className="flex flex-wrap items-center gap-2 border-t border-ink-800 p-2">
						<Select className="w-auto text-xs" aria-label={t("strategy")} value={chosen} onChange={(e) => setStrategy(e.target.value as WorktreeStrategy)}>
							<option value="squash">{t("squash")}</option>
							<option value="merge">{t("mergeKeep")}</option>
							<option value="apply">{t("apply")}</option>
						</Select>
						{chosen !== "apply" && (
							<input
								value={message}
								onChange={(e) => setMessage(e.target.value)}
								placeholder={t("message")}
								className="min-w-40 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-xs text-ink-100 outline-none focus:border-ember-500"
							/>
						)}
						<div className="ml-auto flex items-center gap-1.5">
							<Button variant="ghost" disabled={busy || streaming || status.behind === 0} onClick={() => void act(() => worktreeSync(id!))} title={t("sync")}>
								<RefreshCw className="size-3.5" />
							</Button>
							<Button variant="danger" disabled={busy || streaming} onClick={() => void discard()}>
								<Trash2 className="size-3.5" />
								{t("discard")}
							</Button>
							<Button
								variant="primary"
								disabled={busy || streaming || !!status.blocked}
								title={status.blocked ? t("blocked") : undefined}
								onClick={() => void act(async () => { await worktreeMerge(id!, chosen, message); setMessage(""); })}
							>
								<GitMerge className="size-3.5" />
								{t("merge")}
							</Button>
						</div>
					</div>
				</div>
			</Collapse>
			{review && <DiffReview title={t("reviewTitle")} subtitle={t("reviewSub")} files={files} initial={review.initial} loadDiff={loadDiff} onClose={() => setReview(null)} />}
		</div>
	);
}

const S = defineMessages({
	zh: { label: "独立工作树", on: "本对话在独立的 git 工作树里工作，合并前不会改动项目文件夹", off: "本对话直接改项目文件夹" },
	en: { label: "Own worktree", on: "This chat works in its own git worktree; the project folder is untouched until you merge", off: "This chat edits the project folder directly" },
});

/** New-chat switch (shown when the setting is "ask"): whether the chat gets its own worktree. */
export function WorktreeSwitch() {
	const t = useT(S);
	const ask = useStore((s) => s.hostSettings?.worktreeMode === "ask");
	const on = useStore((s) => draftWorktreeOn(s));
	if (!ask) return null;
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			title={t(on ? "on" : "off")}
			onClick={() => setDraftWorktree(!on)}
			className={clsx(
				"flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-colors",
				on ? "border-ember-500/50 bg-ember-500/10 text-ember-300" : "border-ink-700 text-ink-400 hover:text-ink-200",
			)}
		>
			<GitBranch className="size-3.5" />
			{t("label")}
		</button>
	);
}
