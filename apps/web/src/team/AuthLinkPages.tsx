// Signed-out pages behind the links the Hub mails out (verify email, reset password) and the forms that request those mails.
import { CheckCircle2, MailCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button, Field, Input } from "../components/ui.tsx";
import { defineMessages, useT } from "../lib/i18n.ts";
import { TeamApiError, type HubApi } from "./api.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { errorText } from "./i18n.ts";
import { ErrorBox, Notice, useAction } from "./kit.tsx";
import type { VerifyEmailResult } from "./types.ts";

const M = defineMessages({
	zh: {
		verifying: "正在验证邮箱",
		verifiedTitle: "邮箱已验证",
		verifiedActive: "账号已启用，现在可以登录。",
		verifiedPending: "邮箱已验证。账号还需要管理员审批，批准后即可登录。",
		verifyFailed: "验证链接无效、已过期或已被使用。",
		toSignIn: "去登录",
		email: "邮箱",
		resend: "重新发送验证邮件",
		resendNeutral: "如果该邮箱对应一个未验证的账号，新的验证邮件已发送，请查收。",
		busy: "请稍候",
		forgotTitle: "忘记密码",
		forgotBody: "输入注册邮箱，我们会发送重置密码的链接。",
		forgotSend: "发送重置邮件",
		forgotNeutral: "如果该邮箱对应一个账号，重置邮件已发送，请查收。链接 1 小时内有效。",
		backToLogin: "返回登录",
		resetTitle: "设置新密码",
		newPassword: "新密码",
		confirmPassword: "确认新密码",
		passwordHint: "至少 8 位",
		mismatch: "两次输入的密码不一致",
		resetSave: "保存新密码",
		resetDone: "密码已更新，请用新密码登录。其他设备上的登录会失效。",
		resetFailed: "重置链接无效、已过期或已被使用。可以重新申请一封。",
		requestAnother: "重新申请重置邮件",
	},
	en: {
		verifying: "Verifying your email",
		verifiedTitle: "Email verified",
		verifiedActive: "Your account is active. You can sign in now.",
		verifiedPending: "Email verified. An administrator still has to approve the account before you can sign in.",
		verifyFailed: "The verification link is invalid, expired or already used.",
		toSignIn: "Go to sign in",
		email: "Email",
		resend: "Resend verification email",
		resendNeutral: "If that email belongs to an unverified account, a new verification mail was sent. Check your inbox.",
		busy: "Please wait",
		forgotTitle: "Forgot password",
		forgotBody: "Enter the email you registered with and we will send a link to reset the password.",
		forgotSend: "Send reset email",
		forgotNeutral: "If that email belongs to an account, a reset mail was sent. Check your inbox. The link works for 1 hour.",
		backToLogin: "Back to sign in",
		resetTitle: "Set a new password",
		newPassword: "New password",
		confirmPassword: "Confirm new password",
		passwordHint: "At least 8 characters",
		mismatch: "The two passwords do not match",
		resetSave: "Save new password",
		resetDone: "Password updated. Sign in with the new one. Other devices are signed out.",
		resetFailed: "The reset link is invalid, expired or already used. You can request another.",
		requestAnother: "Request another reset email",
	},
});

/** Asks the Hub to mail a fresh verification link; always answers with the same neutral line. */
export function ResendVerification({ api, initialEmail = "" }: { api: HubApi; initialEmail?: string }) {
	const t = useT(M);
	const [email, setEmail] = useState(initialEmail);
	const [sent, setSent] = useState(false);
	const { busy, error, run } = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setSent(false);
		if ((await run(async () => (await api.resendVerification(email.trim()), true))) === true) setSent(true);
	};
	return (
		<form onSubmit={submit} className="space-y-3" aria-label={t("resend")}>
			<Field label={t("email")}>
				<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
			</Field>
			<Button type="submit" variant="outline" disabled={busy || !email.trim()} className="w-full">
				{busy ? t("busy") : t("resend")}
			</Button>
			{sent && <Notice kind="ok">{t("resendNeutral")}</Notice>}
			{error && <Notice kind="error">{error}</Notice>}
		</form>
	);
}

// A verification token works once and React StrictMode runs effects twice in development: share one call per token.
const verifyCalls = new Map<string, Promise<VerifyEmailResult>>();

