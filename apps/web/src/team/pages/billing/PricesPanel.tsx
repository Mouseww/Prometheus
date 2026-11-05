// Operator: model price list (credits per million tokens). The "*" row is the fallback for models without their own price.
import { Pencil, Plus, Tag } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { Badge, Button, Empty, Field, Input, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Card, Notice, Table, Td, useAction, useAsync } from "../../kit.tsx";
import { formatPrice, parsePriceInput } from "../../logic/billing.ts";
import type { PriceView } from "../../types.ts";
import { ConfirmDialog } from "./parts.tsx";

const M = defineMessages({
	zh: {
		intro: "每个模型按「输入 / 输出」分别计价，单位为 credits / 百万 token。模型写 * 表示兜底价，未单独定价的模型使用它。",
		add: "新增价目",
		formAdd: "新增价目",
		formEdit: "编辑价目",
		model: "模型",
		modelHint: "模型 ID，或 * 作为兜底",
		gateway: "网关",
		anyGateway: "所有网关",
		input: "输入价",
		output: "输出价",
		unit: "credits / 百万 token",
		note: "备注",
		tableLabel: "价目表",
		actions: "操作",
		fallback: "兜底",
		empty: "还没有价目",
		noFallback: "还没有 * 兜底价。没有单独价格的模型将无法计费。",
		saved: "已保存",
		deleted: "已删除",
		edit: "编辑 {name}",
		delete: "删除",
		deleteTitle: "删除价目",
		deleteBody: "确定删除「{name}」的价目吗？之后该模型改用兜底价或无法计费。此操作不可撤销。",
		invalid: "价格需要是不小于 0 的数字",
		fallbackRow: "兜底价 *",
	},
	en: {
		intro: "Each model is priced for input and output separately, in credits per million tokens. A model of * is the fallback used by models without their own price.",
		add: "Add a price",
		formAdd: "Add a price",
		formEdit: "Edit price",
		model: "Model",
		modelHint: "A model id, or * for the fallback",
		gateway: "Gateway",
		anyGateway: "All gateways",
		input: "Input price",
		output: "Output price",
		unit: "credits per million tokens",
		note: "Note",
		tableLabel: "Prices",
		actions: "Actions",
		fallback: "Fallback",
		empty: "No prices yet",
		noFallback: "There is no * fallback price. Models without their own price cannot be billed.",
		saved: "Saved",
		deleted: "Deleted",
		edit: "Edit {name}",
		delete: "Delete",
		deleteTitle: "Delete price",
		deleteBody: "Delete the price of \"{name}\"? The model then falls back to the * price or cannot be billed. This cannot be undone.",
		invalid: "Prices must be numbers of zero or more",
		fallbackRow: "Fallback *",
	},
});

interface Draft {
	id: string | undefined;
	model: string;
	gatewayId: string;
	input: string;
	output: string;
	note: string;
}

const blank = (): Draft => ({ id: undefined, model: "", gatewayId: "", input: "", output: "", note: "" });
const fromPrice = (p: PriceView): Draft => ({ id: p.id, model: p.model, gatewayId: p.gatewayId ?? "", input: formatPrice(p.inputPrice), output: formatPrice(p.outputPrice), note: p.currencyNote ?? "" });

