// Root of the Hub's own web UI (Hub mode). Owns the login state; everything after sign-in is the shared TeamShell.
import { Clock, LogOut, MailCheck } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button, Field, Input } from "../components/ui.tsx";
import { defineMessages, useT } from "../lib/i18n.ts";
import { usePrefs } from "../lib/prefs.ts";
import { dismissSplash } from "../lib/splash.ts";
import { TeamApiError, type HubApi } from "./api.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { ForgotPasswordForm, ResendVerification, ResetPasswordPage, VerifyEmailPage } from "./AuthLinkPages.tsx";
import { createHubApi } from "./hubApi.ts";
import { inviteTokenFromPath } from "./hubMode.ts";
import { errorText, roleLabel, useCommonT } from "./i18n.ts";
import { ErrorBox, Notice, useAction } from "./kit.tsx";
import { APP_ROOT, type AuthLink, authLinkFromLocation, isPublicMode, needsTurnstile } from "./logic/publicMode.ts";
import { TeamShell } from "./TeamShell.tsx";
import type { InvitationView, MetaInfo } from "./types.ts";
import { Turnstile } from "./Turnstile.tsx";

const M = defineMessages({
	zh: {
		login: "登录",
		register: "注册",
		email: "邮箱",
		password: "密码",
		passwordHint: "至少 8 位",
		displayName: "姓名",
		remember: "记住我",
		setupCode: "设置码",
		setupHint: "首次启动时 Hub 日志里打印的设置码。你将成为运营者。",
		signIn: "登录",
		signUp: "创建账号",
		busy: "请稍候",
		noAccount: "还没有账号？注册",
		haveAccount: "已有账号？登录",
		forgot: "忘记密码？",
		registrationClosed: "当前不开放注册，请联系管理员创建账号或发送邀请。",
		invitedTo: "邀请你加入 {name}（{role}）",
		inviteBad: "邀请链接无效或已过期。",
		pendingTitle: "等待管理员审批",
		pendingBody: "账号已创建，管理员批准后即可登录。",
		verifyTitle: "请查收验证邮件",
		verifyBody: "我们已向 {email} 发送了验证链接。点击链接验证邮箱后即可登录，链接 24 小时内有效。",
		verifyNoMail: "这个 Hub 没有配置邮件服务，验证链接只会写入 Hub 日志。请联系运营者。",
		backToLogin: "返回登录",
		menu: "账户菜单",
		signOut: "退出登录",
		language: "English",
		metaFailed: "无法读取 Hub 信息",
		loading: "正在连接 Hub",
		approvalNote: "注册后需要管理员审批。",
		needVerify: "还没有验证邮箱？",
		inviteSignedInTitle: "你已登录",
		inviteSignedIn: "你当前以 {name}（{email}）登录。",
		inviteDetail: "这个邀请要加入 {name}（{role}），发给 {to}。",
		inviteHow: "邀请需要在创建新账号时使用。退出登录后，可以用这个邀请注册另一个账号；也可以继续使用当前账号。",
		inviteSwitch: "退出登录，用其他账号使用邀请",
		inviteKeep: "继续使用当前账号",
	},
	en: {
		login: "Sign in",
		register: "Register",
		email: "Email",
		password: "Password",
		passwordHint: "At least 8 characters",
		displayName: "Name",
		remember: "Remember me",
		setupCode: "Setup code",
		setupHint: "The setup code the Hub printed in its log on first start. You become the operator.",
		signIn: "Sign in",
		signUp: "Create account",
		busy: "Please wait",
		noAccount: "No account yet? Register",
		haveAccount: "Have an account? Sign in",
		forgot: "Forgot password?",
		registrationClosed: "Registration is closed. Ask an administrator for an account or an invitation.",
		invitedTo: "You are invited to join {name} ({role})",
		inviteBad: "The invitation link is invalid or expired.",
		pendingTitle: "Waiting for approval",
		pendingBody: "Your account was created. You can sign in once an administrator approves it.",
		verifyTitle: "Check your email",
		verifyBody: "We sent a verification link to {email}. Click it to verify the address, then sign in. The link works for 24 hours.",
		verifyNoMail: "This Hub has no mail service configured, so the verification link only goes to the Hub log. Ask the operator.",
		backToLogin: "Back to sign in",
		menu: "Account menu",
		signOut: "Sign out",
		language: "中文",
		metaFailed: "Cannot read Hub information",
		loading: "Connecting to the Hub",
		approvalNote: "An administrator must approve new accounts.",
		needVerify: "Have not verified your email yet?",
		inviteSignedInTitle: "You are signed in",
		inviteSignedIn: "You are signed in as {name} ({email}).",
		inviteDetail: "This invitation is to join {name} ({role}), addressed to {to}.",
		inviteHow: "An invitation is used when creating a new account. Sign out to register another account with it, or keep using the current account.",
		inviteSwitch: "Sign out and use another account",
		inviteKeep: "Keep this account",
	},
});

