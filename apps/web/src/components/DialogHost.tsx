import { useEffect, useState } from "react";
import type { UIRequest } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { respondUI, useStore } from "../lib/store.ts";
import { Button, Input, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: { request: "扩展请求", cancel: "取消", confirm: "确认", submit: "提交" },
	en: { request: "Extension request", cancel: "Cancel", confirm: "Confirm", submit: "Submit" },
});

/** Renders blocking extension UI requests (select / confirm / input / editor) as modal dialogs. */
export function DialogHost() {
	const head = useStore((s) => s.uiQueue[0]);
	if (!head) return null;
	return <Dialog key={head.request.id} sessionId={head.sessionId} request={head.request} />;
}

function Dialog({ sessionId, request }: { sessionId: string; request: UIRequest }) {
	const t = useT(M);
	const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
	const cancel = () => void respondUI(sessionId, request.id, { cancelled: true });

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	const title = "title" in request ? request.title : "";

	return (
		<div className="fixed inset-0 z-40 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal>
			<div className="w-full max-w-lg animate-rise rounded-2xl border border-ink-700 bg-ink-900 p-5 shadow-2xl shadow-black/60">
				<div className="mb-1 font-mono text-[10.5px] tracking-widest text-ember-400 uppercase">{t("request")}</div>
				<h2 className="font-display text-lg font-semibold">{title}</h2>

				{request.method === "confirm" && (
					<>
						<p className="mt-2 text-sm whitespace-pre-wrap text-ink-300">{request.message}</p>
						<div className="mt-5 flex justify-end gap-2">
							<Button variant="outline" onClick={() => void respondUI(sessionId, request.id, { confirmed: false })}>
								{t("cancel")}
							</Button>
							<Button variant="primary" autoFocus onClick={() => void respondUI(sessionId, request.id, { confirmed: true })}>
								{t("confirm")}
							</Button>
						</div>
					</>
				)}

				{request.method === "select" && (
					<div className="mt-4 max-h-80 space-y-1 overflow-y-auto">
						{request.options.map((o, i) => (
							<button
								key={o}
								type="button"
								autoFocus={i === 0}
								onClick={() => void respondUI(sessionId, request.id, { value: o })}
								className="w-full rounded-lg border border-ink-800 px-3.5 py-2.5 text-left text-sm text-ink-200 hover:border-ember-500/40 hover:bg-ink-850 focus:border-ember-500/60 focus:outline-none"
							>
								{o}
							</button>
						))}
					</div>
				)}

				{(request.method === "input" || request.method === "editor") && (
					<form
						className="mt-4 space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							void respondUI(sessionId, request.id, { value });
						}}
					>
						{request.method === "input" ? (
							<Input autoFocus value={value} placeholder={request.placeholder} onChange={(e) => setValue(e.target.value)} />
						) : (
							<Textarea autoFocus rows={12} value={value} onChange={(e) => setValue(e.target.value)} className="font-mono text-xs" />
						)}
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={cancel}>
								{t("cancel")}
							</Button>
							<Button type="submit" variant="primary">
								{t("submit")}
							</Button>
						</div>
					</form>
				)}

				{request.method === "select" && (
					<div className="mt-4 flex justify-end">
						<Button variant="ghost" onClick={cancel}>
							{t("cancel")}
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
