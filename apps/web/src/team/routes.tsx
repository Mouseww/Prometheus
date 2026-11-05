// The team UI route table. The shell (TeamShell) renders the left nav and the page from this list only, so adding a
// page means adding an entry here. The ids in ./slots.tsx SLOT are the stable contract for navigating to part 2 pages.
import { Activity, ArrowRightLeft, Boxes, Building2, Cpu, Gauge, LayoutDashboard, type LucideIcon, Mailbox, MailX, MonitorCog, ScrollText, Server, Settings2, ShieldCheck, UserCog, UserRound, Users, Wallet } from "lucide-react";
import type { ComponentType } from "react";
import { defineMessages } from "../lib/i18n.ts";
import { canSeeAdmin, isOperator } from "./context.tsx";
import { AuditPage } from "./pages/admin/AuditPage.tsx";
import { DisposableDomainsPage } from "./pages/admin/DisposableDomainsPage.tsx";
import { TransfersPage } from "./pages/TransfersPage.tsx";
import { GatewaysPage } from "./pages/admin/GatewaysPage.tsx";
import { InvitationsPage } from "./pages/admin/InvitationsPage.tsx";
import { OrgsPage } from "./pages/admin/OrgsPage.tsx";
import { QuotasPage } from "./pages/admin/QuotasPage.tsx";
import { RegistrationPage } from "./pages/admin/RegistrationPage.tsx";
import { SettingsPage } from "./pages/admin/SettingsPage.tsx";
import { UsagePage } from "./pages/admin/UsagePage.tsx";
import { UsersPage } from "./pages/admin/UsersPage.tsx";
import { OpsBillingPage } from "./pages/billing/OpsBillingPage.tsx";
import { MySettingsPage } from "./pages/billing/MySettingsPage.tsx";
import { TeamHomePage } from "./pages/home/TeamHomePage.tsx";
import { MergeRequestPage } from "./pages/MergeRequestPage.tsx";
import { NotificationsPage } from "./pages/notifications/NotificationsPage.tsx";
import { SessionPage } from "./pages/session/SessionPage.tsx";
import { TeamDetailPage } from "./pages/TeamDetailPage.tsx";
import { TeamsPage } from "./pages/TeamsPage.tsx";
import { WorkbenchPage } from "./pages/WorkbenchPage.tsx";
import { WorkspacePage } from "./pages/WorkspacePage.tsx";
import { NodesPage } from "./pages/admin/NodesPage.tsx";
import { RuntimesPage } from "./pages/admin/RuntimesPage.tsx";
import { SLOT } from "./slots.tsx";
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
		mySettings: "个人设置",
		opsBilling: "运营",
		transfers: "团队转入",
		domains: "邮箱黑名单",
			workbench: "我的工作台",
			nodes: "执行节点",
			runtimes: "租户实例",
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
		mySettings: "My settings",
		opsBilling: "Operations",
		transfers: "Team transfers",
		domains: "Blocked email domains",
			workbench: "My workbench",
			nodes: "Executor nodes",
			runtimes: "Tenant instances",
	},
});

export type NavKey = keyof typeof N.zh;

/** Facts beyond the viewer that decide nav visibility. `billing` is false until the one-time probe says billing is on. */
export interface NavFlags {
	billing: boolean;
	/** The Hub runs in public (online service) mode. */
	publicMode?: boolean;
	/** The page is the Hub's own web UI (not the embedded member view): only there can the tenant workbench be opened. */
	hubMode?: boolean;
}

export interface TeamRoute {
	id: string;
	component: ComponentType;
	/** Present when the route has a left nav entry. */
	nav?: { group: "main" | "admin"; label: NavKey; icon: LucideIcon; visible?: (me: MeResult, flags: NavFlags) => boolean };
	/** Title key for routes without a nav entry (used by the header). */
	title?: NavKey;
}

const operatorOnly = (me: MeResult) => isOperator(me);
/** The transfer inbox is for people who can send a personal team into an organization or decide on one. */
const canUseTransfers = (me: MeResult): boolean => isOperator(me) || me.orgs.length > 0 || me.teams.some((t) => t.orgId === null);

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

	// ---- part 2 pages (ids reserved by ./slots.tsx) ----
	// Team home: daily report | board.
	{ id: SLOT.teamHome, component: TeamHomePage, nav: { group: "main", label: "teamHome", icon: LayoutDashboard } },
	// Session viewer (spectate, fork, grant). Opened from the board and merge requests; no nav entry.
	{ id: SLOT.session, component: SessionPage, title: "session" },
	// Notifications list. The bell lives in the shell header (NotificationsBell in ./slots.tsx).
	{ id: SLOT.notifications, component: NotificationsPage, title: "notifications" },
	// Admin: model gateways, quotas, usage.
	{ id: SLOT.gateways, component: GatewaysPage, nav: { group: "admin", label: "gateways", icon: Cpu, visible: canSeeAdmin } },
	{ id: SLOT.quotas, component: QuotasPage, nav: { group: "admin", label: "quotas", icon: Gauge, visible: canSeeAdmin } },
	{ id: SLOT.usage, component: UsagePage, nav: { group: "admin", label: "usage", icon: Activity, visible: canSeeAdmin } },

	// ---- part 4D: personal settings (BYOK models, credits and billing) and the operator billing console ----
	{ id: SLOT.mySettings, component: MySettingsPage, nav: { group: "main", label: "mySettings", icon: UserRound } },
	{ id: SLOT.opsBilling, component: OpsBillingPage, nav: { group: "admin", label: "opsBilling", icon: Wallet, visible: operatorOnly } },

	// ---- part 4D-2: online service (team transfer inbox, operator disposable-domain list) ----
	{ id: SLOT.transfers, component: TransfersPage, nav: { group: "main", label: "transfers", icon: ArrowRightLeft, visible: (me) => canUseTransfers(me) } },
	{ id: SLOT.domains, component: DisposableDomainsPage, nav: { group: "admin", label: "domains", icon: MailX, visible: (me, flags) => isOperator(me) && flags.publicMode === true } },

	// ---- block 3C: tenant runtimes ----
	{ id: "workbench", component: WorkbenchPage, nav: { group: "main", label: "workbench", icon: MonitorCog, visible: (_me, flags) => flags.hubMode === true } },
	{ id: "admin.nodes", component: NodesPage, nav: { group: "admin", label: "nodes", icon: Server, visible: operatorOnly } },
	{ id: "admin.runtimes", component: RuntimesPage, nav: { group: "admin", label: "runtimes", icon: Boxes, visible: operatorOnly } },
];

export const DEFAULT_ROUTE_ID = "teams";

export const findRoute = (id: string): TeamRoute | undefined => TEAM_ROUTES.find((r) => r.id === id);

/** Nav entries the viewer may see, grouped. */
export function navFor(me: MeResult, group: "main" | "admin", flags: NavFlags = { billing: false }): TeamRoute[] {
	return TEAM_ROUTES.filter((r) => r.nav?.group === group && (r.nav.visible?.(me, flags) ?? true));
}
