// EXTENSION SLOTS for part 2 (2E-2). Each component here is a neutral placeholder. Part 2 replaces the component
// referenced from the matching route entry in ./routes.tsx (or this file's NotificationsBell) and leaves the route id as is.
import { Bell, Clock } from "lucide-react";
import { Empty, PageHeader } from "../components/ui.tsx";
import { useCommonT } from "./i18n.ts";
import { useTeam } from "./context.tsx";
import { Body } from "./kit.tsx";

/** Route ids reserved for part 2. Navigate with `navigate({ page: SLOT.session, params: { sessionId } })`. */
export const SLOT = {
	teamHome: "teamHome",
	session: "session",
	notifications: "notifications",
	gateways: "admin.gateways",
	quotas: "admin.quotas",
	usage: "admin.usage",
} as const;

/** Neutral "coming soon" page. `title` is the already translated page name. */
export function ComingSoon({ slot, title }: { slot: string; title: string }) {
	const t = useCommonT();
	return (
		<div data-team-slot={slot} className="flex min-h-0 flex-1 flex-col">
			<PageHeader title={title} />
			<Body>
				<Empty icon={<Clock className="size-5" />} title={t("comingSoon")}>
					{t("comingSoonBody")}
				</Empty>
			</Body>
		</div>
	);
}

/** Top bar bell. SLOT (part 2): replace with the unread-count bell and the notification list popover. */
export function NotificationsBell() {
	const { navigate } = useTeam();
	const t = useCommonT();
	return (
		<button
			type="button"
			data-team-slot={SLOT.notifications}
			aria-label={t("notifications")}
			onClick={() => navigate({ page: SLOT.notifications })}
			className="rounded-lg p-2 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-ember-400"
		>
			<Bell className="size-4" aria-hidden />
		</button>
	);
}
