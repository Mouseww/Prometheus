// Operator console: the mail server that sends invitations, verification and password reset mails.
import { Send } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, Field, Input, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { Card, ConfirmButton, Notice, useAction } from "../../kit.tsx";
import { defaultPort, mailFormInput, mailFormProblem, type MailForm, toMailForm } from "../../logic/mailSettings.ts";
import type { MailSettings, MailTestResult, SmtpSecurity } from "../../types.ts";

const M = defineMessages({
	zh: {
		title: "邮件服务",
		intro: "邀请、邮箱验证和重置密码都通过这里的邮件服务发出。保存后立即生效，不需要重启 Hub。",
		sourceSettings: "当前使用这里保存的设置。",
		sourceEnv: "当前使用环境变量 HUB_SMTP_URL。在这里保存后会改用这里的设置。",
		sourceNone: "还没有配置：邮件只会写入 Hub 日志，收件人收不到。",
		host: "SMTP 服务器",
		hostHint: "例如 smtp.example.com",
		port: "端口",
		security: "加密方式",
		tls: "SSL/TLS（通常 465）",
		starttls: "STARTTLS（通常 587）",
		none: "不加密（通常 25，不建议）",
		username: "用户名",
		usernameHint: "服务器不需要登录时留空",
		password: "密码",
		passwordSaved: "已保存，留空表示不修改",
		clearPassword: "清除已保存的密码",
		from: "发件人",
		fromHint: "例如 Prometheus <no-reply@example.com>，需要是服务器允许使用的地址",
		save: "保存",
		clear: "清除设置",
		clearConfirm: "再点一次清除",
		cleared: "已清除，邮件改用环境变量，没有则只写入日志。",
		testTitle: "发送测试邮件",
		testTo: "收件人",
		testSend: "发送测试邮件",
		testOk: "已发出，请到收件箱确认。",
		testFailed: "发送失败：{error}",
		testHintUnsaved: "测试使用表单里当前填写的内容，不需要先保存。",
		saved: "已保存并生效。",
	},
	en: {
		title: "Mail server",
		intro: "Invitations, email verification and password resets are all sent through this server. Saving takes effect at once, no Hub restart.",
		sourceSettings: "Using the settings saved here.",
		sourceEnv: "Using the HUB_SMTP_URL environment variable. Saving here switches to these settings.",
		sourceNone: "Not configured: mail only goes to the Hub log and recipients never get it.",
		host: "SMTP server",
		hostHint: "For example smtp.example.com",
		port: "Port",
		security: "Encryption",
		tls: "SSL/TLS (usually 465)",
		starttls: "STARTTLS (usually 587)",
		none: "None (usually 25, not recommended)",
		username: "Username",
		usernameHint: "Leave empty when the server needs no login",
		password: "Password",
		passwordSaved: "Saved. Leave empty to keep it",
		clearPassword: "Remove the saved password",
		from: "Sender",
		fromHint: "For example Prometheus <no-reply@example.com>. The server must allow this address",
		save: "Save",
		clear: "Clear settings",
		clearConfirm: "Click again to clear",
		cleared: "Cleared. Mail goes back to the environment variable, or only to the log if there is none.",
		testTitle: "Send a test mail",
		testTo: "Recipient",
		testSend: "Send test mail",
		testOk: "Sent. Check the inbox to be sure.",
		testFailed: "Sending failed: {error}",
		testHintUnsaved: "The test uses what is in the form now, so you can try before saving.",
		saved: "Saved and in effect.",
	},
});

const SECURITIES: readonly SmtpSecurity[] = ["tls", "starttls", "none"];

