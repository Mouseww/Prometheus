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

/** Minimal HTML escaping for values spliced into mail templates. */
export const escapeHtml = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
