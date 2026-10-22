import clsx from "clsx";
import { confirmDialog } from "../lib/dialogs.ts";
import { Check, LoaderCircle, Monitor, Plus, Repeat, Server, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { isTauri, localSupported, passwordLogin } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { loadPlatforms, normalizeUrl, type Platform, samePlatform, savePlatforms, switchLocal, switchPlatform } from "../lib/platforms.ts";
import { toast, useStore } from "../lib/store.ts";
import { targetFromUrl } from "../lib/backend.ts";
import { Badge, Button, Empty, Field, Input, PageHeader } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "多平台",
		subtitle: "保存多个 Prometheus 服务，一键切换要连接的那一个",
		add: "添加平台",
		current: "当前",
		switchTo: "切换",
		local: "本机",
		localDesc: "这台电脑上自动启动的 Prometheus 服务",
		saveCurrent: "保存当前连接",
		unsaved: "当前连接尚未保存",
		emptyTitle: "还没有保存的平台",
		emptyBody: "添加其他设备或服务器上的 Prometheus 地址后，可以在这里和侧边栏里快速切换。",
		name: "名称",
		namePlaceholder: "公司服务器",
		url: "服务器地址",
		token: "访问令牌",
		tokenHint: "服务器端 PROMETHEUS_TOKEN；使用登录密码时留空",
		loginPassword: "登录密码",
		loginHint: "服务器「网络访问」里设置的密码；登录后只保存会话令牌，不保存密码",
		save: "保存",
		saveSwitch: "保存并切换",
		cancel: "取消",
		badUrl: "服务器地址不合法，应以 http:// 或 https:// 开头",
		confirmDelete: "移除平台「{name}」？",
		signingIn: "正在登录…",
		saved: "已保存平台 {name}",
		storedLocally: "平台列表和令牌只保存在当前设备的浏览器/应用中。",
	},
	en: {
		title: "Platforms",
		subtitle: "Save several Prometheus servers and switch between them in one click",
		add: "Add platform",
		current: "Current",
		switchTo: "Switch",
		local: "This device",
		localDesc: "The Prometheus server started automatically on this computer",
		saveCurrent: "Save current connection",
		unsaved: "The current connection is not saved yet",
		emptyTitle: "No saved platforms",
		emptyBody: "Add the address of Prometheus on another device or server to switch quickly here and from the sidebar.",
		name: "Name",
		namePlaceholder: "Company server",
		url: "Server URL",
		token: "Access token",
		tokenHint: "PROMETHEUS_TOKEN on the server; leave empty when using a login password",
		loginPassword: "Login password",
		loginHint: "The password set under the server's Network access. Only a session token is stored, never the password",
		save: "Save",
		saveSwitch: "Save and switch",
		cancel: "Cancel",
		badUrl: "Invalid server URL; it must start with http:// or https://",
		confirmDelete: "Remove platform \"{name}\"?",
		signingIn: "Signing in…",
		saved: "Saved platform {name}",
		storedLocally: "The list and tokens are stored only in this device's browser/app.",
	},
});

