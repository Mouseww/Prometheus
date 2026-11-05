// Layout shared by Hub mode and member mode: header (context, bell, user menu slot), left nav and the routed page.
import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import type { TeamApi } from "./api.ts";
import { type MemberPlugin, type Route, TeamContext, type TeamContextValue } from "./context.tsx";
import { useCommonT } from "./i18n.ts";
import { ErrorBox, useAsync } from "./kit.tsx";
import { DEFAULT_ROUTE_ID, findRoute, N, navFor, type TeamRoute } from "./routes.tsx";
import { ContextSwitcher } from "./ContextSwitcher.tsx";
import { probeBilling } from "./logic/billing.ts";
import { billingFromMeta, isPublicMode, SCOPE_ALL, validScope } from "./logic/publicMode.ts";
import { NotificationsBell } from "./slots.tsx";
import type { MetaInfo } from "./types.ts";
import { VerifyBanner } from "./VerifyBanner.tsx";

const M = defineMessages({
	zh: { nav: "团队导航", admin: "管理后台", brand: "团队", orgs: "企业", unknownPage: "页面不存在" },
	en: { nav: "Team navigation", admin: "Administration", brand: "Team", orgs: "Organization", unknownPage: "Page not found" },
});

/** Detail pages highlight the nav entry they belong to. */
const NAV_PARENT: Record<string, string> = { team: "teams", workspace: "teams", mergeRequest: "teams", session: "teamHome", notifications: "teamHome" };

export interface TeamShellProps {
	api: TeamApi;
	mode: "hub" | "member";
	/** Member mode: local plugin RPC and navigation (checkout, start/fork session, resolve binary conflicts). */
	plugin?: MemberPlugin;
	/** Rendered at the right end of the header (Hub mode: the user menu). */
	topRight?: (ctx: { reloadMe: () => void }) => ReactNode;
	initialRoute?: Route;
	/** Hub mode: the public /api/meta answer. It decides billing visibility without a billing call, and feeds the account banners. */
	hubMeta?: MetaInfo;
	/** Hub mode: mails a new verification link. */
	resendVerification?: (email: string) => Promise<void>;
}

function NavButton({ route, active, onClick }: { route: TeamRoute; active: boolean; onClick: () => void }) {
	const t = useT(N);
	const Icon = route.nav?.icon;
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			className={clsx(
				"flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ember-400 @3xl:w-full",
				active ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:bg-ink-850 hover:text-ink-100",
			)}
		>
			{Icon && <Icon className={clsx("size-4", active && "text-ember-400")} aria-hidden />}
			{route.nav && t(route.nav.label)}
		</button>
	);
}

export function TeamShell({ api, mode, plugin, topRight, initialRoute, hubMeta, resendVerification }: TeamShellProps) {
	const t = useT(M);
	const c = useCommonT();
	const me = useAsync(() => api.me(), [api]);
	const [stack, setStack] = useState<Route[]>([initialRoute ?? { page: DEFAULT_ROUTE_ID }]);
	const route = stack[stack.length - 1] as Route;

	const navigate = useCallback((next: Route) => setStack((s) => [...s, next]), []);
	const back = useCallback((fallback: Route) => setStack((s) => (s.length > 1 ? s.slice(0, -1) : [fallback])), []);
	const goRoot = useCallback((next: Route) => setStack([next]), []);
	const reload = me.reload;
	const reloadMe = useCallback(async () => reload(), [reload]);

	// Hub mode knows from /api/meta whether billing is on, so no billing call is made (a 404 would log a console error).
	// Member mode has no meta: one probe per api, since the user billing routes answer 404 billingDisabled when off.
	const metaBilling = billingFromMeta(hubMeta);
	const billing = useAsync(() => (metaBilling === undefined ? probeBilling(() => api.getBillingSummary()) : Promise.resolve(undefined)), [api, metaBilling]);
	const billingEnabled = metaBilling ?? billing.data === "enabled";
	const [scope, setScope] = useState<string>(SCOPE_ALL);

	const ctx = useMemo<TeamContextValue | null>(
		() =>
			me.data
				? { api, plugin, me: me.data, mode, route, navigate, back, reloadMe, billingEnabled, meta: hubMeta, scope: validScope(scope, me.data), setScope, resendVerification }
				: null,
		[api, plugin, me.data, mode, route, navigate, back, reloadMe, billingEnabled, hubMeta, scope, resendVerification],
	);

	if (!ctx) {
		if (me.error) {
			const e = me.error;
			return <ErrorBox message={e} onRetry={me.reload} />;
		}
		return (
			<div role="status" aria-live="polite" className="flex h-full items-center justify-center gap-2 text-sm text-ink-400">
				<Loader2 className="size-4 animate-spin" aria-hidden /> {c("loading")}
			</div>
		);
	}

	const def = findRoute(route.page);
	const Page = def?.component;
	const activeNav = NAV_PARENT[route.page] ?? route.page;
	const flags = { billing: billingEnabled, publicMode: isPublicMode(hubMeta) };
	const main = navFor(ctx.me, "main", flags);
	const admin = navFor(ctx.me, "admin", flags);
	const teamName = route.params?.teamId ? ctx.me.teams.find((x) => x.id === route.params?.teamId)?.name : undefined;

	return (
		<TeamContext.Provider value={ctx}>
			<div className="@container relative flex h-full min-h-0 w-full flex-col">
				<header className="flex h-12 shrink-0 items-center gap-3 border-b hairline px-4">
					<span className="font-display text-sm font-semibold tracking-wide">{t("brand")}</span>
					{teamName ? <span className="min-w-0 truncate rounded-md bg-ink-800 px-2 py-0.5 text-xs text-ink-300">{teamName}</span> : <ContextSwitcher />}
					<span className="flex-1" />
					<NotificationsBell />
					{topRight?.({ reloadMe: me.reload })}
				</header>
				<VerifyBanner />
				<div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
					<nav aria-label={t("nav")} className="flex shrink-0 gap-1 overflow-x-auto border-b hairline px-2 py-2 @3xl:w-56 @3xl:flex-col @3xl:overflow-y-auto @3xl:border-r @3xl:border-b-0 @3xl:px-3">
						{main.map((r) => (
							<NavButton key={r.id} route={r} active={activeNav === r.id} onClick={() => goRoot({ page: r.id })} />
						))}
						{admin.length > 0 && (
							<>
								<span className="mx-2 shrink-0 self-center text-[10.5px] font-medium tracking-wide text-ink-500 uppercase @3xl:mx-2.5 @3xl:mt-3 @3xl:mb-1 @3xl:self-start">{t("admin")}</span>
								{admin.map((r) => (
									<NavButton key={r.id} route={r} active={activeNav === r.id} onClick={() => goRoot({ page: r.id })} />
								))}
							</>
						)}
					</nav>
					<main className="flex min-h-0 min-w-0 flex-1 flex-col">
						{Page ? <Page key={`${route.page}:${JSON.stringify(route.params ?? {})}`} /> : <ErrorBox message={t("unknownPage")} />}
					</main>
				</div>
			</div>
		</TeamContext.Provider>
	);
}
