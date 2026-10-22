import { isTauri, loadRemote, saveMode, saveRemote, saveSameOriginToken, startLocal, targetFromUrl } from "./backend.ts";
import type { BackendTarget } from "./client.ts";

/** A saved Prometheus server the user can switch to. Lives in this browser/app only; tokens never leave it. */
export interface Platform {
	id: string;
	name: string;
	url: string;
	token?: string;
}

const KEY = "prometheus.platforms";
export const CONNECT_EVENT = "prometheus:connect";

export function loadPlatforms(): Platform[] {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
		if (!Array.isArray(raw)) return [];
		return raw.filter((p): p is Platform => !!p && typeof p.id === "string" && typeof p.url === "string" && typeof p.name === "string");
	} catch {
		return [];
	}
}

export function savePlatforms(list: Platform[]): void {
	localStorage.setItem(KEY, JSON.stringify(list));
}

export function normalizeUrl(url: string): string {
	const u = new URL(url.trim());
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
	return u.origin;
}

export function samePlatform(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
}

function announce(target: BackendTarget): void {
	window.dispatchEvent(new CustomEvent<BackendTarget>(CONNECT_EVENT, { detail: target }));
}

/** Makes `p` the active server and tells the app to reconnect. */
export function switchPlatform(p: Platform): void {
	const target = targetFromUrl(p.url, p.token);
	if (!isTauri() && samePlatform(p.url, location.origin)) {
		// The page's own server is the default; no saved remote needed.
		saveRemote(null);
		saveSameOriginToken(p.token ?? null);
	} else saveRemote({ url: target.httpBase, token: p.token });
	saveMode("remote");
	announce(target);
}

/** Desktop only: switch back to the bundled server on this machine. */
export async function switchLocal(): Promise<void> {
	const target = await startLocal();
	saveMode("local");
	announce(target);
}

export function currentRemote(): { url: string; token?: string } | null {
	return loadRemote();
}