export function VerifyEmailPage({ api, token, onDone }: { api: HubApi; token: string; onDone: () => void }) {
	const t = useT(M);
	const [state, setState] = useState<{ phase: "loading" } | { phase: "ok"; result: VerifyEmailResult } | { phase: "error"; message: string }>({ phase: "loading" });

	useEffect(() => {
		let live = true;
		let call = verifyCalls.get(token);
		if (!call) {
			call = api.verifyEmail(token);
			verifyCalls.set(token, call);
		}
		call.then(
			(result) => live && setState({ phase: "ok", result }),
			(e: unknown) => live && setState({ phase: "error", message: e instanceof TeamApiError && e.status < 500 && e.code !== "network" ? t("verifyFailed") : errorText(e) }),
		);
		return () => {
			live = false;
		};
	}, [api, token, t]);

	return (
		<AuthFrame>
			{state.phase === "loading" && (
				<p role="status" className="text-sm text-ink-400">
					{t("verifying")}
				</p>
			)}
			{state.phase === "ok" && (
				<div className="space-y-3 text-center" role="status">
					<div className="mx-auto grid size-12 place-items-center rounded-2xl border border-ink-700 text-moss-400">
						<CheckCircle2 className="size-5" aria-hidden />
					</div>
					<h2 className="font-display text-lg font-semibold">{t("verifiedTitle")}</h2>
					<p className="text-sm text-ink-400">{state.result.status === "active" ? t("verifiedActive") : t("verifiedPending")}</p>
					<Button variant="primary" onClick={onDone}>
						{t("toSignIn")}
					</Button>
				</div>
			)}
			{state.phase === "error" && (
				<div className="space-y-4">
					<ErrorBox message={state.message} compact />
					<ResendVerification api={api} />
					<Button variant="ghost" onClick={onDone} className="w-full">
						{t("backToLogin")}
					</Button>
				</div>
			)}
		</AuthFrame>
	);
}

/** Embedded in the sign-in card as its third mode. Always shows the neutral line, whether or not the account exists. */
export function ForgotPasswordForm({ api, initialEmail, onBack }: { api: HubApi; initialEmail: string; onBack: () => void }) {
	const t = useT(M);
	const [email, setEmail] = useState(initialEmail);
	const [sent, setSent] = useState(false);
	const { busy, error, run } = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setSent(false);
		if ((await run(async () => (await api.forgotPassword(email.trim()), true))) === true) setSent(true);
	};
	return (
		<div className="space-y-3">
			<div>
				<h2 className="font-display text-lg font-semibold">{t("forgotTitle")}</h2>
				<p className="text-sm text-ink-400">{t("forgotBody")}</p>
			</div>
			<form onSubmit={submit} className="space-y-3" aria-label={t("forgotTitle")}>
				<Field label={t("email")}>
					<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" autoFocus />
				</Field>
				{sent && (
					<Notice kind="ok">
						<MailCheck className="mr-1.5 inline size-4" aria-hidden />
						{t("forgotNeutral")}
					</Notice>
				)}
				{error && <Notice kind="error">{error}</Notice>}
				<Button type="submit" variant="primary" disabled={busy || !email.trim()} className="w-full">
					{busy ? t("busy") : t("forgotSend")}
				</Button>
			</form>
			<button type="button" onClick={onBack} className="text-sm text-ink-400 underline-offset-2 hover:text-ink-100 hover:underline">
				{t("backToLogin")}
			</button>
		</div>
	);
}

export function ResetPasswordPage({ api, token, onDone, onRequestAnother }: { api: HubApi; token: string; onDone: () => void; onRequestAnother: () => void }) {
	const t = useT(M);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [done, setDone] = useState(false);
	const [dead, setDead] = useState(false);
	const { busy, error, run } = useAction();
	const mismatch = confirm.length > 0 && confirm !== password;

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (password !== confirm) return;
		try {
			await api.resetPassword(token, password);
			setDone(true);
		} catch (err) {
			// The Hub answers invalidToken (401) for a used, expired or unknown link.
			if (err instanceof TeamApiError && err.code === "invalidToken") setDead(true);
			else await run(() => Promise.reject(err));
		}
	};

	return (
		<AuthFrame>
			{done ? (
				<div className="space-y-3 text-center" role="status">
					<div className="mx-auto grid size-12 place-items-center rounded-2xl border border-ink-700 text-moss-400">
						<CheckCircle2 className="size-5" aria-hidden />
					</div>
					<p className="text-sm text-ink-300">{t("resetDone")}</p>
					<Button variant="primary" onClick={onDone}>
						{t("toSignIn")}
					</Button>
				</div>
			) : dead ? (
				<div className="space-y-3">
					<ErrorBox message={t("resetFailed")} compact />
					<Button variant="primary" onClick={onRequestAnother} className="w-full">
						{t("requestAnother")}
					</Button>
				</div>
			) : (
				<form onSubmit={submit} className="space-y-3" aria-label={t("resetTitle")}>
					<h2 className="font-display text-lg font-semibold">{t("resetTitle")}</h2>
					<Field label={t("newPassword")} hint={t("passwordHint")}>
						<Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" autoFocus />
					</Field>
					<Field label={t("confirmPassword")}>
						<Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" aria-invalid={mismatch} />
					</Field>
					{mismatch && <Notice kind="error">{t("mismatch")}</Notice>}
					{error && <Notice kind="error">{error}</Notice>}
					<Button type="submit" variant="primary" disabled={busy || mismatch} className="w-full">
						{busy ? t("busy") : t("resetSave")}
					</Button>
				</form>
			)}
		</AuthFrame>
	);
}
