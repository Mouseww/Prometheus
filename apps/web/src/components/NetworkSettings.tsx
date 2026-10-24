import clsx from "clsx";
import { Copy, LoaderCircle, Lock, ShieldAlert, Wifi } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { NetworkPatch, NetworkStatus } from "@prometheus/protocol";
import { localizeError } from "../lib/errors.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { toast, useStore } from "../lib/store.ts";
import { QrCode } from "./QrCode.tsx";
import { Button, Field, Input, PageHeader, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "网络访问",
		subtitle: "让局域网里的其他设备，或通过域名（如 nginx 反向代理），访问这台电脑上的 Prometheus",
		remoteBlocked: "为了安全，网络访问只能在运行 Prometheus 的这台电脑上修改。以下是当前状态。",
		managed: "监听地址由环境变量（PROMETHEUS_HOST）管理，这里的设置不生效。",
		lan: "允许局域网访问",
		lanDesc: "开启后，同一网络里的设备可以通过这台电脑的 IP 打开 Prometheus，并需要输入下面的登录密码。",
		needPasswordFirst: "请先设置登录密码，才能开启局域网访问",
		password: "登录密码",
		passwordSet: "已设置",
		passwordNotSet: "未设置",
		passwordHint: "至少 8 个字符。局域网和域名访问的设备都要输入它登录一次，之后保持登录 30 天。本机访问不需要密码。",
		newPassword: "新密码",
		confirmPassword: "再输入一次",
		setPassword: "设置密码",
		changePassword: "修改密码",
		mismatch: "两次输入的密码不一致",
		passwordSaved: "密码已保存",
		changeWarn: "修改密码后，所有已登录的设备都会被登出。",
		signOutAll: "登出所有设备",
		signedOut: "已登出所有设备",
		port: "局域网端口",
		portHint: "1024–65535。本机访问仍使用原来的端口，不受影响。",
		hosts: "域名白名单",
		hostsHint: "每行一个域名，如 agent.example.com，或 *.example.com 匹配所有子域名。通过域名访问（比如 nginx 反代）时，域名必须在这里，否则会被拒绝。用 IP 访问不受限制。",
		hostsPlaceholder: "agent.example.com\n*.corp.example.com",
		save: "保存",
		saved: "已保存",
		status: "当前状态",
		off: "未开启",
		on: "已开启，监听端口 {p}",
		failed: "开启失败：{e}",
		reach: "其他设备可以访问",
		copy: "复制",
		copied: "已复制",
		nginx: "nginx 反向代理示例",
		nginxHint: "把域名加进上面的白名单，再让 nginx 转发到下面的端口。必须保留 Upgrade 头，否则无法实时对话。",
		firewall: "如果其他设备打不开，请在这台电脑的防火墙里放行上面的端口。",
		exposeWarn: "开启后，任何能连上这个端口并知道密码的人都能让 Agent 在这台电脑上读写文件、执行命令。请使用强密码，不要把端口直接暴露到公网；公网访问请通过带 HTTPS 的反向代理。",
		unauthorized: "只能在本机修改",
		lanQr: "局域网地址 {u}（仅同一网络可用；公网请开启上面的公网地址）。手机在连接页点「扫码」",
		scanHint: "手机打开 Prometheus 的连接页，点「扫码」即可填入地址",
		tunnel: "一键公网地址（Cloudflare）",
		tunnelDesc: "不需要域名、反向代理或 DDNS。开启后会获得一个 https://…trycloudflare.com 的公网地址，在任何设备上用上面设置的登录密码即可连接。地址是临时随机的，关闭或重启后会变化。",
		tunnelNeedPassword: "请先设置登录密码，再开启公网地址",
		tunnelDownloading: "正在下载 cloudflared（首次使用，约 40 MB）…",
		tunnelStarting: "正在向 Cloudflare 申请地址…",
		tunnelOn: "公网地址已开启",
		tunnelFailed: "开启失败：{e}",
		tunnelNetworkHint: "这多半是网络问题：无法连接 GitHub 或 Cloudflare。请检查网络或代理（必要时开启代理的全局/TUN 模式），网络恢复后再点开关重试。",
		tunnelWarn: "公网上任何人拿到这个地址都能看到登录页，请使用强密码。这是 Cloudflare 的免费临时隧道，不保证稳定，不适合长期生产使用。",
	},
	en: {
		title: "Network access",
		subtitle: "Let other devices on your network, or a domain name (such as through an nginx reverse proxy), reach the Prometheus running on this computer",
		remoteBlocked: "For safety, network access can only be changed on the computer running Prometheus. Current state shown below.",
		managed: "The listen address is managed by the PROMETHEUS_HOST environment variable, so these settings have no effect.",
		lan: "Allow LAN access",
		lanDesc: "When on, devices on the same network can open Prometheus through this computer's IP and must sign in with the password below.",
		needPasswordFirst: "Set a login password first to turn on LAN access",
		password: "Login password",
		passwordSet: "Set",
		passwordNotSet: "Not set",
		passwordHint: "At least 8 characters. Every device reaching Prometheus over the LAN or a domain signs in once with it and stays signed in for 30 days. This computer itself never needs it.",
		newPassword: "New password",
		confirmPassword: "Repeat it",
		setPassword: "Set password",
		changePassword: "Change password",
		mismatch: "The two passwords do not match",
		passwordSaved: "Password saved",
		changeWarn: "Changing the password signs out every signed-in device.",
		signOutAll: "Sign out all devices",
		signedOut: "All devices signed out",
		port: "LAN port",
		portHint: "1024–65535. Access from this computer keeps using its original port.",
		hosts: "Domain allow-list",
		hostsHint: "One domain per line, like agent.example.com, or *.example.com for every subdomain. When reached through a domain (for example behind nginx) the name must be listed here or the request is refused. IP addresses are not restricted.",
		hostsPlaceholder: "agent.example.com\n*.corp.example.com",
		save: "Save",
		saved: "Saved",
		status: "Status",
		off: "Off",
		on: "On, listening on port {p}",
		failed: "Could not start: {e}",
		reach: "Other devices can open",
		copy: "Copy",
		copied: "Copied",
		nginx: "nginx reverse proxy example",
		nginxHint: "Add the domain to the allow-list above, then have nginx forward to the port below. Keep the Upgrade headers or live chat will not work.",
		firewall: "If other devices cannot connect, allow the port above through this computer's firewall.",
		exposeWarn: "Once on, anyone who can reach this port and knows the password can make the agent read and write files and run commands on this computer. Use a strong password, do not expose the port directly to the internet, and put public access behind an HTTPS reverse proxy.",
		unauthorized: "Can only be changed on this computer",
		lanQr: "LAN address {u} (same network only; turn on the public address for internet access). Tap Scan on the phone connect page",
		scanHint: "On your phone open the Prometheus connect page and tap Scan to fill in the address",
		tunnel: "One-click public address (Cloudflare)",
		tunnelDesc: "No domain, reverse proxy or DDNS needed. Turning it on gives you a public https://…trycloudflare.com address; open it on any device and sign in with the password set above. The address is random and temporary: it changes after you turn it off or restart.",
		tunnelNeedPassword: "Set a login password first to open a public address",
		tunnelDownloading: "Downloading cloudflared (first use, about 40 MB)…",
		tunnelStarting: "Requesting an address from Cloudflare…",
		tunnelOn: "Public address is on",
		tunnelFailed: "Could not start: {e}",
		tunnelNetworkHint: "This is most likely a network problem: GitHub or Cloudflare cannot be reached. Check your connection or proxy (use the proxy's global/TUN mode if needed), then flip the switch again once the network is back.",
		tunnelWarn: "Anyone on the internet who gets this address sees the sign-in page, so use a strong password. This is Cloudflare's free temporary tunnel: no stability guarantee, not meant for long-term production use.",
	},
});

