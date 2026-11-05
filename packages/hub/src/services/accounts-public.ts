import type { HubConfig } from "../config.ts";
import { hashPassword, randomToken, sha256Hex } from "../crypto.ts";
import { badRequest, forbidden, tooManyRequests } from "../errors.ts";
import { ulid } from "../ids.ts";
import { LOG_PREFIX } from "../log.ts";
import type { RateLimiter } from "../rate-limit.ts";
import type { AbuseGuard } from "./abuse.ts";
import type { AuditService } from "./audit.ts";
import { normalizeEmail, type ServiceDeps, type UserRow } from "./common.ts";
import { escapeHtml, type Mailer } from "./mailer.ts";
import type { RegistrationService } from "./registration.ts";
import type { SettingsService } from "./settings.ts";
import { type TurnstileConfig, verifyTurnstile } from "./turnstile.ts";

export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAIL_PER_IP_PER_HOUR = 10;
const MAIL_PER_EMAIL_PER_HOUR = 3;

export interface PublicMeta {
	mode: "private" | "public";
	/** False when HUB_SMTP_URL is unset and mails only go to the log: the admin UI shows a warning. */
	mailConfigured: boolean;
	turnstileSiteKey: string | null;
	turnstileRequired: boolean;
	allowSelfCreateOrg: boolean;
}

export interface PublicAccounts {
	/** Mail delivery is fire and forget so response timing does not reveal whether an account exists. */
	flush(): Promise<void>;
	meta(): Promise<PublicMeta>;
	/** Turnstile, IP/subnet limits and the disposable-domain list; a no-op for the very first (bootstrap) account. */
	guardRegister(input: { email: string; turnstileToken?: string }, ip: string): Promise<void>;
	/** Creates a 24h single-use token for the user and mails the link. */
	sendVerification(user: { id: string; email: string; displayName: string }): Promise<void>;
	verifyEmail(token: string): Promise<{ verified: true; status: "active" | "pending" }>;
	resendVerification(email: string, ip: string): Promise<void>;
	forgotPassword(email: string, ip: string): Promise<void>;
	resetPassword(token: string, password: string): Promise<void>;
}

export interface PublicAccountsDeps {
	config: HubConfig;
	mailer: Mailer;
	turnstile: TurnstileConfig | undefined;
	abuse: AbuseGuard;
	limiter: RateLimiter;
	audit: AuditService;
	registration: RegistrationService;
	settings: SettingsService;
}

const invalidToken = (): Error => badRequest("链接无效或已过期", "invalidToken");

