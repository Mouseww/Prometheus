import clsx from "clsx";
import { CloudDownload, LoaderCircle, Network, Plus, Search, Trash2, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { GatewayAuth, GatewayConfig, GatewayFormat, GatewayModel } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call, refreshModels, toast } from "../lib/store.ts";
import { Badge, Button, Empty, Field, Input, PageHeader, Select } from "./ui.tsx";

const M = defineMessages({
	zh: {
		hintCompletions: "/v1/chat/completions，兼容绝大多数中转与本地推理",
		hintResponses: "/v1/responses，新一代 OpenAI 接口",
		hintAnthropic: "/v1/messages，Claude 原生格式；Base URL 填到主机即可，末尾 /v1 会自动去掉",
		hintGemini: "generateContent，Gemini 原生格式",
		authNative: "协议默认",
		authBearer: "Bearer Token",
		authHeader: "自定义请求头",
		authNone: "无鉴权",
		title: "AI 网关",
		subtitle: "接入任意 OpenAI / Claude / Gemini 兼容端点，自定义地址、鉴权方式与密钥",
		addGateway: "添加网关",
		emptyTitle: "还没有网关",
		emptyBody: "添加一个网关后，它的模型会立即出现在对话的模型选择器中。PI 自带的 /login 账号同样可用。",
		modelCount: "{n} 模型",
		saved: "已保存网关 {name}",
		confirmDelete: "删除网关「{name}」？",
		newGateway: "新建网关",
		close: "关闭",
		idHint: "小写字母/数字/-/_，即 Provider 名",
		displayName: "显示名称",
		namePlaceholder: "公司 Claude 网关",
		format: "接口格式",
		auth: "鉴权方式",
		apiKeyHint: "留空或保持掩码表示不修改",
		headerName: "请求头名",
		prefix: "值前缀",
		prefixHint: "例如 Token、Bearer，留空则只发送密钥",
		extraHeaders: "附加请求头",
		delete: "删除",
		header: "请求头",
		models: "模型",
		modelId: "模型 ID",
		context: "上下文",
		reasoning: "思考",
		vision: "视觉",
		deleteModel: "删除模型",
		model: "模型",
		loadModels: "从接口加载模型列表",
		enable: "启用此网关",
		testOk: "连通成功",
		testFail: "连通失败",
		test: "测试连通",
		save: "保存",
		searchModels: "搜索 {n} 个模型…",
		selected: "已选 {n}",
		noMatch: "没有匹配的模型",
	},
	en: {
		hintCompletions: "/v1/chat/completions, works with most proxies and local inference",
		hintResponses: "/v1/responses, the newer OpenAI API",
		hintAnthropic: "/v1/messages, native Claude format; host only is enough, a trailing /v1 is stripped",
		hintGemini: "generateContent, native Gemini format",
		authNative: "Protocol default",
		authBearer: "Bearer Token",
		authHeader: "Custom header",
		authNone: "No auth",
		title: "AI Gateways",
		subtitle: "Connect any OpenAI / Claude / Gemini compatible endpoint with custom URL, auth and keys",
		addGateway: "Add gateway",
		emptyTitle: "No gateways yet",
		emptyBody: "Once added, a gateway's models appear right away in the chat model picker. Accounts from PI's /login work too.",
		modelCount: "{n} models",
		saved: "Saved gateway {name}",
		confirmDelete: "Delete gateway \"{name}\"?",
		newGateway: "New gateway",
		close: "Close",
		idHint: "Lowercase letters, digits, - or _; used as the provider name",
		displayName: "Display name",
		namePlaceholder: "Company Claude gateway",
		format: "API format",
		auth: "Authentication",
		apiKeyHint: "Leave blank or masked to keep unchanged",
		headerName: "Header name",
		prefix: "Value prefix",
		prefixHint: "e.g. Token or Bearer; leave blank to send only the key",
		extraHeaders: "Extra headers",
		delete: "Delete",
		header: "Header",
		models: "Models",
		modelId: "Model ID",
		context: "Context",
		reasoning: "Reasoning",
		vision: "Vision",
		deleteModel: "Remove model",
		model: "Model",
		loadModels: "Load models from API",
		enable: "Enable this gateway",
		testOk: "Connected",
		testFail: "Connection failed",
		test: "Test connection",
		save: "Save",
		searchModels: "Search {n} models…",
		selected: "{n} selected",
		noMatch: "No matching models",
	},
});
type MsgKey = keyof typeof M.zh;

