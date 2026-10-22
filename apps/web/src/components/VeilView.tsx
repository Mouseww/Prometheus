import clsx from "clsx";
import { Plus, RefreshCw, Shield, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginCall, toast } from "../lib/store.ts";
import { Badge, Button, Empty, Field, Input, PageHeader, Select, Textarea } from "./ui.tsx";

/** The plugin's own rule shape, mirrored here so the view does not import server code. */
interface Rule {
	id: string;
	name: string;
	typePrefix: string;
	enabled: boolean;
	kind: "regex" | "dictionary" | "ip";
	pattern?: string;
	words?: string[];
	priority: number;
}

interface VeilState {
	config: {
		redaction: boolean;
		relay: boolean;
		relayPort: number;
		upstream: string;
		regionNeutral: boolean;
		acceptLanguage: string;
		mappingTtlDays: number;
		packs: { secrets: boolean; region: boolean };
		proxyKind: "none" | "http" | "socks5";
		proxyServer: string;
		proxyAuth: boolean;
		rules: Rule[];
		allowlist: string[];
	};
	relay: { running: boolean; baseUrl: string; port: number; error?: string };
	stats: { mappings: number; hits: number; lastTypes: string[] };
}

interface MappingEntry {
	token: string;
	type: string;
	masked: string;
	createdAt: number;
}

interface HitEntry {
	at: number;
	method: string;
	upstream: string;
	path: string;
	status: number;
	types: string[];
	durationMs: number;
}

