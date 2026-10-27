import { copyToClipboard } from "../lib/clipboard.ts";
import { Copy, Loader2, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { openExternal } from "../lib/links.ts";
import { confirmDialog } from "../lib/dialogs.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginCall, toast, useStore } from "../lib/store.ts";
import { Badge, Button, Dialog, Empty, Field, Input, PageHeader, Select } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "连接器",
		subtitle: "连接 GitHub、Jira、Microsoft 365、数据库等第三方服务并授权，之后 Agent 即可按你设定的权限使用它们",
		add: "添加连接",
		emptyTitle: "还没有连接",
		emptyBody: "添加后，Agent 可通过 connector_call 工具使用该服务。凭据加密保存在本机，不会发送给模型。",
		policy: "写入权限",
		"policy.read-only": "只读",
		"policy.confirm": "写前确认",
		"policy.allow": "允许写入",
		test: "测试",
		remove: "删除",
		confirmRemove: "删除连接「{name}」？已保存的凭据将被清除。",
		removed: "已删除",
		testOk: "连接正常：{account}",
		testFail: "连接失败：{error}",
		provider: "服务",
		method: "授权方式",
		label: "显示名称",
		labelHint: "区分同一服务的多个账号，如「工作」「个人」",
		connect: "连接",
		cancel: "取消",
		connected: "已连接 {name}",
		oauthStart: "开始授权",
		"kind.token": "访问令牌",
		"kind.basic": "账号 + 令牌",
		"kind.connection-string": "连接串",
		"kind.oauth-device": "设备码授权（OAuth）",
		"kind.oauth-code": "浏览器授权（OAuth）",
		deviceHint: "在打开的页面输入下面的代码并确认，完成后此窗口会自动继续。",
		openPage: "打开授权页面",
		copyCode: "复制代码",
		waiting: "等待授权…",
		redirectHint: "在 OAuth 应用中登记的回调地址：",
		reuseHint: "已为该服务配置过 OAuth 应用时，Client ID / Secret 可留空以沿用。",
		secretHint: "凭据只加密保存在本机，永不回显",
		ops: "可用操作",
		writeBadge: "写",
		cat: "类别",
	},
	en: {
		title: "Connectors",
		subtitle: "Connect and authorise third-party services such as GitHub, Jira, Microsoft 365 and databases so the agent can use them within the permissions you set",
		add: "Add connection",
		emptyTitle: "No connections yet",
		emptyBody: "Once added, the agent can use the service through the connector_call tool. Credentials are encrypted on this machine and never sent to the model.",
		policy: "Write access",
		"policy.read-only": "Read only",
		"policy.confirm": "Ask before writing",
		"policy.allow": "Allow writes",
		test: "Test",
		remove: "Remove",
		confirmRemove: "Remove connection \"{name}\"? Stored credentials will be erased.",
		removed: "Removed",
		testOk: "Working: {account}",
		testFail: "Failed: {error}",
		provider: "Service",
		method: "Authorisation",
		label: "Display name",
		labelHint: "Tell several accounts of one service apart, e.g. \"Work\" or \"Personal\"",
		connect: "Connect",
		cancel: "Cancel",
		connected: "Connected {name}",
		oauthStart: "Start authorisation",
		"kind.token": "Access token",
		"kind.basic": "Account + token",
		"kind.connection-string": "Connection string",
		"kind.oauth-device": "Device code (OAuth)",
		"kind.oauth-code": "Browser sign-in (OAuth)",
		deviceHint: "Enter the code below on the page that opens and confirm. This window continues automatically.",
		openPage: "Open authorisation page",
		copyCode: "Copy code",
		waiting: "Waiting for authorisation…",
		redirectHint: "Redirect URI to register in your OAuth app:",
		reuseHint: "If an OAuth app is already set up for this service, leave Client ID / Secret empty to reuse it.",
		secretHint: "Credentials are stored encrypted on this machine and never shown again",
		ops: "Operations",
		writeBadge: "write",
		cat: "Category",
	},
});

type Policy = "read-only" | "confirm" | "allow";
type Kind = "token" | "basic" | "connection-string" | "oauth-device" | "oauth-code";
interface FieldSpec {
	key: string;
	label: string;
	secret?: boolean;
	required?: boolean;
	placeholder?: string;
	help?: string;
}
interface ProviderInfo {
	id: string;
	name: string;
	category: string;
	description: string;
	auth: { kind: Kind; help?: string; label?: string }[];
	/** Auth kinds whose OAuth app ships with Prometheus, so no client ID is asked for. */
	builtin?: string[];
	fields: Record<string, FieldSpec[]>;
	operations: { name: string; description: string; access: "read" | "write" }[];
}
interface Connection {
	id: string;
	provider: string;
	label: string;
	authKind: Kind;
	policy: Policy;
	account?: string;
	createdAt: string;
}

