// Workspace sync status of the open team session: the last snapshot applied from the other side, and a visible notice
// when the user's own local changes were saved aside because the snapshot overwrote the working tree.
import { Check, Copy, GitBranch, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { useStore } from "../../lib/store.ts";
import { useTeamExec } from "../execStore.ts";
import { errorText } from "../i18n.ts";
import { gitInspectCommand, parseRestoreResult, type RestoreMode, type RestoreResult, shortCommit, type SyncConflict } from "../logic/exec.ts";
import { memberPlugin } from "../memberTransport.ts";

const M = defineMessages({
	zh: {
		synced: "工作区已同步到 {commit}",
		unchanged: "工作区已是最新（{commit}）",
		conflictBadge: "已同步，你的本地改动另存",
		conflictTitle: "你的本地改动已另存，未丢失",
		conflictBody: "另一端的快照覆盖了工作区。你在这之前的改动保存在下面这个引用里：",
		ref: "引用",
		worktree: "工作区",
		inspect: "查看改动的命令",
		copy: "复制命令",
		copied: "已复制",
		dismiss: "知道了",
		restoreApply: "恢复我的改动",
		restoreApplyHint: "把另存的改动放回会话工作区，作为未提交的修改。两边改了同一个文件时不会动任何文件。",
		restoreBranch: "恢复到新分支",
		restoreBranchHint: "在会话旁边新建一个工作区和分支放这些改动，不动当前工作区。",
		restoredApply: "已恢复，{n} 个文件现在是未提交的修改",
		restoredBranch: "已恢复到分支 {branch}，位置：{worktree}",
	},
	en: {
		synced: "Workspace synced to {commit}",
		unchanged: "Workspace is up to date ({commit})",
		conflictBadge: "Synced; your local edits were saved aside",
		conflictTitle: "Your local changes were saved aside, nothing is lost",
		conflictBody: "A snapshot from the other side replaced the working tree. Your earlier edits are kept under this ref:",
		ref: "Ref",
		worktree: "Worktree",
		inspect: "Command to inspect the changes",
		copy: "Copy command",
		copied: "Copied",
		dismiss: "Got it",
		restoreApply: "Restore my changes",
		restoreApplyHint: "Puts the saved edits back in the session worktree as uncommitted changes. Nothing is touched if both sides changed the same file.",
		restoreBranch: "Restore to a new branch",
		restoreBranchHint: "Checks the edits out on a new branch in a new worktree next to the session, leaving the current one alone.",
		restoredApply: "Restored. {n} files are now uncommitted changes.",
		restoredBranch: "Restored on branch {branch} at {worktree}",
	},
});

function CopyCommand({ command }: { command: string }) {
	const t = useT(M);
	const [copied, setCopied] = useState(false);
	return (
		<div className="mt-2 flex items-stretch gap-1.5">
			<code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-ink-950/60 px-2 py-1.5 font-mono text-xs whitespace-nowrap text-ink-200" aria-label={t("inspect")}>
				{command}
			</code>
			<button
				type="button"
				onClick={() => void copyToClipboard(command).then(() => (setCopied(true), window.setTimeout(() => setCopied(false), 1800)))}
				className="flex shrink-0 items-center gap-1 rounded-md border border-ink-700 px-2 text-xs text-ink-300 hover:bg-ink-800 hover:text-ink-100"
			>
				{copied ? <Check className="size-3.5 text-moss-400" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
				{copied ? t("copied") : t("copy")}
			</button>
		</div>
	);
}

function RestoreActions({ conflict }: { conflict: SyncConflict }) {
	const t = useT(M);
	const [busy, setBusy] = useState<RestoreMode | undefined>(undefined);
	const [result, setResult] = useState<RestoreResult | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	const restore = (mode: RestoreMode) => {
		setBusy(mode);
		setError(undefined);
		memberPlugin()
			.call("sync.restoreConflict", { hubSessionId: conflict.hubSessionId, conflictRef: conflict.conflictRef, mode })
			.then((r) => setResult(parseRestoreResult(r)))
			.catch((e: unknown) => setError(errorText(e)))
			.finally(() => setBusy(undefined));
	};

	return (
		<div className="mt-2">
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="outline" disabled={busy !== undefined} onClick={() => restore("apply")} title={t("restoreApplyHint")} className="h-8 text-xs">
					{busy === "apply" && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />} {t("restoreApply")}
				</Button>
				<Button variant="ghost" disabled={busy !== undefined} onClick={() => restore("branch")} title={t("restoreBranchHint")} className="h-8 text-xs">
					{busy === "branch" && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />} {t("restoreBranch")}
				</Button>
			</div>
			{error && (
				<p role="alert" className="mt-1.5 text-xs break-words text-rose-400">
					{error}
				</p>
			)}
			{result && (
				<p role="status" className="mt-1.5 text-xs break-words text-moss-400">
					{result.mode === "apply" ? t("restoredApply", { n: result.files.length }) : t("restoredBranch", { branch: result.branch ?? "", worktree: result.worktree })}
				</p>
			)}
		</div>
	);
}

/** Renders nothing for a session without a team link or without sync news. */
export function SyncStatus() {
	const t = useT(M);
	const sessionId = useStore((s) => s.session?.id);
	const hubSessionId = useTeamExec((s) => (sessionId ? s.links[sessionId]?.hubSessionId : undefined));
	const info = useTeamExec((s) => (hubSessionId ? s.sync[hubSessionId] : undefined));
	const conflict = useTeamExec((s) => (hubSessionId ? s.conflicts[hubSessionId] : undefined));
	const dismiss = useTeamExec((s) => s.dismissConflict);
	if (!hubSessionId || (!info && !conflict)) return null;

	return (
		<div className="shrink-0 border-b hairline px-4 py-1.5">
			{info && !conflict && (
				<p role="status" className="flex items-center gap-1.5 text-xs text-ink-400">
					<GitBranch className="size-3.5" aria-hidden />
					{t(info.status === "unchanged" ? "unchanged" : "synced", { commit: shortCommit(info.commit) })}
				</p>
			)}
			{conflict && (
				<div role="alert" className="rounded-lg border border-ember-500/30 bg-ember-500/8 px-3 py-2">
					<div className="flex items-start gap-2">
						<TriangleAlert className="mt-0.5 size-4 shrink-0 text-ember-300" aria-hidden />
						<div className="min-w-0 flex-1 text-sm">
							<p className="font-medium text-ink-100">{conflict.message || t("conflictTitle")}</p>
							<p className="mt-0.5 text-xs text-ink-400">{t("conflictBody")}</p>
							<dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
								<dt className="text-ink-500">{t("ref")}</dt>
								<dd className="min-w-0 font-mono break-all text-ink-200">{conflict.conflictRef}</dd>
								<dt className="text-ink-500">{t("worktree")}</dt>
								<dd className="min-w-0 font-mono break-all text-ink-200">{conflict.worktree}</dd>
							</dl>
							<CopyCommand command={gitInspectCommand(conflict)} />
							<RestoreActions conflict={conflict} />
						</div>
						<button type="button" onClick={() => dismiss(hubSessionId)} aria-label={t("dismiss")} title={t("dismiss")} className="shrink-0 rounded p-1 text-ink-500 hover:bg-ink-800 hover:text-ink-100">
							<X className="size-4" aria-hidden />
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
