import { describe, expect, it } from "vitest";
import { defaultPort, type MailForm, mailFormInput, mailFormProblem, toMailForm } from "../src/team/logic/mailSettings.ts";
import { onboardingProgress, showOnboarding } from "../src/team/logic/onboarding.ts";
import type { MailSettings, OnboardingStatus } from "../src/team/types.ts";

const form = (patch: Partial<MailForm> = {}): MailForm => ({
	host: "smtp.example.com",
	port: "465",
	security: "tls",
	username: "mailer@example.com",
	password: "",
	clearPassword: false,
	from: "Prometheus <no-reply@example.com>",
	...patch,
});

describe("mail form", () => {
	it("starts from what the Hub reports, with the password empty because it never comes back", () => {
		const hub: MailSettings = { source: "settings", configured: true, host: "h.example.com", port: 587, security: "starttls", username: "u", hasPassword: true, from: "a@b.co" };
		expect(toMailForm(hub)).toEqual({ host: "h.example.com", port: "587", security: "starttls", username: "u", password: "", clearPassword: false, from: "a@b.co" });
	});

	it("knows the usual port of each encryption mode", () => {
		expect([defaultPort("tls"), defaultPort("starttls"), defaultPort("none")]).toEqual([465, 587, 25]);
	});

	it("accepts a plain address or a named one as the sender", () => {
		expect(mailFormProblem(form())).toBeUndefined();
		expect(mailFormProblem(form({ from: "no-reply@example.com" }))).toBeUndefined();
	});

	it("names the first thing wrong, in the order the form reads", () => {
		expect(mailFormProblem(form({ host: "" }))).toBe("host");
		expect(mailFormProblem(form({ host: "has space.example.com" }))).toBe("host");
		expect(mailFormProblem(form({ host: "smtp.example.com\r\nX" }))).toBe("host");
		expect(mailFormProblem(form({ port: "" }))).toBe("port");
		expect(mailFormProblem(form({ port: "0" }))).toBe("port");
		expect(mailFormProblem(form({ port: "65536" }))).toBe("port");
		expect(mailFormProblem(form({ port: "46x5" }))).toBe("port");
		expect(mailFormProblem(form({ from: "not an address" }))).toBe("from");
		expect(mailFormProblem(form({ from: "Name <broken>" }))).toBe("from");
	});

	it("sends trimmed values and leaves the password out unless it was typed", () => {
		expect(mailFormInput(form({ host: "  smtp.example.com ", port: " 465 ", from: " a@b.co " }))).toEqual({
			host: "smtp.example.com",
			port: 465,
			security: "tls",
			from: "a@b.co",
			username: "mailer@example.com",
		});
		expect(mailFormInput(form({ password: "s3cret" }))).toMatchObject({ password: "s3cret" });
		expect(mailFormInput(form({ clearPassword: true }))).toMatchObject({ clearPassword: true });
		expect("password" in mailFormInput(form())).toBe(false);
	});

	it("sends no credentials at all when there is no username", () => {
		const input = mailFormInput(form({ username: "  ", password: "left over", clearPassword: true }));
		expect(input).not.toHaveProperty("username");
		expect(input).not.toHaveProperty("password");
		expect(input).not.toHaveProperty("clearPassword");
	});
});

const status = (done: boolean[], dismissed = false): OnboardingStatus => ({
	steps: (["publicUrl", "mail", "gateway", "team", "workspace", "invite"] as const).map((id, i) => ({ id, done: done[i] === true })),
	dismissed,
});

describe("first-run checklist", () => {
	it("points at the first open step, not the first one that happens to be undone later", () => {
		expect(onboardingProgress(status([true, false, false, true, false, false]))).toEqual({ done: 2, total: 6, next: "mail", complete: false });
		expect(onboardingProgress(status([false, false, false, false, false, false])).next).toBe("publicUrl");
	});

	it("is complete when every step is done", () => {
		expect(onboardingProgress(status([true, true, true, true, true, true]))).toEqual({ done: 6, total: 6, next: undefined, complete: true });
	});

	it("shows only to the operator, in the Hub UI, until it is dismissed, and not on an older Hub without it", () => {
		const open = status([true]);
		expect(showOnboarding(open, true, true)).toBe(true);
		expect(showOnboarding(open, false, true)).toBe(false);
		expect(showOnboarding(open, true, false)).toBe(false);
		expect(showOnboarding(status([true], true), true, true)).toBe(false);
		expect(showOnboarding(undefined, true, true)).toBe(false);
	});
});
