import clsx from "clsx";
import { ChevronRight, GitBranch, GitMerge, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitChangedFile, GitDiff, WorktreeResolve, WorktreeStatus, WorktreeStrategy } from "@prometheus/protocol";
import { confirmDialog } from "../lib/dialogs.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call, draftWorktreeOn, sendPrompt, setDraftWorktree, useStore, worktreeDiscard, worktreeMerge, worktreeRestoreBackup, worktreeSync } from "../lib/store.ts";
import { DiffReview, LineCounts } from "./DiffReview.tsx";
import { Button, Collapse, Select } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "独立工作树",
		pending: "已改 {n} 个文件，待合并到项目",
		hint: "这些改动在独立分支 {branch} 里，合并后才会进入项目文件夹。",
		behind: "基础分支有 {b} 个新提交，可先同步。",
		review: "审查",
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
		dirtyTitle: "项目文件夹里已有 {n} 个同名文件的另一个版本（未提交）",
		dirtyBody: "可能是另一个对话直接写入的。选择保留哪一个，被替换的版本会自动备份，随时可恢复。",
		useMine: "用本对话的版本合并",
		keepMain: "保留项目里的版本，只合并其余文件",
		movedTitle: "项目文件夹现在在分支 {branch}，本对话基于 {base}",
		movedBody: "合并需要先切回 {base}；如果切换会覆盖未提交的改动，会自动取消，不会丢东西。",
		switchBase: "切回 {base} 并合并",
		conflictTitle: "有文件和项目里的新改动冲突：{files}",
		conflictBody: "需要把两边的改动合在一起。可以交给 AI 在本对话里处理，处理完再点合并。",
		aiFix: "让 AI 解决冲突",
		viewConflict: "查看冲突",
		aiPrompt: "本对话的工作树在同步基础分支 {base} 时产生了合并冲突，请解决这些文件里的冲突：{files}。\n要求：在文件里找到 <<<<<<< / ======= / >>>>>>> 标记，综合两边的意图改成最终内容，并删掉所有冲突标记；不要执行 git commit / merge / rebase 等命令，不要改其它文件；二进制文件无法逐行合并，请在两个版本中选一个并告诉我选了哪个。解决后简要说明每个文件怎么合的。",
		backedUp: "已合并。项目里原来的 {n} 个未提交版本已备份。",
		restore: "恢复项目里的版本",
		dismiss: "知道了",
		landed: "改动已合并进远程 {ref}，本地分支还没拉取。请先在项目文件夹里拉取，否则本地和远程会分叉",
		remoteMoved: "远程 {ref} 已改动了这些文件，请先在项目文件夹里拉取：{files}",
		remoteBehind: "远程 {ref} 比本地分支新 {b} 个提交。",
	},
	en: {
		title: "Own worktree",
		pending: "{n} files changed, not merged yet",
		hint: "These changes live on branch {branch} and reach the project folder only after you merge.",
		behind: "The base branch has {b} new commits; you can sync first.",
		review: "Review",
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
		dirtyTitle: "The project folder already has another, uncommitted version of {n} of these files",
		dirtyBody: "Maybe another chat wrote them directly. Pick which one to keep; the replaced version is backed up and can be restored.",
		useMine: "Merge this chat's version",
		keepMain: "Keep the project's version, merge the rest",
		movedTitle: "The project folder is on branch {branch}; this chat is based on {base}",
		movedBody: "Merging needs {base} checked out first. If switching would overwrite uncommitted edits it is cancelled, nothing is lost.",
		switchBase: "Switch to {base} and merge",
		conflictTitle: "Files conflict with new changes in the project: {files}",
		conflictBody: "Both sides need to be combined. Let the AI do it in this chat, then merge again.",
		aiFix: "Let the AI resolve the conflicts",
		viewConflict: "View conflicts",
		aiPrompt: "This chat's worktree hit merge conflicts while syncing the base branch {base}. Please resolve the conflicts in these files: {files}.\nRules: find the <<<<<<< / ======= / >>>>>>> markers, combine the intent of both sides into the final content and remove every marker; do not run git commit / merge / rebase and do not touch other files; binary files cannot be merged line by line, so pick one of the two versions and tell me which. Afterwards, briefly say how each file was combined.",
		backedUp: "Merged. {n} uncommitted project versions were backed up.",
		restore: "Restore the project's versions",
		dismiss: "Dismiss",
		landed: "The changes are already merged into remote {ref}, but the local branch has not pulled. Pull in the project folder first, or local and remote will diverge",
		remoteMoved: "Remote {ref} changed these files; pull in the project folder first: {files}",
		remoteBehind: "Remote {ref} is {b} commits ahead of the local branch.",
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
	// Nothing left to merge (no file differs from the base branch, whether or not the chat has commits): the strip would only be noise,
	// unless a merge just set the project's own versions aside and the user may want them back.
	const backup = wt.backup;
	if (files.length === 0 && !backup) return null;

	const totals = files.reduce((a, f) => ({ added: a.added + f.added, deleted: a.deleted + f.deleted }), { added: 0, deleted: 0 });
	const chosen = strategy ?? hostStrategy;
	const reason = streaming
		? t("running")
		: status.blocked === "worktreeConflict"
			? t("conflicts", { files: status.blockedDetail ?? "" })
			: status.blocked === "worktreeLanded"
				? t("landed", { ref: status.remote?.ref ?? "" })
				: status.blocked === "worktreeRemoteMoved"
					? t("remoteMoved", { ref: status.remote?.ref ?? "", files: status.remote?.overlap.slice(0, 8).join(", ") ?? "" })
					: status.blocked === "worktreeBaseMoved"
				? t("moved", { branch: status.blockedDetail ?? "", base: wt.baseBranch })
				: status.blocked === "worktreeMainDirty"
					? t("dirty", { files: status.blockedDetail ?? "" })
					: status.blocked === "worktreeEmpty"
						? t("empty")
						: undefined;

	const merging = (resolve: WorktreeResolve) => act(async () => { await worktreeMerge(id!, chosen, message, resolve); setMessage(""); });

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

	const backupBar = backup && (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-green-500/20 bg-green-500/10 px-3 py-2 text-xs text-green-300">
			<span>{t("backedUp", { n: backup.files.length })}</span>
			<button type="button" disabled={busy} onClick={() => void act(() => worktreeRestoreBackup(id!))} className="text-ember-300 underline hover:text-ember-200">
				{t("restore")}
			</button>
			<button type="button" disabled={busy} onClick={() => void act(() => worktreeRestoreBackup(id!, true))} className="text-ink-400 hover:text-ink-200">
				{t("dismiss")}
			</button>
		</div>
	);
	if (files.length === 0) return <div className="mb-2 overflow-hidden rounded-xl border border-ink-800/70 bg-ink-900/40">{backupBar}</div>;

	const blocker = streaming ? null : status.blocked === "worktreeMainDirty" ? (
		<div className="m-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
			<p className="text-[13px] text-ink-100">{t("dirtyTitle", { n: status.mainDirty.length })}</p>
			<p className="mb-2 text-xs text-ink-400">{t("dirtyBody")}</p>
			<div className="flex flex-wrap gap-2">
				<Button variant="primary" disabled={busy} onClick={() => void merging("overwrite")}>{t("useMine")}</Button>
				<Button variant="ghost" disabled={busy} onClick={() => void merging("keepMain")}>{t("keepMain")}</Button>
			</div>
		</div>
	) : status.blocked === "worktreeBaseMoved" ? (
		<div className="m-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2">
			<p className="text-[13px] text-ink-100">{t("movedTitle", { branch: status.blockedDetail ?? "", base: wt.baseBranch })}</p>
			<p className="mb-2 text-xs text-ink-400">{t("movedBody", { base: wt.baseBranch })}</p>
			<Button variant="primary" disabled={busy} onClick={() => void merging("switchBase")}>{t("switchBase", { base: wt.baseBranch })}</Button>
		</div>
	) : status.blocked === "worktreeConflict" ? (
		<div className="m-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2">
			<p className="text-[13px] text-ink-100">{t("conflictTitle", { files: status.blockedDetail ?? "" })}</p>
			<p className="mb-2 text-xs text-ink-400">{t("conflictBody")}</p>
			<div className="flex flex-wrap gap-2">
				<Button variant="primary" disabled={busy} onClick={() => void sendPrompt(t("aiPrompt", { base: wt.baseBranch, files: status.conflicts.join(", ") }))}>{t("aiFix")}</Button>
				<Button variant="ghost" onClick={() => setReview({ initial: status.conflicts[0] })}>{t("viewConflict")}</Button>
			</div>
		</div>
	) : null;

	return (
		<div className="mb-2 overflow-hidden rounded-xl border border-ink-800/70 bg-ink-900/40">
			{backupBar}
			<div className="flex items-center">
				<button
					type="button"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
					title={wt.branch}
					className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left text-xs text-ink-400 transition-colors hover:text-ink-200"
				>
					<ChevronRight className={clsx("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
					<span className={clsx("truncate", status.blocked === "worktreeLanded" && "text-amber-400")}>
						{status.blocked === "worktreeLanded" ? t("landed", { ref: status.remote?.ref ?? "" }) : t("pending", { n: files.length })}
					</span>
					{files.length > 0 && <LineCounts {...totals} />}
				</button>
				{files.length > 0 && (
					<button type="button" onClick={() => setReview({})} className="shrink-0 px-3 py-1 text-xs text-ember-300 hover:underline">
						{t("review")}
					</button>
				)}
			</div>
			{blocker}
			<Collapse open={open}>
				<div className="border-t border-ink-800">
					<p className="px-3 pt-2 pb-1 text-xs text-ink-500">
						{t("hint", { branch: wt.branch })}
						{status.behind > 0 && ` ${t("behind", { b: status.behind })}`}
						{status.remote && status.remote.behind > 0 && ` ${t("remoteBehind", { ref: status.remote.ref, b: status.remote.behind })}`}
					</p>
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
					{!blocker && status.overlaps.map((o) => (
						<p key={o.sessionId} className="px-3 py-1 text-xs text-amber-400">
							{t("overlap", { files: o.files.slice(0, 4).join(", ") })}
						</p>
					))}
					{reason && !blocker && <p className="px-3 py-1 text-xs text-ink-400">{reason}</p>}
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
