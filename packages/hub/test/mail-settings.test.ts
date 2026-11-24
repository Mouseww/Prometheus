import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MailTransport, SmtpSettings } from "../src/services/mailer.ts";
import { startHub, type TestHub } from "./hub-helpers.ts";

type Sent = { from: string; to: string; subject: string; html: string; text: string };

const FORM = { host: "smtp.example.com", port: 465, security: "tls", username: "mailer@example.com", password: "s3cret-pass", from: "Prometheus <no-reply@example.com>" } as const;

describe("mail settings in the admin console", () => {
	let t: TestHub;
	let root: { token: string; orgId: string };
	let member: { token: string };
	const sent: Sent[] = [];
	const built: SmtpSettings[] = [];
	let failNext: string | undefined;

	beforeAll(async () => {
		const mailTransport = (settings: SmtpSettings): MailTransport => {
			built.push(settings);
			return {
				sendMail: async (m) => {
					if (failNext) {
						const message = failNext;
						failNext = undefined;
						throw new Error(message);
					}
					sent.push(m);
				},
			};
		};
		t = await startHub({ publicUrl: "https://hub.corp.test", mailTransport });
		root = await t.bootstrap();
		member = await t.createUser(root.token, "member@corp.test");
	});
	afterAll(() => t.stop());

	it("starts unconfigured: mail only goes to the log", async () => {
		const view = await t.api("GET", "/api/admin/mail", { token: root.token });
		expect(view.data).toMatchObject({ source: "none", configured: false, host: "", hasPassword: false });
		expect((await t.api("GET", "/api/meta")).data.mailConfigured).toBe(false);
	});

	it("only the operator can read or change it", async () => {
		expect((await t.api("GET", "/api/admin/mail", { token: member.token })).status).toBe(403);
		expect((await t.api("PUT", "/api/admin/mail", { token: member.token, body: FORM })).status).toBe(403);
		expect((await t.api("POST", "/api/admin/mail/test", { token: member.token, body: { to: "a@b.co" } })).status).toBe(403);
		expect((await t.api("DELETE", "/api/admin/mail", { token: member.token })).status).toBe(403);
	});

	it("rejects hosts, ports and addresses that could smuggle in headers or commands", async () => {
		const put = (body: object) => t.api("PUT", "/api/admin/mail", { token: root.token, body: { ...FORM, ...body } });
		expect((await put({ host: "smtp.example.com\r\nRCPT TO:<x@y.z>" })).status).toBe(400);
		expect((await put({ host: "has space.example.com" })).code).toBe("invalidMailHost");
		expect((await put({ port: 0 })).status).toBe(400);
		expect((await put({ port: 70000 })).status).toBe(400);
		expect((await put({ security: "ssl" })).status).toBe(400);
		expect((await put({ from: "no-reply@example.com\r\nBcc: victim@x.y" })).code).toBe("invalidMailFrom");
		expect((await put({ from: "not an address" })).code).toBe("invalidMailFrom");
		expect((await put({ username: "a\nb" })).code).toBe("invalidMailUsername");
		expect((await t.api("GET", "/api/admin/mail", { token: root.token })).data.host).toBe("");
	});

	it("saving takes effect at once, never returns the password, and seals it at rest", async () => {
		const saved = await t.api("PUT", "/api/admin/mail", { token: root.token, body: FORM });
		expect(saved.status).toBe(200);
		expect(saved.data).toMatchObject({ source: "settings", configured: true, host: FORM.host, port: 465, security: "tls", username: FORM.username, hasPassword: true, from: FORM.from });
		expect(JSON.stringify(saved.body)).not.toContain(FORM.password);
		expect(JSON.stringify((await t.api("GET", "/api/admin/mail", { token: root.token })).body)).not.toContain(FORM.password);
		// No restart: the public meta already says mail works.
		expect((await t.api("GET", "/api/meta")).data.mailConfigured).toBe(true);

		const rows = await t.hub.db.query<{ value: unknown }>("SELECT value FROM platform_settings WHERE key = 'mail_settings'");
		expect(JSON.stringify(rows[0]?.value)).not.toContain(FORM.password);
		expect(JSON.stringify(rows[0]?.value)).toContain("v1:");

		const audit = await t.api("GET", "/api/admin/audit?action=mail.update", { token: root.token });
		expect(audit.data.items?.length ?? audit.data.length).toBeGreaterThan(0);
		expect(JSON.stringify(audit.body)).not.toContain(FORM.password);
	});

	it("leaving the password out keeps the saved one; clearing it removes it", async () => {
		const { password: _drop, ...noPassword } = FORM;
		await t.api("PUT", "/api/admin/mail", { token: root.token, body: { ...noPassword, port: 587, security: "starttls" } });
		expect(built.at(-1)).toMatchObject({ port: 587, security: "starttls", password: FORM.password });
		expect((await t.api("GET", "/api/admin/mail", { token: root.token })).data.hasPassword).toBe(true);

		await t.api("PUT", "/api/admin/mail", { token: root.token, body: { ...noPassword, clearPassword: true } });
		expect(built.at(-1)?.password).toBeUndefined();
		expect((await t.api("GET", "/api/admin/mail", { token: root.token })).data.hasPassword).toBe(false);
		await t.api("PUT", "/api/admin/mail", { token: root.token, body: FORM });
	});

	it("sends a test mail through what is saved, and reports the server's own error when it fails", async () => {
		const ok = await t.api("POST", "/api/admin/mail/test", { token: root.token, body: { to: "me@corp.test" } });
		expect(ok.data).toEqual({ ok: true });
		expect(sent.at(-1)).toMatchObject({ to: "me@corp.test", from: FORM.from });

		failNext = "535 5.7.8 Authentication failed";
		const bad = await t.api("POST", "/api/admin/mail/test", { token: root.token, body: { to: "me@corp.test" } });
		expect(bad.status).toBe(200);
		expect(bad.data).toEqual({ ok: false, error: "535 5.7.8 Authentication failed" });
	});

	it("tests unsaved settings without saving them, borrowing the saved password when the form leaves it out", async () => {
		const before = (await t.api("GET", "/api/admin/mail", { token: root.token })).data;
		const { password: _drop, ...noPassword } = FORM;
		const r = await t.api("POST", "/api/admin/mail/test", { token: root.token, body: { to: "me@corp.test", config: { ...noPassword, host: "other.example.com" } } });
		expect(r.data).toEqual({ ok: true });
		expect(built.at(-1)).toMatchObject({ host: "other.example.com", password: FORM.password });
		expect((await t.api("GET", "/api/admin/mail", { token: root.token })).data).toEqual(before);
		expect((await t.api("POST", "/api/admin/mail/test", { token: root.token, body: { to: "bad", config: FORM } })).status).toBe(400);
	});

	it("the mail settings survive a restart of the service layer: load() applies what is stored", async () => {
		const mailSettings = t.hub.registry.require<{ load(): Promise<void> }>("mailSettings");
		await mailSettings.load();
		expect((await t.api("GET", "/api/admin/mail", { token: root.token })).data).toMatchObject({ source: "settings", configured: true });
	});

	it("clearing falls back to the environment, here nothing", async () => {
		const cleared = await t.api("DELETE", "/api/admin/mail", { token: root.token });
		expect(cleared.data).toMatchObject({ source: "none", configured: false, host: "", hasPassword: false });
		expect((await t.api("GET", "/api/meta")).data.mailConfigured).toBe(false);
		const test = await t.api("POST", "/api/admin/mail/test", { token: root.token, body: { to: "me@corp.test" } });
		expect(test.code).toBe("mailNotConfigured");
	});

	it("limits how often test mails can be sent", async () => {
		await t.api("PUT", "/api/admin/mail", { token: root.token, body: FORM });
		let last = 0;
		for (let i = 0; i < 12; i++) last = (await t.api("POST", "/api/admin/mail/test", { token: root.token, body: { to: "me@corp.test" } })).status;
		expect(last).toBe(429);
	});
});

