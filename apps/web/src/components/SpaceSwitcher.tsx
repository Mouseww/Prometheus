import clsx from "clsx";
import { Briefcase, User } from "lucide-react";
import { useMemo } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { type Space, spaceOf } from "../lib/spaces.ts";
import { setSpace, useSpace, useStore } from "../lib/store.ts";

const M = defineMessages({
	zh: { personal: "个人", work: "工作", hint: "Ctrl+1 个人 · Ctrl+2 工作", waiting: "另一边有 {n} 个对话有新结果" },
	en: { personal: "Personal", work: "Work", hint: "Ctrl+1 personal · Ctrl+2 work", waiting: "{n} chat(s) on the other side have news" },
});

/** Two-way switch at the top of the sidebar. The badge counts finished or failed runs the user has not looked at in the other space. */
export function SpaceSwitcher() {
	const t = useT(M);
	const space = useSpace();
	const home = useStore((s) => s.assistant?.home ?? null);
	const sessions = useStore((s) => s.sessions);
	const marks = useStore((s) => s.marks);
	// Computed here, not in the selector: a selector that returns a new object every time makes the store re-render forever.
	const unseen = useMemo(() => {
		const n: Record<Space, number> = { personal: 0, work: 0 };
		for (const sess of sessions) if (marks[sess.id]) n[spaceOf(sess.cwd, home)]++;
		return n;
	}, [sessions, marks, home]);
	const items: { id: Space; label: string; icon: typeof User }[] = [
		{ id: "personal", label: t("personal"), icon: User },
		{ id: "work", label: t("work"), icon: Briefcase },
	];
	return (
		<div role="tablist" title={t("hint")} className="grid grid-cols-2 rounded-lg border border-ink-800 bg-ink-950/70 p-0.5">
			{items.map(({ id, label, icon: Icon }) => {
				const on = space === id;
				const n = on ? 0 : unseen[id];
				return (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={on}
						title={n ? t("waiting", { n }) : undefined}
						onClick={() => void setSpace(id)}
						className={clsx(
							"relative flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[13px] transition-colors",
							on ? "bg-ink-800 text-ink-100 shadow-sm" : "text-ink-400 hover:text-ink-200",
						)}
					>
						<Icon className={clsx("size-3.5", on && (id === "personal" ? "text-ember-400" : "text-sky-400"))} />
						{label}
						{n > 0 && <span className="absolute top-0.5 right-1.5 min-w-4 rounded-full bg-ember-500 px-1 text-center font-mono text-[9.5px] leading-4 font-semibold text-white">{n}</span>}
					</button>
				);
			})}
		</div>
	);
}
