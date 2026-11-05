// Route ids of the pages that part 1 reserved and part 2 (2E-2) implemented. The ids are a stable contract with
// other code that navigates by them (`navigate({ page: SLOT.session, params: { sessionId } })`).
import { Clock } from "lucide-react";
import { Empty, PageHeader } from "../components/ui.tsx";
import { useCommonT } from "./i18n.ts";
import { Body } from "./kit.tsx";

export const SLOT = {
	teamHome: "teamHome",
	session: "session",
	notifications: "notifications",
	gateways: "admin.gateways",
	quotas: "admin.quotas",
	usage: "admin.usage",
	mySettings: "settings.me",
	opsBilling: "admin.billing",
	transfers: "transfers",
	domains: "admin.domains",
} as const;

export { NotificationsBell } from "./pages/notifications/NotificationsBell.tsx";

/** Neutral "coming soon" page, for routes that are registered before their page exists. `title` is the translated page name. */
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
