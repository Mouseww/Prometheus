import type { Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { isAndroid, isDesktopShell, isTauri, localSupported } from "./backend.ts";
import { usePrefs } from "./prefs.ts";
import { useStore } from "./store.ts";
import { isNewer } from "./version.ts";

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
/** Android: where the new APK is downloaded from (the system installer takes over from there). */
let apkUrl: string | null = null;

const RELEASES_API = "https://api.github.com/repos/Mouseww/Prometheus/releases/latest";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Desktop uses the signed Tauri updater; Android (no such plugin) installs the APK from the release page. */
export async function updaterSupported(): Promise<boolean> {
	return (isDesktopShell() && (await localSupported())) || (isTauri() && isAndroid());
}

async function checkAndroid(silent: boolean): Promise<void> {
	useUpdater.setState({ phase: "checking", error: null });
	try {
		const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
		if (!res.ok) throw new Error(`GitHub ${res.status}`);
		const release = (await res.json()) as { tag_name?: string; body?: string; assets?: { name: string; browser_download_url: string }[] };
		const tag = release.tag_name ?? "";
		const apk = release.assets?.find((a) => /android.*\.apk$/i.test(a.name));
		if (!tag || !isNewer(tag, __APP_VERSION__) || !apk) {
			apkUrl = null;
			useUpdater.setState({ phase: silent ? "idle" : "uptodate" });
			return;
		}
		apkUrl = apk.browser_download_url;
		useUpdater.setState({ phase: "available", version: tag.replace(/^v/, ""), notes: release.body ?? null, dismissed: false });
	} catch (e) {
		useUpdater.setState(silent ? { phase: "idle" } : { phase: "error", error: errText(e) });
	}
}

/** `silent` checks (startup) never surface "up to date" or errors. */
export async function checkForUpdate(silent = false): Promise<void> {
	const { phase } = useUpdater.getState();
	if (phase === "checking" || phase === "installing" || !(await updaterSupported())) return;
	if (isAndroid()) return checkAndroid(silent);
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

/** Hands the APK link to the system, which downloads it and offers the install; the dialog stays so the user can retry. */
async function installAndroid(): Promise<void> {
	if (!apkUrl) return;
	try {
		const { openUrl } = await import("@tauri-apps/plugin-opener");
		await openUrl(apkUrl);
	} catch (e) {
		useUpdater.setState({ phase: "error", error: errText(e), dismissed: false });
	}
}

/** No agent is working: no chat is streaming and no session in the list is running (automations and goals show up there too). */
export function agentsIdle(): boolean {
	const s = useStore.getState();
	return !s.session?.isStreaming && !s.sessions.some((x) => x.running);
}

const IDLE_TICK_MS = 30_000;
/** How long everything must stay quiet before an update is installed on its own. */
const IDLE_NEEDED_MS = 2 * 60_000;
const RECHECK_MS = 6 * 60 * 60_000;

/**
 * Idle auto-update (desktop, setting "Update when idle", on by default): checks for a new version every few hours and, once
 * no agent has been running for two minutes, downloads and installs it. If an agent starts while the download runs, the
 * install (which restarts the backend) waits until it is quiet again. Returns the stop function.
 */
export function startIdleUpdater(): () => void {
	let idleSince: number | null = null;
	let lastCheck = Date.now();
	let busy = false;
	const tick = async () => {
		if (busy || !usePrefs.getState().idleUpdate || isAndroid() || !(await updaterSupported())) return;
		if (!agentsIdle()) {
			idleSince = null;
			return;
		}
		idleSince ??= Date.now();
		const { phase } = useUpdater.getState();
		if (phase === "installing" || phase === "checking") return;
		if (phase !== "available" && Date.now() - lastCheck > RECHECK_MS) {
			lastCheck = Date.now();
			await checkForUpdate(true);
		}
		if (useUpdater.getState().phase !== "available" || Date.now() - idleSince < IDLE_NEEDED_MS) return;
		busy = true;
		try {
			// The dialog is for updates the user decides on; this one happens quietly.
			useUpdater.setState({ dismissed: true });
			await installUpdate(true);
		} finally {
			busy = false;
		}
	};
	const timer = setInterval(() => void tick(), IDLE_TICK_MS);
	return () => clearInterval(timer);
}

/** Downloads first, then stops the local server (its files are locked on Windows) and installs. `whenIdle`: wait for a quiet moment before the restart. */
export async function installUpdate(whenIdle = false): Promise<void> {
	if (isAndroid()) return installAndroid();
	const update = pending;
	if (!update) return;
	useUpdater.setState({ phase: "installing", error: null });
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		await update.download();
		if (whenIdle) {
			// Restarting the backend would cut a running agent short: hold on until nothing runs (or the user turned this off).
			while (!agentsIdle()) {
				if (!usePrefs.getState().idleUpdate) {
					useUpdater.setState({ phase: "available", dismissed: false });
					return;
				}
				await new Promise((r) => setTimeout(r, 10_000));
			}
		}
		await invoke("stop_local_backend");
		await update.install();
		await invoke("relaunch_app");
	} catch (e) {
		useUpdater.setState({ phase: "error", error: errText(e), dismissed: false });
	}
}
