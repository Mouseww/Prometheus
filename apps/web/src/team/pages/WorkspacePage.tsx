import { GitMerge } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Badge, Button, Empty, Field, Input, PageHeader, Select } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { usePrefs } from "../../lib/prefs.ts";
import { isTeamAdmin, useTeam } from "../context.tsx";
import { useCommonT } from "../i18n.ts";
import { AsyncView, Body, Card, Notice, shortDate, Tabs, useAction, useAsync } from "../kit.tsx";
import { MERGE_REQUEST_STATUSES, type MergeRequestStatus, type UpdateWorkspaceInput, type UpstreamStatus, type WorkspaceView } from "../types.ts";
import { MergeRequestStatusBadge, mrStatusLabel } from "./mrStatus.tsx";

const M = defineMessages({
	zh: {
		back: "团队",
		tabs: "工作区内容",
		mergeRequests: "合并请求",
		settings: "设置",
		allStatuses: "全部状态",
		status: "状态",
		noMrs: "没有合并请求",
		noMrsHint: "成员在团队会话里提交的修改会出现在这里。",
		by: "作者 {name}",
		general: "基本信息",
		name: "工作区名称",
		report: "日报",
		reportEnabled: "每天生成日报",
		reportTime: "生成时间",
		reportTz: "时区",
		upstream: "上游仓库",
		upstreamUrl: "上游地址（仅 HTTPS，留空表示不使用）",
		upstreamToken: "上游访问令牌",
		tokenSet: "已设置，留空表示不修改",
		clearToken: "清除已保存的令牌",
		upstreamStatus: "上游状态",
		checkedAt: "最近检查：{date}",
		neverChecked: "尚未检查",
		readOnly: "只有团队管理员可以修改设置。",
		ok: "同步正常",
		push_failed: "推送失败",
		fetch_failed: "拉取失败",
		upstream_diverged: "上游已分叉",
		divergedHint: "上游默认分支与 Hub 分叉，需要管理员手动处理。",
		notFound: "找不到这个工作区",
		defaultBranch: "默认分支：{branch}",
	},
	en: {
		back: "Team",
		tabs: "Workspace content",
		mergeRequests: "Merge requests",
		settings: "Settings",
		allStatuses: "All statuses",
		status: "Status",
		noMrs: "No merge requests",
		noMrsHint: "Changes members submit from team sessions show up here.",
		by: "by {name}",
		general: "General",
		name: "Workspace name",
		report: "Daily report",
		reportEnabled: "Generate a report every day",
		reportTime: "Time",
		reportTz: "Time zone",
		upstream: "Upstream repository",
		upstreamUrl: "Upstream URL (HTTPS only, empty for none)",
		upstreamToken: "Upstream access token",
		tokenSet: "Set. Leave empty to keep it.",
		clearToken: "Remove the stored token",
		upstreamStatus: "Upstream status",
		checkedAt: "Last checked: {date}",
		neverChecked: "Not checked yet",
		readOnly: "Only team admins can change settings.",
		ok: "In sync",
		push_failed: "Push failed",
		fetch_failed: "Fetch failed",
		upstream_diverged: "Upstream diverged",
		divergedHint: "The upstream default branch diverged from the Hub. An administrator must resolve it by hand.",
		notFound: "This workspace does not exist",
		defaultBranch: "Default branch: {branch}",
	},
});

const upstreamTone = (s: UpstreamStatus): "moss" | "rose" | "ember" => (s === "ok" ? "moss" : s === "upstream_diverged" ? "ember" : "rose");

