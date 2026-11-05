// Root of the Hub's own web UI (Hub mode). Owns the login state; everything after sign-in is the shared TeamShell.
import { Clock, LogOut } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button, Field, Flame, Input } from "../components/ui.tsx";
import { defineMessages, useT } from "../lib/i18n.ts";
import { usePrefs } from "../lib/prefs.ts";
import { dismissSplash } from "../lib/splash.ts";
import { TeamApiError, type HubApi } from "./api.ts";
import { createHubApi } from "./hubApi.ts";
import { inviteTokenFromPath } from "./hubMode.ts";
import { errorText, roleLabel, useCommonT } from "./i18n.ts";
import { ErrorBox, Notice, useAction } from "./kit.tsx";
import { TeamShell } from "./TeamShell.tsx";
import type { InvitationView, MetaInfo } from "./types.ts";

const M = defineMessages({
	zh: {
		subtitle: "团队协作 Hub",
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
		registrationClosed: "当前不开放注册，请联系管理员创建账号或发送邀请。",
		invitedTo: "邀请你加入 {name}（{role}）",
		inviteBad: "邀请链接无效或已过期。",
		pendingTitle: "等待管理员审批",
		pendingBody: "账号已创建，管理员批准后即可登录。",
		backToLogin: "返回登录",
		menu: "账户菜单",
		signOut: "退出登录",
		language: "English",
		metaFailed: "无法读取 Hub 信息",
		loading: "正在连接 Hub",
		approvalNote: "注册后需要管理员审批。",
	},
	en: {
		subtitle: "Team collaboration Hub",
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
		registrationClosed: "Registration is closed. Ask an administrator for an account or an invitation.",
		invitedTo: "You are invited to join {name} ({role})",
		inviteBad: "The invitation link is invalid or expired.",
		pendingTitle: "Waiting for approval",
		pendingBody: "Your account was created. You can sign in once an administrator approves it.",
		backToLogin: "Back to sign in",
		menu: "Account menu",
		signOut: "Sign out",
		language: "中文",
		metaFailed: "Cannot read Hub information",
		loading: "Connecting to the Hub",
		approvalNote: "An administrator must approve new accounts.",
	},
});

type Phase = "anon" | "authed" | "pending";

function AuthFrame({ children }: { children: React.ReactNode }) {
	const t = useT(M);
	return (
		<div className="forge-bg flex h-full items-center justify-center overflow-y-auto p-4">
			<div className="sheen w-full max-w-md space-y-5 rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-2xl shadow-black/50">
				<div className="flex items-center gap-3">
					<Flame className="size-9" />
					<div>
						<h1 className="font-display text-xl font-semibold tracking-tight">Prometheus Hub</h1>
						<p className="text-xs text-ink-400">{t("subtitle")}</p>
					</div>
				</div>
				{children}
			</div>
		</div>
	);
}

function Pending({ onBack }: { onBack: () => void }) {
	const t = useT(M);
	return (
		<AuthFrame>
			<div className="space-y-3 text-center" role="status">
				<div className="mx-auto grid size-12 place-items-center rounded-2xl border border-ink-700 text-ember-400">
					<Clock className="size-5" aria-hidden />
				</div>
				<h2 className="font-display text-lg font-semibold">{t("pendingTitle")}</h2>
				<p className="text-sm text-ink-400">{t("pendingBody")}</p>
				<Button variant="outline" onClick={onBack}>
					{t("backToLogin")}
				</Button>
			</div>
		</AuthFrame>
	);
}

interface AuthProps {
	api: HubApi;
	meta: MetaInfo | undefined;
	inviteToken: string | undefined;
	onAuthed: () => void;
	onPending: () => void;
}

function AuthScreen({ api, meta, inviteToken, onAuthed, onPending }: AuthProps) {
	const t = useT(M);
	const c = useCommonT();
	const canRegister = Boolean(meta && (meta.needsSetup || meta.registration.open || meta.registration.invite || inviteToken));
	const [mode, setMode] = useState<"login" | "register">(inviteToken || meta?.needsSetup ? "register" : "login");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [setupCode, setSetupCode] = useState("");
	const [remember, setRemember] = useState(false);
	const [invitation, setInvitation] = useState<InvitationView | "bad" | undefined>(undefined);
	const { busy, error, run, clearError } = useAction();
	const seeded = useRef(false);

	useEffect(() => {
		if (meta?.needsSetup && !seeded.current) {
			seeded.current = true;
			setMode("register");
		}
	}, [meta?.needsSetup]);

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
		const user = await run(async () => {
			try {
				return await api.login(email.trim(), password, remember);
			} catch (e) {
				if (e instanceof TeamApiError && e.code === "pendingApproval") return null;
				throw e;
			}
		});
		if (user === null) onPending();
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
			}),
		);
		if (!res) return;
		if (res.status === "pending") return onPending();
		await signIn();
	};

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
					<label className="flex items-center gap-2 text-sm text-ink-300">
						<input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-ember-500" />
						{t("remember")}
					</label>
				)}
				{mode === "register" && meta?.registration.approval && !meta.needsSetup && <p className="text-xs text-ink-400">{t("approvalNote")}</p>}
				{error && <Notice kind="error">{error}</Notice>}
				<Button type="submit" variant="primary" disabled={busy} className="w-full">
					{busy ? t("busy") : mode === "login" ? t("signIn") : t("signUp")}
				</Button>
			</form>
			{canRegister ? (
				<button
					type="button"
					onClick={() => {
						clearError();
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
	const inviteToken = useMemo(() => inviteTokenFromPath(location.pathname), []);
	const [phase, setPhase] = useState<Phase>(() => (api.hasSession() ? "authed" : "anon"));
	const [meta, setMeta] = useState<MetaInfo | undefined>(undefined);
	const [metaError, setMetaError] = useState<string | undefined>(undefined);
	const [metaTick, setMetaTick] = useState(0);

	useEffect(() => dismissSplash(), []);
	useEffect(() => {
		document.title = "Prometheus Hub";
	}, []);
	useEffect(() => api.onSessionEnd(() => setPhase("anon")), [api]);
	// Public information (setup needed, registration policy) is only needed on the sign-in screen.
	useEffect(() => {
		if (phase === "authed") return;
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

	if (phase === "authed") {
		return (
			<div className="forge-bg h-full">
				<TeamShell api={api} mode="hub" topRight={() => <UserMenu api={api} onSignedOut={() => setPhase("anon")} />} />
			</div>
		);
	}
	if (phase === "pending") return <Pending onBack={() => setPhase("anon")} />;
	if (!meta && metaError) {
		return (
			<AuthFrame>
				<ErrorBox message={`${t("metaFailed")}: ${metaError}`} onRetry={() => setMetaTick((n) => n + 1)} compact />
			</AuthFrame>
		);
	}
	return <AuthScreen api={api} meta={meta} inviteToken={inviteToken} onAuthed={() => setPhase("authed")} onPending={() => setPhase("pending")} />;
}
