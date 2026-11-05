// "我的模型": the viewer's own gateways (bring your own key). Hidden behind an explanation when the Hub or the org turned BYOK off.
import { Cpu, Lock, Pencil, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, Button, Empty, Field, Input, Select, Textarea } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Card, ConfirmButton, Notice, Table, Td, useAction, useAsync } from "../../kit.tsx";
import { modelsToText, parseModels } from "../../logic/gateway.ts";
import { GATEWAY_FORMATS, type GatewayFormat, type UserGatewayView } from "../../types.ts";
import { Checkbox } from "../admin/shared.tsx";

const M = defineMessages({
	zh: {
		intro: "接入你自己的模型服务商密钥。使用自己的网关时不扣平台额度，只记录 token 用量。密钥保存后只显示末四位。",
		notAllowedTitle: "自带模型已关闭",
		notAllowedBody: "平台管理员或你所在的企业已关闭自带模型功能。如需使用，请联系管理员开启。",
		add: "添加模型网关",
		formAdd: "添加我的模型网关",
		formEdit: "编辑我的模型网关",
		name: "名称",
		format: "接口格式",
		baseUrl: "接口地址",
		apiKey: "API 密钥",
		apiKeyKeep: "已保存为 {masked}，留空则保持不变",
		models: "模型列表",
		modelsHint: "每行一个：模型 ID，或「模型 ID | 显示名」",
		enabled: "启用",
		tableLabel: "我的模型网关",
		actions: "操作",
		on: "已启用",
		off: "已停用",
		enable: "启用",
		disable: "停用",
		empty: "还没有自己的模型网关",
		emptyHint: "添加后，你的模型会出现在会话的模型列表里。",
		saved: "已保存",
		deleted: "已删除",
		edit: "编辑 {name}",
		modelsCount: "{n} 个",
	},
	en: {
		intro: "Connect your own provider key. Calls through your own gateway cost no platform credits; only tokens are recorded. A saved key shows its last four characters only.",
		notAllowedTitle: "Bring your own models is off",
		notAllowedBody: "The platform administrator or your organization turned this feature off. Ask an administrator to enable it.",
		add: "Add a model gateway",
		formAdd: "Add my model gateway",
		formEdit: "Edit my model gateway",
		name: "Name",
		format: "API format",
		baseUrl: "Base URL",
		apiKey: "API key",
		apiKeyKeep: "Saved as {masked}. Leave empty to keep it.",
		models: "Models",
		modelsHint: "One per line: a model id, or \"model id | display name\"",
		enabled: "Enabled",
		tableLabel: "My model gateways",
		actions: "Actions",
		on: "Enabled",
		off: "Disabled",
		enable: "Enable",
		disable: "Disable",
		empty: "No gateways of your own yet",
		emptyHint: "Once added, your models appear in the session model list.",
		saved: "Saved",
		deleted: "Deleted",
		edit: "Edit {name}",
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
const fromGateway = (g: UserGatewayView): Draft => ({ id: g.id, name: g.name, format: g.format, baseUrl: g.baseUrl, apiKey: "", models: modelsToText(g.models), enabled: g.enabled, masked: g.apiKeyMasked });

function GatewayForm({ draft, onDone, onCancel }: { draft: Draft; onDone: () => void; onCancel: () => void }) {
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
				await api.updateMyGateway(d.id, { name: d.name.trim(), format: d.format, baseUrl: d.baseUrl.trim(), models, enabled: d.enabled, ...(d.apiKey ? { apiKey: d.apiKey } : {}) });
			} else {
				await api.createMyGateway({ name: d.name.trim(), format: d.format, baseUrl: d.baseUrl.trim(), apiKey: d.apiKey, models, enabled: d.enabled });
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

function GatewayList() {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const list = useAsync(() => api.listMyGateways(), [api]);
	const [draft, setDraft] = useState<Draft | undefined>(undefined);
	const [note, setNote] = useState<string | undefined>(undefined);
	const act = useAction();

	const remove = (g: UserGatewayView) =>
		void act
			.run(async () => {
				await api.deleteMyGateway(g.id);
				return true;
			})
			.then((ok) => {
				if (ok) {
					setNote(t("deleted"));
					list.reload();
				}
			});
	const toggle = (g: UserGatewayView) =>
		void act
			.run(async () => {
				await api.updateMyGateway(g.id, { enabled: !g.enabled });
				return true;
			})
			.then((ok) => {
				if (ok) {
					setNote(t("saved"));
					list.reload();
				}
			});

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="primary" onClick={() => setDraft(blank())}>
					<Plus className="size-4" aria-hidden /> {t("add")}
				</Button>
				{note && <Notice kind="ok">{note}</Notice>}
				{act.error && <Notice kind="error">{act.error}</Notice>}
			</div>
			{draft && (
				<GatewayForm
					key={draft.id ?? "new"}
					draft={draft}
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
											<Button variant="ghost" disabled={act.busy} onClick={() => toggle(g)}>
												{g.enabled ? t("disable") : t("enable")}
											</Button>
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
											<ConfirmButton label={c("delete")} disabled={act.busy} onConfirm={() => remove(g)} />
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

export function MyModelsTab() {
	const { api } = useTeam();
	const t = useT(M);
	const allowed = useAsync(() => api.getMyByok(), [api]);
	return (
		<div className="space-y-4">
			<p className="max-w-3xl text-sm text-ink-400">{t("intro")}</p>
			<AsyncView state={allowed}>
				{(a) =>
					a.allowed ? (
						<GatewayList />
					) : (
						<Empty icon={<Lock className="size-5" />} title={t("notAllowedTitle")}>
							{t("notAllowedBody")}
						</Empty>
					)
				}
			</AsyncView>
		</div>
	);
}
