import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function tokensEqual(a: string, b: string): boolean {
	const ha = createHash("sha256").update(a).digest();
	const hb = createHash("sha256").update(b).digest();
	return timingSafeEqual(ha, hb);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackAddress(host: string): boolean {
	return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
}

function hostname(hostHeader: string | undefined): string {
	if (!hostHeader) return "";
	if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
	return hostHeader.split(":")[0] ?? "";
}

const TAURI_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

export interface OriginPolicy {
	tokenRequired: boolean;
	extraOrigins: Set<string>;
}

/**
 * Blocks cross-site WebSocket hijacking and DNS rebinding. Without a token the server is only safe
 * when both the Host header and the Origin are loopback/same-origin; with a token the first-frame
 * auth protects it, but foreign browser origins are still refused unless explicitly allowed.
 */
export function originAllowed(req: IncomingMessage, policy: OriginPolicy): boolean {
	const host = req.headers.host;
	if (!policy.tokenRequired && !isLoopbackAddress(hostname(host))) return false;
	const origin = req.headers.origin;
	// Non-browser clients (CLI, native mobile) send no Origin.
	if (!origin) return true;
	if (TAURI_ORIGINS.has(origin) || policy.extraOrigins.has(origin)) return true;
	try {
		const url = new URL(origin);
		if (url.host === host) return true;
		return !policy.tokenRequired && isLoopbackAddress(url.hostname);
	} catch {
		return false;
	}
}

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (header ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
	}
	return out;
}
