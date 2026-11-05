// Strip above a team session's messages: where it runs, the local-first / team-first switch, the handoff action and
// the badge a plugin pinned to the session (restricted mode, "team server executing").
import clsx from "clsx";
import { ArrowRightLeft, Cloud, Eye, Laptop, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Dialog } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { useStore } from "../../lib/store.ts";
import { TeamApiError } from "../api.ts";
import { useTeamExec } from "../execStore.ts";
import { errorText } from "../i18n.ts";
import { isReadOnly, otherSide } from "../logic/exec.ts";
import { memberTeamApi } from "../memberTransport.ts";
import type { ExecLocation, ExecMode } from "../types.ts";

const M = defineMessages({
	zh: {
		bar: "团队会话执行位置",
		local: "本机执行",
		team: "团队 server 执行",
		modeLabel: "新会话优先在",
		modeLocal: "本机优先",
		modeTeam: "团队优先",
		modeLocalHint: "会话默认在本机执行，需要时再移交",
		modeTeamHint: "会话默认在团队 server 执行",
		handToTeam: "移交到团队 server",
		handToLocal: "移回本机",
		mirror: "只读镜像",
		mirrorToTeam: "此会话已移交到团队 server 执行，请在「我的工作台」继续对话。",
		mirrorToLocal: "此会话已移回本机执行，请在本机 Prometheus 继续对话。",
		confirmTitleTeam: "移交到团队 server？",
		confirmTitleLocal: "移回本机？",
		confirmBodyTeam: "会话的对话和工作区会同步到团队 server，之后由团队 server 继续执行。本机这份变成只读镜像。",
		confirmBodyLocal: "会话的对话和工作区会同步回本机，之后由本机继续执行。团队 server 上这份变成只读镜像。",
		confirm: "移交",
		cancel: "取消",
		busyTitle: "Agent 仍在运行",
		busyBody: "现在移交会中断它正在做的事。确定要中断并移交吗？",
		force: "中断并移交",
		working: "正在移交…",
		done: "已移交，正在切换到另一端",
		loadFailed: "读取执行位置失败",
		retry: "重试",
	},
	en: {
		bar: "Team session execution",
		local: "Runs locally",
		team: "Runs on team server",
		modeLabel: "New work prefers",
		modeLocal: "Local first",
		modeTeam: "Team first",
		modeLocalHint: "The session runs locally by default and is handed off when needed",
		modeTeamHint: "The session runs on the team server by default",
		handToTeam: "Hand off to team server",
		handToLocal: "Move back to this machine",
		mirror: "Read-only mirror",
		mirrorToTeam: "This session moved to the team server. Continue it from My workbench.",
		mirrorToLocal: "This session moved back to your machine. Continue it in your local Prometheus.",
		confirmTitleTeam: "Hand off to the team server?",
		confirmTitleLocal: "Move back to this machine?",
		confirmBodyTeam: "The conversation and workspace sync to the team server, which continues the session. This copy becomes a read-only mirror.",
		confirmBodyLocal: "The conversation and workspace sync back to your machine, which continues the session. The team server copy becomes a read-only mirror.",
		confirm: "Hand off",
		cancel: "Cancel",
		busyTitle: "The agent is still running",
		busyBody: "Handing off now interrupts what it is doing. Interrupt it and hand off anyway?",
		force: "Interrupt and hand off",
		working: "Handing off…",
		done: "Handed off. Switching to the other side.",
		loadFailed: "Could not read where the session runs",
		retry: "Retry",
	},
});

function SideBadge({ side }: { side: ExecLocation }) {
	const t = useT(M);
	const Icon = side === "team" ? Cloud : Laptop;
	return (
		<span className={clsx("inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium", side === "team" ? "bg-sky-400/12 text-sky-400" : "bg-moss-400/12 text-moss-400")}>
			<Icon className="size-3.5" aria-hidden />
			{t(side)}
		</span>
	);
}

