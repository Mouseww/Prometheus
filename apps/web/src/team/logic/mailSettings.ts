// Pure helpers for the mail server form: what the form holds, what it sends, and when it is not worth sending.
import type { MailSettings, MailSettingsInput, SmtpSecurity } from "../types.ts";

/** The form keeps the port as text so a half typed number does not jump around. */
export interface MailForm {
	host: string;
	port: string;
	security: SmtpSecurity;
	username: string;
	password: string;
	clearPassword: boolean;
	from: string;
}

const USUAL_PORT: Record<SmtpSecurity, number> = { tls: 465, starttls: 587, none: 25 };

export const defaultPort = (security: SmtpSecurity): number => USUAL_PORT[security];

/** The form for what the Hub reports. The password never comes back, so it starts empty. */
export function toMailForm(s: MailSettings): MailForm {
	return { host: s.host, port: String(s.port), security: s.security, username: s.username, password: "", clearPassword: false, from: s.from };
}

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]+\]$/;
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** `Name <a@b.c>` or a bare address. */
const addressOf = (from: string): string => /<([^<>]+)>\s*$/.exec(from.trim())?.[1]?.trim() ?? from.trim();

export type MailFormProblem = "host" | "port" | "from";

/** The first thing that would make the Hub refuse the form, so the buttons can stay off; the Hub checks again. */
export function mailFormProblem(f: MailForm): MailFormProblem | undefined {
	const host = f.host.trim();
	if (!host || !HOST.test(host)) return "host";
	const port = Number(f.port);
	if (!/^\d+$/.test(f.port.trim()) || port < 1 || port > 65535) return "port";
	if (!ADDRESS.test(addressOf(f.from))) return "from";
	return undefined;
}

/** What goes over the wire: trimmed, and the password only when it was typed or is being removed. */
export function mailFormInput(f: MailForm): MailSettingsInput {
	const username = f.username.trim();
	return {
		host: f.host.trim(),
		port: Number(f.port),
		security: f.security,
		from: f.from.trim(),
		...(username ? { username } : {}),
		...(username && f.password ? { password: f.password } : {}),
		...(username && f.clearPassword ? { clearPassword: true } : {}),
	};
}
