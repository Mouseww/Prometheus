import type { BackendTarget } from "./client.ts";

/** `prefix` is the path the server is mounted under (a tenant behind the Hub proxy); only the page's own server has one. */
export function targetFromUrl(url: string, token?: string, prefix = ""): BackendTarget {
	const u = new URL(url);
	const wsProtocol = u.protocol === "https:" ? "wss:" : "ws:";
	return { wsUrl: `${wsProtocol}//${u.host}${prefix}/ws`, httpBase: `${u.origin}${prefix}`, token: token || undefined, label: u.host };
}
