import nodemailer from "nodemailer";
import { type HubLog, LOG_PREFIX } from "../log.ts";

export interface MailMessage {
	to: string;
	subject: string;
	html: string;
	text: string;
}

export interface Mailer {
	/** True when mail really leaves the Hub (SMTP); false for the log fallback. Exposed in /api/meta as `mailConfigured`. */
	readonly configured: boolean;
	send(to: string, subject: string, html: string, text: string): Promise<void>;
}

/** The part of a nodemailer transport the Hub uses; tests pass a fake. */
export interface MailTransport {
	sendMail(message: { from: string; to: string; subject: string; html: string; text: string }): Promise<unknown>;
}

export const DEFAULT_MAIL_FROM = "Prometheus <no-reply@localhost>";

/** Development fallback: writes the whole mail to the log so verification links can be copied from it. */
export class LogMailer implements Mailer {
	readonly configured = false;
	readonly #log: HubLog;

	constructor(log: HubLog) {
		this.#log = log;
	}

	async send(to: string, subject: string, _html: string, text: string): Promise<void> {
		this.#log.info(`${LOG_PREFIX} 未配置 HUB_SMTP_URL，邮件仅写入日志。收件人: ${to}，主题: ${subject}\n${text}`);
	}
}

export class SmtpMailer implements Mailer {
	readonly configured = true;
	readonly #transport: MailTransport;
	readonly #from: string;

	constructor(transport: MailTransport, from: string) {
		this.#transport = transport;
		this.#from = from;
	}

	async send(to: string, subject: string, html: string, text: string): Promise<void> {
		await this.#transport.sendMail({ from: this.#from, to, subject, html, text });
	}
}

export interface MailerOptions {
	/** HUB_SMTP_URL, e.g. `smtps://user:pass@host:465`. */
	smtpUrl: string | undefined;
	/** HUB_MAIL_FROM. */
	from: string | undefined;
	/** Tests: replaces the nodemailer transport built from `smtpUrl`. */
	transport?: MailTransport;
}

export function createMailer(options: MailerOptions, log: HubLog): Mailer {
	if (!options.smtpUrl && !options.transport) {
		log.warn(`${LOG_PREFIX} 未配置 HUB_SMTP_URL，验证与重置邮件只会写入日志，生产环境请配置 SMTP`);
		return new LogMailer(log);
	}
	const transport = options.transport ?? (nodemailer.createTransport(options.smtpUrl as string) as MailTransport);
	return new SmtpMailer(transport, options.from || DEFAULT_MAIL_FROM);
}

export type SmtpSecurity = "tls" | "starttls" | "none";

/** SMTP connection saved from the admin console (the password stays in memory here; it is sealed at rest). */
export interface SmtpSettings {
	host: string;
	port: number;
	/** `tls`: implicit TLS (usually 465); `starttls`: upgrade on a plain port (usually 587); `none`: unencrypted. */
	security: SmtpSecurity;
	username?: string;
	password?: string;
	from: string;
}

export type MailSource = "settings" | "env" | "none";

/** Builds a transport for saved settings; tests replace it with a fake that records what would be sent. */
export type MailTransportFactory = (settings: SmtpSettings) => MailTransport;

const CONNECT_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

export const smtpTransport: MailTransportFactory = (s) =>
	nodemailer.createTransport({
		host: s.host,
		port: s.port,
		secure: s.security === "tls",
		requireTLS: s.security === "starttls",
		ignoreTLS: s.security === "none",
		...(s.username ? { auth: { user: s.username, pass: s.password ?? "" } } : {}),
		connectionTimeout: CONNECT_TIMEOUT_MS,
		greetingTimeout: CONNECT_TIMEOUT_MS,
		socketTimeout: SOCKET_TIMEOUT_MS,
	}) as MailTransport;

/**
 * The mailer the Hub hands to everything that sends mail. Settings saved in the admin console take over from the
 * environment's `HUB_SMTP_URL` without a restart; clearing them falls back to the environment again.
 */
export class RuntimeMailer implements Mailer {
	readonly #fallback: Mailer;
	#override: Mailer | undefined;

	constructor(fallback: Mailer) {
		this.#fallback = fallback;
	}

	get configured(): boolean {
		return (this.#override ?? this.#fallback).configured;
	}

	get source(): MailSource {
		if (this.#override) return "settings";
		return this.#fallback.configured ? "env" : "none";
	}

	/** Mail goes through these settings from now on; undefined returns to the environment's mailer. */
	use(settings: SmtpSettings | undefined, factory: MailTransportFactory = smtpTransport): void {
		this.#override = settings ? new SmtpMailer(factory(settings), settings.from) : undefined;
	}

	send(to: string, subject: string, html: string, text: string): Promise<void> {
		return (this.#override ?? this.#fallback).send(to, subject, html, text);
	}
}

/** Minimal HTML escaping for values spliced into mail templates. */
export const escapeHtml = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
