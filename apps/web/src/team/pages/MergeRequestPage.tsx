import { Check, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Field, PageHeader, Textarea } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { usePrefs } from "../../lib/prefs.ts";
import { canReview, useTeam } from "../context.tsx";
import { AsyncView, Body, Card, ConfirmButton, Notice, shortDate, useAction, useAsync } from "../kit.tsx";
import type { ConflictFile, MergeRequestView } from "../types.ts";
import { DiffView } from "./DiffView.tsx";
import { MergeRequestStatusBadge } from "./mrStatus.tsx";

const M = defineMessages({
	zh: {
		back: "返回工作区",
		by: "作者 {name}",
		branch: "分支",
		commits: "提交",
		decided: "处理于 {date}",
		skipped: "已跳过审核",
		session: "来自会话 {id}",
		description: "说明",
		noDescription: "没有说明",
		conflicts: "冲突文件",
		conflictHint: "这些文件在默认分支上有新的修改。作者需要处理后刷新冲突检测。",
		modifiedBy: "已被 {name} 修改",
		binary: "二进制",
		unknownModifier: "已被他人修改",
		approve: "通过并合并",
		reject: "拒绝",
		refresh: "刷新冲突检测",
		close: "关闭合并请求",
		rejectReason: "拒绝理由（可选）",
		confirmReject: "确认拒绝",
		cancel: "取消",
		changes: "代码变更",
		merged: "已合并为 {commit}",
		diffTitle: "差异",
	},
	en: {
		back: "Back to workspace",
		by: "by {name}",
		branch: "Branch",
		commits: "Commits",
		decided: "Decided {date}",
		skipped: "Review skipped",
		session: "From session {id}",
		description: "Description",
		noDescription: "No description",
		conflicts: "Conflicting files",
		conflictHint: "These files changed on the default branch. The author must resolve them and refresh.",
		modifiedBy: "Already modified by {name}",
		binary: "Binary",
		unknownModifier: "Already modified by someone else",
		approve: "Approve and merge",
		reject: "Reject",
		refresh: "Refresh conflict check",
		close: "Close merge request",
		rejectReason: "Reason (optional)",
		confirmReject: "Confirm reject",
		cancel: "Cancel",
		changes: "Changes",
		merged: "Merged as {commit}",
		diffTitle: "Diff",
	},
});

const short = (sha: string) => sha.slice(0, 8);

function ConflictList({ files }: { files: ConflictFile[] }) {
	const t = useT(M);
	return (
		<Card title={t("conflicts")} className="border-ember-500/40">
			<p className="mb-3 text-sm text-ink-300">{t("conflictHint")}</p>
			<ul className="space-y-1.5">
				{files.map((f) => (
					<li key={f.path} className="flex flex-wrap items-center gap-2 text-sm">
						<span className="break-all font-mono text-xs">{f.path}</span>
						{f.binary && <Badge tone="ember">{t("binary")}</Badge>}
						<span className="text-ink-400">{f.lastModifiedBy ? t("modifiedBy", { name: f.lastModifiedBy.displayName }) : t("unknownModifier")}</span>
					</li>
				))}
			</ul>
		</Card>
	);
}

