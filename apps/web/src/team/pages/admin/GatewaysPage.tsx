import { Cpu, Pencil, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, Button, Empty, Field, Input, PageHeader, Select, Textarea } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Body, Card, ConfirmButton, Notice, Table, Td, useAction, useAsync } from "../../kit.tsx";
import { modelsToText, parseModels } from "../../logic/gateway.ts";
import { GATEWAY_FORMATS, type GatewayFormat, type GatewayScope, type GatewayView } from "../../types.ts";
import { Checkbox, useAdminOrgs } from "./shared.tsx";

const M = defineMessages({
	zh: {
		title: "模型网关",
		subtitle: "团队成员通过 Hub 调用的上游模型服务。API Key 只写入，不会再显示。",
		scope: "范围",
		platform: "平台",
		org: "企业",
		orgPick: "企业",
		add: "添加网关",
		edit: "编辑 {name}",
		formAdd: "添加网关",
		formEdit: "编辑网关",
		name: "名称",
		format: "接口格式",
		baseUrl: "接口地址",
		apiKey: "API Key",
		apiKeyKeep: "已保存 {masked}，留空表示不修改",
		models: "模型列表",
		modelsHint: "每行一个，格式：模型 ID 或「模型 ID | 显示名称」",
		enabled: "启用",
		tableLabel: "模型网关",
		actions: "操作",
		on: "已启用",
		off: "已停用",
		empty: "还没有网关",
		emptyHint: "添加一个网关后，成员才能通过团队使用模型。",
		saved: "已保存",
		deleted: "已删除",
		noOrgs: "没有可管理的企业",
		modelsCount: "{n} 个",
	},
	en: {
		title: "Model gateways",
		subtitle: "Upstream model services members reach through the Hub. API keys are write-only and never shown again.",
		scope: "Scope",
		platform: "Platform",
		org: "Organization",
		orgPick: "Organization",
		add: "Add gateway",
		edit: "Edit {name}",
		formAdd: "Add gateway",
		formEdit: "Edit gateway",
		name: "Name",
		format: "API format",
		baseUrl: "Base URL",
		apiKey: "API key",
		apiKeyKeep: "Saved as {masked}. Leave empty to keep it.",
		models: "Models",
		modelsHint: "One per line: a model id, or \"model id | display name\"",
		enabled: "Enabled",
		tableLabel: "Model gateways",
		actions: "Actions",
		on: "Enabled",
		off: "Disabled",
		empty: "No gateways yet",
		emptyHint: "Add a gateway so members can use models through the team.",
		saved: "Saved",
		deleted: "Deleted",
		noOrgs: "No organization to manage",
		modelsCount: "{n}",
	},
});

interface Draft {
	id: string | undefined;
	name: string;
	format: GatewayFormat;
	baseUrl: string;
	apiKey: string;
	models: string;
	enabled: boolean;
	masked: string;
}

const blank = (): Draft => ({ id: undefined, name: "", format: "openai", baseUrl: "", apiKey: "", models: "", enabled: true, masked: "" });
const fromGateway = (g: GatewayView): Draft => ({ id: g.id, name: g.name, format: g.format, baseUrl: g.baseUrl, apiKey: "", models: modelsToText(g.models), enabled: g.enabled, masked: g.apiKeyMasked });

function GatewayForm({ draft, scope, scopeId, onDone, onCancel }: { draft: Draft; scope: GatewayScope; scopeId: string | undefined; onDone: () => void; onCancel: () => void }) {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const [d, setD] = useState(draft);
	const { busy, error, run } = useAction();
	const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((cur) => ({ ...cur, [k]: v }));

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const models = parseModels(d.models);
		const ok = await run(async () => {
			if (d.id) {
				await api.updateGateway(d.id, { name: d.name.trim(), format: d.format, baseUrl: d.baseUrl.trim(), models, enabled: d.enabled, ...(d.apiKey ? { apiKey: d.apiKey } : {}) });
			} else {
				await api.createGateway({ scope, ...(scope === "org" && scopeId ? { scopeId } : {}), name: d.name.trim(), format: d.format, baseUrl: d.baseUrl.trim(), apiKey: d.apiKey, models, enabled: d.enabled });
			}
			return true;
		});
		if (ok) onDone();
	};

	return (
		<Card title={d.id ? t("formEdit") : t("formAdd")}>
			<form onSubmit={(e) => void submit(e)} className="space-y-3">
				<div className="grid gap-3 @2xl:grid-cols-2">
					<Field label={t("name")}>
						<Input value={d.name} onChange={(e) => set("name", e.target.value)} required maxLength={100} />
					</Field>
					<Field label={t("format")}>
						<Select value={d.format} onChange={(e) => set("format", e.target.value as GatewayFormat)}>
							{GATEWAY_FORMATS.map((f) => (
								<option key={f} value={f}>
									{f}
								</option>
							))}
						</Select>
					</Field>
					<Field label={t("baseUrl")}>
						<Input type="url" value={d.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} required placeholder="https://" />
					</Field>
					<Field label={t("apiKey")}>
						<Input type="password" value={d.apiKey} onChange={(e) => set("apiKey", e.target.value)} required={!d.id} autoComplete="off" placeholder={d.id ? t("apiKeyKeep", { masked: d.masked }) : ""} />
					</Field>
				</div>
				<Field label={t("models")} hint={t("modelsHint")}>
					<Textarea value={d.models} onChange={(e) => set("models", e.target.value)} rows={4} className="font-mono text-xs" />
				</Field>
				<Checkbox checked={d.enabled} onChange={(v) => set("enabled", v)} label={t("enabled")} />
				{error && <Notice kind="error">{error}</Notice>}
				<div className="flex gap-2">
					<Button type="submit" variant="primary" disabled={busy}>
						{c("save")}
					</Button>
					<Button type="button" variant="ghost" onClick={onCancel}>
						{c("cancel")}
					</Button>
				</div>
			</form>
		</Card>
	);
}

