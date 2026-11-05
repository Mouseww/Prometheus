import clsx from "clsx";
import { defineMessages, relativeTime, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { notificationText } from "./text.ts";
import type { NotificationView } from "../../types.ts";

const M = defineMessages({
	zh: { unread: "未读" },
	en: { unread: "Unread" },
});

/** The rows shared by the dropdown and the full page. */
export function NotificationList({ items, onOpen, className }: { items: NotificationView[]; onOpen: (n: NotificationView) => void; className?: string }) {
	const t = useT(M);
	const lang = usePrefs((s) => s.lang);
	return (
		<ul className={clsx("divide-y divide-ink-800", className)}>
			{items.map((n) => (
				<li key={n.id}>
					<button
						type="button"
						onClick={() => onOpen(n)}
						className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-ink-850 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ember-400"
					>
						<span className={clsx("mt-1.5 size-2 shrink-0 rounded-full", n.readAt === null ? "bg-ember-400" : "bg-transparent")} role={n.readAt === null ? "img" : undefined} aria-label={n.readAt === null ? t("unread") : undefined} />
						<span className="min-w-0 flex-1">
							<span className={clsx("block text-sm break-words", n.readAt === null ? "text-ink-100" : "text-ink-300")}>{notificationText(n, lang)}</span>
							<span className="block text-xs text-ink-500">{relativeTime(n.createdAt, lang)}</span>
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}