export function MailSettingsCard({ initial }: { initial: MailSettings }) {
	const { api, me } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const [current, setCurrent] = useState(initial);
	const [form, setForm] = useState<MailForm>(() => toMailForm(initial));
	const [to, setTo] = useState(me.user.email);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const [test, setTest] = useState<MailTestResult | undefined>(undefined);
	const save = useAction();
	const testing = useAction();
	const clearing = useAction();

	const patch = (next: Partial<MailForm>) => {
		setForm((f) => ({ ...f, ...next }));
		setNotice(undefined);
		setTest(undefined);
	};
	// Moving between encryption modes also moves the port, but only when it still holds the previous mode's usual port.
	const changeSecurity = (security: SmtpSecurity) => patch({ security, port: form.port === String(defaultPort(form.security)) ? String(defaultPort(security)) : form.port });

	const problem = mailFormProblem(form);
	const apply = (next: MailSettings) => {
		setCurrent(next);
		setForm(toMailForm(next));
	};

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const next = await save.run(() => api.putMailSettings(mailFormInput(form)));
		if (!next) return;
		apply(next);
		setNotice(t("saved"));
	};
	const sendTest = async () => {
		setTest(undefined);
		const r = await testing.run(() => api.testMail(to.trim(), mailFormInput(form)));
		if (r) setTest(r);
	};
	const clear = async () => {
		const next = await clearing.run(() => api.clearMailSettings());
		if (!next) return;
		apply(next);
		setNotice(t("cleared"));
	};

	const sourceText = current.source === "settings" ? t("sourceSettings") : current.source === "env" ? t("sourceEnv") : t("sourceNone");
	return (
		<Card title={t("title")}>
			<div className="space-y-4">
				<p className="text-sm text-ink-300">{t("intro")}</p>
				<p className={current.configured ? "text-xs text-moss-400" : "text-xs text-ember-300"} role="status">
					{sourceText}
				</p>
				<form onSubmit={submit} className="space-y-3">
					<div className="grid gap-3 @xl:grid-cols-[1fr_8rem_14rem]">
						<Field label={t("host")} hint={t("hostHint")}>
							<Input value={form.host} onChange={(e) => patch({ host: e.target.value })} required autoComplete="off" spellCheck={false} placeholder="smtp.example.com" />
						</Field>
						<Field label={t("port")}>
							<Input value={form.port} onChange={(e) => patch({ port: e.target.value })} required inputMode="numeric" autoComplete="off" />
						</Field>
						<Field label={t("security")}>
							<Select value={form.security} onChange={(e) => changeSecurity(e.target.value as SmtpSecurity)}>
								{SECURITIES.map((s) => (
									<option key={s} value={s}>
										{t(s)}
									</option>
								))}
							</Select>
						</Field>
					</div>
					<div className="grid gap-3 @xl:grid-cols-2">
						<Field label={t("username")} hint={t("usernameHint")}>
							<Input value={form.username} onChange={(e) => patch({ username: e.target.value })} autoComplete="off" spellCheck={false} />
						</Field>
						<Field label={t("password")}>
							<Input
								type="password"
								value={form.password}
								onChange={(e) => patch({ password: e.target.value, clearPassword: false })}
								autoComplete="new-password"
								placeholder={current.hasPassword && !form.clearPassword ? t("passwordSaved") : ""}
								disabled={form.clearPassword}
							/>
						</Field>
					</div>
					{current.hasPassword && (
						<label className="flex items-center gap-2 text-sm">
							<input type="checkbox" checked={form.clearPassword} onChange={(e) => patch({ clearPassword: e.target.checked, password: "" })} className="size-4 accent-ember-500" />
							{t("clearPassword")}
						</label>
					)}
					<Field label={t("from")} hint={t("fromHint")}>
						<Input value={form.from} onChange={(e) => patch({ from: e.target.value })} required autoComplete="off" spellCheck={false} placeholder="Prometheus <no-reply@example.com>" />
					</Field>
					<div className="flex flex-wrap items-center gap-2">
						<Button type="submit" variant="primary" disabled={save.busy || problem !== undefined}>
							{c("save")}
						</Button>
						{current.source === "settings" && <ConfirmButton label={t("clear")} confirmLabel={t("clearConfirm")} onConfirm={() => void clear()} disabled={clearing.busy} />}
					</div>
					{notice && <Notice kind="ok">{notice}</Notice>}
					{save.error && <Notice kind="error">{save.error}</Notice>}
					{clearing.error && <Notice kind="error">{clearing.error}</Notice>}
				</form>

				<div className="space-y-3 border-t hairline pt-4">
					<h3 className="text-sm font-medium">{t("testTitle")}</h3>
					<p className="text-xs text-ink-500">{t("testHintUnsaved")}</p>
					<div className="grid gap-3 @xl:grid-cols-[1fr_auto] @xl:items-end">
						<Field label={t("testTo")}>
							<Input type="email" value={to} onChange={(e) => setTo(e.target.value)} autoComplete="off" />
						</Field>
						<Button type="button" variant="outline" onClick={() => void sendTest()} disabled={testing.busy || problem !== undefined || !to.trim()}>
							<Send className="size-4" aria-hidden /> {t("testSend")}
						</Button>
					</div>
					{test?.ok && <Notice kind="ok">{t("testOk")}</Notice>}
					{test && !test.ok && <Notice kind="error">{t("testFailed", { error: test.error ?? "" })}</Notice>}
					{testing.error && <Notice kind="error">{testing.error}</Notice>}
				</div>
			</div>
		</Card>
	);
}