const POLICIES: Policy[] = ["read-only", "confirm", "allow"];
const CALLBACK_PATH = "/plugins/connectors/oauth/callback";

export function ConnectorsView() {
	const t = useT(M);
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [list, setList] = useState<Connection[]>([]);
	const [adding, setAdding] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(async () => {
		const [p, c] = await Promise.all([pluginCall<ProviderInfo[]>("connectors", "providers"), pluginCall<Connection[]>("connectors", "list")]);
		if (p) setProviders(p);
		if (c) setList(c);
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const byId = (id: string) => providers.find((p) => p.id === id);

	const test = async (c: Connection) => {
		setBusy(c.id);
		const r = await pluginCall<{ ok: boolean; account?: string; error?: string }>("connectors", "test", { id: c.id });
		setBusy(null);
		if (!r) return;
		if (r.ok) toast(t("testOk", { account: r.account ?? "" }));
		else toast(t("testFail", { error: r.error ?? "" }), "error");
		await load();
	};

	const remove = async (c: Connection) => {
		if (!(await confirmDialog(t("confirmRemove", { name: c.label })))) return;
		if ((await pluginCall("connectors", "remove", { id: c.id })) === undefined) return;
		toast(t("removed"));
		await load();
	};

	const setPolicy = async (c: Connection, policy: Policy) => {
		if ((await pluginCall("connectors", "update", { id: c.id, policy })) !== undefined) await load();
	};

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<Button variant="primary" onClick={() => setAdding(true)} disabled={!providers.length}>
						<Plus className="size-4" /> {t("add")}
					</Button>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto p-4 @3xl:p-6">
				{list.length === 0 ? (
					<Empty icon={<Plug className="size-5" />} title={t("emptyTitle")}>
						{t("emptyBody")}
					</Empty>
				) : (
					<div className="grid gap-3 @3xl:grid-cols-2 @5xl:grid-cols-3">
						{list.map((c) => {
							const p = byId(c.provider);
							return (
								<div key={c.id} className="animate-rise space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
									<div className="flex items-center gap-2">
										<span className="truncate font-display font-semibold">{c.label}</span>
										<Badge tone="ember">{p?.name.split(" ")[0] ?? c.provider}</Badge>
									</div>
									<div className="truncate font-mono text-xs text-ink-500">{c.account ?? "—"}</div>
									<Field label={t("policy")}>
										<Select value={c.policy} onChange={(e) => void setPolicy(c, e.target.value as Policy)}>
											{POLICIES.map((v) => (
												<option key={v} value={v}>
													{t(`policy.${v}`)}
												</option>
											))}
										</Select>
									</Field>
									<div className="flex gap-2">
										<Button variant="outline" onClick={() => void test(c)} disabled={busy === c.id}>
											{busy === c.id ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("test")}
										</Button>
										<Button variant="danger" onClick={() => void remove(c)}>
											<Trash2 className="size-3.5" /> {t("remove")}
										</Button>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
			{adding && (
				<AddDialog
					providers={providers}
					onClose={() => setAdding(false)}
					onDone={async (name) => {
						toast(t("connected", { name }));
						setAdding(false);
						await load();
					}}
				/>
			)}
		</div>
	);
}

type Device = { flowId: string; userCode: string; verificationUri: string; intervalSec: number };

function AddDialog({ providers, onClose, onDone }: { providers: ProviderInfo[]; onClose: () => void; onDone: (name: string) => Promise<void> }) {
	const t = useT(M);
	const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
	const provider = providers.find((p) => p.id === providerId);
	const [kind, setKind] = useState<Kind | "">("");
	const method = provider?.auth.find((a) => a.kind === kind) ?? provider?.auth[0];
	const [label, setLabel] = useState("");
	const [policy, setPolicy] = useState<Policy>("confirm");
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [device, setDevice] = useState<Device | null>(null);
	const [waiting, setWaiting] = useState(false);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const isOAuth = method?.kind === "oauth-device" || method?.kind === "oauth-code";
	const builtin = !!method && !!provider?.builtin?.includes(method.kind);
	const fields = builtin ? [] : ((isOAuth ? provider?.fields["oauth-app"] : method && provider?.fields[method.kind]) ?? []);
	const httpBase = useStore((st) => st.client?.target.httpBase) ?? window.location.origin;
	const redirectUri = `${httpBase}${CALLBACK_PATH}`;
	const common = { provider: providerId, authKind: method?.kind, label: label.trim(), policy, values };

	const poll = async (flowId: string, intervalSec: number) => {
		setWaiting(true);
		let wait = Math.max(intervalSec, 2) * 1000;
		while (alive.current) {
			await new Promise((r) => setTimeout(r, wait));
			if (!alive.current) return;
			const r = await pluginCall<{ status: "pending" | "done" | "error"; slowDown?: boolean; error?: string }>("connectors", "oauthPoll", { flowId });
			if (!r || r.status === "error") {
				setWaiting(false);
				setDevice(null);
				if (r?.error) toast(r.error, "error");
				return;
			}
			if (r.status === "done") {
				await onDone(label.trim() || provider?.name || "");
				return;
			}
			if (r.slowDown) wait += 5000;
		}
	};

	const submit = async () => {
		setBusy(true);
		try {
			if (!isOAuth) {
				const rec = await pluginCall<{ label: string }>("connectors", "connect", common);
				if (rec) await onDone(rec.label);
				return;
			}
			const r = await pluginCall<{ flowId: string; kind: "device" | "code"; userCode?: string; verificationUri?: string; intervalSec?: number; url?: string }>("connectors", "oauthStart", { ...common, redirectUri });
			if (!r) return;
			if (r.kind === "code" && r.url) {
				void openExternal(r.url);
				void poll(r.flowId, 2);
			} else if (r.userCode) {
				setDevice({ flowId: r.flowId, userCode: r.userCode, verificationUri: r.verificationUri ?? "", intervalSec: r.intervalSec ?? 5 });
				void poll(r.flowId, r.intervalSec ?? 5);
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog title={t("add")} onClose={onClose}>
			<Field label={t("provider")} hint={provider?.description}>
				<Select
					value={providerId}
					disabled={waiting}
					onChange={(e) => {
						setProviderId(e.target.value);
						setKind("");
						setValues({});
					}}
				>
					{providers.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
				</Select>
			</Field>
			{provider && provider.auth.length > 1 && (
				<Field label={t("method")}>
					<Select
						value={method?.kind}
						disabled={waiting}
						onChange={(e) => {
							setKind(e.target.value as Kind);
							setValues({});
						}}
					>
						{provider.auth.map((a) => (
							<option key={a.kind} value={a.kind}>
								{t(`kind.${a.kind}`)}
							</option>
						))}
					</Select>
				</Field>
			)}
			{method?.help && <p className="text-xs text-ink-400">{method.help}</p>}
			<Field label={t("label")} hint={t("labelHint")}>
				<Input value={label} disabled={waiting} onChange={(e) => setLabel(e.target.value)} placeholder={provider?.name} />
			</Field>
			{fields.map((f) => (
				<Field key={f.key} label={f.label} hint={f.help}>
					<Input
						type={f.secret ? "password" : "text"}
						autoComplete="off"
						disabled={waiting}
						value={values[f.key] ?? ""}
						placeholder={f.placeholder}
						onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
					/>
				</Field>
			))}
			{isOAuth && !builtin && <p className="text-xs text-ink-500">{t("reuseHint")}</p>}
			{method?.kind === "oauth-code" && (
				<p className="text-xs text-ink-400">
					{t("redirectHint")} <code className="break-all font-mono text-ink-200">{redirectUri}</code>
				</p>
			)}
			<Field label={t("policy")}>
				<Select value={policy} disabled={waiting} onChange={(e) => setPolicy(e.target.value as Policy)}>
					{POLICIES.map((v) => (
						<option key={v} value={v}>
							{t(`policy.${v}`)}
						</option>
					))}
				</Select>
			</Field>
			{provider && (
				<details className="text-xs text-ink-400">
					<summary className="cursor-pointer">{t("ops")}</summary>
					<ul className="mt-2 space-y-1">
						{provider.operations.map((o) => (
							<li key={o.name}>
								<code className="font-mono text-ink-200">{o.name}</code> {o.access === "write" && <Badge tone="rose">{t("writeBadge")}</Badge>} {o.description}
							</li>
						))}
					</ul>
				</details>
			)}
			{device && (
				<div className="space-y-2 rounded-xl border border-ember-500/40 bg-ink-850 p-3 text-sm">
					<p>{t("deviceHint")}</p>
					<div className="flex items-center gap-2">
						<code className="font-mono text-xl tracking-widest text-ember-400">{device.userCode}</code>
						<Button variant="outline" onClick={() => void copyToClipboard(device.userCode)}>
							<Copy className="size-3.5" /> {t("copyCode")}
						</Button>
						<Button variant="primary" onClick={() => void openExternal(device.verificationUri)}>
							{t("openPage")}
						</Button>
					</div>
				</div>
			)}
			{waiting && (
				<p className="flex items-center gap-2 text-xs text-ink-400">
					<Loader2 className="size-3.5 animate-spin" /> {t("waiting")}
				</p>
			)}
			{!isOAuth && <p className="text-xs text-ink-500">{t("secretHint")}</p>}
			<div className="flex justify-end gap-2">
				<Button variant="ghost" onClick={onClose}>
					{t("cancel")}
				</Button>
				<Button variant="primary" onClick={() => void submit()} disabled={busy || waiting || !provider}>
					{busy && <Loader2 className="size-4 animate-spin" />} {isOAuth ? t("oauthStart") : t("connect")}
				</Button>
			</div>
		</Dialog>
	);
}
