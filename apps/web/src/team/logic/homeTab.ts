// Team home: which tab opens first, and the per-workspace memory of the user's last choice.
import type { TeamRole } from "../types.ts";

export type HomeTab = "report" | "board";

export const HOME_TAB_KEY_PREFIX = "prometheus.team.homeTab.";

/** Minimal storage surface (localStorage in the app, a stub in tests). */
export interface TabStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** Team admins (project managers) start on the daily report, everyone else on the board. */
export function defaultHomeTab(role: TeamRole | string | undefined): HomeTab {
	return role === "admin" ? "report" : "board";
}

const isTab = (v: unknown): v is HomeTab => v === "report" || v === "board";

const browserStore = (): TabStore | undefined => {
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		return undefined;
	}
};

/** The remembered tab for a workspace, or the role default when nothing valid is stored. Never throws. */
export function resolveHomeTab(workspaceId: string, role: TeamRole | string | undefined, store: TabStore | undefined = browserStore()): HomeTab {
	try {
		const saved = store?.getItem(HOME_TAB_KEY_PREFIX + workspaceId);
		if (isTab(saved)) return saved;
	} catch {
		/* storage blocked: fall through to the default */
	}
	return defaultHomeTab(role);
}

/** Remembers the tab for a workspace. Returns false when storage is unavailable. */
export function rememberHomeTab(workspaceId: string, tab: HomeTab, store: TabStore | undefined = browserStore()): boolean {
	try {
		if (!store) return false;
		store.setItem(HOME_TAB_KEY_PREFIX + workspaceId, tab);
		return true;
	} catch {
		return false;
	}
}

/** Key of the last picked workspace (shared across tabs). */
export const HOME_WORKSPACE_KEY = "prometheus.team.homeWorkspace";
