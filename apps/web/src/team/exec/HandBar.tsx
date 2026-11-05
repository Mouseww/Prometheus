// Confirmation bar for a "hand" call: the other side of a hybrid session asks to run a tool on this machine.
// It sits above the composer of the asking session. The plugin times a question out on its own; `handResolved` clears it.
import { FolderCheck, FolderX, ShieldQuestion, TimerOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { useStore } from "../../lib/store.ts";
import { TIMEOUT_NOTE_MS, useTeamExec } from "../execStore.ts";
import { errorText } from "../i18n.ts";
import { handsForSession, type HandItem, summarizeInput } from "../logic/exec.ts";
import { memberPlugin } from "../memberTransport.ts";

const M = defineMessages({
	zh: {
		region: "团队 server 的执行请求",
		ask: "团队会话请求在本机执行 {tool}",
		inside: "在项目内",
		outside: "在项目外",
		once: "允许一次",
		session: "本会话内允许",
		deny: "拒绝",
		timedOut: "{tool} 的请求等待超时，已按拒绝处理",
		answerFailed: "回复失败",
		more: "还有 {n} 个请求在排队",
	},
	en: {
		region: "Execution requests from the team server",
		ask: "The team session asks to run {tool} on this machine",
		inside: "Inside the project",
		outside: "Outside the project",
		once: "Allow once",
		session: "Allow for this session",
		deny: "Deny",
		timedOut: "The request for {tool} timed out and was denied",
		answerFailed: "Could not send the answer",
		more: "{n} more requests are waiting",
	},
});

type Decision = "once" | "session" | "deny";

function HandCard({ item }: { item: HandItem }) {
	const t = useT(M);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const summary = summarizeInput(item.input);

	const answer = (decision: Decision) => {
		setBusy(true);
		setError(undefined);
		memberPlugin()
			.call("hand.answer", { callId: item.callId, decision })
			.catch((e: unknown) => setError(errorText(e)))
			.finally(() => setBusy(false));
	};

	return (
		<div role="group" aria-label={t("ask", { tool: item.tool })} className="rounded-xl border border-ember-500/30 bg-ember-500/8 px-3 py-2.5">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-100">
				<ShieldQuestion className="size-4 shrink-0 text-ember-300" aria-hidden />
				<span className="min-w-0 flex-1 font-medium">{t("ask", { tool: item.tool })}</span>
				<span className={item.insideProject ? "inline-flex items-center gap-1 text-xs text-moss-400" : "inline-flex items-center gap-1 text-xs text-ember-300"}>
					{item.insideProject ? <FolderCheck className="size-3.5" aria-hidden /> : <FolderX className="size-3.5" aria-hidden />}
					{t(item.insideProject ? "inside" : "outside")}
				</span>
			</div>
			{summary && (
				<pre className="mt-1.5 max-h-20 overflow-auto rounded-md bg-ink-950/60 px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap text-ink-300" title={summary}>
					{summary}
				</pre>
			)}
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Button variant="primary" disabled={busy} onClick={() => answer("once")} className="h-8 text-xs">
					{t("once")}
				</Button>
				<Button variant="outline" disabled={busy} onClick={() => answer("session")} className="h-8 text-xs">
					{t("session")}
				</Button>
				<Button variant="ghost" disabled={busy} onClick={() => answer("deny")} className="h-8 text-xs">
					{t("deny")}
				</Button>
				{error && (
					<span role="alert" className="text-xs text-rose-400">
						{t("answerFailed")}: {error}
					</span>
				)}
			</div>
		</div>
	);
}

/** Pending hand questions for the open session, and brief timeout notes. Renders nothing when there is nothing to show. */
export function HandBar() {
	const t = useT(M);
	const sessionId = useStore((s) => s.session?.id);
	const hands = useTeamExec((s) => s.hands);
	const links = useTeamExec((s) => s.links);
	const timedOut = useTeamExec((s) => s.timedOut);
	const dropTimedOut = useTeamExec((s) => s.dropTimedOut);

	// Each timeout note disappears on its own after a few seconds.
	useEffect(() => {
		if (timedOut.length === 0) return;
		const ids = timedOut.map((h) => window.setTimeout(() => dropTimedOut(h.callId), TIMEOUT_NOTE_MS));
		return () => {
			for (const id of ids) window.clearTimeout(id);
		};
	}, [timedOut, dropTimedOut]);

	const mine = handsForSession(hands, links, sessionId);
	const notes = handsForSession(timedOut, links, sessionId);
	if (mine.length === 0 && notes.length === 0) return null;
	const [first, ...rest] = mine;

	return (
		<div role="region" aria-label={t("region")} className="chat-col mx-auto w-full space-y-1.5 px-5 pb-2">
			{first && <HandCard key={first.callId} item={first} />}
			{rest.length > 0 && <p className="px-1 text-xs text-ink-400">{t("more", { n: rest.length })}</p>}
			{notes.map((h) => (
				<p key={h.callId} role="status" className="flex items-center gap-1.5 px-1 text-xs text-ink-400">
					<TimerOff className="size-3.5" aria-hidden /> {t("timedOut", { tool: h.tool })}
				</p>
			))}
		</div>
	);
}
