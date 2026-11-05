// What a granted user can do to someone else's session: send a prompt, answer pending requests, abort.
// Everything goes through the Hub relay, so the owner's machine must be online (errors are explained, see ../../i18n.ts).
import { Send } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useState } from "react";
import { Button, Input, Textarea } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useTeam } from "../../context.tsx";
import { ConfirmButton, Notice, useAction } from "../../kit.tsx";
import { type RequestItem, responseFor } from "../../logic/transcript.ts";

const M = defineMessages({
	zh: {
		prompt: "发给这个会话的消息",
		placeholder: "以被授权人的身份发送消息，所有者的会话里会标注来自你",
		send: "发送",
		abort: "中断",
		abortConfirm: "确认中断",
		sent: "已发送",
		aborted: "已请求中断",
		allow: "允许",
		deny: "拒绝",
		approvePlan: "批准计划",
		keepPlan: "继续规划",
		yes: "是",
		no: "否",
		answer: "回答",
		submit: "提交",
		cancelRequest: "取消请求",
		answered: "已回复",
		inputLabel: "回答",
	},
	en: {
		prompt: "Message to this session",
		placeholder: "Sends as a granted user. The owner's session shows it came from you.",
		send: "Send",
		abort: "Abort",
		abortConfirm: "Confirm abort",
		sent: "Sent",
		aborted: "Abort requested",
		allow: "Allow",
		deny: "Deny",
		approvePlan: "Approve plan",
		keepPlan: "Keep planning",
		yes: "Yes",
		no: "No",
		answer: "Answer",
		submit: "Submit",
		cancelRequest: "Cancel request",
		answered: "Answered",
		inputLabel: "Answer",
	},
});

/** Answer buttons of one pending UI request. */
export function RequestActions({ sessionId, item }: { sessionId: string; item: RequestItem }) {
	const { api } = useTeam();
	const t = useT(M);
	const { busy, error, run } = useAction();
	const [text, setText] = useState("");
	const [done, setDone] = useState(false);

	const respond = async (response: unknown) => {
		const r = await run(() => api.sendSessionAction(sessionId, { type: "respond", requestId: item.requestId, response }));
		if (r !== undefined) setDone(true);
	};

	let body: ReactNode;
	if (item.method === "select" && item.options.length > 0) {
		body = item.options.map((o) => (
			<Button key={o} variant="outline" disabled={busy} onClick={() => void respond({ value: o })}>
				{o}
			</Button>
		));
	} else if (item.method === "input" || item.method === "editor") {
		body = (
			<form
				className="flex w-full items-center gap-2"
				onSubmit={(e: FormEvent) => {
					e.preventDefault();
					void respond({ value: text });
				}}
			>
				<Input aria-label={t("inputLabel")} value={text} onChange={(e) => setText(e.target.value)} className="min-w-0 flex-1 py-1.5" />
				<Button type="submit" variant="primary" disabled={busy}>
					{t("submit")}
				</Button>
			</form>
		);
	} else {
		const plan = item.method === "permission" && item.requestKind === "plan";
		const confirm = item.method === "confirm";
		body = (
			<>
				<Button variant="primary" disabled={busy} onClick={() => void respond(responseFor(item, "approve"))}>
					{plan ? t("approvePlan") : confirm ? t("yes") : t("allow")}
				</Button>
				<Button variant="outline" disabled={busy} onClick={() => void respond(responseFor(item, "deny"))}>
					{plan ? t("keepPlan") : confirm ? t("no") : t("deny")}
				</Button>
			</>
		);
	}

	if (done) return <p className="mt-2 text-xs text-moss-400">{t("answered")}</p>;
	return (
		<div className="mt-2.5 space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				{body}
				<Button variant="ghost" disabled={busy} onClick={() => void respond({ cancelled: true })}>
					{t("cancelRequest")}
				</Button>
			</div>
			{error && <Notice kind="error">{error}</Notice>}
		</div>
	);
}

/** Prompt box and abort button for granted users (and the owner viewing from the Hub). */
export function PromptBar({ sessionId }: { sessionId: string }) {
	const { api } = useTeam();
	const t = useT(M);
	const [text, setText] = useState("");
	const send = useAction();
	const abort = useAction();
	const [note, setNote] = useState<string | undefined>(undefined);

	const submit = async () => {
		const body = text.trim();
		if (!body) return;
		setNote(undefined);
		const r = await send.run(() => api.sendSessionAction(sessionId, { type: "prompt", text: body }));
		if (r !== undefined) {
			setText("");
			setNote(t("sent"));
		}
	};

	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void submit();
		}
	};

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
			className="space-y-2 border-t hairline bg-ink-900/60 px-4 py-3 @3xl:px-8"
		>
			<Textarea aria-label={t("prompt")} placeholder={t("placeholder")} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={2} maxLength={100000} />
			<div className="flex flex-wrap items-center gap-2">
				<Button type="submit" variant="primary" disabled={send.busy || !text.trim()}>
					<Send className="size-4" aria-hidden /> {t("send")}
				</Button>
				<ConfirmButton
					label={t("abort")}
					confirmLabel={t("abortConfirm")}
					disabled={abort.busy}
					onConfirm={() => {
						setNote(undefined);
						void abort.run(() => api.sendSessionAction(sessionId, { type: "abort" })).then((r) => r !== undefined && setNote(t("aborted")));
					}}
				/>
				{note && <Notice kind="ok">{note}</Notice>}
				{(send.error || abort.error) && <Notice kind="error">{send.error ?? abort.error}</Notice>}
			</div>
		</form>
	);
}
