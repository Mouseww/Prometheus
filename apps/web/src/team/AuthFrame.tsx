// The centered card every signed-out screen of the Hub web UI sits in.
import type { ReactNode } from "react";
import { Flame } from "../components/ui.tsx";
import { defineMessages, useT } from "../lib/i18n.ts";

const M = defineMessages({
	zh: { subtitle: "团队协作 Hub" },
	en: { subtitle: "Team collaboration Hub" },
});

export function AuthFrame({ children }: { children: ReactNode }) {
	const t = useT(M);
	return (
		<div className="forge-bg flex h-full items-center justify-center overflow-y-auto p-4">
			<div className="sheen w-full max-w-md space-y-5 rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-2xl shadow-black/50">
				<div className="flex items-center gap-3">
					<Flame className="size-9" />
					<div>
						<h1 className="font-display text-xl font-semibold tracking-tight">Prometheus Hub</h1>
						<p className="text-xs text-ink-400">{t("subtitle")}</p>
					</div>
				</div>
				{children}
			</div>
		</div>
	);
}
