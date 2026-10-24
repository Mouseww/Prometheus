import { isTauri } from "./backend.ts";
import { usePrefs } from "./prefs.ts";

/** granted / denied / default (not asked yet) / unsupported (no notification system here). */
export type NotifyPermission = "granted" | "denied" | "default" | "unsupported";

/**
 * System notifications go through the OS of the device the app runs on: the Tauri notification plugin in the
 * desktop and Android apps (Windows toast, macOS Notification Center, Android channel), the Web Notification API in a browser.
 */
export async function notifyPermission(): Promise<NotifyPermission> {
	try {
		if (isTauri()) {
			const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
			return (await isPermissionGranted()) ? "granted" : "default";
		}
	} catch {
		return "unsupported";
	}
	if (typeof Notification === "undefined") return "unsupported";
	return Notification.permission;
}

/** Asks the OS for permission (the Android 13+ runtime prompt, the browser prompt); must follow a user gesture in browsers. */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
	try {
		if (isTauri()) {
			const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
			if (await isPermissionGranted()) return "granted";
			return (await requestPermission()) === "granted" ? "granted" : "denied";
		}
	} catch {
		return "unsupported";
	}
	if (typeof Notification === "undefined") return "unsupported";
	return Notification.requestPermission();
}

export async function sendNotification(title: string, body: string): Promise<void> {
	try {
		if (isTauri()) {
			const { isPermissionGranted, sendNotification: send } = await import("@tauri-apps/plugin-notification");
			if (await isPermissionGranted()) send({ title, body });
			return;
		}
		if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(title, { body });
	} catch {
		// A notification that cannot be shown must never break the chat.
	}
}

const TEXT = {
	zh: (name: string) => `「${name}」已完成本轮任务`,
	en: (name: string) => `"${name}" finished its turn`,
};

/** Called when an agent turn settles. Honours the user's switch and, by default, stays quiet while the window is in front. */
export function notifyTurnDone(sessionName: string): void {
	const p = usePrefs.getState();
	if (!p.notifyOnDone) return;
	if (p.notifyBackgroundOnly && !document.hidden && document.hasFocus()) return;
	void sendNotification("Prometheus", TEXT[p.lang](sessionName || "Prometheus"));
}
