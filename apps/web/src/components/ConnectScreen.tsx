import clsx from "clsx";
import { Globe, LoaderCircle, Monitor, ScanLine, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { QrScanner } from "./QrScanner.tsx";
import { isTauri, localSupported, passwordLogin, forgetServer, loadServerHistory, saveMode, saveRemote, saveSameOriginToken, saveSession, startLocal, targetFromUrl } from "../lib/backend.ts";
import type { BackendTarget } from "../lib/client.ts";
import { localizeError } from "../lib/errors.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { Button, Field, Flame, Input } from "./ui.tsx";

const M = defineMessages({
	zh: {
		scan: "扫码",
		badQr: "二维码不是有效的服务器地址",
		subtitle: "选择运行方式",
		local: "本机模式",
		localDesc: "在这台设备上自动启动 Prometheus 服务，数据保存在本地",
		remote: "连接服务器",
		remoteDesc: "连接到已部署的 Prometheus 服务器",
		starting: "正在启动本机服务…首次启动可能需要数十秒",
		startFailed: "本机服务启动失败：{e}",
		unauthorized: "访问令牌无效或缺失",
		url: "服务器地址",
		token: "访问令牌",
		tokenHint: "服务器端 PROMETHEUS_TOKEN 的值；仅本机访问时可留空",
		loginPassword: "登录密码",
		loginHint: "在运行 Prometheus 的电脑上「设置 → 网络访问」里设置的密码；留空则按访问令牌连接",
		needPassword: "这台服务器需要登录密码",
		signingIn: "正在登录…",
		badUrl: "服务器地址不合法",
		connect: "连接",
		back: "返回",
		webSubtitle: "连接到你的 Agent 服务器",
	},
	en: {
		scan: "Scan",
		badQr: "That QR code is not a valid server address",
		subtitle: "Choose how to run",
		local: "Local mode",
		localDesc: "Start a Prometheus server on this device automatically; data stays local",
		remote: "Connect to server",
		remoteDesc: "Connect to a deployed Prometheus server",
		starting: "Starting the local server… first launch may take a while",
		startFailed: "Local server failed to start: {e}",
		unauthorized: "Access token is invalid or missing",
		url: "Server URL",
		token: "Access token",
		tokenHint: "Value of PROMETHEUS_TOKEN on the server; may be empty for loopback-only servers",
		loginPassword: "Login password",
		loginHint: "The password set under Settings → Network access on the computer running Prometheus. Leave empty to connect with an access token instead",
		needPassword: "This server needs a login password",
		signingIn: "Signing in…",
		badUrl: "Invalid server URL",
		connect: "Connect",
		back: "Back",
		webSubtitle: "Connect to your agent server",
	},
});

export function ConnectScreen({ unauthorized, error, onConnect, wantsPassword = false }: { unauthorized: boolean; error?: string | null; onConnect: (t: BackendTarget) => void; wantsPassword?: boolean }) {
	const t = useT(M);
	const sameOrigin = !isTauri() && location.protocol.startsWith("http");
	const [canLocal, setCanLocal] = useState(false);
	const [mode, setMode] = useState<"choose" | "remote">(isTauri() ? "choose" : "remote");
	const [url, setUrl] = useState(() => loadServerHistory()[0]?.url ?? (sameOrigin ? location.origin : "https://"));
	const [history, setHistory] = useState(loadServerHistory);
	const [token, setToken] = useState(() => loadServerHistory()[0]?.token ?? "");
	const [login, setLogin] = useState("");
	const [scanning, setScanning] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(error ?? null);

	useEffect(() => {
		void localSupported().then((ok) => {
			setCanLocal(ok);
			if (!ok) setMode("remote");
		});
	}, []);

	useEffect(() => {
		if (unauthorized) setMode("remote");
	}, [unauthorized]);

	const runLocal = async () => {
		setBusy(true);
		setMessage(null);
		try {
			const target = await startLocal();
			saveMode("local");
			onConnect(target);
		} catch (err) {
			setMessage(t("startFailed", { e: localizeError(err instanceof Error ? err.message : String(err)) }));
		} finally {
			setBusy(false);
		}
	};

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		let target: BackendTarget;
		try {
			target = targetFromUrl(url.trim(), token.trim());
		} catch {
			setMessage(t("badUrl"));
			return;
		}
		// A login password is traded for a long-lived session token; the password itself is never stored.
		if (login) {
			setBusy(true);
			setMessage(null);
			const result = await passwordLogin(target, login);
			setBusy(false);
			if (!result.ok) {
				setMessage(result.message);
				return;
			}
			setLogin("");
			target = { ...target, token: result.token };
			saveSession(target, result.token);
		} else if (sameOrigin && target.httpBase === location.origin) {
			saveSameOriginToken(token.trim() || null);
			saveRemote(null);
		} else {
			saveRemote({ url: target.httpBase, token: token.trim() || undefined });
		}
		saveMode("remote");
		onConnect(target);
	};

	const onScan = (text: string) => {
		setScanning(false);
		try {
			const u = new URL(text.trim());
			if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
			setUrl(u.origin);
			setToken("");
			setMessage(null);
		} catch {
			setMessage(t("badQr"));
		}
	};

	const card = "flex w-full items-start gap-3.5 rounded-2xl border p-4 text-left transition-all disabled:opacity-60";

	return (
		<div className="forge-bg flex h-full overflow-y-auto p-5 md:p-6">
			<div className="m-auto w-full max-w-md animate-rise space-y-6">
				<div className="flex items-center gap-3">
					<Flame className="size-11" />
					<div>
						<h1 className="font-display text-3xl font-semibold tracking-tight">Prometheus</h1>
						<p className="text-sm text-ink-400">{isTauri() ? t("subtitle") : t("webSubtitle")}</p>
					</div>
				</div>

				{unauthorized && <p className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-400">{wantsPassword ? t("needPassword") : t("unauthorized")}</p>}
				{message && <p className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm break-words text-rose-400">{message}</p>}

				{mode === "choose" && (
					<div className="space-y-3">
						{canLocal && (
							<button type="button" disabled={busy} onClick={() => void runLocal()} className={clsx(card, "border-ember-500/40 bg-ember-500/6 hover:border-ember-500/70 hover:bg-ember-500/10")}>
								<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ember-500/15 text-ember-300">
									{busy ? <LoaderCircle className="size-5 animate-spin" /> : <Monitor className="size-5" />}
								</span>
								<span>
									<span className="block font-display font-semibold text-ink-100">{t("local")}</span>
									<span className="mt-0.5 block text-sm text-ink-400">{busy ? t("starting") : t("localDesc")}</span>
								</span>
							</button>
						)}
						<button type="button" disabled={busy} onClick={() => setMode("remote")} className={clsx(card, "border-ink-700 bg-ink-900/60 hover:border-ink-500")}>
							<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ink-800 text-ink-300">
								<Globe className="size-5" />
							</span>
							<span>
								<span className="block font-display font-semibold text-ink-100">{t("remote")}</span>
								<span className="mt-0.5 block text-sm text-ink-400">{t("remoteDesc")}</span>
							</span>
						</button>
					</div>
				)}

				{mode === "remote" && (
					<form onSubmit={submit} className="space-y-5">
						{history.length > 0 && (
							<div className="flex flex-wrap gap-2">
								{history.map((h) => (
									<span key={h.url} className={clsx("flex items-center rounded-full border text-xs", url === h.url ? "border-ember-500/60 text-ember-300" : "border-ink-700 text-ink-300")}>
										<button type="button" className="max-w-[14rem] truncate py-1 pr-1 pl-2.5" onClick={() => { setUrl(h.url); setToken(h.token ?? ""); }}>
											{h.url.replace(/^https?:\/\//, "")}
										</button>
										<button type="button" aria-label="remove" className="px-2 py-1 text-ink-500 hover:text-rose-400" onClick={() => { forgetServer(h.url); setHistory(loadServerHistory()); }}>×</button>
									</span>
								))}
							</div>
						)}
						<Field label={t("url")}>
							<div className="flex gap-2">
								<Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://agent.example.com" required />
								<Button variant="outline" onClick={() => setScanning(true)}>
									<ScanLine className="size-4" /> {t("scan")}
								</Button>
							</div>
						</Field>
						<Field label={t("loginPassword")} hint={t("loginHint")}>
							<Input type="password" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="current-password" autoFocus={unauthorized} />
						</Field>
						<Field label={t("token")} hint={t("tokenHint")}>
							<Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
						</Field>
						<div className="flex gap-2">
							{canLocal && (
								<Button variant="outline" className="py-2.5" onClick={() => setMode("choose")}>
									{t("back")}
								</Button>
							)}
							<Button type="submit" variant="primary" className="flex-1 py-2.5" disabled={busy}>
								{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Server className="size-4" />} {busy ? t("signingIn") : t("connect")}
							</Button>
						</div>
					</form>
				)}
			</div>
			{scanning && <QrScanner onResult={onScan} onClose={() => setScanning(false)} />}
		</div>
	);
}