function GatewayTable({ scope, scopeId }: { scope: GatewayScope; scopeId: string | undefined }) {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const list = useAsync(() => api.listGateways(scope === "org" ? { scope, orgId: scopeId } : { scope }), [api, scope, scopeId]);
	const [draft, setDraft] = useState<Draft | undefined>(undefined);
	const [note, setNote] = useState<string | undefined>(undefined);
	const del = useAction();

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Button variant="primary" onClick={() => setDraft(blank())}>
					<Plus className="size-4" aria-hidden /> {t("add")}
				</Button>
				{note && <Notice kind="ok">{note}</Notice>}
				{del.error && <Notice kind="error">{del.error}</Notice>}
			</div>
			{draft && (
				<GatewayForm
					key={draft.id ?? "new"}
					draft={draft}
					scope={scope}
					scopeId={scopeId}
					onCancel={() => setDraft(undefined)}
					onDone={() => {
						setDraft(undefined);
						setNote(t("saved"));
						list.reload();
					}}
				/>
			)}
			<AsyncView state={list}>
				{(rows) =>
					rows.length === 0 ? (
						<Empty icon={<Cpu className="size-5" />} title={t("empty")}>
							{t("emptyHint")}
						</Empty>
					) : (
						<Table label={t("tableLabel")} head={[t("name"), t("format"), t("baseUrl"), t("apiKey"), t("models"), t("enabled"), t("actions")]}>
							{rows.map((g) => (
								<tr key={g.id}>
									<Td className="font-medium">{g.name}</Td>
									<Td>
										<Badge>{g.format}</Badge>
									</Td>
									<Td className="max-w-64 truncate font-mono text-xs">{g.baseUrl}</Td>
									<Td className="font-mono text-xs text-ink-400">{g.apiKeyMasked}</Td>
									<Td>{t("modelsCount", { n: g.models.length })}</Td>
									<Td>
										<Badge tone={g.enabled ? "moss" : "muted"}>{g.enabled ? t("on") : t("off")}</Badge>
									</Td>
									<Td>
										<div className="flex items-center gap-1.5">
											<Button
												variant="ghost"
												aria-label={t("edit", { name: g.name })}
												onClick={() => {
													setNote(undefined);
													setDraft(fromGateway(g));
												}}
											>
												<Pencil className="size-4" aria-hidden />
											</Button>
											<ConfirmButton
												label={c("delete")}
												disabled={del.busy}
												onConfirm={() =>
													void del
														.run(async () => {
															await api.deleteGateway(g.id);
															return true;
														})
														.then((ok) => {
															if (ok) {
																setNote(t("deleted"));
																list.reload();
															}
														})
												}
											/>
										</div>
									</Td>
								</tr>
							))}
						</Table>
					)
				}
			</AsyncView>
		</div>
	);
}

export function GatewaysPage() {
	const { me } = useTeam();
	const t = useT(M);
	const operator = isOperator(me);
	const orgs = useAdminOrgs();
	const [scope, setScope] = useState<GatewayScope>(operator ? "platform" : "org");
	const [orgId, setOrgId] = useState("");
	const orgList = orgs.data ?? [];
	const selectedOrg = orgList.some((o) => o.id === orgId) ? orgId : orgList[0]?.id;

	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body className="space-y-4">
				<div className="flex flex-wrap items-end gap-3">
					<Field label={t("scope")}>
						<Select value={scope} onChange={(e) => setScope(e.target.value as GatewayScope)} className="w-40" disabled={!operator}>
							{operator && <option value="platform">{t("platform")}</option>}
							<option value="org">{t("org")}</option>
						</Select>
					</Field>
					{scope === "org" && (
						<Field label={t("orgPick")}>
							<Select value={selectedOrg ?? ""} onChange={(e) => setOrgId(e.target.value)} className="w-56" disabled={orgList.length === 0}>
								{orgList.length === 0 && <option value="">{t("noOrgs")}</option>}
								{orgList.map((o) => (
									<option key={o.id} value={o.id}>
										{o.name}
									</option>
								))}
							</Select>
						</Field>
					)}
				</div>
				{scope === "org" && !selectedOrg ? (
					<AsyncView state={orgs}>{() => <Notice kind="error">{t("noOrgs")}</Notice>}</AsyncView>
				) : (
					<GatewayTable key={`${scope}:${selectedOrg ?? ""}`} scope={scope} scopeId={scope === "org" ? selectedOrg : undefined} />
				)}
			</Body>
		</>
	);
}
