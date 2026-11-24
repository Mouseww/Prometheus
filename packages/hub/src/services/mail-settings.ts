import type { SecretBox } from "../crypto.ts";
import { badRequest, forbidden, HubError, tooManyRequests } from "../errors.ts";
import { type Actor, can } from "../permissions.ts";
import type { RateLimiter } from "../rate-limit.ts";
import type { AuditService } from "./audit.ts";
import type { ServiceDeps } from "./common.ts";
import { escapeHtml, type MailSource, type MailTransportFactory, type RuntimeMailer, type SmtpSecurity, type SmtpSettings, smtpTransport } from "./mailer.ts";
import type { SettingsService } from "./settings.ts";

const SETTINGS_KEY = "mail_settings";
const SECURITIES: readonly SmtpSecurity[] = ["tls", "starttls", "none"];
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]+\]$/;
const ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const TEST_SENDS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

/** What is stored in `platform_settings`; the password is sealed with the master key. */
interface StoredMail {
	host: string;
	port: number;
	security: SmtpSecurity;
	username?: string;
	passwordSealed?: string;
	from: string;
}

/** What the admin console reads back. The password never leaves the Hub. */
export interface MailSettingsView {
	/** Where mail goes through now: the saved settings, the `HUB_SMTP_URL` environment variable, or only the log. */
	source: MailSource;
	configured: boolean;
	host: string;
	port: number;
	security: SmtpSecurity;
	username: string;
	hasPassword: boolean;
	from: string;
}

export interface MailSettingsInput {
	host: string;
	port: number;
	security: SmtpSecurity;
	username?: string;
	/** Omitted keeps the saved password. */
	password?: string;
	clearPassword?: boolean;
	from: string;
}

export interface MailTestResult {
	ok: boolean;
	/** The transport's own message when sending failed. */
	error?: string;
}

export interface MailSettingsService {
	view(actor: Actor): Promise<MailSettingsView>;
	save(actor: Actor, input: MailSettingsInput): Promise<MailSettingsView>;
	/** Forgets the saved settings; mail goes back to `HUB_SMTP_URL`, or to the log. */
	clear(actor: Actor): Promise<MailSettingsView>;
	/** Sends a test mail. With `candidate` it uses those settings without saving them. */
	test(actor: Actor, to: string, candidate?: MailSettingsInput): Promise<MailTestResult>;
	/** Applies what is saved; called once at startup. */
	load(): Promise<void>;
}

export interface MailSettingsDeps {
	settings: SettingsService;
	secretBox: SecretBox;
	mailer: RuntimeMailer;
	audit: AuditService;
	limiter: RateLimiter;
	/** Tests: records mail instead of opening SMTP connections. */
	transport?: MailTransportFactory;
}

const noLineBreaks = (value: string): boolean => !/[\r\n\0]/.test(value);

/** Rejects anything that is not a plain host name, port or address; header injection starts with a line break. */
export function validateMailInput(input: MailSettingsInput): void {
	if (!input.host || input.host.length > 253 || !HOST_PATTERN.test(input.host)) throw badRequest("SMTP 服务器地址无效", "invalidMailHost");
	if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw badRequest("端口必须在 1 到 65535 之间", "invalidMailPort");
	if (!SECURITIES.includes(input.security)) throw badRequest("加密方式无效", "invalidMailSecurity");
	if (input.username !== undefined && (!noLineBreaks(input.username) || input.username.length > 254)) throw badRequest("用户名无效", "invalidMailUsername");
	if (input.password !== undefined && (!noLineBreaks(input.password) || input.password.length > 512)) throw badRequest("密码无效", "invalidMailPassword");
	if (!noLineBreaks(input.from) || input.from.length > 254 || !ADDRESS_PATTERN.test(addressOf(input.from))) throw badRequest("发件人地址无效", "invalidMailFrom");
}

/** `Name <a@b.c>` or a bare address. */
const addressOf = (from: string): string => {
	const m = /<([^<>]+)>\s*$/.exec(from.trim());
	return (m?.[1] ?? from).trim();
};