function Actions({ mr, role, onChanged }: { mr: MergeRequestView; role: string | undefined; onChanged: (mr: MergeRequestView) => void }) {
	const { api, me } = useTeam();
	const t = useT(M);
	const { busy, error, run } = useAction();
	const [rejecting, setRejecting] = useState(false);
	const [reason, setReason] = useState("");
	const isAuthor = mr.authorId === me.user.id;
	const reviewer = canReview(role);
	const live = mr.status === "open" || mr.status === "conflict";

	const act = async (fn: () => Promise<MergeRequestView>) => {
		const next = await run(fn);
		if (next) {
			setRejecting(false);
			setReason("");
			onChanged(next);
		}
	};

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				{reviewer && mr.status === "open" && (
					<Button variant="primary" disabled={busy} onClick={() => void act(() => api.approveMergeRequest(mr.id))}>
						<Check className="size-4" aria-hidden /> {t("approve")}
					</Button>
				)}
				{reviewer && live && !rejecting && (
					<Button variant="outline" disabled={busy} onClick={() => setRejecting(true)} aria-expanded={rejecting}>
						<X className="size-4" aria-hidden /> {t("reject")}
					</Button>
				)}
				{(isAuthor || reviewer) && live && (
					<Button variant="outline" disabled={busy} onClick={() => void act(() => api.refreshMergeRequest(mr.id))}>
						<RefreshCw className="size-4" aria-hidden /> {t("refresh")}
					</Button>
				)}
				{(isAuthor || reviewer) && live && <ConfirmButton label={t("close")} disabled={busy} onConfirm={() => void act(() => api.closeMergeRequest(mr.id))} />}
			</div>
			{rejecting && (
				<div className="space-y-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3">
					<Field label={t("rejectReason")}>
						<Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} />
					</Field>
					<div className="flex gap-2">
						<Button variant="destructive" disabled={busy} onClick={() => void act(() => api.rejectMergeRequest(mr.id, reason.trim() || undefined))}>
							{t("confirmReject")}
						</Button>
						<Button variant="ghost" onClick={() => setRejecting(false)}>
							{t("cancel")}
						</Button>
					</div>
				</div>
			)}
			{error && <Notice kind="error">{error}</Notice>}
		</div>
	);
}

export function MergeRequestPage() {
	const { api, route, navigate } = useTeam();
	const t = useT(M);
	const lang = usePrefs((s) => s.lang);
	const id = route.params?.mergeRequestId ?? "";
	const teamId = route.params?.teamId ?? "";
	const workspaceId = route.params?.workspaceId ?? "";
	const mr = useAsync(() => api.getMergeRequest(id), [api, id]);
	const diff = useAsync(() => api.getMergeRequestDiff(id), [api, id, mr.data?.headCommit, mr.data?.status]);
	const teams = useAsync(() => api.listTeams(), [api]);
	const role = teams.data?.find((x) => x.id === teamId)?.role;
	const { reload: reloadMr } = mr;
	const wsId = mr.data?.workspaceId ?? workspaceId;
	useEffect(() => (wsId ? api.subscribe(`workspace:${wsId}`, () => reloadMr()) : undefined), [api, wsId, reloadMr]);

	return (
		<>
			<PageHeader
				title={mr.data?.title ?? "..."}
				subtitle={mr.data ? t("by", { name: mr.data.authorName }) : undefined}
				actions={
					<Button variant="ghost" onClick={() => navigate({ page: "workspace", params: { teamId, workspaceId: wsId } })}>
						{t("back")}
					</Button>
				}
			/>
			<Body>
				<AsyncView state={mr}>
					{(m) => (
						<div className="space-y-4">
							<Card>
								<div className="flex flex-wrap items-center gap-2">
									<MergeRequestStatusBadge status={m.status} />
									{m.skippedReview && <Badge tone="ember">{t("skipped")}</Badge>}
									<span className="text-xs text-ink-400">
										{t("branch")} <span className="font-mono">{m.branch}</span> · {t("commits")} <span className="font-mono">{short(m.baseCommit)}..{short(m.headCommit)}</span>
									</span>
									{m.decidedAt && <span className="text-xs text-ink-500">{t("decided", { date: shortDate(m.decidedAt, lang) })}</span>}
									{m.mergedCommit && <span className="text-xs text-ink-400">{t("merged", { commit: short(m.mergedCommit) })}</span>}
									{m.sessionId && <span className="font-mono text-xs text-ink-500">{t("session", { id: short(m.sessionId) })}</span>}
								</div>
								<h3 className="mt-3 mb-1 text-xs font-medium tracking-wide text-ink-300">{t("description")}</h3>
								<p className="whitespace-pre-wrap break-words text-sm text-ink-200">{m.description || <span className="text-ink-500">{t("noDescription")}</span>}</p>
							</Card>
							<Actions mr={m} role={role} onChanged={mr.setData} />
							{m.conflictFiles && m.conflictFiles.length > 0 && <ConflictList files={m.conflictFiles} />}
							<h2 className="font-display text-sm font-semibold tracking-wide text-ink-200">{t("changes")}</h2>
							<AsyncView state={diff}>{(d) => <DiffView diff={d} />}</AsyncView>
						</div>
					)}
				</AsyncView>
			</Body>
		</>
	);
}