const FORMATS: { value: GatewayFormat; label: string; hint: MsgKey; base: string }[] = [
	{ value: "openai-completions", label: "OpenAI Chat Completions", hint: "hintCompletions", base: "https://api.openai.com/v1" },
	{ value: "openai-responses", label: "OpenAI Responses", hint: "hintResponses", base: "https://api.openai.com/v1" },
	{ value: "anthropic-messages", label: "Anthropic Messages", hint: "hintAnthropic", base: "https://api.anthropic.com" },
	{ value: "google-generative-ai", label: "Google Gemini", hint: "hintGemini", base: "https://generativelanguage.googleapis.com/v1beta" },
];

const AUTH_LABEL: Record<GatewayAuth["type"], MsgKey> = {
	native: "authNative",
	bearer: "authBearer",
	header: "authHeader",
	none: "authNone",
};

function blank(): GatewayConfig {
	return {
		id: "",
		name: "",
		format: "openai-completions",
		baseUrl: "https://api.openai.com/v1",
		auth: { type: "native" },
		apiKey: "",
		headers: {},
		models: [{ id: "" }],
		enabled: true,
	};
}

export function GatewaysView() {
	const t = useT(M);
	const [list, setList] = useState<GatewayConfig[]>([]);
	const [editing, setEditing] = useState<{ gateway: GatewayConfig; isNew: boolean } | null>(null);

	const load = async () => {
		const gateways = await call((c) => c.rpc("gateway.list", {}));
		if (gateways) setList(gateways);
	};
	useEffect(() => {
		void load();
	}, []);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<Button variant="primary" onClick={() => setEditing({ gateway: blank(), isNew: true })}>
						<Plus className="size-4" /> {t("addGateway")}
					</Button>
				}
			/>
			<div className="flex min-h-0 flex-1">
				<div className={clsx("min-h-0 overflow-y-auto p-4 md:p-6", editing ? "hidden w-96 shrink-0 border-r hairline lg:block" : "flex-1")}>
					{list.length === 0 ? (
						<Empty icon={<Network className="size-5" />} title={t("emptyTitle")}>
							{t("emptyBody")}
						</Empty>
					) : (
						<div className={clsx("grid gap-3", !editing && "md:grid-cols-2 xl:grid-cols-3")}>
							{list.map((g) => (
								<button
									key={g.id}
									type="button"
									onClick={() => setEditing({ gateway: structuredClone(g), isNew: false })}
									className={clsx(
										"group animate-rise rounded-xl border bg-ink-900/60 p-4 text-left transition-colors hover:border-ink-600",
										editing?.gateway.id === g.id ? "border-ember-500/50" : "border-ink-800",
									)}
								>
									<div className="flex items-center gap-2">
										<span className={clsx("size-2 rounded-full", g.enabled === false ? "bg-ink-600" : "bg-moss-400")} />
										<span className="font-display font-semibold">{g.name}</span>
										<span className="ml-auto font-mono text-[11px] text-ink-500">{g.id}</span>
									</div>
									<div className="mt-1 truncate font-mono text-xs text-ink-500">{g.baseUrl}</div>
									<div className="mt-3 flex flex-wrap gap-1.5">
										<Badge tone="ember">{g.format}</Badge>
										<Badge>{t(AUTH_LABEL[g.auth.type])}</Badge>
										<Badge tone="sky">{t("modelCount", { n: g.models.length })}</Badge>
									</div>
								</button>
							))}
						</div>
					)}
				</div>
				{editing && (
					<GatewayEditor
						key={editing.isNew ? "new" : editing.gateway.id}
						initial={editing.gateway}
						isNew={editing.isNew}
						onClose={() => setEditing(null)}
						onSaved={async () => {
							await load();
							await refreshModels();
						}}
					/>
				)}
			</div>
		</div>
	);
}

