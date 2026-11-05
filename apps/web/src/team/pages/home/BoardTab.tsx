import clsx from "clsx";
import { GitMerge, Users } from "lucide-react";
import { useEffect, useRef } from "react";
import { Badge, Empty } from "../../../components/ui.tsx";
import { defineMessages, relativeTime, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { useTeam } from "../../context.tsx";
import { roleLabel, useCommonT } from "../../i18n.ts";
import { AsyncView, Card, useAsync } from "../../kit.tsx";
import { applyBoardEvent } from "../../logic/board.ts";
import type { BoardMember, BoardMergeRequest, MergeRequestStatus } from "../../types.ts";
import { MergeRequestStatusBadge } from "../mrStatus.tsx";
import { STATUS_BG, STATUS_CHIP, useStatusLabel } from "./status.tsx";

const M = defineMessages({
	zh: {
		members: "成员",
		noMembers: "这个团队还没有成员",
		online: "在线",
		offlineMember: "离线",
		noSessions: "没有会话",
		lastActive: "最近活动 {when}",
		never: "没有活动记录",
		open: "待审核合并",
		recent: "最近合并",
		noOpen: "没有待审核的合并请求",
		noRecent: "还没有合并记录",
		by: "{name}",
		openSession: "查看会话 {title}",
		untitled: "未命名会话",
	},
	en: {
		members: "Members",
		noMembers: "This team has no members yet",
		online: "Online",
		offlineMember: "Offline",
		noSessions: "No sessions",
		lastActive: "Last active {when}",
		never: "No activity yet",
		open: "Awaiting review",
		recent: "Recently merged",
		noOpen: "No merge requests waiting",
		noRecent: "Nothing merged yet",
		by: "{name}",
		openSession: "Open session {title}",
		untitled: "Untitled session",
	},
});

function MemberCard({ member, teamId, workspaceId }: { member: BoardMember; teamId: string; workspaceId: string }) {
	const { navigate } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const statusLabel = useStatusLabel();
	const lang = usePrefs((s) => s.lang);
	return (
		<li className="rounded-xl border border-ink-700 bg-ink-900/60 p-3.5">
			<div className="flex flex-wrap items-center gap-2">
				<span className={clsx("size-2.5 shrink-0 rounded-full", member.online ? "bg-moss-400" : "bg-ink-600")} role="img" aria-label={member.online ? t("online") : t("offlineMember")} />
				<span className="min-w-0 truncate font-medium">{member.user.displayName}</span>
				<Badge>{roleLabel(c, member.role)}</Badge>
				<span className="ml-auto text-xs text-ink-500">{member.lastActivityAt ? t("lastActive", { when: relativeTime(member.lastActivityAt, lang) }) : t("never")}</span>
			</div>
			{member.sessions.length === 0 ? (
				<p className="mt-2.5 text-xs text-ink-500">{t("noSessions")}</p>
			) : (
				<ul className="mt-2.5 flex flex-wrap gap-1.5">
					{member.sessions.map((s) => (
						<li key={s.id}>
							<button
								type="button"
								title={`${statusLabel(s.status)} · ${relativeTime(s.lastActivityAt, lang)}`}
								aria-label={t("openSession", { title: s.title || t("untitled") })}
								onClick={() => navigate({ page: "session", params: { sessionId: s.id, workspaceId, teamId } })}
								className={clsx("flex max-w-56 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:brightness-125 focus-visible:outline-2 focus-visible:outline-ember-400", STATUS_CHIP[s.status])}
							>
								<span className={clsx("size-1.5 shrink-0 rounded-full", STATUS_BG[s.status], s.status === "running" && "animate-pulse")} aria-hidden />
								<span className="truncate">{s.title || t("untitled")}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

function MrList({ items, empty, teamId, workspaceId }: { items: BoardMergeRequest[]; empty: string; teamId: string; workspaceId: string }) {
	const { navigate } = useTeam();
	const t = useT(M);
	if (items.length === 0) return <p className="text-sm text-ink-500">{empty}</p>;
	return (
		<ul className="-my-1 divide-y divide-ink-800">
			{items.map((mr) => (
				<li key={mr.id}>
					<button
						type="button"
						onClick={() => navigate({ page: "mergeRequest", params: { teamId, workspaceId, mergeRequestId: mr.id } })}
						className="flex w-full items-start gap-2 py-2 text-left hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-ember-400"
					>
						<GitMerge className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-sm font-medium">{mr.title}</span>
							<span className="block truncate text-xs text-ink-400">
								{t("by", { name: mr.authorName ?? mr.authorId })} · <span className="font-mono">{mr.branch}</span>
							</span>
						</span>
						<MergeRequestStatusBadge status={mr.status as MergeRequestStatus} />
					</button>
				</li>
			))}
		</ul>
	);
}

export function BoardTab({ workspaceId, teamId }: { workspaceId: string; teamId: string }) {
	const { api } = useTeam();
	const t = useT(M);
	const board = useAsync(() => api.getBoard(workspaceId), [api, workspaceId]);
	const { reload, setData } = board;
	const current = useRef(board.data);
	current.current = board.data;

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const off = api.subscribe(`workspace:${workspaceId}`, (ev) => {
			const now = current.current;
			if (!now) return;
			const update = applyBoardEvent(now, ev);
			if (update.kind === "patched") setData(update.board);
			else if (update.kind === "reload") {
				clearTimeout(timer);
				timer = setTimeout(reload, 400);
			}
		});
		return () => {
			clearTimeout(timer);
			off();
		};
	}, [api, workspaceId, reload, setData]);

	return (
		<AsyncView state={board}>
			{(b) => (
				<div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_20rem]">
					<section aria-label={t("members")}>
						{b.members.length === 0 ? (
							<Empty icon={<Users className="size-5" />} title={t("noMembers")} />
						) : (
							<ul className="grid gap-3 @2xl:grid-cols-2">
								{b.members.map((m) => (
									<MemberCard key={m.user.id} member={m} teamId={teamId} workspaceId={workspaceId} />
								))}
							</ul>
						)}
					</section>
					<div className="space-y-4">
						<Card title={t("open")}>
							<MrList items={b.openMergeRequests} empty={t("noOpen")} teamId={teamId} workspaceId={workspaceId} />
						</Card>
						<Card title={t("recent")}>
							<MrList items={b.recentMerges} empty={t("noRecent")} teamId={teamId} workspaceId={workspaceId} />
						</Card>
					</div>
				</div>
			)}
		</AsyncView>
	);
}