function MergeRequests({ workspaceId, teamId }: { workspaceId: string; teamId: string }) {
	const { api, navigate } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const lang = usePrefs((s) => s.lang);
	const [status, setStatus] = useState<MergeRequestStatus | "">("");
	const list = useAsync(() => api.listMergeRequests(workspaceId, status ? { status } : undefined), [api, workspaceId, status]);
	const { reload } = list;
	useEffect(() => api.subscribe(`workspace:${workspaceId}`, () => reload()), [api, workspaceId, reload]);

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Select aria-label={t("status")} value={status} onChange={(e) => setStatus(e.target.value as MergeRequestStatus | "")} className="w-48 py-1.5">
					<option value="">{t("allStatuses")}</option>
					{MERGE_REQUEST_STATUSES.map((s) => (
						<option key={s} value={s}>
							{mrStatusLabel(lang, s)}
						</option>
					))}
				</Select>
				<Button variant="ghost" onClick={reload}>
					{c("refresh")}
				</Button>
			</div>
			<AsyncView state={list}>
				{(rows) =>
					rows.length === 0 ? (
						<Empty icon={<GitMerge className="size-5" />} title={t("noMrs")}>
							{t("noMrsHint")}
						</Empty>
					) : (
						<ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-700">
							{rows.map((mr) => (
								<li key={mr.id}>
									<button
										type="button"
										onClick={() => navigate({ page: "mergeRequest", params: { teamId, workspaceId, mergeRequestId: mr.id } })}
										className="flex w-full items-center gap-3 bg-ink-900/60 px-4 py-3 text-left transition-colors hover:bg-ink-850 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ember-400"
									>
										<GitMerge className="size-4 shrink-0 text-ink-400" aria-hidden />
										<span className="min-w-0 flex-1">
											<span className="block truncate font-medium">{mr.title}</span>
											<span className="block truncate text-xs text-ink-400">
												{t("by", { name: mr.authorName })} · <span className="font-mono">{mr.branch}</span> · {shortDate(mr.updatedAt, lang)}
											</span>
										</span>
										<MergeRequestStatusBadge status={mr.status} />
									</button>
								</li>
							))}
						</ul>
					)
				}
			</AsyncView>
		</div>
	);
}

