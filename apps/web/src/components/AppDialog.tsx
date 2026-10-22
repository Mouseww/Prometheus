import { CircleHelp, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { defineMessages, useT } from "../lib/i18n.ts";
import { type AppDialogRequest, settleDialog, useDialogs } from "../lib/dialogs.ts";
import { Button, Input } from "./ui.tsx";

const M = defineMessages({
	zh: { cancel: "取消", ok: "确定", confirmTitle: "请确认", promptTitle: "请输入" },
	en: { cancel: "Cancel", ok: "OK", confirmTitle: "Please confirm", promptTitle: "Enter a value" },
});

/** Renders confirm/prompt requests made through lib/dialogs, one at a time, above everything else. */
export function AppDialogHost() {
	const head = useDialogs((s) => s.queue[0]);
	return head ? <AppDialog key={head.id} req={head} /> : null;
}

function AppDialog({ req }: { req: AppDialogRequest }) {
	const t = useT(M);
	const [value, setValue] = useState(req.defaultValue ?? "");
	const okRef = useRef<HTMLButtonElement>(null);
	const cancel = () => settleDialog(req.id, req.kind === "confirm" ? false : null);
	const accept = () => settleDialog(req.id, req.kind === "confirm" ? true : value.trim() || null);

	useEffect(() => {
		if (req.kind === "confirm") okRef.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				cancel();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const Icon = req.danger ? TriangleAlert : CircleHelp;
	return createPortal(
		<div className="fixed inset-0 z-[60] grid place-items-center bg-ink-950/60 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
			<form
				role="alertdialog"
				aria-modal
				className="w-full max-w-sm animate-rise space-y-4 rounded-2xl border border-ink-700 bg-ink-900 p-5 shadow-2xl shadow-black/50"
				onSubmit={(e) => {
					e.preventDefault();
					accept();
				}}
			>
				<div className="flex items-start gap-3">
					<span className={`grid size-9 shrink-0 place-items-center rounded-xl ${req.danger ? "bg-rose-400/12 text-rose-400" : "bg-ember-500/12 text-ember-400"}`}>
						<Icon className="size-5" />
					</span>
					<div className="min-w-0 flex-1">
						<h2 className="font-display text-base font-semibold">{req.title ?? (req.kind === "confirm" ? t("confirmTitle") : t("promptTitle"))}</h2>
						<p className="mt-1 text-sm break-words whitespace-pre-wrap text-ink-300">{req.message}</p>
					</div>
				</div>
				{req.kind === "prompt" && <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} />}
				<div className="flex justify-end gap-2">
					<Button onClick={cancel}>{t("cancel")}</Button>
					<Button ref={okRef} type="submit" variant={req.danger ? "destructive" : "primary"}>
						{req.confirmLabel ?? t("ok")}
					</Button>
				</div>
			</form>
		</div>,
		document.body,
	);
}
