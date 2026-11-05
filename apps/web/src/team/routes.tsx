// The team UI route table. The shell (TeamShell) renders the left nav and the page from this list only, so adding a
// page means adding an entry here. Entries marked `slot: true` are placeholders that part 2 (2E-2) replaces by
// swapping their `component`; their ids (see ./slots.tsx SLOT) are the stable contract.
import { Activity, Building2, Cpu, Gauge, LayoutDashboard, type LucideIcon, Mailbox, ScrollText, Settings2, ShieldCheck, UserCog, Users } from "lucide-react";
import type { ComponentType } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { canSeeAdmin, isOperator } from "./context.tsx";
import { AuditPage } from "./pages/admin/AuditPage.tsx";
import { InvitationsPage } from "./pages/admin/InvitationsPage.tsx";
import { OrgsPage } from "./pages/admin/OrgsPage.tsx";
import { RegistrationPage } from "./pages/admin/RegistrationPage.tsx";
import { SettingsPage } from "./pages/admin/SettingsPage.tsx";
import { UsersPage } from "./pages/admin/UsersPage.tsx";
import { MergeRequestPage } from "./pages/MergeRequestPage.tsx";
import { TeamDetailPage } from "./pages/TeamDetailPage.tsx";
import { TeamsPage } from "./pages/TeamsPage.tsx";
import { WorkspacePage } from "./pages/WorkspacePage.tsx";
import { ComingSoon, SLOT } from "./slots.tsx";
import type { MeResult } from "./types.ts";

export const N = defineMessages({
	zh: {
		teamHome: "团队首页",
		teams: "团队",
		admin: "管理后台",
		users: "用户",
		registration: "注册策略",
		invitations: "邀请",
		orgs: "企业与成员",
		settings: "平台设置",
		audit: "审计日志",
		gateways: "模型网关",
		quotas: "配额",
		usage: "用量统计",
		session: "会话",
		notifications: "通知",
	},
	en: {
		teamHome: "Team home",
		teams: "Teams",
		admin: "Administration",
		users: "Users",
		registration: "Registration",
		invitations: "Invitations",
		orgs: "Organizations",
		settings: "Platform settings",
		audit: "Audit log",
		gateways: "Model gateways",
		quotas: "Quotas",
		usage: "Usage",
		session: "Session",
		notifications: "Notifications",
	},
});

export type NavKey = keyof typeof N.zh;

export interface TeamRoute {
	id: string;
	component: ComponentType;
	/** Present when the route has a left nav entry. */
	nav?: { group: "main" | "admin"; label: NavKey; icon: LucideIcon; visible?: (me: MeResult) => boolean };
	/** Title key for routes without a nav entry (used by the header). */
	title?: NavKey;
	/** Placeholder for part 2. */
	slot?: boolean;
}

/** Placeholder page factory for slots (stable component identity per slot). */
function slotPage(slot: string, label: NavKey): ComponentType {
	function SlotPage() {
		const t = useT(N);
		return <ComingSoon slot={slot} title={t(label)} />;
	}
	return SlotPage;
}

const operatorOnly = (me: MeResult) => isOperator(me);

export const TEAM_ROUTES: readonly TeamRoute[] = [
	// ---- part 1 pages ----
	{ id: "teams", component: TeamsPage, nav: { group: "main", label: "teams", icon: Users } },
	{ id: "team", component: TeamDetailPage, title: "teams" },
	{ id: "workspace", component: WorkspacePage, title: "teams" },
	{ id: "mergeRequest", component: MergeRequestPage, title: "teams" },
	{ id: "admin.users", component: UsersPage, nav: { group: "admin", label: "users", icon: UserCog, visible: canSeeAdmin } },
	{ id: "admin.registration", component: RegistrationPage, nav: { group: "admin", label: "registration", icon: ShieldCheck, visible: canSeeAdmin } },
	{ id: "admin.invitations", component: InvitationsPage, nav: { group: "admin", label: "invitations", icon: Mailbox, visible: canSeeAdmin } },
	{ id: "admin.orgs", component: OrgsPage, nav: { group: "admin", label: "orgs", icon: Building2, visible: canSeeAdmin } },
	{ id: "admin.settings", component: SettingsPage, nav: { group: "admin", label: "settings", icon: Settings2, visible: operatorOnly } },
	{ id: "admin.audit", component: AuditPage, nav: { group: "admin", label: "audit", icon: ScrollText, visible: canSeeAdmin } },

	// ---- EXTENSION SLOTS (part 2 replaces these components, keeps the ids) ----
	// Team home: daily report | board.
	{ id: SLOT.teamHome, component: slotPage(SLOT.teamHome, "teamHome"), nav: { group: "main", label: "teamHome", icon: LayoutDashboard }, slot: true },
	// Session viewer (spectate, fork, grant). Opened from the board and merge requests; no nav entry.
	{ id: SLOT.session, component: slotPage(SLOT.session, "session"), title: "session", slot: true },
	// Notifications list. The bell lives in the shell header (NotificationsBell in ./slots.tsx).
	{ id: SLOT.notifications, component: slotPage(SLOT.notifications, "notifications"), title: "notifications", slot: true },
	// Admin: model gateways, quotas, usage.
	{ id: SLOT.gateways, component: slotPage(SLOT.gateways, "gateways"), nav: { group: "admin", label: "gateways", icon: Cpu, visible: canSeeAdmin }, slot: true },
	{ id: SLOT.quotas, component: slotPage(SLOT.quotas, "quotas"), nav: { group: "admin", label: "quotas", icon: Gauge, visible: canSeeAdmin }, slot: true },
	{ id: SLOT.usage, component: slotPage(SLOT.usage, "usage"), nav: { group: "admin", label: "usage", icon: Activity, visible: canSeeAdmin }, slot: true },
];

export const DEFAULT_ROUTE_ID = "teams";

export const findRoute = (id: string): TeamRoute | undefined => TEAM_ROUTES.find((r) => r.id === id);

/** Nav entries the viewer may see, grouped. */
export function navFor(me: MeResult, group: "main" | "admin"): TeamRoute[] {
	return TEAM_ROUTES.filter((r) => r.nav?.group === group && (r.nav.visible?.(me) ?? true));
}