function Settings({ ws, canEdit, onSaved }: { ws: WorkspaceView; canEdit: boolean; onSaved: (ws: WorkspaceView) => void }) {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const lang = usePrefs((s) => s.lang);
	const [name, setName] = useState(ws.name);
	const [time, setTime] = useState(ws.dailyReportTime);
	const [tz, setTz] = useState(ws.dailyReportTz);
	const [enabled, setEnabled] = useState(ws.dailyReportEnabled);
	const [url, setUrl] = useState(ws.upstreamUrl ?? "");
	const [token, setToken] = useState("");
	const [clearToken, setClearToken] = useState(false);
	const [saved, setSaved] = useState(false);
	const { busy, error, run } = useAction();

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const patch: UpdateWorkspaceInput = {
			name: name.trim(),
			dailyReportTime: time,
			dailyReportTz: tz.trim(),
			dailyReportEnabled: enabled,
			upstreamUrl: url.trim() ? url.trim() : null,
		};
		if (clearToken) patch.upstreamToken = null;
		else if (token.trim()) patch.upstreamToken = token.trim();
		const next = await run(() => api.updateWorkspace(ws.id, patch));
		if (next) {
			setToken("");
			setClearToken(false);
			setSaved(true);
			onSaved(next);
		}
	};

	const zones = (() => {
		try {
			return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
		} catch {
			return [];
		}
	})();

	return (
		<form
			onSubmit={submit}
			onChange={() => setSaved(false)}
			className="space-y-4"
		>
			{!canEdit && <Notice kind="ok">{t("readOnly")}</Notice>}
			<fieldset disabled={!canEdit || busy} className="space-y-4">
				<Card title={t("general")}>
					<div className="grid gap-3 @2xl:grid-cols-2">
						<Field label={t("name")}>
							<Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
						</Field>
						<p className="self-end pb-2 text-sm text-ink-400">{t("defaultBranch", { branch: ws.defaultBranch })}</p>
					</div>
				</Card>
				<Card title={t("report")}>
					<div className="grid gap-3 @2xl:grid-cols-3 @2xl:items-end">
						<label className="flex items-center gap-2 text-sm">
							<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-ember-500" />
							{t("reportEnabled")}
						</label>
						<Field label={t("reportTime")}>
							<Input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
						</Field>
						<Field label={t("reportTz")}>
							<Input value={tz} onChange={(e) => setTz(e.target.value)} list="team-tz-list" required maxLength={64} />
							<datalist id="team-tz-list">
								{zones.map((z) => (
									<option key={z} value={z} />
								))}
							</datalist>
						</Field>
					</div>
				</Card>
				<Card title={t("upstream")}>
					<div className="space-y-3">
						{ws.upstreamUrl && (
							<div className="flex flex-wrap items-center gap-2 text-sm">
								<span className="text-ink-400">{t("upstreamStatus")}</span>
								{ws.upstreamStatus ? <Badge tone={upstreamTone(ws.upstreamStatus)}>{t(ws.upstreamStatus)}</Badge> : <Badge>{t("neverChecked")}</Badge>}
								{ws.upstreamCheckedAt && <span className="text-xs text-ink-500">{t("checkedAt", { date: shortDate(ws.upstreamCheckedAt, lang) })}</span>}
							</div>
						)}
						{ws.upstreamStatus === "upstream_diverged" && <Notice kind="error">{t("divergedHint")}</Notice>}
						{ws.upstreamError && ws.upstreamStatus !== "ok" && <p className="break-words font-mono text-xs text-rose-400">{ws.upstreamError}</p>}
						<div className="grid gap-3 @2xl:grid-cols-2">
							<Field label={t("upstreamUrl")}>
								<Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
							</Field>
							<Field label={t("upstreamToken")}>
								<Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder={ws.hasUpstreamToken ? t("tokenSet") : ""} disabled={clearToken} />
							</Field>
						</div>
						{ws.hasUpstreamToken && (
							<label className="flex items-center gap-2 text-sm text-ink-300">
								<input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} className="size-4 accent-ember-500" />
								{t("clearToken")}
							</label>
						)}
					</div>
				</Card>
			</fieldset>
			{canEdit && (
				<div className="flex items-center gap-3">
					<Button type="submit" variant="primary" disabled={busy}>
						{c("save")}
					</Button>
					{saved && <Notice kind="ok">{c("saved")}</Notice>}
					{error && <Notice kind="error">{error}</Notice>}
				</div>
			)}
		</form>
	);
}

export function WorkspacePage() {
	const { api, route, navigate } = useTeam();
	const t = useT(M);
	const teamId = route.params?.teamId ?? "";
	const workspaceId = route.params?.workspaceId ?? "";
	const ws = useAsync(() => api.getWorkspace(workspaceId), [api, workspaceId]);
	const teams = useAsync(() => api.listTeams(), [api]);
	const [tab, setTab] = useState<"mrs" | "settings">("mrs");
	const role = teams.data?.find((x) => x.id === teamId)?.role;

	return (
		<>
			<PageHeader
				title={ws.data?.name ?? "..."}
				subtitle={ws.data ? t("defaultBranch", { branch: ws.data.defaultBranch }) : undefined}
				actions={
					<Button variant="ghost" onClick={() => navigate({ page: "team", params: { teamId } })}>
						{teams.data?.find((x) => x.id === teamId)?.name ?? t("back")}
					</Button>
				}
			/>
			<Body>
				<AsyncView state={ws}>
					{(w) => (
						<>
							<Tabs
								label={t("tabs")}
								value={tab}
								onChange={setTab}
								tabs={[
									{ id: "mrs", label: t("mergeRequests") },
									{ id: "settings", label: t("settings") },
								]}
							/>
							{tab === "mrs" ? <MergeRequests workspaceId={w.id} teamId={teamId} /> : <Settings key={w.id + w.createdAt + (w.upstreamCheckedAt ?? "")} ws={w} canEdit={isTeamAdmin(role)} onSaved={ws.setData} />}
						</>
					)}
				</AsyncView>
			</Body>
		</>
	);
}