function GatewayEditor({ initial, isNew, onClose, onSaved }: { initial: GatewayConfig; isNew: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
	const t = useT(M);
	const [g, setG] = useState<GatewayConfig>(initial);
	const [headers, setHeaders] = useState<[string, string][]>(Object.entries(initial.headers ?? {}));
	const [busy, setBusy] = useState(false);
	const [test, setTest] = useState<{ ok: boolean; latencyMs: number; message: string } | null>(null);
	const [catalogue, setCatalogue] = useState<GatewayModel[] | null>(null);
	const [loadingModels, setLoadingModels] = useState(false);
	const patch = (p: Partial<GatewayConfig>) => setG((x) => ({ ...x, ...p }));
	const patchModel = (i: number, p: Partial<GatewayModel>) => setG((x) => ({ ...x, models: x.models.map((m, j) => (j === i ? { ...m, ...p } : m)) }));
	const format = FORMATS.find((f) => f.value === g.format);

	const draft = (): GatewayConfig => ({
		...g,
		id: g.id.trim(),
		headers: Object.fromEntries(headers.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
		models: g.models.filter((m) => m.id.trim()).map((m) => ({ ...m, id: m.id.trim() })),
	});

	const loadModels = async () => {
		setLoadingModels(true);
		const list = await call((c) => c.rpc("gateway.models", { gateway: draft() }));
		setLoadingModels(false);
		if (list) setCatalogue(list);
	};

	const toggleModel = (m: GatewayModel) =>
		setG((x) => {
			const kept = x.models.filter((y) => y.id.trim());
			return kept.some((y) => y.id === m.id) ? { ...x, models: kept.filter((y) => y.id !== m.id) } : { ...x, models: [...kept, m] };
		});

	const save = async () => {
		setBusy(true);
		const gateway = draft();
		const saved = await call((c) => c.rpc("gateway.save", { gateway }));
		setBusy(false);
		if (!saved) return;
		toast(t("saved", { name: saved.name }));
		setG(saved);
		await onSaved();
		if (isNew) onClose();
	};

	const runTest = async () => {
		setTest(null);
		setBusy(true);
		const result = await call((c) => c.rpc("gateway.test", { id: g.id }));
		setBusy(false);
		if (result) setTest(result);
	};

	const remove = async () => {
		if (!confirm(t("confirmDelete", { name: g.name }))) return;
		const ok = await call((c) => c.rpc("gateway.delete", { id: g.id }));
		if (ok !== undefined) {
			await onSaved();
			onClose();
		}
	};

	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto max-w-2xl space-y-6 p-4 md:p-6">
				<div className="flex items-center justify-between">
					<h2 className="font-display text-xl font-semibold">{isNew ? t("newGateway") : g.name}</h2>
					<Button onClick={onClose}>{t("close")}</Button>
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<Field label="ID" hint={t("idHint")}>
						<Input value={g.id} disabled={!isNew} onChange={(e) => patch({ id: e.target.value })} placeholder="my-gateway" />
					</Field>
					<Field label={t("displayName")}>
						<Input value={g.name} onChange={(e) => patch({ name: e.target.value })} placeholder={t("namePlaceholder")} />
					</Field>
				</div>

				<Field label={t("format")} hint={format ? t(format.hint) : undefined}>
					<div className="grid grid-cols-2 gap-2">
						{FORMATS.map((f) => (
							<button
								key={f.value}
								type="button"
								onClick={() => patch({ format: f.value, baseUrl: g.baseUrl && !FORMATS.some((x) => x.base === g.baseUrl) ? g.baseUrl : f.base })}
								className={clsx(
									"rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
									g.format === f.value ? "border-ember-500/60 bg-ember-500/8 text-ink-100" : "border-ink-700 text-ink-400 hover:border-ink-500",
								)}
							>
								{f.label}
							</button>
						))}
					</div>
				</Field>

				<Field label="Base URL">
					<Input value={g.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} className="font-mono" />
				</Field>

				<div className="grid gap-4 sm:grid-cols-2">
					<Field label={t("auth")}>
						<Select
							value={g.auth.type}
							onChange={(e) => {
								const type = e.target.value as GatewayAuth["type"];
								patch({ auth: type === "header" ? { type, header: "api-key", prefix: "" } : { type } });
							}}
						>
							{Object.entries(AUTH_LABEL).map(([v, l]) => (
								<option key={v} value={v}>
									{t(l)}
								</option>
							))}
						</Select>
					</Field>
					{g.auth.type !== "none" && (
						<Field label="API Key / Token" hint={isNew ? undefined : t("apiKeyHint")}>
							<Input type="password" autoComplete="off" value={g.apiKey ?? ""} onChange={(e) => patch({ apiKey: e.target.value })} className="font-mono" />
						</Field>
					)}
				</div>

				{g.auth.type === "header" && (
					<div className="grid gap-4 sm:grid-cols-2">
						<Field label={t("headerName")}>
							<Input value={g.auth.header} onChange={(e) => patch({ auth: { type: "header", header: e.target.value, prefix: g.auth.type === "header" ? g.auth.prefix : "" } })} className="font-mono" />
						</Field>
						<Field label={t("prefix")} hint={t("prefixHint")}>
							<Input value={g.auth.prefix ?? ""} onChange={(e) => patch({ auth: { type: "header", header: g.auth.type === "header" ? g.auth.header : "", prefix: e.target.value } })} className="font-mono" />
						</Field>
					</div>
				)}

				<Field label={t("extraHeaders")}>
					<div className="space-y-2">
						{headers.map(([k, v], i) => (
							<div key={i} className="flex gap-2">
								<Input value={k} placeholder="X-Header" onChange={(e) => setHeaders(headers.map((h, j) => (j === i ? [e.target.value, h[1]] : h)))} className="font-mono" />
								<Input value={v} placeholder="value" onChange={(e) => setHeaders(headers.map((h, j) => (j === i ? [h[0], e.target.value] : h)))} className="font-mono" />
								<Button variant="danger" onClick={() => setHeaders(headers.filter((_, j) => j !== i))} aria-label={t("delete")}>
									<Trash2 className="size-4" />
								</Button>
							</div>
						))}
						<Button variant="outline" onClick={() => setHeaders([...headers, ["", ""]])}>
							<Plus className="size-3.5" /> {t("header")}
						</Button>
					</div>
				</Field>

				<Field label={t("models")}>
					<div className="space-y-2">
						{g.models.map((m, i) => (
							<div key={i} className="grid grid-cols-[1fr_6rem_auto_auto_auto] items-center gap-2 rounded-lg border border-ink-800 p-2">
								<Input value={m.id} placeholder={t("modelId")} onChange={(e) => patchModel(i, { id: e.target.value })} className="font-mono" />
								<Input
									type="number"
									value={m.contextWindow ?? ""}
									placeholder={t("context")}
									onChange={(e) => patchModel(i, { contextWindow: e.target.value ? Number(e.target.value) : undefined })}
									className="font-mono"
								/>
								<label className="flex items-center gap-1 text-xs text-ink-400">
									<input type="checkbox" checked={m.reasoning ?? false} onChange={(e) => patchModel(i, { reasoning: e.target.checked })} className="accent-ember-500" />
									{t("reasoning")}
								</label>
								<label className="flex items-center gap-1 text-xs text-ink-400">
									<input type="checkbox" checked={m.vision ?? false} onChange={(e) => patchModel(i, { vision: e.target.checked })} className="accent-ember-500" />
									{t("vision")}
								</label>
								<Button variant="danger" onClick={() => setG({ ...g, models: g.models.filter((_, j) => j !== i) })} aria-label={t("deleteModel")}>
									<Trash2 className="size-4" />
								</Button>
							</div>
						))}
						<div className="flex flex-wrap gap-2">
							<Button variant="outline" onClick={() => setG({ ...g, models: [...g.models, { id: "" }] })}>
								<Plus className="size-3.5" /> {t("model")}
							</Button>
							<Button variant="outline" disabled={loadingModels || !g.baseUrl} onClick={() => void loadModels()}>
								{loadingModels ? <LoaderCircle className="size-3.5 animate-spin" /> : <CloudDownload className="size-3.5" />} {t("loadModels")}
							</Button>
						</div>
						{catalogue && <ModelCatalogue list={catalogue} selected={g.models} onToggle={toggleModel} onClose={() => setCatalogue(null)} />}
					</div>
				</Field>

				<label className="flex items-center gap-2 text-sm text-ink-300">
					<input type="checkbox" checked={g.enabled !== false} onChange={(e) => patch({ enabled: e.target.checked })} className="accent-ember-500" />
					{t("enable")}
				</label>

				{test && (
					<div className={clsx("rounded-lg border px-3.5 py-2.5 text-sm", test.ok ? "border-moss-400/30 bg-moss-400/8 text-moss-400" : "border-rose-400/30 bg-rose-400/8 text-rose-400")}>
						{test.ok ? t("testOk") : t("testFail")} · {test.latencyMs}ms
						<div className="mt-1 font-mono text-xs break-all opacity-80">{test.message}</div>
					</div>
				)}

				<div className="flex items-center gap-2 border-t hairline pt-5">
					{!isNew && (
						<Button variant="danger" onClick={() => void remove()}>
							<Trash2 className="size-4" /> {t("delete")}
						</Button>
					)}
					<div className="flex-1" />
					{!isNew && (
						<Button variant="outline" disabled={busy} onClick={() => void runTest()}>
							<Zap className="size-4" /> {t("test")}
						</Button>
					)}
					<Button variant="primary" disabled={busy} onClick={() => void save()}>
						{t("save")}
					</Button>
				</div>
			</div>
		</div>
	);
}

function ModelCatalogue({ list, selected, onToggle, onClose }: { list: GatewayModel[]; selected: GatewayModel[]; onToggle: (m: GatewayModel) => void; onClose: () => void }) {
	const t = useT(M);
	const [q, setQ] = useState("");
	const chosen = new Set(selected.map((m) => m.id));
	const filtered = list.filter((m) => `${m.id} ${m.name ?? ""}`.toLowerCase().includes(q.toLowerCase()));
	return (
		<div className="mt-2 overflow-hidden rounded-xl border border-ink-700 bg-ink-950/50">
			<div className="flex items-center gap-2 border-b border-ink-800 px-3">
				<Search className="size-3.5 text-ink-500" />
				<input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchModels", { n: list.length })} className="w-full bg-transparent py-2 text-sm focus:outline-none" />
				<span className="font-mono text-[11px] whitespace-nowrap text-ink-500">{t("selected", { n: selected.filter((m) => m.id.trim()).length })}</span>
				<button type="button" onClick={onClose} className="rounded p-1 text-ink-500 hover:bg-ink-800 hover:text-ink-100" aria-label={t("close")}>
					<X className="size-3.5" />
				</button>
			</div>
			<div className="max-h-72 overflow-y-auto p-1">
				{filtered.length === 0 && <p className="py-6 text-center text-sm text-ink-500">{t("noMatch")}</p>}
				{filtered.map((m) => (
					<label key={m.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-ink-850">
						<input type="checkbox" checked={chosen.has(m.id)} onChange={() => onToggle(m)} className="accent-ember-500" />
						<span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink-100">{m.id}</span>
						{m.name && m.name !== m.id && <span className="hidden max-w-40 truncate text-xs text-ink-500 sm:inline">{m.name}</span>}
						{m.reasoning && <Badge tone="sky">{t("reasoning")}</Badge>}
						{m.vision && <Badge tone="moss">{t("vision")}</Badge>}
						{m.contextWindow && <span className="font-mono text-[10.5px] text-ink-600">{Math.round(m.contextWindow / 1000)}k</span>}
					</label>
				))}
			</div>
		</div>
	);
}
