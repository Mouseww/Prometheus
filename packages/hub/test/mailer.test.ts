import { describe, expect, it } from "vitest";
import type { HubLog } from "../src/log.ts";
import { createMailer, DEFAULT_MAIL_FROM, LogMailer, type MailTransport, SmtpMailer } from "../src/services/mailer.ts";

const capture = (): { log: HubLog; lines: string[] } => {
	const lines: string[] = [];
	return { lines, log: { info: (m) => void lines.push(`I ${m}`), warn: (m) => void lines.push(`W ${m}`), error: (m) => void lines.push(`E ${m}`) } };
};

describe("mailer", () => {
	it("LogMailer writes recipient, subject and text to the log and reports not configured", async () => {
		const { log, lines } = capture();
		const mailer = new LogMailer(log);
		await mailer.send("a@example.com", "主题", "<p>x</p>", "正文 http://link");
		expect(mailer.configured).toBe(false);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("[prometheus-hub]");
		expect(lines[0]).toContain("a@example.com");
		expect(lines[0]).toContain("正文 http://link");
	});

	it("SmtpMailer hands the message to the transport with the configured sender", async () => {
		const sent: unknown[] = [];
		const transport: MailTransport = { sendMail: async (m) => void sent.push(m) };
		const mailer = new SmtpMailer(transport, "Hub <hub@example.com>");
		await mailer.send("b@example.com", "s", "<b>h</b>", "t");
		expect(mailer.configured).toBe(true);
		expect(sent).toEqual([{ from: "Hub <hub@example.com>", to: "b@example.com", subject: "s", html: "<b>h</b>", text: "t" }]);
	});

	it("SmtpMailer propagates transport failures", async () => {
		const mailer = new SmtpMailer({ sendMail: async () => Promise.reject(new Error("boom")) }, "x@y.z");
		await expect(mailer.send("b@example.com", "s", "h", "t")).rejects.toThrow("boom");
	});

	it("createMailer falls back to LogMailer with a warning when HUB_SMTP_URL is unset", () => {
		const { log, lines } = capture();
		const mailer = createMailer({ smtpUrl: undefined, from: undefined }, log);
		expect(mailer).toBeInstanceOf(LogMailer);
		expect(lines.some((l) => l.startsWith("W ") && l.includes("HUB_SMTP_URL"))).toBe(true);
	});

	it("createMailer builds an SMTP mailer from HUB_SMTP_URL (real nodemailer transport, nothing sent)", () => {
		const mailer = createMailer({ smtpUrl: "smtp://user:pass@127.0.0.1:2525", from: undefined }, capture().log);
		expect(mailer).toBeInstanceOf(SmtpMailer);
		expect(mailer.configured).toBe(true);
	});

	it("createMailer uses an injected transport and the default sender", async () => {
		const sent: { from: string }[] = [];
		const mailer = createMailer({ smtpUrl: undefined, from: undefined, transport: { sendMail: async (m) => void sent.push(m) } }, capture().log);
		await mailer.send("c@example.com", "s", "h", "t");
		expect(sent[0]?.from).toBe(DEFAULT_MAIL_FROM);
	});
});
