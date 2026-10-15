import clsx from "clsx";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Button({ variant = "ghost", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "outline" }) {
	return (
		<button
			type="button"
			{...props}
			className={clsx(
				"inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
				"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember-400",
				variant === "primary" && "bg-ember-500 text-ink-950 hover:bg-ember-400",
				variant === "ghost" && "text-ink-300 hover:bg-ink-800 hover:text-ink-100",
				variant === "outline" && "border border-ink-700 text-ink-200 hover:border-ink-500 hover:bg-ink-850",
				variant === "danger" && "text-rose-400 hover:bg-rose-400/10",
				className,
			)}
		/>
	);
}

const fieldClass =
	"w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 transition-colors focus:border-ember-500/70 focus:outline-none focus:ring-2 focus:ring-ember-500/15";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return <input {...props} className={clsx(fieldClass, className)} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return <textarea {...props} className={clsx(fieldClass, "resize-y", className)} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
	return <select {...props} className={clsx(fieldClass, "appearance-none pr-8", className)} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<label className="block space-y-1.5">
			<span className="text-xs font-medium tracking-wide text-ink-300">{label}</span>
			{children}
			{hint && <span className="block text-xs text-ink-500">{hint}</span>}
		</label>
	);
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
	return (
		<header className="flex items-end justify-between gap-4 border-b hairline px-8 pt-8 pb-5">
			<div>
				<h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
				{subtitle && <p className="mt-1 text-sm text-ink-400">{subtitle}</p>}
			</div>
			{actions}
		</header>
	);
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "ember" | "moss" | "rose" | "sky" }) {
	return (
		<span
			className={clsx(
				"inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-medium tracking-wide uppercase",
				tone === "muted" && "bg-ink-800 text-ink-300",
				tone === "ember" && "bg-ember-500/12 text-ember-300",
				tone === "moss" && "bg-moss-400/12 text-moss-400",
				tone === "rose" && "bg-rose-400/12 text-rose-400",
				tone === "sky" && "bg-sky-400/12 text-sky-400",
			)}
		>
			{children}
		</span>
	);
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
			<div className="grid size-12 place-items-center rounded-2xl border border-ink-700 bg-ink-900 text-ember-400">{icon}</div>
			<h3 className="font-display text-lg font-semibold">{title}</h3>
			{children && <div className="max-w-sm text-sm text-ink-400">{children}</div>}
		</div>
	);
}

export function Flame({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 32 32" className={className} aria-hidden>
			<defs>
				<linearGradient id="flame-g" x1="0" y1="1" x2="0" y2="0">
					<stop offset="0" stopColor="#ff5a1f" />
					<stop offset="1" stopColor="#ffc061" />
				</linearGradient>
			</defs>
			<path
				className="origin-bottom animate-flicker"
				d="M16 3c1.9 5 7.7 7.8 7.7 14.4A7.7 7.7 0 0 1 16 25.1a7.7 7.7 0 0 1-7.7-7.7c0-3.5 1.9-5.4 3.5-7.1.4 2.4 1.4 3.8 3 4.3C13.8 11 14.3 6.6 16 3Z"
				fill="url(#flame-g)"
			/>
			<rect x="8" y="27" width="16" height="2.2" rx="1.1" fill="#ff7a2f" opacity=".55" />
		</svg>
	);
}
