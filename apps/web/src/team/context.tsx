import { createContext, useContext } from "react";
import type { TeamApi } from "./api.ts";
import type { MeResult } from "./types.ts";

export interface Route {
	/** Id of an entry of the route table (./routes.tsx). */
	page: string;
	params?: Readonly<Record<string, string>>;
}

export interface TeamContextValue {
	api: TeamApi;
	me: MeResult;
	/** `hub`: the page is the Hub's own web UI. `member`: embedded in the normal app through the team plugin. */
	mode: "hub" | "member";
	route: Route;
	navigate: (route: Route) => void;
	/** Goes to the previous route, or to `fallback` when there is none. */
	back: (fallback: Route) => void;
	reloadMe: () => Promise<void>;
}

export const TeamContext = createContext<TeamContextValue | null>(null);

export function useTeam(): TeamContextValue {
	const v = useContext(TeamContext);
	if (!v) throw new Error("useTeam must be used inside <TeamShell>");
	return v;
}

/** Permission checks the UI uses to hide actions. The Hub enforces the same matrix on every request. */
export const isOperator = (me: MeResult): boolean => me.user.platformRole === "operator";
export const managedOrgs = (me: MeResult) => me.orgs.filter((o) => o.role === "owner" || o.role === "admin");
/** Admin console is for operators and org owners/admins. */
export const canSeeAdmin = (me: MeResult): boolean => isOperator(me) || managedOrgs(me).length > 0;
export const canReview = (role: string | undefined): boolean => role === "admin" || role === "reviewer";
export const isTeamAdmin = (role: string | undefined): boolean => role === "admin";