export function createPublicAccounts(deps: ServiceDeps, p: PublicAccountsDeps): PublicAccounts {
	const pending = new Set<Promise<void>>();
	const link = (path: string, token: string): string => `${p.config.publicUrl}${path}?token=${encodeURIComponent(token)}`;

	const deliver = (to: string, subject: string, intro: string, url: string, hours: number): void => {
		const text = `${intro}\n\n${url}\n\n链接 ${hours} 小时内有效，且只能使用一次。如果这不是你本人的操作，请忽略此邮件。`;
		const html = `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>链接 ${hours} 小时内有效，且只能使用一次。如果这不是你本人的操作，请忽略此邮件。</p>`;
		const job = p.mailer
			.send(to, subject, html, text)
			.catch((err: unknown) => deps.log.error(`${LOG_PREFIX} 邮件发送失败 (${subject}): ${err instanceof Error ? err.message : String(err)}`))
			.finally(() => void pending.delete(job));
		pending.add(job);
	};

	/** Limits per IP loudly (429) and per address silently so replies never reveal whether an account exists. */
	const throttleMail = (kind: string, email: string, ip: string): boolean => {
		const byIp = p.limiter.hit(`${kind}:ip:${ip}`, MAIL_PER_IP_PER_HOUR, HOUR_MS);
		if (!byIp.allowed) throw tooManyRequests(byIp.retryAfterSec);
		return p.limiter.hit(`${kind}:email:${email}`, MAIL_PER_EMAIL_PER_HOUR, HOUR_MS).allowed;
	};

	const issueVerification = async (user: { id: string; email: string; displayName: string }): Promise<void> => {
		const token = randomToken();
		const nowMs = deps.now();
		await deps.db.tx({ system: true }, async (q) => {
			// A new link replaces older unused ones.
			await q.query("UPDATE email_verifications SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL", [user.id, new Date(nowMs)]);
			await q.query("INSERT INTO email_verifications (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)", [
				ulid(nowMs),
				user.id,
				sha256Hex(token),
				new Date(nowMs + VERIFY_TOKEN_TTL_MS),
			]);
		});
		deliver(user.email, "请验证你的邮箱", `你好 ${user.displayName}，请点击下面的链接验证邮箱并启用账号：`, link("/verify-email", token), 24);
	};

	return {
		flush: async () => {
			while (pending.size > 0) await Promise.all([...pending]);
		},

		async meta() {
			return {
				mode: p.config.mode,
				mailConfigured: p.mailer.configured,
				turnstileSiteKey: p.turnstile?.siteKey ?? null,
				turnstileRequired: p.turnstile !== undefined,
				allowSelfCreateOrg: await p.settings.allowSelfCreateOrg(),
			};
		},

		async guardRegister(input, ip) {
			const count = await deps.db.query<{ n: string | number }>("SELECT count(*) AS n FROM users");
			if (Number(count[0]?.n ?? 0) === 0) return;
			if (p.turnstile && !input.turnstileToken) throw badRequest("需要完成人机验证", "turnstileRequired");
			p.abuse.checkRegistrationRate(ip);
			await p.abuse.assertEmailAllowed(normalizeEmail(input.email));
			if (p.turnstile && input.turnstileToken && !(await verifyTurnstile(p.turnstile, input.turnstileToken, ip, deps.log))) {
				throw forbidden("人机验证未通过，请重试", "turnstileFailed");
			}
		},

		sendVerification: issueVerification,

		async verifyEmail(token) {
			const nowDate = new Date(deps.now());
			return deps.db.tx({ system: true }, async (q) => {
				// Consume-and-read in one statement: a token can be redeemed once.
				const used = await q.query<{ user_id: string }>(
					"UPDATE email_verifications SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING user_id",
					[sha256Hex(token), nowDate],
				);
				const userId = used[0]?.user_id;
				if (!userId) throw invalidToken();
				const platform = await p.registration.platformPolicy(q);
				const rows = await q.query<Pick<UserRow, "status">>(
					`UPDATE users SET email_verified_at = coalesce(email_verified_at, $2),
					   status = CASE WHEN status = 'pending' AND NOT $3::boolean THEN 'active' ELSE status END, updated_at = now()
					 WHERE id = $1 RETURNING status`,
					[userId, nowDate, platform.requireApproval],
				);
				const status = rows[0]?.status === "active" ? "active" : "pending";
				await p.audit.write(q, { actorId: userId, action: "user.verifyEmail", targetType: "user", targetId: userId, detail: { status } });
				return { verified: true as const, status };
			});
		},

		async resendVerification(rawEmail, ip) {
			const email = normalizeEmail(rawEmail);
			if (!throttleMail("verify", email, ip)) return;
			const rows = await deps.db.query<{ id: string; email: string; display_name: string; status: string; email_verified_at: unknown }>(
				"SELECT id, email, display_name, status, email_verified_at FROM users WHERE email = $1",
				[email],
			);
			const user = rows[0];
			if (!user || user.email_verified_at !== null || user.status === "disabled") return;
			await issueVerification({ id: user.id, email: user.email, displayName: user.display_name });
		},

		async forgotPassword(rawEmail, ip) {
			const email = normalizeEmail(rawEmail);
			if (!throttleMail("reset", email, ip)) return;
			const rows = await deps.db.query<{ id: string; email: string; display_name: string; status: string }>(
				"SELECT id, email, display_name, status FROM users WHERE email = $1",
				[email],
			);
			const user = rows[0];
			if (!user || user.status === "disabled") return;
			const token = randomToken();
			const nowMs = deps.now();
			await deps.db.tx({ system: true }, async (q) => {
				await q.query("UPDATE password_resets SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL", [user.id, new Date(nowMs)]);
				await q.query("INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)", [
					ulid(nowMs),
					user.id,
					sha256Hex(token),
					new Date(nowMs + RESET_TOKEN_TTL_MS),
				]);
			});
			deliver(user.email, "重置密码", `你好 ${user.display_name}，请点击下面的链接重置密码：`, link("/reset-password", token), 1);
		},

		async resetPassword(token, password) {
			const nowDate = new Date(deps.now());
			const passwordHash = await hashPassword(password);
			await deps.db.tx({ system: true }, async (q) => {
				const used = await q.query<{ user_id: string }>(
					"UPDATE password_resets SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING user_id",
					[sha256Hex(token), nowDate],
				);
				const userId = used[0]?.user_id;
				if (!userId) throw invalidToken();
				await q.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [userId, passwordHash]);
				await q.query("UPDATE password_resets SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL", [userId, nowDate]);
				await q.query("UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, nowDate]);
				await p.audit.write(q, { actorId: userId, action: "user.passwordReset", targetType: "user", targetId: userId });
			});
		},
	};
}