type Phase = "anon" | "authed" | "pending";
type PendingInfo = { kind: "approval" } | { kind: "verify"; email: string };

/** The one-time link must not linger in the address bar or the history once it has been used. */
function leaveLinkUrl(): void {
	try {
		history.replaceState(null, "", APP_ROOT);
	} catch {
		/* sandboxed frames may forbid it; the URL then just stays */
	}
}

function Pending({ api, info, mailConfigured, onBack }: { api: HubApi; info: PendingInfo; mailConfigured: boolean | undefined; onBack: () => void }) {
	const t = useT(M);
	return (
		<AuthFrame>
			<div className="space-y-3 text-center" role="status">
				<div className="mx-auto grid size-12 place-items-center rounded-2xl border border-ink-700 text-ember-400">
					{info.kind === "verify" ? <MailCheck className="size-5" aria-hidden /> : <Clock className="size-5" aria-hidden />}
				</div>
				<h2 className="font-display text-lg font-semibold">{info.kind === "verify" ? t("verifyTitle") : t("pendingTitle")}</h2>
				<p className="text-sm text-ink-400">{info.kind === "verify" ? t("verifyBody", { email: info.email }) : t("pendingBody")}</p>
				{info.kind === "verify" && mailConfigured === false && <p className="text-xs text-ember-400">{t("verifyNoMail")}</p>}
			</div>
			{info.kind === "verify" && <ResendVerification api={api} initialEmail={info.email} />}
			<Button variant="outline" onClick={onBack} className="w-full">
				{t("backToLogin")}
			</Button>
		</AuthFrame>
	);
}

interface AuthProps {
	api: HubApi;
	meta: MetaInfo | undefined;
	inviteToken: string | undefined;
	startMode: "login" | "forgot";
	onAuthed: () => void;
	onPending: (info: PendingInfo) => void;
}

