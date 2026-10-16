import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { useStore } from "../lib/store.ts";

export function Toasts() {
	const toasts = useStore((s) => s.toasts);
	return (
		<div className="pointer-events-none fixed right-3 bottom-3 left-3 z-50 flex flex-col gap-2 md:right-5 md:bottom-5 md:left-auto md:w-80" aria-live="polite">
			{toasts.map((t) => (
				<div
					key={t.id}
					className={clsx(
						"pointer-events-auto flex animate-rise items-start gap-2.5 rounded-xl border bg-ink-900/95 px-3.5 py-3 text-sm shadow-2xl shadow-black/40 backdrop-blur",
						t.level === "error" ? "border-rose-400/30" : t.level === "warning" ? "border-ember-300/30" : "border-ink-700",
					)}
				>
					{t.level === "error" ? (
						<AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-400" />
					) : t.level === "warning" ? (
						<Info className="mt-0.5 size-4 shrink-0 text-ember-300" />
					) : (
						<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-moss-400" />
					)}
					<span className="break-words text-ink-200">{t.message}</span>
				</div>
			))}
		</div>
	);
}
