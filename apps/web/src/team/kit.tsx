// Small building blocks shared by the team pages: async loading, states, confirm buttons, tables.
import clsx from "clsx";
import { AlertTriangle, Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui.tsx";
import { errorText, useCommonT } from "./i18n.ts";

export interface AsyncState<T> {
	data: T | undefined;
	error: string | undefined;
	loading: boolean;
	reload: () => void;
	setData: (next: T) => void;
}

/** Runs `load` on mount and whenever `deps` change; stale responses are dropped. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
	const [data, setData] = useState<T | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const [tick, setTick] = useState(0);
	const seq = useRef(0);
	const loadRef = useRef(load);
	loadRef.current = load;

	// biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller's explicit trigger list
	useEffect(() => {
		const mine = ++seq.current;
		setLoading(true);
		loadRef
			.current()
			.then((d) => {
				if (mine !== seq.current) return;
				setData(d);
				setError(undefined);
			})
			.catch((e: unknown) => {
				if (mine === seq.current) setError(errorText(e));
			})
			.finally(() => {
				if (mine === seq.current) setLoading(false);
			});
		return () => {
			seq.current += 1;
		};
	}, [...deps, tick]);

	return { data, error, loading, reload: useCallback(() => setTick((n) => n + 1), []), setData };
}

/** Loading spinner, error with retry, or the children once data is there. Empty handling stays with the caller. */
export function AsyncView<T>({ state, children }: { state: AsyncState<T>; children: (data: T) => ReactNode }) {
	const t = useCommonT();
	if (state.data === undefined) {
		if (state.error) return <ErrorBox message={state.error} onRetry={state.reload} />;
		return (
			<div role="status" aria-live="polite" className="flex items-center justify-center gap-2 py-16 text-sm text-ink-400">
				<Loader2 className="size-4 animate-spin" aria-hidden /> {t("loading")}
			</div>
		);
	}
	return (
		<>
			{state.error && <ErrorBox message={state.error} onRetry={state.reload} compact />}
			{children(state.data)}
		</>
	);
}

export function ErrorBox({ message, onRetry, compact }: { message: string; onRetry?: () => void; compact?: boolean }) {
	const t = useCommonT();
	return (
		<div role="alert" className={clsx("flex items-start gap-2.5 rounded-lg border border-rose-400/30 bg-rose-400/8 px-3 py-2.5 text-sm text-rose-400", compact ? "mb-3" : "mx-auto my-8 max-w-lg")}>
			<AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
			<span className="min-w-0 flex-1 break-words">{message}</span>
			{onRetry && (
				<button type="button" onClick={onRetry} className="shrink-0 rounded px-1.5 font-medium underline underline-offset-2 hover:text-rose-300">
					{t("retry")}
				</button>
			)}
		</div>
	);
}

/** One-line result of an action: green for success, red for failure. */
export function Notice({ kind, children }: { kind: "ok" | "error"; children: ReactNode }) {
	return (
		<p role={kind === "error" ? "alert" : "status"} className={clsx("rounded-lg px-3 py-2 text-sm", kind === "error" ? "bg-rose-400/10 text-rose-400" : "bg-moss-400/10 text-moss-400")}>
			{children}
		</p>
	);
}

/** Runs an async action with a busy flag and an error message. */
export function useAction() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
		setBusy(true);
		setError(undefined);
		try {
			return await fn();
		} catch (e) {
			setError(errorText(e));
			return undefined;
		} finally {
			setBusy(false);
		}
	}, []);
	return { busy, error, run, clearError: () => setError(undefined) };
}

/** Destructive button that asks for a second click before it runs. */
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, variant = "danger" }: { label: string; confirmLabel?: string; onConfirm: () => void; disabled?: boolean; variant?: "danger" | "destructive" }) {
	const t = useCommonT();
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		if (!armed) return;
		const id = window.setTimeout(() => setArmed(false), 4000);
		return () => window.clearTimeout(id);
	}, [armed]);
	return (
		<Button
			variant={armed ? "destructive" : variant}
			disabled={disabled}
			onClick={() => {
				if (!armed) return setArmed(true);
				setArmed(false);
				onConfirm();
			}}
		>
			{armed ? (confirmLabel ?? t("confirm")) : label}
		</Button>
	);
}

/** Page body padding used by every team page. */
export function Body({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={clsx("min-h-0 flex-1 overflow-y-auto px-4 py-4 @3xl:px-8 @3xl:py-6", className)}>{children}</div>;
}

export function Card({ title, actions, children, className }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
	return (
		<section className={clsx("rounded-xl border border-ink-700 bg-ink-900/60", className)}>
			{(title || actions) && (
				<div className="flex items-center justify-between gap-3 border-b hairline px-4 py-2.5">
					{title && <h2 className="font-display text-sm font-semibold tracking-wide text-ink-200">{title}</h2>}
					{actions && <div className="flex items-center gap-2">{actions}</div>}
				</div>
			)}
			<div className="p-4">{children}</div>
		</section>
	);
}

export function Tabs<K extends string>({ tabs, value, onChange, label }: { tabs: readonly { id: K; label: string }[]; value: K; onChange: (id: K) => void; label: string }) {
	return (
		<div role="tablist" aria-label={label} className="mb-4 flex flex-wrap gap-1 border-b hairline">
			{tabs.map((tab) => (
				<button
					key={tab.id}
					type="button"
					role="tab"
					aria-selected={value === tab.id}
					onClick={() => onChange(tab.id)}
					className={clsx(
						"-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ember-400",
						value === tab.id ? "border-ember-500 text-ink-100" : "border-transparent text-ink-400 hover:text-ink-100",
					)}
				>
					{tab.label}
				</button>
			))}
		</div>
	);
}

/** Responsive table wrapper with the shared look. */
export function Table({ head, children, label }: { head: readonly string[]; children: ReactNode; label: string }) {
	return (
		<div className="overflow-x-auto rounded-xl border border-ink-700">
			<table aria-label={label} className="w-full min-w-[32rem] text-left text-sm">
				<thead className="bg-ink-850 text-xs tracking-wide text-ink-400">
					<tr>
						{head.map((h, i) => (
							<th key={`${h}-${i}`} scope="col" className="px-3 py-2 font-medium">
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="divide-y divide-ink-800">{children}</tbody>
			</table>
		</div>
	);
}

export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => <td className={clsx("px-3 py-2 align-middle", className)}>{children}</td>;

export function shortDate(iso: string | null | undefined, lang: string): string {
	if (!iso) return "-";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(lang === "zh" ? "zh" : "en", { dateStyle: "medium", timeStyle: "short" });
}