function AuthScreen({ api, meta, inviteToken, startMode, onAuthed, onPending }: AuthProps) {
	const t = useT(M);
	const c = useCommonT();
	const canRegister = Boolean(meta && (meta.needsSetup || meta.registration.open || meta.registration.invite || inviteToken));
	const [mode, setMode] = useState<"login" | "register" | "forgot">(startMode === "forgot" ? "forgot" : inviteToken || meta?.needsSetup ? "register" : "login");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [setupCode, setSetupCode] = useState("");
	const [remember, setRemember] = useState(false);
	const [invitation, setInvitation] = useState<InvitationView | "bad" | undefined>(undefined);
	const [needsVerify, setNeedsVerify] = useState(false);
	const [turnstileToken, setTurnstileToken] = useState<string | undefined>(undefined);
	const [turnstileRun, setTurnstileRun] = useState(0);
	const { busy, error, run, clearError } = useAction();
	const seeded = useRef(false);
	const turnstile = mode === "register" && needsTurnstile(meta);

	useEffect(() => {
		if (meta?.needsSetup && !seeded.current && startMode !== "forgot") {
			seeded.current = true;
			setMode("register");
		}
	}, [meta?.needsSetup, startMode]);

	useEffect(() => {
		if (!inviteToken) return;
		let live = true;
		api.lookupInvitation(inviteToken).then(
			(inv) => {
				if (!live) return;
				setInvitation(inv);
				setEmail((cur) => cur || inv.email);
			},
			() => live && setInvitation("bad"),
		);
		return () => {
			live = false;
		};
	}, [api, inviteToken]);

	const signIn = async () => {
		setNeedsVerify(false);
		const user = await run(async () => {
			try {
				return await api.login(email.trim(), password, remember);
			} catch (e) {
				if (e instanceof TeamApiError && e.code === "pendingApproval") return null;
				if (e instanceof TeamApiError && e.code === "emailNotVerified") setNeedsVerify(true);
				throw e;
			}
		});
		if (user === null) onPending({ kind: "approval" });
		else if (user) onAuthed();
	};

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (mode === "login") return signIn();
		const res = await run(() =>
			api.register({
				email: email.trim(),
				password,
				displayName: displayName.trim(),
				...(setupCode.trim() ? { setupCode: setupCode.trim() } : {}),
				...(inviteToken ? { inviteToken } : {}),
				...(turnstile && turnstileToken ? { turnstileToken } : {}),
			}),
		);
		// A Turnstile token is single use, whatever the outcome.
		if (turnstile) {
			setTurnstileToken(undefined);
			setTurnstileRun((n) => n + 1);
		}
		if (!res) return;
		if (res.status === "pending") return onPending(isPublicMode(meta) && !res.bootstrap && res.user.emailVerifiedAt === null ? { kind: "verify", email: email.trim() } : { kind: "approval" });
		await signIn();
	};

	if (mode === "forgot") {
		return (
			<AuthFrame>
				<ForgotPasswordForm api={api} initialEmail={email} onBack={() => setMode("login")} />
			</AuthFrame>
		);
	}

	return (
		<AuthFrame>
			{inviteToken && invitation && invitation !== "bad" && <Notice kind="ok">{t("invitedTo", { name: invitation.scopeName, role: roleLabel(c, invitation.role) })}</Notice>}
			{invitation === "bad" && <Notice kind="error">{t("inviteBad")}</Notice>}
			<form onSubmit={submit} className="space-y-3" aria-label={mode === "login" ? t("login") : t("register")}>
				{mode === "register" && (
					<Field label={t("displayName")}>
						<Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={100} autoComplete="name" />
					</Field>
				)}
				<Field label={t("email")}>
					<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" autoFocus />
				</Field>
				<Field label={t("password")} hint={mode === "register" ? t("passwordHint") : undefined}>
					<Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === "register" ? 8 : 1} autoComplete={mode === "login" ? "current-password" : "new-password"} />
				</Field>
				{mode === "register" && meta?.needsSetup && (
					<Field label={t("setupCode")} hint={t("setupHint")}>
						<Input value={setupCode} onChange={(e) => setSetupCode(e.target.value)} required autoComplete="off" className="font-mono" />
					</Field>
				)}
				{mode === "login" && (
					<div className="flex items-center justify-between gap-3">
						<label className="flex items-center gap-2 text-sm text-ink-300">
							<input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-ember-500" />
							{t("remember")}
						</label>
						<button
							type="button"
							onClick={() => {
								clearError();
								setMode("forgot");
							}}
							className="text-sm text-ink-400 underline-offset-2 hover:text-ink-100 hover:underline"
						>
							{t("forgot")}
						</button>
					</div>
				)}
				{/* An invitation skips approval, so the note would be wrong for it. */}
				{mode === "register" && meta?.registration.approval && !meta.needsSetup && !inviteToken && <p className="text-xs text-ink-400">{t("approvalNote")}</p>}
				{turnstile && meta?.turnstileSiteKey && <Turnstile key={turnstileRun} siteKey={meta.turnstileSiteKey} onToken={setTurnstileToken} />}
				{error && <Notice kind="error">{error}</Notice>}
				<Button type="submit" variant="primary" disabled={busy || (turnstile && !turnstileToken)} className="w-full">
					{busy ? t("busy") : mode === "login" ? t("signIn") : t("signUp")}
				</Button>
			</form>
			{mode === "login" && needsVerify && (
				<div className="space-y-2 border-t hairline pt-3">
					<p className="text-xs text-ink-400">{t("needVerify")}</p>
					<ResendVerification api={api} initialEmail={email.trim()} />
				</div>
			)}
			{canRegister ? (
				<button
					type="button"
					onClick={() => {
						clearError();
						setNeedsVerify(false);
						setMode(mode === "login" ? "register" : "login");
					}}
					className="text-sm text-ink-400 underline-offset-2 hover:text-ink-100 hover:underline"
				>
					{mode === "login" ? t("noAccount") : t("haveAccount")}
				</button>
			) : (
				meta && <p className="text-xs text-ink-500">{t("registrationClosed")}</p>
			)}
		</AuthFrame>
	);
}

