// "My workbench": the member's own tenant runtime (their Prometheus on the team server), opened through the Hub proxy.
// Hub mode only: the address needs the Hub access token, which member mode never holds.
import { ExternalLink, Loader2, Play, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, PageHeader } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { usePrefs } from "../../lib/prefs.ts";
import type { HubApi } from "../api.ts";
import { useTeam } from "../context.tsx";
import { useCommonT } from "../i18n.ts";
import { AsyncView, Body, Card, Notice, shortDate, useAction, useAsync } from "../kit.tsx";
import { canOpenWorkbench, canStartRuntime, isTransitional } from "../logic/runtime.ts";
import { RuntimeStatusBadge, useDriverLabel } from "./runtime/status.tsx";

const POLL_MS = 2000;

const M = defineMessages({
	zh: {
		title: "我的工作台",
		subtitle: "你在团队 server 上的 Prometheus。会话可以在本机和这里之间移交。",
		state: "状态",
		driver: "运行方式",
		lastActive: "最近活动",
		restricted: "受限模式",
		restrictedHint: "这个实例禁用 shell 和终端，读取文件前需要确认。",
		start: "启动工作台",
		starting: "正在启动，通常需要几十秒…",
		stopping: "正在停止…",
		open: "打开工作台",
		openHint: "在新标签页打开，首次会建立登录状态。",
		opened: "已在新标签页打开",
		noUrl: "登录已失效，请重新登录后再打开",
		popupBlocked: "浏览器拦截了新标签页，请允许弹出窗口后重试",
		failed: "上次启动失败",
		stoppedHint: "工作台当前没有运行。点击启动，或直接打开（会自动启动）。",
		restartRequired: "资源限制已更新，下次启动后生效",
		never: "还没有使用过",
		memberMode: "请在 Hub 网页中打开「我的工作台」。",
	},
	en: {
		title: "My workbench",
		subtitle: "Your Prometheus on the team server. Sessions can move between your machine and here.",
		state: "State",
		driver: "Runs as",
		lastActive: "Last active",
		restricted: "Restricted mode",
		restrictedHint: "This instance has no shell or terminal and asks before reading files.",
		start: "Start workbench",
		starting: "Starting. This usually takes a few seconds to a minute…",
		stopping: "Stopping…",
		open: "Open workbench",
		openHint: "Opens in a new tab and signs you in the first time.",
		opened: "Opened in a new tab",
		noUrl: "Your session expired. Sign in again, then open it.",
		popupBlocked: "The browser blocked the new tab. Allow pop-ups and retry.",
		failed: "The last start failed",
		stoppedHint: "The workbench is not running. Start it, or open it directly and it starts on demand.",
		restartRequired: "Resource limits changed and apply after the next start",
		never: "Not used yet",
		memberMode: "Open My workbench from the Hub web page.",
	},
});

const hasWorkbenchUrl = (api: unknown): api is Pick<HubApi, "workbenchUrl"> => typeof (api as { workbenchUrl?: unknown }).workbenchUrl === "function";

export function WorkbenchPage() {
	const { api, mode } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const lang = usePrefs((s) => s.lang);
	const driverLabel = useDriverLabel();
	const runtime = useAsync(() => api.getMyRuntime(), [api]);
	const start = useAction();
	const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | undefined>(undefined);

	const status = runtime.data?.status;
	const reload = runtime.reload;
	// While the instance is coming up or going down, ask again until it settles.
	useEffect(() => {
		if (!status || !isTransitional(status)) return;
		const id = window.setInterval(reload, POLL_MS);
		return () => window.clearInterval(id);
	}, [status, reload]);

	if (mode !== "hub" || !hasWorkbenchUrl(api)) return <Body>{<Notice kind="error">{t("memberMode")}</Notice>}</Body>;

	const doStart = async () => {
		setNote(undefined);
		const next = await start.run(() => api.startMyRuntime());
		if (next) runtime.setData(next);
		reload();
	};

	const doOpen = async () => {
		setNote(undefined);
		// The tab opens inside the click so the browser allows it; the address follows once the token is fresh.
		const win = window.open("about:blank", "_blank");
		if (!win) return setNote({ kind: "error", text: t("popupBlocked") });
		const url = await api.workbenchUrl(runtime.data?.workbenchUrl).catch(() => undefined);
		if (!url) {
			win.close();
			return setNote({ kind: "error", text: t("noUrl") });
		}
		win.location.href = url;
		setNote({ kind: "ok", text: t("opened") });
	};

	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body className="space-y-4">
				<AsyncView state={runtime}>
					{(rt) => (
						<Card
							actions={
								<Button variant="ghost" onClick={runtime.reload} disabled={runtime.loading}>
									{c("refresh")}
								</Button>
							}
						>
							<dl className="grid gap-x-6 gap-y-3 text-sm @xl:grid-cols-3">
								<div>
									<dt className="text-xs text-ink-500">{t("state")}</dt>
									<dd className="mt-1 flex items-center gap-2">
										<RuntimeStatusBadge status={rt.status} />
										{isTransitional(rt.status) && <Loader2 className="size-3.5 animate-spin text-ink-400" aria-hidden />}
									</dd>
								</div>
								<div>
									<dt className="text-xs text-ink-500">{t("driver")}</dt>
									<dd className="mt-1 text-ink-200">{driverLabel(rt.driver)}</dd>
								</div>
								<div>
									<dt className="text-xs text-ink-500">{t("lastActive")}</dt>
									<dd className="mt-1 text-ink-200">{rt.lastSeenAt ? shortDate(rt.lastSeenAt, lang) : t("never")}</dd>
								</div>
							</dl>

							{rt.restricted && (
								<p className="mt-4 flex items-start gap-2 rounded-lg bg-ember-500/8 px-3 py-2 text-sm text-ember-200">
									<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
									<span>
										<Badge tone="ember">{t("restricted")}</Badge> <span className="ml-1">{t("restrictedHint")}</span>
									</span>
								</p>
							)}
							{rt.restartRequired && <p className="mt-3 text-xs text-ink-400">{t("restartRequired")}</p>}
							{rt.status === "failed" && rt.lastError && (
								<div className="mt-3">
									<Notice kind="error">
										{t("failed")}: {rt.lastError}
									</Notice>
								</div>
							)}
							{rt.status === "starting" && <p className="mt-3 text-sm text-ink-400">{t("starting")}</p>}
							{rt.status === "stopping" && <p className="mt-3 text-sm text-ink-400">{t("stopping")}</p>}
							{rt.status === "stopped" && <p className="mt-3 text-sm text-ink-400">{t("stoppedHint")}</p>}

							<div className="mt-4 flex flex-wrap items-center gap-2">
								{canStartRuntime(rt.status) && (
									<Button variant="outline" disabled={start.busy} onClick={() => void doStart()}>
										{start.busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />} {t("start")}
									</Button>
								)}
								<Button variant="primary" disabled={!canOpenWorkbench(rt.status) && !canStartRuntime(rt.status)} onClick={() => void doOpen()} title={t("openHint")}>
									<ExternalLink className="size-4" aria-hidden /> {t("open")}
								</Button>
							</div>
							{start.error && (
								<div className="mt-3">
									<Notice kind="error">{start.error}</Notice>
								</div>
							)}
							{note && (
								<div className="mt-3">
									<Notice kind={note.kind}>{note.text}</Notice>
								</div>
							)}
						</Card>
					)}
				</AsyncView>
			</Body>
		</>
	);
}
