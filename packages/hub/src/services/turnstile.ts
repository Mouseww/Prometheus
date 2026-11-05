import { LOG_PREFIX, type HubLog } from "../log.ts";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 10_000;

export interface TurnstileConfig {
	secret: string;
	siteKey: string | undefined;
	/** HUB_TURNSTILE_VERIFY_URL: overridable for tests. */
	verifyUrl: string;
}

/** `undefined` when HUB_TURNSTILE_SECRET is not set (the check is then skipped). */
export function resolveTurnstile(env: NodeJS.ProcessEnv): TurnstileConfig | undefined {
	const secret = env.HUB_TURNSTILE_SECRET;
	if (!secret) return undefined;
	return { secret, siteKey: env.HUB_TURNSTILE_SITE_KEY || undefined, verifyUrl: env.HUB_TURNSTILE_VERIFY_URL || TURNSTILE_VERIFY_URL };
}

/** Posts the token to the siteverify endpoint. Any transport failure counts as a failed check (fail closed). */
export async function verifyTurnstile(cfg: TurnstileConfig, token: string, ip: string | undefined, log: HubLog): Promise<boolean> {
	const form = new URLSearchParams({ secret: cfg.secret, response: token });
	if (ip) form.set("remoteip", ip);
	try {
		const res = await fetch(cfg.verifyUrl, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form,
			signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
		});
		if (!res.ok) {
			log.warn(`${LOG_PREFIX} Turnstile 校验服务返回 ${res.status}`);
			return false;
		}
		const body = (await res.json()) as { success?: unknown };
		return body.success === true;
	} catch (err) {
		log.warn(`${LOG_PREFIX} Turnstile 校验请求失败: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}