describe("environment mail stays the fallback", () => {
	it("reports the environment as the source until the console saves something", async () => {
		const sent: Sent[] = [];
		const t = await startHub({
			env: { HUB_SMTP_URL: "smtp://user:pw@smtp.env.test:25", HUB_MAIL_FROM: "Env <env@corp.test>" },
			mailTransport: () => ({ sendMail: async (m) => void sent.push(m) }),
		});
		try {
			const root = await t.bootstrap();
			expect((await t.api("GET", "/api/admin/mail", { token: root.token })).data).toMatchObject({ source: "env", configured: true, host: "" });
			await t.api("PUT", "/api/admin/mail", { token: root.token, body: FORM });
			expect((await t.api("GET", "/api/admin/mail", { token: root.token })).data.source).toBe("settings");
			expect((await t.api("DELETE", "/api/admin/mail", { token: root.token })).data.source).toBe("env");
		} finally {
			await t.stop();
		}
	});
});

describe("invitation mail", () => {
	let t: TestHub;
	let root: { token: string; orgId: string };
	const sent: Sent[] = [];
	let failNext = false;

	beforeAll(async () => {
		t = await startHub({
			publicUrl: "https://hub.corp.test",
			mailTransport: () => ({
				sendMail: async (m) => {
					if (failNext) {
						failNext = false;
						throw new Error("550 mailbox unavailable");
					}
					sent.push(m);
				},
			}),
		});
		root = await t.bootstrap();
	});
	afterAll(() => t.stop());

	const invite = (email: string, sendEmail?: boolean) =>
		t.api("POST", "/api/invitations", { token: root.token, body: { scope: "org", scopeId: root.orgId, email, role: "member", ...(sendEmail === undefined ? {} : { sendEmail }) } });

	it("without asking, only the link comes back and nothing is mailed", async () => {
		const r = await invite("a@outside.test");
		expect(r.data.mail).toBe("skipped");
		expect(r.data.link).toContain("https://hub.corp.test/invite/");
		expect(sent).toHaveLength(0);
	});

	it("asking while mail is not configured reports it but still creates the invitation", async () => {
		const r = await invite("b@outside.test", true);
		expect(r.status).toBe(201);
		expect(r.data).toMatchObject({ mail: "failed", mailError: "mailNotConfigured" });
		expect(r.data.link).toContain("/invite/");
	});

	it("mails the link once mail is configured, escaping what it splices in", async () => {
		await t.api("PUT", "/api/admin/mail", { token: root.token, body: FORM });
		await t.api("PUT", "/api/admin/settings", { token: root.token, body: { siteName: "Acme <Labs>" } });
		const r = await invite("c@outside.test", true);
		expect(r.data.mail).toBe("sent");
		const mail = sent.at(-1) as Sent;
		expect(mail.to).toBe("c@outside.test");
		expect(mail.text).toContain(r.data.link);
		expect(mail.text).toContain("Acme <Labs>");
		expect(mail.html).toContain("Acme &lt;Labs&gt;");
		expect(mail.html).not.toContain("Acme <Labs>");
	});

	it("a failing mail server never fails the invitation and does not leak its answer to the inviter", async () => {
		failNext = true;
		const r = await invite("d@outside.test", true);
		expect(r.status).toBe(201);
		expect(r.data).toMatchObject({ mail: "failed", mailError: "sendFailed" });
		expect(JSON.stringify(r.body)).not.toContain("550");
		expect((await t.api("GET", `/api/invitations/${r.data.token}`)).status).toBe(200);
	});

	it("the validity period comes from the platform settings", async () => {
		await t.api("PUT", "/api/admin/settings", { token: root.token, body: { invitationTtlDays: 2 } });
		const r = await invite("e@outside.test");
		const days = (Date.parse(r.data.invitation.expiresAt) - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(1.9);
		expect(days).toBeLessThan(2.1);
	});

	it("validates the new platform settings", async () => {
		const put = (body: object) => t.api("PUT", "/api/admin/settings", { token: root.token, body });
		expect((await put({ invitationTtlDays: 0 })).status).toBe(400);
		expect((await put({ invitationTtlDays: 31 })).status).toBe(400);
		expect((await put({ siteName: "x".repeat(61) })).status).toBe(400);
		const ok = await put({ siteName: "  Acme  ", invitationTtlDays: 14 });
		expect(ok.data).toMatchObject({ siteName: "Acme", invitationTtlDays: 14 });
		expect((await t.api("GET", "/api/admin/settings", { token: root.token })).data).toMatchObject({ siteName: "Acme", invitationTtlDays: 14 });
	});
});

describe("without a public URL", () => {
	it("cannot put a link into a mail and says so", async () => {
		const t = await startHub({ mailTransport: () => ({ sendMail: async () => {} }) });
		try {
			const root = await t.bootstrap();
			await t.api("PUT", "/api/admin/mail", { token: root.token, body: FORM });
			const r = await t.api("POST", "/api/invitations", { token: root.token, body: { scope: "org", scopeId: root.orgId, email: "f@outside.test", role: "member", sendEmail: true } });
			expect(r.data).toMatchObject({ mail: "failed", mailError: "publicUrlMissing" });
		} finally {
			await t.stop();
		}
	});
});

describe("first-run checklist", () => {
	let t: TestHub;
	let root: { token: string; orgId: string };
	let member: { token: string };

	beforeAll(async () => {
		t = await startHub({ publicUrl: "https://hub.corp.test", mailTransport: () => ({ sendMail: async () => {} }) });
		root = await t.bootstrap();
		member = await t.createUser(root.token, "member@corp.test");
	});
	afterAll(() => t.stop());

	const status = async () => (await t.api("GET", "/api/admin/onboarding", { token: root.token })).data as { steps: { id: string; done: boolean }[]; dismissed: boolean };
	const done = (s: { steps: { id: string; done: boolean }[] }) => Object.fromEntries(s.steps.map((x) => [x.id, x.done]));

	it("only the operator sees it", async () => {
		expect((await t.api("GET", "/api/admin/onboarding", { token: member.token })).status).toBe(403);
		expect((await t.api("PUT", "/api/admin/onboarding", { token: member.token, body: { dismissed: true } })).status).toBe(403);
	});

	it("each step turns done by itself as the Hub gets set up", async () => {
		// createUser above counts as a second account, so the invite step starts done; check the rest in order.
		const first = await status();
		expect(first.steps.map((s) => s.id)).toEqual(["publicUrl", "mail", "gateway", "team", "workspace", "invite"]);
		expect(first.dismissed).toBe(false);
		expect(done(first)).toMatchObject({ publicUrl: true, mail: false, gateway: false, team: false, workspace: false });

		await t.api("PUT", "/api/admin/mail", { token: root.token, body: FORM });
		expect(done(await status()).mail).toBe(true);

		await t.api("POST", "/api/teams", { token: root.token, body: { name: "Platform", orgId: root.orgId } });
		expect(done(await status()).team).toBe(true);
	});

	it("can be dismissed and brought back", async () => {
		expect((await t.api("PUT", "/api/admin/onboarding", { token: root.token, body: { dismissed: true } })).data.dismissed).toBe(true);
		expect((await status()).dismissed).toBe(true);
		expect((await t.api("PUT", "/api/admin/onboarding", { token: root.token, body: { dismissed: false } })).data.dismissed).toBe(false);
	});

	it("reports a missing public URL as the first thing to fix", async () => {
		const bare = await startHub();
		try {
			const r = await bare.bootstrap();
			const s = (await bare.api("GET", "/api/admin/onboarding", { token: r.token })).data as { steps: { id: string; done: boolean }[] };
			expect(done(s).publicUrl).toBe(false);
		} finally {
			await bare.stop();
		}
	});
});