/** Shown instead of the app when an /invite/<token> link is opened while signed in. The Hub has no accept-for-current-user endpoint. */
function InviteWhileSignedIn({ api, inviteToken, onSwitch, onKeep }: { api: HubApi; inviteToken: string; onSwitch: () => void; onKeep: () => void }) {
	const t = useT(M);
	const c = useCommonT();
	const [who, setWho] = useState<{ name: string; email: string } | undefined>(undefined);
	const [invitation, setInvitation] = useState<InvitationView | "bad" | undefined>(undefined);
	useEffect(() => {
		let live = true;
		api.me().then(
			(m) => live && setWho({ name: m.user.displayName, email: m.user.email }),
			() => undefined,
		);
		api.lookupInvitation(inviteToken).then(
			(inv) => live && setInvitation(inv),
			() => live && setInvitation("bad"),
		);
		return () => {
			live = false;
		};
	}, [api, inviteToken]);
	return (
		<AuthFrame>
			<div className="space-y-3" role="region" aria-label={t("inviteSignedInTitle")}>
				<h2 className="font-display text-lg font-semibold">{t("inviteSignedInTitle")}</h2>
				{who && <p className="text-sm text-ink-300">{t("inviteSignedIn", who)}</p>}
				{invitation === "bad" && <Notice kind="error">{t("inviteBad")}</Notice>}
				{invitation && invitation !== "bad" && <Notice kind="ok">{t("inviteDetail", { name: invitation.scopeName, role: roleLabel(c, invitation.role), to: invitation.email })}</Notice>}
				<p className="text-sm text-ink-400">{t("inviteHow")}</p>
				<div className="flex flex-col gap-2">
					<Button variant="primary" onClick={onSwitch}>
						{t("inviteSwitch")}
					</Button>
					<Button variant="outline" onClick={onKeep}>
						{t("inviteKeep")}
					</Button>
				</div>
			</div>
		</AuthFrame>
	);
}

function UserMenu({ api, onSignedOut }: { api: HubApi; onSignedOut: () => void }) {
	const t = useT(M);
	const lang = usePrefs((s) => s.lang);
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const [name, setName] = useState("");
	useEffect(() => {
		api.me().then((m) => setName(m.user.displayName), () => undefined);
	}, [api]);
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);
	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={t("menu")}
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-300 hover:bg-ink-800 hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-ember-400"
			>
				<span className="grid size-6 place-items-center rounded-full bg-ember-500/20 text-xs font-semibold text-ember-300">{(name || "?").slice(0, 1).toUpperCase()}</span>
				<span className="max-w-32 truncate max-md:hidden">{name}</span>
			</button>
			{open && (
				<div role="menu" className="absolute right-0 z-30 mt-1 w-48 animate-pop rounded-xl border border-ink-700 bg-ink-900 p-1 shadow-xl shadow-black/50">
					<button
						type="button"
						role="menuitem"
						onClick={() => usePrefs.setState({ lang: lang === "zh" ? "en" : "zh" })}
						className="flex w-full rounded-lg px-3 py-2 text-left text-sm text-ink-200 hover:bg-ink-800"
					>
						{t("language")}
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => void api.logout().finally(onSignedOut)}
						className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-400 hover:bg-rose-400/10"
					>
						<LogOut className="size-4" aria-hidden /> {t("signOut")}
					</button>
				</div>
			)}
		</div>
	);
}

