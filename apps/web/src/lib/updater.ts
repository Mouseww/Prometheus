import type { Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { isDesktopShell, localSupported } from "./backend.ts";

export type UpdatePhase = "idle" | "checking" | "uptodate" | "available" | "installing" | "error";

interface UpdaterState {
	phase: UpdatePhase;
	version: string | null;
	notes: string | null;
	error: string | null;
	/** The prompt dialog is hidden once dismissed; the settings button can reopen it. */
	dismissed: boolean;
}

export const useUpdater = create<UpdaterState>(() => ({ phase: "idle", version: null, notes: null, error: null, dismissed: false }));

let pending: Update | null = null;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The updater only exists in desktop builds. */
export async function updaterSupported(): Promise<boolean> {
	return isDesktopShell() && (await localSupported());
}

/** `silent` checks (startup) never surface "up to date" or errors. */
export async function checkForUpdate(silent = false): Promise<void> {
	const { phase } = useUpdater.getState();
	if (phase === "checking" || phase === "installing" || !(await updaterSupported())) return;
	useUpdater.setState({ phase: "checking", error: null });
	try {
		const { check } = await import("@tauri-apps/plugin-updater");
		const update = await check();
		if (!update) {
			pending = null;
			useUpdater.setState({ phase: silent ? "idle" : "uptodate" });
			return;
		}
		pending = update;
		useUpdater.setState({ phase: "available", version: update.version, notes: update.body ?? null, dismissed: false });
	} catch (e) {
		useUpdater.setState(silent ? { phase: "idle" } : { phase: "error", error: errText(e) });
	}
}

export function dismissUpdate(): void {
	useUpdater.setState({ dismissed: true });
}

export function showUpdate(): void {
	useUpdater.setState({ dismissed: false });
}

/** Downloads first, then stops the local server (its files are locked on Windows) and installs. */
export async function installUpdate(): Promise<void> {
	const update = pending;
	if (!update) return;
	useUpdater.setState({ phase: "installing", error: null });
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		await update.download();
		await invoke("stop_local_backend");
		await update.install();
		await invoke("relaunch_app");
	} catch (e) {
		useUpdater.setState({ phase: "error", error: errText(e), dismissed: false });
	}
}