const M = defineMessages({
	zh: {
		title: "隐私面罩",
		subtitle: "发往模型的请求先在本机把密钥、手机号、连接串等换成化名，回答回到屏幕时再换回原文。上游只看见化名。",
		tabPrivacy: "隐私保护",
		tabProxy: "出口代理",
		tabRules: "规则",

		redaction: "启用脱敏",
		redactionHint: "关掉后请求原样发往上游，已保存的化名映射不会删除。",
		region: "区域中立化",
		regionHint: "把 Accept-Language 换成下面的值，禁用压缩以免化名被压掉。",
		acceptLanguage: "Accept-Language",
		saved: "已保存",
		save: "保存",

		tryIt: "试一下",
		tryHint: "粘贴一段文本，看看会被换成什么。不会发送到任何地方。",
		tryPlaceholder: "查一下我们的数据库连接串和值班手机号",
		redact: "脱敏",
		noHits: "没有命中任何规则。",
		hitsCount: "命中 {n} 条",
		hintRules: "命中的字在出网前换成 {{类型_ULID}}。优先级高的先匹配，先匹配到的占住位置。",

		mappings: "化名映射",
		mappingsTotal: "共 {n} 条映射",
		mappingsEmpty: "还没有映射。发一次含敏感信息的请求就会产生。",
		refresh: "刷新",
		clearMappings: "清空映射",
		confirmClearMappings: "清空所有化名映射？旧的对话里出现过的化名将无法再换回原文。",
		mappingsCleared: "已清空映射",
		colType: "类型",
		colToken: "化名",
		colMasked: "原值",
		colTime: "时间",

		relayOn: "启用出口代理",
		relayHint: "开启后，网关的地址会被指到本机转发端口；关掉后恢复直连。",
		relayRunning: "转发中",
		relayStopped: "未运行",
		relayEnabled: "已开启。网关地址已指向本机转发端口。",
		relayDisabled: "已关闭，恢复直连。",
		proxyServer: "代理服务器",
		proxyHint: "支持 http:// 与 socks5://，可带用户名密码。",
		proxyPlaceholder: "socks5://user:pass@127.0.0.1:1080",
		proxyAuthSaved: "已保存用户名密码，留空重填可更换。",
		proxyAuthNone: "没有保存凭据。地址里带上 user:pass@ 即可。",
		saveProxy: "保存代理",
		noProxy: "不用代理",
		relayPort: "转发端口",
		relayPortHint: "监听端口，1024–65535",
		upstream: "上游地址",
		upstreamHint: "裸路径请求时使用，可留空",
		saveRelay: "保存",
		restartRelay: "重启转发",
		recentHits: "最近的转发",
		hitsEmpty: "还没有转发记录。",
		colStatus: "状态",
		colDuration: "耗时",
		colUpstream: "上游",
		clear: "清空",

		packs: "规则包",
		packSecrets: "密钥包",
		packSecretsHint: "私钥、API Key、Token、连接串、密码、身份证、手机号、IP、邮箱",
		packRegion: "区域包",
		packRegionHint: "时区、locale 等区域特征",
		ruleList: "规则列表",
		builtin: "内置",
		delete: "删除",
		noRegex: "按地址解析，没有正则",
		newRule: "新增规则",
		idLabel: "id（唯一）",
		idPlaceholder: "project-codename",
		typeLabel: "类型（会出现在化名里）",
		typePlaceholder: "CODENAME",
		kind: "匹配方式",
		kindRegex: "正则",
		kindDict: "词表（一行一个）",
		priority: "优先级（大的先匹配）",
		pattern: "正则表达式 / 词表",
		patternPlaceholder: "正则：ACME-[0-9]{4}\n词表：一行一个词",
		addRule: "添加规则",
		ruleAdded: "已添加规则",
		allowlist: "白名单",
		allowlistHint: "这些字符串永远不替换。一行一个。",
		saveAllowlist: "保存白名单",
		priorityShort: "p{n}",
	},
	en: {
		title: "Privacy Mask",
		subtitle: "Requests to the model leave with keys, phone numbers and connection strings swapped for aliases, and the reply is restored on the way back. Upstream only ever sees aliases.",
		tabPrivacy: "Privacy",
		tabProxy: "Exit proxy",
		tabRules: "Rules",

		redaction: "Redact outbound requests",
		redactionHint: "When off, requests go upstream untouched. Saved aliases are kept.",
		region: "Neutralise region",
		regionHint: "Rewrites Accept-Language and disables compression so aliases are not deflated.",
		acceptLanguage: "Accept-Language",
		saved: "Saved",
		save: "Save",

		tryIt: "Try it",
		tryHint: "Paste some text to see what it becomes. Nothing is sent anywhere.",
		tryPlaceholder: "Look up our database connection string and the on-call phone number",
		redact: "Redact",
		noHits: "Nothing matched.",
		hitsCount: "{n} match(es)",
		hintRules: "Matches become {{TYPE_ULID}} before the request leaves. Higher priority wins; whoever matches first keeps the span.",

		mappings: "Alias mappings",
		mappingsTotal: "{n} mapping(s)",
		mappingsEmpty: "No mappings yet. Send one request containing a secret and they appear here.",
		refresh: "Refresh",
		clearMappings: "Clear mappings",
		confirmClearMappings: "Clear every alias mapping? Aliases already used in past conversations can no longer be restored.",
		mappingsCleared: "Mappings cleared",
		colType: "Type",
		colToken: "Alias",
		colMasked: "Value",
		colTime: "Time",

		relayOn: "Enable exit proxy",
		relayHint: "Points gateways at the local relay port. Turning it off restores direct connections.",
		relayRunning: "Forwarding",
		relayStopped: "Not running",
		relayEnabled: "Enabled. Gateway addresses now point at the local relay.",
		relayDisabled: "Disabled, back to direct connections.",
		proxyServer: "Proxy server",
		proxyHint: "http:// and socks5://, optionally with a username and password.",
		proxyPlaceholder: "socks5://user:pass@127.0.0.1:1080",
		proxyAuthSaved: "A username and password are saved. Leave empty to keep them.",
		proxyAuthNone: "No credentials saved. Put user:pass@ in the address.",
		saveProxy: "Save proxy",
		noProxy: "No proxy",
		relayPort: "Relay port",
		relayPortHint: "Listen port, 1024–65535",
		upstream: "Upstream",
		upstreamHint: "Used for bare-path requests; may be empty",
		saveRelay: "Save",
		restartRelay: "Restart relay",
		recentHits: "Recent forwards",
		hitsEmpty: "No forwards yet.",
		colStatus: "Status",
		colDuration: "Took",
		colUpstream: "Upstream",
		clear: "Clear",

		packs: "Rule packs",
		packSecrets: "Secrets",
		packSecretsHint: "Private keys, API keys, tokens, connection strings, passwords, ID cards, phones, IPs, emails",
		packRegion: "Region",
		packRegionHint: "Timezones, locales and other regional fingerprints",
		ruleList: "Rules",
		builtin: "built-in",
		delete: "Delete",
		noRegex: "Resolved by address, no pattern",
		newRule: "New rule",
		idLabel: "id (unique)",
		idPlaceholder: "project-codename",
		typeLabel: "Type (appears in the alias)",
		typePlaceholder: "CODENAME",
		kind: "Matcher",
		kindRegex: "Regex",
		kindDict: "Word list (one per line)",
		priority: "Priority (higher matches first)",
		pattern: "Pattern or word list",
		patternPlaceholder: "Regex: ACME-[0-9]{4}\nWords: one per line",
		addRule: "Add rule",
		ruleAdded: "Rule added",
		allowlist: "Allowlist",
		allowlistHint: "These strings are never replaced. One per line.",
		saveAllowlist: "Save allowlist",
		priorityShort: "p{n}",
	},
});

