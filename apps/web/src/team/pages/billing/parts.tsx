// Small pieces shared by the billing and BYOK pages.
import type { ReactNode } from "react";
import { Button, Dialog } from "../../../components/ui.tsx";
import { useCommonT } from "../../i18n.ts";
import { Notice } from "../../kit.tsx";

/** Centered confirmation for irreversible operator actions. `onConfirm` runs once; the caller closes the dialog afterwards. */
export function ConfirmDialog({
	title,
	body,
	confirmLabel,
	busy,
	error,
	onConfirm,
	onClose,
}: {
	title: string;
	body: ReactNode;
	confirmLabel: string;
	busy?: boolean;
	error?: string;
	onConfirm: () => void;
	onClose: () => void;
}) {
	const c = useCommonT();
	return (
		<Dialog title={title} onClose={onClose}>
			<div className="space-y-3 text-sm text-ink-200">{body}</div>
			{error && <Notice kind="error">{error}</Notice>}
			<div className="flex justify-end gap-2">
				<Button variant="ghost" onClick={onClose} disabled={busy}>
					{c("cancel")}
				</Button>
				<Button variant="destructive" onClick={onConfirm} disabled={busy} autoFocus>
					{confirmLabel}
				</Button>
			</div>
		</Dialog>
	);
}

/** A labelled figure for the balance and usage cards. */
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "warn" }) {
	return (
		<div className="min-w-0">
			<div className="text-xs font-medium tracking-wide text-ink-400">{label}</div>
			<div className={tone === "warn" ? "mt-1 font-display text-2xl font-semibold tabular-nums text-rose-400" : "mt-1 font-display text-2xl font-semibold tabular-nums text-ink-100"}>{value}</div>
			{hint && <div className="mt-0.5 text-xs text-ink-500">{hint}</div>}
		</div>
	);
}

/** A thin horizontal bar, `percent` 0..100. */
export function Meter({ percent, label }: { percent: number; label: string }) {
	return (
		<div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
			<div className="h-full rounded-full bg-ember-500" style={{ width: `${percent}%` }} />
		</div>
	);
}