function ModeSwitch({ mode, busy, onChange }: { mode: ExecMode | undefined; busy: boolean; onChange: (m: ExecMode) => void }) {
	const t = useT(M);
	const options: { id: ExecMode; label: string; hint: string }[] = [
		{ id: "local-first", label: t("modeLocal"), hint: t("modeLocalHint") },
		{ id: "team-first", label: t("modeTeam"), hint: t("modeTeamHint") },
	];
	return (
		<div role="group" aria-label={t("modeLabel")} className="inline-flex overflow-hidden rounded-md border border-ink-700 text-xs">
			{options.map((o) => (
				<button
					key={o.id}
					type="button"
					title={o.hint}
					aria-pressed={mode === o.id}
					disabled={busy || mode === undefined}
					onClick={() => mode !== o.id && onChange(o.id)}
					className={clsx("px-2 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-ember-400 disabled:opacity-50", mode === o.id ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:bg-ink-850 hover:text-ink-100")}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

interface HandoffDialogProps {
	to: ExecLocation;
	busy: boolean;
	error: string | undefined;
	agentBusy: boolean;
	onConfirm: (force: boolean) => void;
	onClose: () => void;
}

function HandoffDialog({ to, busy, error, agentBusy, onConfirm, onClose }: HandoffDialogProps) {
	const t = useT(M);
	return (
		<Dialog title={t(to === "team" ? "confirmTitleTeam" : "confirmTitleLocal")} onClose={onClose}>
			<p className="text-sm text-ink-300">{t(to === "team" ? "confirmBodyTeam" : "confirmBodyLocal")}</p>
			{error && (
				<div role="alert" className="rounded-lg bg-rose-400/10 px-3 py-2 text-sm text-rose-400">
					{agentBusy && <p className="mb-1 font-medium">{t("busyTitle")}</p>}
					<p className="break-words">{agentBusy ? t("busyBody") : error}</p>
				</div>
			)}
			<div className="flex justify-end gap-2">
				<Button variant="ghost" onClick={onClose} disabled={busy}>
					{t("cancel")}
				</Button>
				{agentBusy ? (
					<Button variant="destructive" onClick={() => onConfirm(true)} disabled={busy}>
						{busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />} {t("force")}
					</Button>
				) : (
					<Button variant="primary" onClick={() => onConfirm(false)} disabled={busy}>
						{busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />} {busy ? t("working") : t("confirm")}
					</Button>
				)}
			</div>
		</Dialog>
	);
}

/** Shown for any chat that is a team session (known link) or carries a plugin badge. */
export function TeamSessionBar() {
	const t = useT(M);
	const sessionId = useStore((s) => s.session?.id);
	// The plugin pins the badge (restricted mode, "team server executing") to the session list entry.
	const badge = useStore((s) => (s.session ? s.sessions.find((x) => x.id === s.session?.id)?.badge : undefined));
	const link = useTeamExec((s) => (sessionId ? s.links[sessionId] : undefined));
	const setExecState = useTeamExec((s) => s.setExecState);
	const hubSessionId = link?.hubSessionId;
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const [pending, setPending] = useState(false);
	const [dialog, setDialog] = useState(false);
	const [error, setError] = useState<{ text: string; busy: boolean } | undefined>(undefined);
	const [done, setDone] = useState(false);

	const load = useCallback(() => {
		if (!sessionId || !hubSessionId) return;
		setLoadError(undefined);
		memberTeamApi()
			.getSessionExec(hubSessionId)
			.then((state) => setExecState(sessionId, state))
			.catch((e: unknown) => setLoadError(errorText(e)));
	}, [sessionId, hubSessionId, setExecState]);

	// The Hub is the source of truth for mode and location; events keep the link current afterwards.
	useEffect(() => {
		setDone(false);
		load();
	}, [load]);

	if (!link && !badge) return null;

	const readOnly = isReadOnly(link);
	const location = link?.location;

	const changeMode = (mode: ExecMode) => {
		if (!sessionId || !hubSessionId) return;
		setPending(true);
		memberTeamApi()
			.setSessionExecMode(hubSessionId, mode)
			.then((state) => setExecState(sessionId, state))
			.catch((e: unknown) => setLoadError(errorText(e)))
			.finally(() => setPending(false));
	};

	const handoff = (force: boolean) => {
		if (!sessionId || !hubSessionId || !location) return;
		setPending(true);
		setError(undefined);
		memberTeamApi()
			.handoffSession(hubSessionId, otherSide(location), force)
			.then(() => {
				setDialog(false);
				setDone(true);
			})
			.catch((e: unknown) => setError({ text: errorText(e), busy: e instanceof TeamApiError && e.code === "agentBusy" }))
			.finally(() => setPending(false));
	};

	return (
		<div role="region" aria-label={t("bar")} className="shrink-0 border-b hairline bg-ink-900/40 px-4 py-1.5">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
				{location && <SideBadge side={readOnly && link?.readOnly ? link.readOnly.to : location} />}
				{readOnly && (
					<Badge tone="muted">
						<Eye className="mr-1 size-3" aria-hidden />
						{t("mirror")}
					</Badge>
				)}
				{badge && <Badge tone={badge.tone === "warn" ? "rose" : "sky"}>{badge.text}</Badge>}
				{link && !readOnly && (
					<>
						<ModeSwitch mode={link.mode} busy={pending} onChange={changeMode} />
						{location && (
							<Button variant="outline" disabled={pending} onClick={() => (setError(undefined), setDialog(true))} className="h-7 px-2 text-xs">
								<ArrowRightLeft className="size-3.5" aria-hidden /> {t(location === "local" ? "handToTeam" : "handToLocal")}
							</Button>
						)}
					</>
				)}
				{done && <span role="status" className="text-moss-400">{t("done")}</span>}
				{loadError && (
					<span role="alert" className="flex items-center gap-2 text-rose-400">
						{t("loadFailed")}: {loadError}
						<button type="button" onClick={load} className="underline underline-offset-2 hover:text-rose-300">
							{t("retry")}
						</button>
					</span>
				)}
			</div>
			{readOnly && link?.readOnly && <p className="mt-1 text-xs text-ink-400">{t(link.readOnly.to === "team" ? "mirrorToTeam" : "mirrorToLocal")}</p>}
			{dialog && location && <HandoffDialog to={otherSide(location)} busy={pending} error={error?.text} agentBusy={error?.busy ?? false} onConfirm={handoff} onClose={() => setDialog(false)} />}
		</div>
	);
}
