import { createHash, randomBytes } from "node:crypto";
import { fill, request } from "./http.ts";
import type { AuthMethod } from "./types.ts";

export interface TokenResult {
	accessToken: string;
	refreshToken?: string;
	/** Epoch ms; undefined when the provider issues non-expiring tokens (GitHub OAuth apps). */
	expiresAt?: number;
}

interface RawToken {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number | string;
	error?: string;
	error_description?: string;
}

const b64url = (b: Buffer) => b.toString("base64url");

export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = b64url(randomBytes(48));
	return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

function parseToken(raw: RawToken, now = Date.now()): TokenResult {
	if (raw.error || !raw.access_token) throw new Error(`授权失败：${raw.error_description ?? raw.error ?? "未返回令牌"}`);
	const ttl = Number(raw.expires_in);
	return { accessToken: raw.access_token, refreshToken: raw.refresh_token, expiresAt: Number.isFinite(ttl) && ttl > 0 ? now + ttl * 1000 : undefined };
}

export function buildAuthorizeUrl(method: Extract<AuthMethod, { kind: "oauth-code" }>, config: Record<string, string>, p: { clientId: string; redirectUri: string; state: string; challenge: string; extra?: Record<string, string> }): string {
	const url = new URL(fill(method.authorizeUrl, config));
	url.searchParams.set("client_id", p.clientId);
	url.searchParams.set("redirect_uri", p.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("state", p.state);
	url.searchParams.set("code_challenge", p.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	if (method.scopes.length) url.searchParams.set("scope", method.scopes.join(" "));
	for (const [k, v] of Object.entries(p.extra ?? {})) url.searchParams.set(k, v);
	return url.toString();
}

export async function exchangeCode(
	method: Extract<AuthMethod, { kind: "oauth-code" }>,
	config: Record<string, string>,
	p: { clientId: string; clientSecret?: string; code: string; redirectUri: string; verifier: string },
): Promise<TokenResult> {
	const form: Record<string, string> = { grant_type: "authorization_code", client_id: p.clientId, code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier };
	if (p.clientSecret) form.client_secret = p.clientSecret;
	return parseToken(await request<RawToken>(fill(method.tokenUrl, config), { form }));
}

export interface DeviceStart {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	intervalSec: number;
	expiresAt: number;
}

interface RawDevice {
	device_code: string;
	user_code: string;
	verification_uri?: string;
	verification_url?: string;
	interval?: number;
	expires_in?: number;
}

export async function startDevice(method: Extract<AuthMethod, { kind: "oauth-device" }>, config: Record<string, string>, clientId: string): Promise<DeviceStart> {
	const raw = await request<RawDevice>(fill(method.deviceUrl, config), { form: { client_id: clientId, scope: method.scopes.join(" ") } });
	return {
		deviceCode: raw.device_code,
		userCode: raw.user_code,
		verificationUri: raw.verification_uri ?? raw.verification_url ?? "",
		intervalSec: raw.interval ?? 5,
		expiresAt: Date.now() + (raw.expires_in ?? 900) * 1000,
	};
}

export type DevicePoll = { status: "pending"; slowDown?: boolean } | { status: "done"; token: TokenResult };

/** One poll. Pending states return normally; real failures (denied, expired) throw. */
export async function pollDevice(method: Extract<AuthMethod, { kind: "oauth-device" }>, config: Record<string, string>, clientId: string, deviceCode: string): Promise<DevicePoll> {
	let raw: RawToken;
	try {
		raw = await request<RawToken>(fill(method.tokenUrl, config), { form: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: deviceCode } });
	} catch (err) {
		// Microsoft answers pending with HTTP 400 + JSON body.
		const m = err instanceof Error ? /HTTP 4\d\d: (.*)$/s.exec(err.message) : null;
		if (!m) throw err;
		try {
			raw = JSON.parse(m[1] ?? "") as RawToken;
		} catch {
			throw err;
		}
	}
	if (raw.error === "authorization_pending") return { status: "pending" };
	if (raw.error === "slow_down") return { status: "pending", slowDown: true };
	return { status: "done", token: parseToken(raw) };
}

export async function refreshToken(method: AuthMethod, config: Record<string, string>, p: { clientId: string; clientSecret?: string; refreshToken: string }): Promise<TokenResult> {
	if (method.kind !== "oauth-code" && method.kind !== "oauth-device") throw new Error("该认证方式不支持刷新");
	const form: Record<string, string> = { grant_type: "refresh_token", client_id: p.clientId, refresh_token: p.refreshToken };
	if (p.clientSecret) form.client_secret = p.clientSecret;
	const r = parseToken(await request<RawToken>(fill(method.tokenUrl, config), { form }));
	// Some providers rotate refresh tokens, others omit it on
	// refresh; keep the old refresh token when the response omits a new one.
	return { ...r, refreshToken: r.refreshToken ?? p.refreshToken };
}

/** A token within this window of expiry is refreshed before use. */
export const REFRESH_SKEW_MS = 60_000;