export function HubApp() {
	const t = useT(M);
	const api = useMemo(() => createHubApi(), []);
	const [inviteToken, setInviteToken] = useState<string | undefined>(() => inviteTokenFromPath(location.pathname));
	const [link, setLink] = useState<AuthLink | undefined>(() => authLinkFromLocation(location.pathname, location.search));
	const [startMode, setStartMode] = useState<"login" | "forgot">("login");
	const [phase, setPhase] = useState<Phase>(() => (api.hasSession() ? "authed" : "anon"));
	const [pending, setPending] = useState<PendingInfo>({ kind: "approval" });
	const [meta, setMeta] = useState<MetaInfo | undefined>(undefined);
	const [metaError, setMetaError] = useState<string | undefined>(undefined);
	const [metaTick, setMetaTick] = useState(0);

	useEffect(() => dismissSplash(), []);
	useEffect(() => {
		document.title = "Prometheus Hub";
	}, []);
	useEffect(() => api.onSessionEnd(() => setPhase("anon")), [api]);
	// Public information: the sign-in screen needs the registration policy; the signed-in shell needs the mode and mail state.
	useEffect(() => {
		let live = true;
		api.meta().then(
			(m) => {
				if (!live) return;
				setMeta(m);
				setMetaError(undefined);
			},
			(e: unknown) => live && setMetaError(errorText(e)),
		);
		return () => {
			live = false;
		};
	}, [api, phase, metaTick]);

	const dropInvite = () => {
		setInviteToken(undefined);
		leaveLinkUrl();
	};
	const dropLink = () => {
		setLink(undefined);
		leaveLinkUrl();
	};

	if (link?.kind === "verify-email") return <VerifyEmailPage api={api} token={link.token} onDone={dropLink} />;
	if (link?.kind === "reset-password") {
		return (
			<ResetPasswordPage
				api={api}
				token={link.token}
				onDone={dropLink}
				onRequestAnother={() => {
					setStartMode("forgot");
					dropLink();
				}}
			/>
		);
	}

	if (phase === "authed") {
		if (inviteToken) {
			return (
				<InviteWhileSignedIn
					api={api}
					inviteToken={inviteToken}
					onKeep={dropInvite}
					onSwitch={() => void api.logout().finally(() => setPhase("anon"))}
				/>
			);
		}
		if (!meta && !metaError) {
			return (
				<AuthFrame>
					<p role="status" className="text-sm text-ink-400">
						{t("loading")}
					</p>
				</AuthFrame>
			);
		}
		return (
			<div className="forge-bg h-full">
				<TeamShell
					api={api}
					mode="hub"
					hubMeta={meta}
					resendVerification={(email) => api.resendVerification(email)}
					topRight={() => <UserMenu api={api} onSignedOut={() => setPhase("anon")} />}
				/>
			</div>
		);
	}
	if (phase === "pending") return <Pending api={api} info={pending} mailConfigured={meta?.mailConfigured} onBack={() => setPhase("anon")} />;
	if (!meta && metaError) {
		return (
			<AuthFrame>
				<ErrorBox message={`${t("metaFailed")}: ${metaError}`} onRetry={() => setMetaTick((n) => n + 1)} compact />
			</AuthFrame>
		);
	}
	return (
		<AuthScreen
			api={api}
			meta={meta}
			inviteToken={inviteToken}
			startMode={startMode}
			onAuthed={() => {
				dropInvite();
				setPhase("authed");
			}}
			onPending={(info) => {
				dropInvite();
				setPending(info);
				setPhase("pending");
			}}
		/>
	);
}