function PriceForm({ draft, onDone, onCancel }: { draft: Draft; onDone: () => void; onCancel: () => void }) {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const gateways = useAsync(() => api.listGateways({ scope: "platform" }).catch(() => []), [api]);
	const [d, setD] = useState(draft);
	const [formError, setFormError] = useState<string | undefined>(undefined);
	const { busy, error, run } = useAction();
	const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((cur) => ({ ...cur, [k]: v }));

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const inputPrice = parsePriceInput(d.input);
		const outputPrice = parsePriceInput(d.output);
		if (inputPrice === undefined || outputPrice === undefined) return setFormError(t("invalid"));
		setFormError(undefined);
		const body = { model: d.model.trim(), gatewayId: d.gatewayId || null, inputPrice, outputPrice, currencyNote: d.note.trim() || null };
		const ok = await run(async () => {
			if (d.id) await api.updatePrice(d.id, body);
			else await api.createPrice(body);
			return true;
		});
		if (ok) onDone();
	};

	return (
		<Card title={d.id ? t("formEdit") : t("formAdd")}>
			<form onSubmit={(e) => void submit(e)} className="space-y-3">
				<div className="grid gap-3 @2xl:grid-cols-3">
					<Field label={t("model")} hint={t("modelHint")}>
						<Input value={d.model} onChange={(e) => set("model", e.target.value)} required maxLength={200} className="font-mono" />
					</Field>
					<Field label={t("gateway")}>
						<Select value={d.gatewayId} onChange={(e) => set("gatewayId", e.target.value)}>
							<option value="">{t("anyGateway")}</option>
							{(gateways.data ?? []).map((g) => (
								<option key={g.id} value={g.id}>
									{g.name}
								</option>
							))}
						</Select>
					</Field>
					<Field label={t("note")}>
						<Input value={d.note} onChange={(e) => set("note", e.target.value)} maxLength={200} />
					</Field>
					<Field label={t("input")} hint={t("unit")}>
						<Input inputMode="decimal" value={d.input} onChange={(e) => set("input", e.target.value)} required />
					</Field>
					<Field label={t("output")} hint={t("unit")}>
						<Input inputMode="decimal" value={d.output} onChange={(e) => set("output", e.target.value)} required />
					</Field>
				</div>
				{(formError ?? error) && <Notice kind="error">{formError ?? error}</Notice>}
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

export function PricesPanel() {
	const { api } = useTeam();
	const t = useT(M);
	const list = useAsync(() => api.listPrices(), [api]);
	const gateways = useAsync(() => api.listGateways({ scope: "platform" }).catch(() => []), [api]);
	const gatewayName = useMemo(() => new Map((gateways.data ?? []).map((g) => [g.id, g.name])), [gateways.data]);
	const [draft, setDraft] = useState<Draft | undefined>(undefined);
	const [note, setNote] = useState<string | undefined>(undefined);
	const [toDelete, setToDelete] = useState<PriceView | undefined>(undefined);
	const del = useAction();

	const confirmDelete = async () => {
		if (!toDelete) return;
		const ok = await del.run(async () => {
			await api.deletePrice(toDelete.id);
			return true;
		});
		if (ok) {
			setToDelete(undefined);
			setNote(t("deleted"));
			list.reload();
		}
	};

	return (
		<div className="space-y-4">
			<p className="max-w-3xl text-sm text-ink-400">{t("intro")}</p>
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="primary" onClick={() => setDraft(blank())}>
					<Plus className="size-4" aria-hidden /> {t("add")}
				</Button>
				<Button variant="ghost" onClick={() => setDraft({ ...blank(), model: "*" })}>
					<Tag className="size-4" aria-hidden /> {t("fallbackRow")}
				</Button>
				{note && <Notice kind="ok">{note}</Notice>}
			</div>
			{draft && (
				<PriceForm
					key={draft.id ?? `new:${draft.model}`}
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
				{(rows) => (
					<>
						{!rows.some((p) => p.model === "*") && <Notice kind="error">{t("noFallback")}</Notice>}
						{rows.length === 0 ? (
							<Empty icon={<Tag className="size-5" />} title={t("empty")} />
						) : (
							<Table label={t("tableLabel")} head={[t("model"), t("gateway"), t("input"), t("output"), t("note"), t("actions")]}>
								{rows.map((p) => (
									<tr key={p.id}>
										<Td className="font-mono text-xs">
											{p.model} {p.model === "*" && <Badge tone="ember">{t("fallback")}</Badge>}
										</Td>
										<Td className="text-xs text-ink-400">{p.gatewayId ? (gatewayName.get(p.gatewayId) ?? p.gatewayId) : t("anyGateway")}</Td>
										<Td className="tabular-nums">{formatPrice(p.inputPrice)}</Td>
										<Td className="tabular-nums">{formatPrice(p.outputPrice)}</Td>
										<Td className="max-w-48 truncate text-xs text-ink-400">{p.currencyNote ?? ""}</Td>
										<Td>
											<div className="flex items-center gap-1.5">
												<Button
													variant="ghost"
													aria-label={t("edit", { name: p.model })}
													onClick={() => {
														setNote(undefined);
														setDraft(fromPrice(p));
													}}
												>
													<Pencil className="size-4" aria-hidden />
												</Button>
												<Button
													variant="danger"
													onClick={() => {
														del.clearError();
														setToDelete(p);
													}}
												>
													{t("delete")}
												</Button>
											</div>
										</Td>
									</tr>
								))}
							</Table>
						)}
					</>
				)}
			</AsyncView>
			{toDelete && (
				<ConfirmDialog
					title={t("deleteTitle")}
					body={<p>{t("deleteBody", { name: toDelete.model })}</p>}
					confirmLabel={t("delete")}
					busy={del.busy}
					error={del.error}
					onConfirm={() => void confirmDelete()}
					onClose={() => setToDelete(undefined)}
				/>
			)}
		</div>
	);
}