const BUILTIN = new Set(["pem", "apikey", "token", "connstr", "password", "idcard", "phone", "ip", "email", "timezone", "locale"]);
const TABS = ["privacy", "proxy", "rules"] as const;
type Tab = (typeof TABS)[number];

export function VeilView() {
	const t = useT(M);
	const [tab, setTab] = useState<Tab>("privacy");
	const [state, setState] = useState<VeilState | null>(null);
	const [busy, setBusy] = useState(false);

	// privacy
	const [testInput, setTestInput] = useState("");
	const [test, setTest] = useState<{ hits: { type: string; value: string }[]; preview: string } | null>(null);
	const [mappings, setMappings] = useState<{ total: number; entries: MappingEntry[] } | null>(null);
	const [lang, setLang] = useState("");
	// proxy
	const [proxyUrl, setProxyUrl] = useState("");
	const [port, setPort] = useState(0);
	const [upstream, setUpstream] = useState("");
	const [hits, setHits] = useState<HitEntry[] | null>(null);
	// rules
	const [allowlist, setAllowlist] = useState("");
	const [draft, setDraft] = useState({ id: "", typePrefix: "", kind: "regex" as Rule["kind"], priority: 100, pattern: "" });

	const apply = (next: VeilState | undefined) => {
		if (!next) return;
		setState(next);
		setLang(next.config.acceptLanguage);
		setProxyUrl(next.config.proxyServer ? `${next.config.proxyKind === "socks5" ? "socks5://" : "http://"}${next.config.proxyServer}` : "");
		setPort(next.config.relayPort);
		setUpstream(next.config.upstream);
		setAllowlist(next.config.allowlist.join("\n"));
	};

	const load = async () => apply(await pluginCall<VeilState>("veil", "state"));

	const mutate = async (method: string, params: Record<string, unknown>, msg?: string) => {
		setBusy(true);
		const next = await pluginCall<VeilState>("veil", method, params);
		setBusy(false);
		if (!next) return false;
		apply(next);
		if (msg) toast(msg);
		return true;
	};

	const loadMappings = async () => {
		const res = await pluginCall<{ total: number; entries: MappingEntry[] }>("veil", "mappings", { limit: 50 });
		if (res) setMappings(res);
	};

	const loadHits = async () => {
		const res = await pluginCall<{ entries: HitEntry[] }>("veil", "hits");
		if (res) setHits(res.entries);
	};

	useEffect(() => {
		void load();
	}, []);

	// Each tab fetches only what it shows; the proxy tab also needs the live relay status.
	useEffect(() => {
		if (tab === "privacy") void loadMappings();
		else if (tab === "proxy") void loadHits();
	}, [tab]);

	const runTest = async () => {
		if (!testInput.trim()) return;
		const res = await pluginCall<{ hits: { type: string; value: string }[]; preview: string }>("veil", "testRules", { text: testInput });
		if (res) setTest(res);
	};

	const sortedRules = useMemo(() => [...(state?.config.rules ?? [])].sort((a, b) => b.priority - a.priority), [state]);

	const addRule = async () => {
		const id = draft.id.trim();
		const typePrefix = draft.typePrefix.trim();
		if (!id || !typePrefix) return;
		const rule: Rule = { id, name: id, typePrefix, enabled: true, kind: draft.kind, priority: Number(draft.priority) || 100 };
		if (draft.kind === "dictionary") {
			rule.words = draft.pattern.split("\n").map((s) => s.trim()).filter(Boolean);
		} else {
			rule.pattern = draft.pattern.trim();
		}
		if (await mutate("setRule", { rule }, t("ruleAdded"))) setDraft({ id: "", typePrefix: "", kind: draft.kind, priority: 100, pattern: "" });
	};

	const relay = state?.relay;

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					relay?.running ? (
						<Badge tone="moss">{t("relayRunning")}</Badge>
					) : state?.config.relay ? (
						<Badge tone="rose">{t("relayStopped")}</Badge>
					) : undefined
				}
			/>

			<div className="flex gap-1 border-b hairline px-4 md:px-8">
				{TABS.map((id) => (
					<button
						key={id}
						type="button"
						onClick={() => setTab(id)}
						className={clsx(
							"-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
							tab === id ? "border-ember-500 text-ink-100" : "border-transparent text-ink-400 hover:text-ink-200",
						)}
					>
						{t(id === "privacy" ? "tabPrivacy" : id === "proxy" ? "tabProxy" : "tabRules")}
					</button>
				))}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
				{!state ? (
					<p className="text-sm text-ink-500">{t("refresh")}…</p>
				) : tab === "privacy" ? (
					<div className="max-w-3xl space-y-4">
						<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
							<label className="flex items-start justify-between gap-4">
								<span className="min-w-0">
									<span className="block text-sm text-ink-100">{t("redaction")}</span>
									<span className="mt-0.5 block text-xs text-ink-500">{t("redactionHint")}</span>
								</span>
								<input
									type="checkbox"
									className="mt-0.5 size-4 shrink-0 accent-ember-500"
									checked={state.config.redaction}
									disabled={busy}
									onChange={(e) => void mutate("setFlags", { redaction: e.target.checked })}
								/>
							</label>
							<label className="flex items-start justify-between gap-4 border-t hairline pt-3">
								<span className="min-w-0">
									<span className="block text-sm text-ink-100">{t("region")}</span>
									<span className="mt-0.5 block text-xs text-ink-500">{t("regionHint")}</span>
								</span>
								<input
									type="checkbox"
									className="mt-0.5 size-4 shrink-0 accent-ember-500"
									checked={state.config.regionNeutral}
									disabled={busy}
									onChange={(e) => void mutate("setFlags", { regionNeutral: e.target.checked })}
								/>
							</label>
							<div className="flex items-end gap-2 border-t hairline pt-3">
								<div className="min-w-0 flex-1">
									<Field label={t("acceptLanguage")}>
										<Input value={lang} placeholder="en-US,en;q=0.9" onChange={(e) => setLang(e.target.value)} />
									</Field>
								</div>
								<Button variant="primary" disabled={busy} onClick={() => void mutate("setHeaders", { acceptLanguage: lang }, t("saved"))}>
									{t("save")}
								</Button>
							</div>
						</section>

						<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
							<h2 className="font-display text-sm font-semibold">{t("tryIt")}</h2>
							<p className="text-xs text-ink-500">{t("tryHint")}</p>
							<Textarea rows={3} value={testInput} placeholder={t("tryPlaceholder")} onChange={(e) => setTestInput(e.target.value)} />
							<div>
								<Button variant="outline" onClick={() => void runTest()}>
									{t("redact")}
								</Button>
							</div>
							{test && (
								<div className="space-y-2 border-t hairline pt-3">
									{test.hits.length === 0 ? (
										<p className="text-xs text-ink-500">{t("noHits")}</p>
									) : (
										<>
											<p className="text-xs text-ink-500">{t("hitsCount", { n: test.hits.length })}</p>
											<ul className="space-y-1">
												{test.hits.map((h, i) => (
													<li key={`${h.type}-${i}`} className="flex gap-2 text-xs">
														<Badge tone="ember">{h.type}</Badge>
														<span className="font-mono text-ink-400">{h.value}</span>
													</li>
												))}
											</ul>
										</>
									)}
									<pre className="overflow-x-auto rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-xs whitespace-pre-wrap text-ink-200">{test.preview}</pre>
								</div>
							)}
						</section>

						<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
							<div className="flex items-center justify-between gap-2">
								<h2 className="font-display text-sm font-semibold">{t("mappings")}</h2>
								<span className="text-xs text-ink-500">{t("mappingsTotal", { n: mappings?.total ?? state.stats.mappings })}</span>
							</div>
							{mappings?.entries.length === 0 ? (
								<Empty icon={<Shield className="size-5" />} title={t("mappingsEmpty")} />
							) : (
								<div className="overflow-x-auto">
									<table className="w-full text-xs">
										<thead>
											<tr className="text-left text-ink-500">
												<th className="py-1 pr-3 font-medium">{t("colType")}</th>
												<th className="py-1 pr-3 font-medium">{t("colToken")}</th>
												<th className="py-1 pr-3 font-medium">{t("colMasked")}</th>
												<th className="py-1 font-medium">{t("colTime")}</th>
											</tr>
										</thead>
										<tbody>
											{(mappings?.entries ?? []).map((e) => (
												<tr key={e.token} className="border-t hairline">
													<td className="py-1.5 pr-3">
														<span className="font-mono text-ember-300">{e.type}</span>
													</td>
													<td className="py-1.5 pr-3 font-mono break-all text-ink-300">{e.token}</td>
													<td className="py-1.5 pr-3 font-mono text-ink-500">{e.masked}</td>
													<td className="py-1.5 font-mono text-ink-500">{new Date(e.createdAt).toLocaleString()}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
							<div className="flex gap-2">
								<Button variant="outline" onClick={() => void loadMappings()}>
									<RefreshCw className="size-3.5" /> {t("refresh")}
								</Button>
								<Button
									variant="danger"
									onClick={async () => {
										if (!window.confirm(t("confirmClearMappings"))) return;
										if (await pluginCall("veil", "clearMappings", {})) {
											toast(t("mappingsCleared"));
											await Promise.all([load(), loadMappings()]);
										}
									}}
								>
									<Trash2 className="size-3.5" /> {t("clearMappings")}
								</Button>
							</div>
						</section>
					</div>
				) : tab === "proxy" ? (
					<div className="max-w-3xl space-y-4">
						<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
							<label className="flex items-start justify-between gap-4">
								<span className="min-w-0">
									<span className="block text-sm text-ink-100">{t("relayOn")}</span>
									<span className="mt-0.5 block text-xs text-ink-500">{t("relayHint")}</span>
								</span>
								<input
									type="checkbox"
									className="mt-0.5 size-4 shrink-0 accent-ember-500"
									checked={state.config.relay}
									disabled={busy}
									onChange={(e) =>
										void mutate("setFlags", { relay: e.target.checked }, e.target.checked ? t("relayEnabled") : t("relayDisabled")).then(() => {
											if (e.target.checked) void loadHits();
										})
									}
								/>
							</label>
							<div className="flex items-center gap-2 border-t hairline pt-3 text-xs">
								{relay?.running ? (
									<>
										<Badge tone="moss">{t("relayRunning")}</Badge>
										<span className="font-mono text-ink-500">{relay.baseUrl}</span>
									</>
								) : (
									<Badge>{t("relayStopped")}</Badge>
								)}
								{relay?.error && <span className="text-rose-400">{relay.error}</span>}
							</div>
						</section>

						<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
							<h2 className="font-display text-sm font-semibold">{t("proxyServer")}</h2>
							<Field label={t("proxyServer")} hint={state.config.proxyAuth ? t("proxyAuthSaved") : t("proxyAuthNone")}>
								<Input value={proxyUrl} placeholder={t("proxyPlaceholder")} onChange={(e) => setProxyUrl(e.target.value)} />
							</Field>
							<p className="text-xs text-ink-500">{t("proxyHint")}</p>
							<div className="flex gap-2">
								<Button variant="primary" disabled={busy} onClick={() => void mutate("setProxy", { url: proxyUrl }, t("saved"))}>
									{t("saveProxy")}
								</Button>
								<Button variant="outline" disabled={busy} onClick={() => void mutate("setProxy", { url: "" }, t("saved"))}>
									{t("noProxy")}
								</Button>
							</div>
						</section>

						<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
							<h2 className="font-display text-sm font-semibold">{t("relayPort")}</h2>
							<div className="grid gap-3 md:grid-cols-2">
								<Field label={t("relayPort")} hint={t("relayPortHint")}>
									<Input type="number" min={1024} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
								</Field>
								<Field label={t("upstream")} hint={t("upstreamHint")}>
									<Input value={upstream} placeholder="https://api.anthropic.com" onChange={(e) => setUpstream(e.target.value)} />
								</Field>
							</div>
							<div className="flex gap-2">
								<Button variant="primary" disabled={busy} onClick={() => void mutate("setRelay", { port, upstream }, t("saved"))}>
									{t("save")}
								</Button>
								<Button variant="outline" disabled={busy} onClick={() => void mutate("restartRelay", {})}>
									<RefreshCw className="size-3.5" /> {t("restartRelay")}
								</Button>
							</div>
						</section>

						<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
							<h2 className="font-display text-sm font-semibold">{t("recentHits")}</h2>
							{hits?.length === 0 ? (
								<p className="text-xs text-ink-500">{t("hitsEmpty")}</p>
							) : (
								<div className="overflow-x-auto">
									<table className="w-full text-xs">
										<thead>
											<tr className="text-left text-ink-500">
												<th className="py-1 pr-3 font-medium">{t("colTime")}</th>
												<th className="py-1 pr-3 font-medium">{t("colType")}</th>
												<th className="py-1 pr-3 font-medium">{t("colUpstream")}</th>
												<th className="py-1 pr-3 font-medium">{t("colStatus")}</th>
												<th className="py-1 pr-3 font-medium">{t("tabRules")}</th>
												<th className="py-1 font-medium">{t("colDuration")}</th>
											</tr>
										</thead>
										<tbody>
											{(hits ?? []).map((h, i) => (
												<tr key={`${h.at}-${i}`} className="border-t hairline font-mono text-ink-400">
													<td className="py-1.5 pr-3">{new Date(h.at).toLocaleTimeString()}</td>
													<td className="py-1.5 pr-3">{h.method}</td>
													<td className="max-w-[16rem] truncate py-1.5 pr-3">{h.upstream + h.path}</td>
													<td className="py-1.5 pr-3">{h.status}</td>
													<td className="py-1.5 pr-3">{h.types.join(", ") || "—"}</td>
													<td className="py-1.5">{h.durationMs}ms</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
							<div className="flex gap-2">
								<Button variant="outline" onClick={() => void loadHits()}>
									<RefreshCw className="size-3.5" /> {t("refresh")}
								</Button>
								<Button
									variant="outline"
									onClick={async () => {
										await pluginCall("veil", "clearHits", {});
										await loadHits();
									}}
								>
									{t("clear")}
								</Button>
							</div>
						</section>
					</div>
				) : (
					<div className="max-w-3xl space-y-4">
						<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
							<h2 className="font-display text-sm font-semibold">{t("packs")}</h2>
							<label className="flex items-start justify-between gap-4">
								<span className="min-w-0">
									<span className="block text-sm text-ink-100">{t("packSecrets")}</span>
									<span className="mt-0.5 block text-xs text-ink-500">{t("packSecretsHint")}</span>
								</span>
								<input
									type="checkbox"
									className="mt-0.5 size-4 shrink-0 accent-ember-500"
									checked={state.config.packs.secrets}
									disabled={busy}
									onChange={(e) => void mutate("setPacks", { secrets: e.target.checked, region: state.config.packs.region })}
								/>
							</label>
							<label className="flex items-start justify-between gap-4 border-t hairline pt-3">
								<span className="min-w-0">
									<span className="block text-sm text-ink-100">{t("packRegion")}</span>
									<span className="mt-0.5 block text-xs text-ink-500">{t("packRegionHint")}</span>
								</span>
								<input
									type="checkbox"
									className="mt-0.5 size-4 shrink-0 accent-ember-500"
									checked={state.config.packs.region}
									disabled={busy}
									onChange={(e) => void mutate("setPacks", { secrets: state.config.packs.secrets, region: e.target.checked })}
								/>
							</label>
						</section>

						<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
							<h2 className="font-display text-sm font-semibold">{t("ruleList")}</h2>
							<p className="text-xs text-ink-500">{t("hintRules")}</p>
							<ul className="divide-y divide-ink-800">
								{sortedRules.map((rule) => (
									<li key={rule.id} className="py-2">
										<div className="flex flex-wrap items-center gap-2">
											<input
												type="checkbox"
												className="size-4 shrink-0 accent-ember-500"
												checked={rule.enabled}
												disabled={busy}
												onChange={(e) => void mutate("toggleRule", { id: rule.id, enabled: e.target.checked })}
											/>
											<span className="font-mono text-xs text-ember-300">{rule.typePrefix}</span>
											<span className="text-sm text-ink-200">{rule.id}</span>
											{BUILTIN.has(rule.id) && <Badge>{t("builtin")}</Badge>}
											<span className="font-mono text-xs text-ink-500">{t("priorityShort", { n: rule.priority })}</span>
											{!BUILTIN.has(rule.id) && (
												<Button
													variant="danger"
													className="ml-auto px-2 py-1 text-xs"
													disabled={busy}
													onClick={() => void mutate("deleteRule", { id: rule.id })}
												>
													<Trash2 className="size-3.5" /> {t("delete")}
												</Button>
											)}
										</div>
										<p className="mt-1 pl-6 font-mono text-xs break-all text-ink-500">
											{rule.kind === "regex" ? rule.pattern || "" : rule.kind === "dictionary" ? (rule.words ?? []).join("、") : t("noRegex")}
										</p>
									</li>
								))}
							</ul>
						</section>

						<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
							<h2 className="font-display text-sm font-semibold">{t("newRule")}</h2>
							<div className="grid gap-3 md:grid-cols-2">
								<Field label={t("idLabel")}>
									<Input value={draft.id} placeholder={t("idPlaceholder")} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
								</Field>
								<Field label={t("typeLabel")}>
									<Input value={draft.typePrefix} placeholder={t("typePlaceholder")} onChange={(e) => setDraft({ ...draft, typePrefix: e.target.value })} />
								</Field>
							</div>
							<div className="grid gap-3 md:grid-cols-2">
								<Field label={t("kind")}>
									<Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Rule["kind"] })}>
										<option value="regex">{t("kindRegex")}</option>
										<option value="dictionary">{t("kindDict")}</option>
									</Select>
								</Field>
								<Field label={t("priority")}>
									<Input type="number" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} />
								</Field>
							</div>
							<Field label={t("pattern")}>
								<Textarea rows={3} value={draft.pattern} placeholder={t("patternPlaceholder")} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} />
							</Field>
							<div>
								<Button variant="primary" disabled={busy || !draft.id.trim() || !draft.typePrefix.trim()} onClick={() => void addRule()}>
									<Plus className="size-3.5" /> {t("addRule")}
								</Button>
							</div>
						</section>

						<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
							<h2 className="font-display text-sm font-semibold">{t("allowlist")}</h2>
							<p className="text-xs text-ink-500">{t("allowlistHint")}</p>
							<Textarea rows={5} className="font-mono text-xs" value={allowlist} onChange={(e) => setAllowlist(e.target.value)} />
							<div>
								<Button variant="primary" disabled={busy} onClick={() => void mutate("setAllowlist", { allowlist: allowlist.split("\n") }, t("saved"))}>
									{t("saveAllowlist")}
								</Button>
							</div>
						</section>
					</div>
				)}
			</div>
		</div>
	);
}