export function PlatformsView() {
	const t = useT(M);
	const client = useStore((s) => s.client);
	const currentUrl = client?.target.httpBase ?? "";
	const isLocal = client?.target.label === "local";
	const [list, setList] = useState<Platform[]>(loadPlatforms);
	const [adding, setAdding] = useState(false);
	const [canLocal, setCanLocal] = useState(false);

	useEffect(() => {
		if (isTauri()) void localSupported().then(setCanLocal);
	}, []);

	const update = (next: Platform[]) => {
		setList(next);
		savePlatforms(next);
	};
	const known = list.some((p) => samePlatform(p.url, currentUrl));

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<Button variant="primary" onClick={() => setAdding(true)}>
						<Plus className="size-4" /> {t("add")}
					</Button>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto p-4 @3xl:p-6">
				<div className="mx-auto max-w-2xl space-y-3">
					{adding && (
						<PlatformForm
							onCancel={() => setAdding(false)}
							onSave={(p, andSwitch) => {
								update([...list, p]);
								setAdding(false);
								toast(t("saved", { name: p.name }));
								if (andSwitch) switchPlatform(p);
							}}
						/>
					)}

					{canLocal && (
						<Row icon={<Monitor className="size-4" />} title={t("local")} subtitle={t("localDesc")} active={isLocal}>
							{isLocal ? <Badge tone="moss">{t("current")}</Badge> : <Button variant="outline" onClick={() => void switchLocal()}><Repeat className="size-3.5" /> {t("switchTo")}</Button>}
						</Row>
					)}

					{!isLocal && currentUrl && !known && (
						<div className="flex items-center gap-3 rounded-xl border border-dashed border-ink-700 p-3 text-sm text-ink-400">
							<span className="min-w-0 flex-1 truncate">
								{t("unsaved")} · <span className="font-mono text-xs">{currentUrl}</span>
							</span>
							<Button
								variant="outline"
								onClick={() => {
									const t0 = client?.target;
									if (!t0) return;
									update([...list, { id: crypto.randomUUID().slice(0, 8), name: t0.label, url: t0.httpBase, token: t0.token }]);
								}}
							>
								{t("saveCurrent")}
							</Button>
						</div>
					)}

					{list.length === 0 && !adding && !canLocal && (
						<Empty icon={<Server className="size-5" />} title={t("emptyTitle")}>
							{t("emptyBody")}
						</Empty>
					)}

					{list.map((p) => {
						const active = !isLocal && samePlatform(p.url, currentUrl);
						return (
							<Row key={p.id} icon={<Server className="size-4" />} title={p.name} subtitle={p.url} active={active}>
								{active ? (
									<Badge tone="moss">{t("current")}</Badge>
								) : (
									<Button variant="outline" onClick={() => switchPlatform(p)}>
										<Repeat className="size-3.5" /> {t("switchTo")}
									</Button>
								)}
								<Button
									variant="danger"
									aria-label="remove"
									onClick={() => void confirmDialog(t("confirmDelete", { name: p.name })).then((ok) => { if (ok) void update(list.filter((x) => x.id !== p.id)); })}
								>
									<Trash2 className="size-4" />
								</Button>
							</Row>
						);
					})}
					<p className="pt-2 text-xs text-ink-500">{t("storedLocally")}</p>
				</div>
			</div>
		</div>
	);
}

function Row({ icon, title, subtitle, active, children }: { icon: React.ReactNode; title: string; subtitle: string; active: boolean; children: React.ReactNode }) {
	return (
		<div className={clsx("flex items-center gap-3 rounded-xl border bg-ink-900/60 p-3", active ? "border-ember-500/50" : "border-ink-800")}>
			<span className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink-800 text-ember-400">{active ? <Check className="size-4" /> : icon}</span>
			<div className="min-w-0 flex-1">
				<div className="truncate font-display font-semibold">{title}</div>
				<div className="truncate font-mono text-xs text-ink-500">{subtitle}</div>
			</div>
			{children}
		</div>
	);
}

function PlatformForm({ onSave, onCancel }: { onSave: (p: Platform, andSwitch: boolean) => void; onCancel: () => void }) {
	const t = useT(M);
	const [name, setName] = useState("");
	const [url, setUrl] = useState("https://");
	const [token, setToken] = useState("");
	const [login, setLogin] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (andSwitch: boolean) => {
		let origin: string;
		try {
			origin = normalizeUrl(url);
		} catch {
			setError(t("badUrl"));
			return;
		}
		let secret = token.trim();
		if (login) {
			setBusy(true);
			setError(null);
			const r = await passwordLogin(targetFromUrl(origin), login);
			setBusy(false);
			if (!r.ok) {
				setError(r.message);
				return;
			}
			secret = r.token;
		}
		onSave({ id: crypto.randomUUID().slice(0, 8), name: name.trim() || new URL(origin).host, url: origin, token: secret || undefined }, andSwitch);
	};

	return (
		<form
			className="animate-rise space-y-4 rounded-xl border border-ember-500/40 bg-ink-900/60 p-4"
			onSubmit={(e) => {
				e.preventDefault();
				void submit(true);
			}}
		>
			<div className="grid gap-4 @xl:grid-cols-2">
				<Field label={t("name")}>
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
				</Field>
				<Field label={t("url")}>
					<Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono" spellCheck={false} />
				</Field>
				<Field label={t("token")} hint={t("tokenHint")}>
					<Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className="font-mono" />
				</Field>
				<Field label={t("loginPassword")} hint={t("loginHint")}>
					<Input type="password" autoComplete="off" value={login} onChange={(e) => setLogin(e.target.value)} />
				</Field>
			</div>
			{error && <p className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm break-words text-rose-400">{error}</p>}
			<div className="flex justify-end gap-2">
				<Button onClick={onCancel}>{t("cancel")}</Button>
				<Button variant="outline" disabled={busy} onClick={() => void submit(false)}>
					{t("save")}
				</Button>
				<Button type="submit" variant="primary" disabled={busy}>
					{busy && <LoaderCircle className="size-4 animate-spin" />} {busy ? t("signingIn") : t("saveSwitch")}
				</Button>
			</div>
		</form>
	);
}