function nginxSample(port: number, host: string): string {
	return `server {
    listen 443 ssl;
    server_name ${host};
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}`;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
	return (
		<section className="space-y-3 rounded-2xl border border-ink-800 bg-ink-900/40 p-5">
			<div>
				<h3 className="text-sm font-medium text-ink-100">{title}</h3>
				{hint && <p className="mt-1 text-xs leading-relaxed text-ink-400">{hint}</p>}
			</div>
			{children}
		</section>
	);
}

export function NetworkSettings() {
	const t = useT(M);
	const [status, setStatus] = useState<NetworkStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pw, setPw] = useState({ next: "", again: "" });
	const [port, setPort] = useState("");
	const [hosts, setHosts] = useState("");

	const load = useCallback(async () => {
		const client = useStore.getState().client;
		if (!client) return;
		try {
			const s = await client.rpc("network.get", {});
			setStatus(s);
			setPort(String(s.port));
			setHosts(s.allowedHosts.join("\n"));
		} catch (err) {
			setError(localizeError(err instanceof Error ? err.message : String(err)));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// Downloading and starting the tunnel take a while; follow along until it settles.
	const tunnelState = status?.tunnel.state;
	useEffect(() => {
		if (tunnelState !== "downloading" && tunnelState !== "starting") return;
		const id = setInterval(() => void load(), 1500);
		return () => clearInterval(id);
	}, [tunnelState, load]);

	/** Sends one change; the server's message (weak password, port taken, ...) is shown inline rather than as a toast. */
	const apply = async (patch: NetworkPatch, done?: string) => {
		const client = useStore.getState().client;
		if (!client) return false;
		setBusy(true);
		setError(null);
		try {
			const s = await client.rpc("network.set", patch);
			setStatus(s);
			setPort(String(s.port));
			setHosts(s.allowedHosts.join("\n"));
			if (done) toast(done);
			return true;
		} catch (err) {
			setError(localizeError(err instanceof Error ? err.message : String(err)));
			return false;
		} finally {
			setBusy(false);
		}
	};

	if (!status) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<PageHeader title={t("title")} subtitle={t("subtitle")} />
				<div className="p-4 @3xl:p-8">{error ? <p className="text-sm text-rose-400">{error}</p> : <LoaderCircle className="size-5 animate-spin text-ink-500" />}</div>
			</div>
		);
	}

	const editable = status.canEdit;
	const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast(t("copied")), () => undefined);
	const urls = status.addresses.map((a) => `http://${a}:${status.port}`);
	const firstHost = status.allowedHosts.find((h) => !h.startsWith("*.")) ?? "agent.example.com";
	const pwReady = pw.next.length >= 8 && pw.next === pw.again;
	const hostsChanged = hosts.split(/\r?\n/).map((h) => h.trim()).filter(Boolean).join("\n") !== status.allowedHosts.join("\n");
	const portChanged = Number(port) !== status.port;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<div className="min-h-0 flex-1 overflow-y-auto p-4 @3xl:p-8">
				<div className="max-w-2xl space-y-5">
					{status.managed && <p className="rounded-xl border border-ink-700 bg-ink-900/60 px-4 py-3 text-sm text-ink-300">{t("managed")}</p>}
					{!status.managed && !editable && (
						<p className="flex items-start gap-2 rounded-xl border border-ember-500/30 bg-ember-500/8 px-4 py-3 text-sm text-ember-200">
							<Lock className="mt-0.5 size-4 shrink-0" />
							{t("remoteBlocked")}
						</p>
					)}
					{error && <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm break-words text-rose-400">{error}</p>}

					<Section title={t("lan")} hint={t("lanDesc")}>
						<div className="flex items-center gap-3">
							<button
								type="button"
								role="switch"
								aria-checked={status.lan}
								disabled={!editable || busy || (!status.lan && !status.passwordSet)}
								onClick={() => void apply({ lan: !status.lan })}
								className={clsx("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50", status.lan ? "bg-ember-500" : "bg-ink-700")}
							>
								<span className={clsx("absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform", status.lan && "translate-x-5")} />
							</button>
							<span className={clsx("flex items-center gap-1.5 text-sm", status.listening ? "text-moss-400" : "text-ink-400")}>
								<Wifi className="size-4" />
								{status.listening ? t("on", { p: status.port }) : t("off")}
							</span>
						</div>
						{!status.passwordSet && !status.lan && <p className="text-xs text-ember-300">{t("needPasswordFirst")}</p>}
						{status.error && <p className="text-xs text-rose-400">{t("failed", { e: status.error })}</p>}
						{status.listening && urls.length > 0 && (
							<div className="space-y-1.5">
								<div className="text-xs text-ink-400">{t("reach")}</div>
								{urls.map((u) => (
									<div key={u} className="flex items-center gap-2 rounded-lg bg-ink-950 px-3 py-1.5 font-mono text-[13px] text-ink-200">
										<span className="min-w-0 flex-1 truncate">{u}</span>
										<button type="button" onClick={() => void copy(u)} className="text-ink-500 hover:text-ink-100" title={t("copy")} aria-label={t("copy")}>
											<Copy className="size-3.5" />
										</button>
									</div>
								))}
								<div className="flex items-center gap-3 pt-1">
									<QrCode value={urls[0] as string} size={144} />
									<p className="text-xs text-ink-400">{t("lanQr", { u: urls[0] as string })}</p>
								</div>
								<p className="text-xs text-ink-500">{t("firewall")}</p>
							</div>
						)}
					</Section>

					<Section title={t("tunnel")} hint={t("tunnelDesc")}>
						<div className="flex items-center gap-3">
							<button
								type="button"
								role="switch"
								aria-checked={status.tunnel.state !== "off" && status.tunnel.state !== "error"}
								disabled={!editable || busy || (status.tunnel.state === "off" && !status.passwordSet)}
								onClick={() => void apply({ tunnel: status.tunnel.state === "off" || status.tunnel.state === "error" })}
								className={clsx("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50", status.tunnel.state === "on" ? "bg-ember-500" : status.tunnel.state === "off" || status.tunnel.state === "error" ? "bg-ink-700" : "bg-ember-500/50")}
							>
								<span className={clsx("absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform", status.tunnel.state !== "off" && status.tunnel.state !== "error" && "translate-x-5")} />
							</button>
							<span className={clsx("flex items-center gap-1.5 text-sm", status.tunnel.state === "on" ? "text-moss-400" : "text-ink-400")}>
								{(status.tunnel.state === "downloading" || status.tunnel.state === "starting") && <LoaderCircle className="size-4 animate-spin" />}
								{status.tunnel.state === "downloading" ? t("tunnelDownloading") : status.tunnel.state === "starting" ? t("tunnelStarting") : status.tunnel.state === "on" ? t("tunnelOn") : t("off")}
							</span>
						</div>
						{!status.passwordSet && status.tunnel.state === "off" && <p className="text-xs text-ember-300">{t("tunnelNeedPassword")}</p>}
						{status.tunnel.state === "error" && <p className="text-xs break-words text-rose-400">{t("tunnelFailed", { e: status.tunnel.error ?? "" })}</p>}
						{status.tunnel.state === "error" && status.tunnel.network && <p className="text-xs text-ember-300">{t("tunnelNetworkHint")}</p>}
						{status.tunnel.state === "on" && status.tunnel.url && (
							<div className="flex items-center gap-2 rounded-lg bg-ink-950 px-3 py-1.5 font-mono text-[13px] text-ink-200">
								<span className="min-w-0 flex-1 truncate">{status.tunnel.url}</span>
								<button type="button" onClick={() => void copy(status.tunnel.url as string)} className="text-ink-500 hover:text-ink-100" title={t("copy")} aria-label={t("copy")}>
									<Copy className="size-3.5" />
								</button>
							</div>
						)}
						{status.tunnel.state === "on" && status.tunnel.url && (
							<div className="flex items-center gap-3">
								<QrCode value={status.tunnel.url} />
								<p className="text-xs text-ink-400">{t("scanHint")}</p>
							</div>
						)}
						{status.tunnel.state !== "off" && <p className="text-xs text-ink-500">{t("tunnelWarn")}</p>}
					</Section>

					<Section title={t("password")} hint={t("passwordHint")}>
						<div className={clsx("text-xs", status.passwordSet ? "text-moss-400" : "text-ember-300")}>{status.passwordSet ? t("passwordSet") : t("passwordNotSet")}</div>
						{editable && (
							<>
								<div className="grid gap-3 @xl:grid-cols-2">
									<Field label={t("newPassword")}>
										<Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
									</Field>
									<Field label={t("confirmPassword")}>
										<Input type="password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} autoComplete="new-password" />
									</Field>
								</div>
								{pw.again && pw.next !== pw.again && <p className="text-xs text-rose-400">{t("mismatch")}</p>}
								{status.passwordSet && <p className="text-xs text-ink-500">{t("changeWarn")}</p>}
								<div className="flex flex-wrap gap-2">
									<Button
										variant="primary"
										disabled={busy || !pwReady}
										onClick={() =>
											void apply({ password: pw.next }, t("passwordSaved")).then((ok) => {
												if (ok) setPw({ next: "", again: "" });
											})
										}
									>
										{status.passwordSet ? t("changePassword") : t("setPassword")}
									</Button>
									{status.passwordSet && (
										<Button variant="outline" disabled={busy} onClick={() => void apply({ revokeSessions: true }, t("signedOut"))}>
											{t("signOutAll")}
										</Button>
									)}
								</div>
							</>
						)}
					</Section>

					<Section title={t("hosts")} hint={t("hostsHint")}>
						<Textarea rows={4} value={hosts} disabled={!editable} onChange={(e) => setHosts(e.target.value)} placeholder={t("hostsPlaceholder")} spellCheck={false} className="font-mono text-[13px]" />
						<div className="flex items-end gap-4">
							<Field label={t("port")} hint={t("portHint")}>
								<Input value={port} disabled={!editable} inputMode="numeric" onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} className="w-28 font-mono" />
							</Field>
						</div>
						{editable && (
							<Button
								variant="primary"
								disabled={busy || (!hostsChanged && !portChanged)}
								onClick={() =>
									void apply({ ...(hostsChanged ? { allowedHosts: hosts.split(/\r?\n/) } : {}), ...(portChanged ? { port: Number(port) } : {}) }, t("saved"))
								}
							>
								{t("save")}
							</Button>
						)}
					</Section>

					{status.lan && (
						<Section title={t("nginx")} hint={t("nginxHint")}>
							<div className="relative">
								<pre className="overflow-x-auto rounded-lg bg-ink-950 p-3 font-mono text-[12px] leading-relaxed text-ink-300">{nginxSample(status.port, firstHost)}</pre>
								<button type="button" onClick={() => void copy(nginxSample(status.port, firstHost))} className="absolute top-2 right-2 rounded-md p-1.5 text-ink-500 hover:bg-ink-800 hover:text-ink-100" title={t("copy")} aria-label={t("copy")}>
									<Copy className="size-3.5" />
								</button>
							</div>
						</Section>
					)}

					<p className="flex items-start gap-2 rounded-xl border border-ink-800 bg-ink-900/40 px-4 py-3 text-xs leading-relaxed text-ink-400">
						<ShieldAlert className="mt-0.5 size-4 shrink-0 text-ember-400" />
						{t("exposeWarn")}
					</p>
				</div>
			</div>
		</div>
	);
}