export function createMailSettingsService(deps: ServiceDeps, d: MailSettingsDeps): MailSettingsService {
	const factory = d.transport ?? smtpTransport;

	const stored = (): Promise<StoredMail | undefined> => d.settings.get<StoredMail | null>(SETTINGS_KEY).then((v) => v ?? undefined);

	const unseal = (s: StoredMail): SmtpSettings => ({
		host: s.host,
		port: s.port,
		security: s.security,
		...(s.username ? { username: s.username } : {}),
		...(s.passwordSealed ? { password: d.secretBox.open(s.passwordSealed) } : {}),
		from: s.from,
	});

	const requireManager = (actor: Actor): void => {
		if (!can(actor, "platform.manage")) throw forbidden();
	};

	const toView = (s: StoredMail | undefined): MailSettingsView => ({
		source: d.mailer.source,
		configured: d.mailer.configured,
		host: s?.host ?? "",
		port: s?.port ?? 465,
		security: s?.security ?? "tls",
		username: s?.username ?? "",
		hasPassword: Boolean(s?.passwordSealed),
		from: s?.from ?? "",
	});

	/** The input with the saved password filled in when the form left it out. */
	const withPassword = async (input: MailSettingsInput): Promise<SmtpSettings> => {
		const base: SmtpSettings = {
			host: input.host.trim(),
			port: input.port,
			security: input.security,
			from: input.from.trim(),
			...(input.username?.trim() ? { username: input.username.trim() } : {}),
		};
		if (!base.username) return base;
		if (input.password !== undefined && input.password !== "") return { ...base, password: input.password };
		if (input.clearPassword) return base;
		const current = await stored();
		return current?.passwordSealed ? { ...base, password: d.secretBox.open(current.passwordSealed) } : base;
	};

	return {
		async load() {
			const s = await stored();
			d.mailer.use(s ? unseal(s) : undefined, factory);
		},

		async view(actor) {
			requireManager(actor);
			return toView(await stored());
		},

		async save(actor, input) {
			requireManager(actor);
			validateMailInput(input);
			const settings = await withPassword(input);
			const next: StoredMail = {
				host: settings.host,
				port: settings.port,
				security: settings.security,
				from: settings.from,
				...(settings.username ? { username: settings.username } : {}),
				...(settings.password ? { passwordSealed: d.secretBox.seal(settings.password) } : {}),
			};
			await deps.db.tx({ system: true }, async (q) => {
				await d.settings.set(q, SETTINGS_KEY, next);
				await d.audit.write(q, {
					actorId: actor.userId,
					action: "mail.update",
					targetType: "platform",
					targetId: "mail",
					detail: { host: next.host, port: next.port, security: next.security, from: next.from, hasUsername: Boolean(next.username), hasPassword: Boolean(next.passwordSealed) },
				});
			});
			d.mailer.use(settings, factory);
			return toView(next);
		},

		async clear(actor) {
			requireManager(actor);
			await deps.db.tx({ system: true }, async (q) => {
				await d.settings.set(q, SETTINGS_KEY, null);
				await d.audit.write(q, { actorId: actor.userId, action: "mail.clear", targetType: "platform", targetId: "mail", detail: {} });
			});
			d.mailer.use(undefined, factory);
			return toView(undefined);
		},

		async test(actor, to, candidate) {
			requireManager(actor);
			if (!ADDRESS_PATTERN.test(to) || !noLineBreaks(to)) throw badRequest("收件人地址无效", "invalidRecipient");
			const hit = d.limiter.hit(`mail:test:${actor.userId}`, TEST_SENDS_PER_HOUR, HOUR_MS);
			if (!hit.allowed) throw tooManyRequests(hit.retryAfterSec);
			const subject = "Prometheus 测试邮件 / Test mail";
			const text = "这是一封测试邮件。收到它说明 Hub 的邮件服务配置正确。\nThis is a test mail. If you can read it, the Hub's mail settings work.";
			const html = `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
			try {
				if (candidate) {
					validateMailInput(candidate);
					const settings = await withPassword(candidate);
					await factory(settings).sendMail({ from: settings.from, to, subject, html, text });
				} else {
					if (!d.mailer.configured) throw badRequest("还没有配置邮件服务", "mailNotConfigured");
					await d.mailer.send(to, subject, html, text);
				}
				return { ok: true };
			} catch (err) {
				// A bad form is the caller's mistake; anything else is the SMTP server's answer, which the operator needs to read.
				if (err instanceof HubError) throw err;
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		},
	};
}
