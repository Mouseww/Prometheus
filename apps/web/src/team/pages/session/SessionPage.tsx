// Session viewer: spectate a mirrored team session (read-only transcript, snapshot files), fork it, grant access,
// and, for granted users, send prompts / answer requests / abort through the Hub relay.
import { GitFork, GitBranch, KeyRound, Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, PageHeader } from "../../../components/ui.tsx";
import { defineMessages, relativeTime, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { type Route, useTeam } from "../../context.tsx";
import { AsyncView, Body, Card, Notice, Tabs, useAction, useAsync } from "../../kit.tsx";
import { localSessionIdOf } from "../../logic/pluginResult.ts";
import type { SessionDetail, SessionStatus } from "../../types.ts";
import { StatusDot } from "../home/status.tsx";
import { MemberWorkspaceActions } from "../MemberWorkspaceActions.tsx";
import { PromptBar, RequestActions } from "./ActionPanel.tsx";
import { FilesTab } from "./FilesTab.tsx";
import { GrantsDialog } from "./GrantsDialog.tsx";
import { TranscriptView } from "./TranscriptView.tsx";
import { useSessionEvents } from "./useSessionEvents.ts";

const M = defineMessages({
	zh: {
		back: "返回",
		by: "所有者 {name}",
		unknownOwner: "未知",
		branch: "分支",
		location: "执行位置",
		activity: "最近活动 {when}",
		fork: "Fork 到我这里",
		forking: "正在 Fork",
		grant: "授权…",
		tabs: "会话内容",
		transcript: "对话",
		files: "文件",
		forkedLocal: "已 Fork，正在打开本地会话",
		forkedLocalNoId: "已 Fork，请在你的 Prometheus 会话列表中打开",
		forkedHub: "已创建，请在你的 Prometheus 中打开",
		forkedTitle: "分支 {branch}",
		readOnly: "你正在旁观这个会话。需要参与的话，请让所有者授权给你，或者 Fork 一份自己的。",
		granted: "你已被授权，可以向这个会话发送消息。",
		owner: "这是你自己的会话。",
		notFound: "找不到这个会话",
	},
	en: {
		back: "Back",
		by: "Owner {name}",
		unknownOwner: "unknown",
		branch: "Branch",
		location: "Runs on",
		activity: "Active {when}",
		fork: "Fork to my machine",
		forking: "Forking",
		grant: "Grant access...",
		tabs: "Session content",
		transcript: "Conversation",
		files: "Files",
		forkedLocal: "Forked. Opening the local session.",
		forkedLocalNoId: "Forked. Open it from your Prometheus session list.",
		forkedHub: "Created. Open it in your Prometheus.",
		forkedTitle: "Branch {branch}",
		readOnly: "You are watching this session. Ask the owner for access to take part, or fork your own copy.",
		granted: "You are granted and can send messages to this session.",
		owner: "This is your own session.",
		notFound: "This session does not exist",
	},
});

function Header({ session, onChanged }: { session: SessionDetail; onChanged: () => void }) {
	const { api, mode, plugin } = useTeam();
	const t = useT(M);
	const lang = usePrefs((s) => s.lang);
	const fork = useAction();
	const [note, setNote] = useState<string | undefined>(undefined);
	const [grants, setGrants] = useState(false);

	const doFork = async () => {
		setNote(undefined);
		const r = await fork.run(async () => {
			if (mode === "member" && plugin) {
				const res = await plugin.call("session.fork", { hubSessionId: session.id });
				const id = localSessionIdOf(res);
				if (id) {
					plugin.openLocalSession(id);
					return t("forkedLocal");
				}
				return t("forkedLocalNoId");
			}
			await api.forkSession(session.id);
			return t("forkedHub");
		});
		if (r) setNote(r);
	};

	return (
		<Card>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<StatusDot status={session.status} />
				<span className="text-sm text-ink-200">{t("by", { name: session.ownerName ?? t("unknownOwner") })}</span>
				<Badge>
					<span className="inline-flex items-center gap-1">
						<GitBranch className="size-3" aria-hidden />
						<span className="font-mono">{session.branch}</span>
					</span>
				</Badge>
				<Badge>
					<span className="inline-flex items-center gap-1">
						<Monitor className="size-3" aria-hidden /> {t("location")} {session.execLocation}
					</span>
				</Badge>
				<span className="text-xs text-ink-500">{t("activity", { when: relativeTime(session.lastActivityAt, lang) })}</span>
				<span className="flex-1" />
				<Button variant="primary" disabled={fork.busy} onClick={() => void doFork()}>
					<GitFork className="size-4" aria-hidden /> {fork.busy ? t("forking") : t("fork")}
				</Button>
				{session.isOwner && (
					<Button variant="outline" onClick={() => setGrants(true)}>
						<KeyRound className="size-4" aria-hidden /> {t("grant")}
					</Button>
				)}
			</div>
			<p className="mt-2.5 text-xs text-ink-400">{session.isOwner ? t("owner") : session.canAct ? t("granted") : t("readOnly")}</p>
			{note && (
				<div className="mt-3">
					<Notice kind="ok">{note}</Notice>
				</div>
			)}
			{fork.error && (
				<div className="mt-3">
					<Notice kind="error">{fork.error}</Notice>
				</div>
			)}
			{grants && <GrantsDialog session={session} onClose={() => setGrants(false)} onChanged={onChanged} />}
		</Card>
	);
}

export function SessionPage() {
	const { api, route, back } = useTeam();
	const t = useT(M);
	const sessionId = route.params?.sessionId ?? "";
	const detail = useAsync(() => api.getSession(sessionId), [api, sessionId]);
	const { reload } = detail;
	const base = detail.data;
	const events = useSessionEvents(api, sessionId);
	const [tab, setTab] = useState<"transcript" | "files">("transcript");
	const [liveStatus, setLiveStatus] = useState<SessionStatus | undefined>(undefined);
	const data = base && liveStatus ? { ...base, status: liveStatus } : base;
	const fallback: Route = { page: "teamHome", params: data ? { workspaceId: data.workspaceId } : undefined };

	useEffect(
		() =>
			api.subscribe(`session:${sessionId}`, (frame) => {
				if (typeof frame !== "object" || frame === null) return;
				const f = frame as { kind?: unknown; status?: unknown };
				if (f.kind === "session.updated") {
					setLiveStatus(undefined);
					reload();
				} else if (f.kind === "session.status" && typeof f.status === "string") setLiveStatus(f.status as SessionStatus);
			}),
		[api, sessionId, reload],
	);

	return (
		<>
			<PageHeader
				title={data?.title || "..."}
				subtitle={data ? t("by", { name: data.ownerName ?? t("unknownOwner") }) : undefined}
				actions={
					<div className="flex flex-wrap items-center gap-2">
						{data && <MemberWorkspaceActions workspaceId={data.workspaceId} />}
						<Button variant="ghost" onClick={() => back(fallback)}>
							{t("back")}
						</Button>
					</div>
				}
			/>
			<Body>
				<AsyncView state={detail}>
					{(d) => {
						const s: SessionDetail = liveStatus ? { ...d, status: liveStatus } : d;
						return (
							<div className="space-y-4">
								<Header session={s} onChanged={reload} />
								<Tabs
									label={t("tabs")}
									value={tab}
									onChange={setTab}
									tabs={[
										{ id: "transcript", label: t("transcript") },
										{ id: "files", label: t("files") },
									]}
								/>
								{tab === "transcript" ? (
									<TranscriptView events={events} renderRequestActions={s.canAct ? (item) => <RequestActions sessionId={s.id} item={item} /> : undefined} />
								) : (
									<FilesTab sessionId={s.id} />
								)}
							</div>
						);
					}}
				</AsyncView>
			</Body>
			{data?.canAct && <PromptBar sessionId={data.id} />}
		</>
	);
}
