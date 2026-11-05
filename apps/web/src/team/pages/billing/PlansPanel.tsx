// Operator: subscription plans (CRUD). The "free" plan keeps its price, period and active flag; the Hub refuses to change them.
import { Pencil, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, Button, Empty, Field, Input, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Card, Notice, Table, Td, useAction, useAsync } from "../../kit.tsx";
import { centsToInput, formatCredits, formatMoney, parseCentsInput, parseCreditsInput } from "../../logic/billing.ts";
import type { PlanPeriod, PlanView } from "../../types.ts";
import { Checkbox } from "../admin/shared.tsx";
import { periodLabel, useBillingLabels } from "./labels.tsx";
import { ConfirmDialog } from "./parts.tsx";

const M = defineMessages({
	zh: {
		intro: "套餐决定每个周期发放的额度和价格。价格为 0 的套餐不可订阅。",
		add: "新建套餐",
		formAdd: "新建套餐",
		formEdit: "编辑套餐",
		name: "名称",
		period: "周期",
		price: "价格",
		priceHint: "按主币种单位填写，例如 19.90",
		currency: "币种",
		currencyHint: "三位字母，例如 cny、usd",
		credits: "每周期额度",
		creditsHint: "整数，单位 credits",
		active: "上架（可订阅）",
		tableLabel: "套餐列表",
		actions: "操作",
		on: "上架",
		off: "已下架",
		empty: "还没有套餐",
		locked: "免费套餐的价格、周期和上架状态不可修改",
		saved: "已保存",
		deleted: "已删除",
		edit: "编辑 {name}",
		delete: "删除套餐",
		deleteTitle: "删除套餐",
		deleteBody: "确定删除套餐「{name}」吗？此操作不可撤销。已有订阅使用的套餐不能删除，可以改为下架。",
		invalid: "请检查输入：价格最多两位小数，币种为三位字母，额度为整数",
	},
	en: {
		intro: "A plan sets the credits issued each period and its price. A plan priced at 0 cannot be subscribed to.",
		add: "New plan",
		formAdd: "New plan",
		formEdit: "Edit plan",
		name: "Name",
		period: "Period",
		price: "Price",
		priceHint: "In major currency units, e.g. 19.90",
		currency: "Currency",
		currencyHint: "Three letters, e.g. cny, usd",
		credits: "Credits per period",
		creditsHint: "Whole number, in credits",
		active: "Active (can be subscribed)",
		tableLabel: "Plans",
		actions: "Actions",
		on: "Active",
		off: "Inactive",
		empty: "No plans yet",
		locked: "The free plan's price, period and active flag cannot be changed",
		saved: "Saved",
		deleted: "Deleted",
		edit: "Edit {name}",
		delete: "Delete plan",
		deleteTitle: "Delete plan",
		deleteBody: "Delete the plan \"{name}\"? This cannot be undone. A plan used by subscriptions cannot be deleted; deactivate it instead.",
		invalid: "Check the input: price with at most two decimals, a three-letter currency, whole-number credits",
	},
});

interface Draft {
	id: string | undefined;
	name: string;
	period: PlanPeriod;
	price: string;
	currency: string;
	credits: string;
	active: boolean;
}

const blank = (): Draft => ({ id: undefined, name: "", period: "month", price: "", currency: "cny", credits: "", active: true });
const fromPlan = (p: PlanView): Draft => ({ id: p.id, name: p.name, period: p.period, price: centsToInput(p.priceCents), currency: p.currency, credits: String(p.monthlyCredits), active: p.active });

function PlanForm({ draft, onDone, onCancel }: { draft: Draft; onDone: () => void; onCancel: () => void }) {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const [d, setD] = useState(draft);
	const [formError, setFormError] = useState<string | undefined>(undefined);
	const { busy, error, run } = useAction();
	const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((cur) => ({ ...cur, [k]: v }));
	const locked = d.id === "free";

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const priceCents = parseCentsInput(d.price);
		const monthlyCredits = parseCreditsInput(d.credits, 0);
		const currency = d.currency.trim().toLowerCase();
		if (priceCents === undefined || monthlyCredits === undefined || !/^[a-z]{3}$/.test(currency)) return setFormError(t("invalid"));
		setFormError(undefined);
		const ok = await run(async () => {
			const base = { name: d.name.trim(), monthlyCredits, currency };
			if (d.id) await api.updatePlan(d.id, locked ? base : { ...base, period: d.period, priceCents, active: d.active });
			else await api.createPlan({ ...base, period: d.period, priceCents, active: d.active });
			return true;
		});
		if (ok) onDone();
	};

	return (
		<Card title={d.id ? t("formEdit") : t("formAdd")}>
			<form onSubmit={(e) => void submit(e)} className="space-y-3">
				{locked && <Notice kind="ok">{t("locked")}</Notice>}
				<div className="grid gap-3 @2xl:grid-cols-3">
					<Field label={t("name")}>
						<Input value={d.name} onChange={(e) => set("name", e.target.value)} required maxLength={100} />
					</Field>
					<Field label={t("period")}>
						<PeriodSelect value={d.period} onChange={(v) => set("period", v)} disabled={locked} />
					</Field>
					<Field label={t("price")} hint={t("priceHint")}>
						<Input inputMode="decimal" value={d.price} onChange={(e) => set("price", e.target.value)} required disabled={locked} />
					</Field>
					<Field label={t("currency")} hint={t("currencyHint")}>
						<Input value={d.currency} onChange={(e) => set("currency", e.target.value)} required maxLength={3} className="uppercase" />
					</Field>
					<Field label={t("credits")} hint={t("creditsHint")}>
						<Input inputMode="numeric" value={d.credits} onChange={(e) => set("credits", e.target.value)} required />
					</Field>
				</div>
				<Checkbox checked={d.active} onChange={(v) => set("active", v)} label={t("active")} disabled={locked} />
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

function PeriodSelect({ value, onChange, disabled }: { value: PlanPeriod; onChange: (v: PlanPeriod) => void; disabled?: boolean }) {
	const l = useBillingLabels();
	return (
		<Select value={value} onChange={(e) => onChange(e.target.value as PlanPeriod)} disabled={disabled}>
			<option value="month">{periodLabel(l, "month")}</option>
			<option value="year">{periodLabel(l, "year")}</option>
		</Select>
	);
}

export function PlansPanel() {
	const { api } = useTeam();
	const t = useT(M);
	const l = useBillingLabels();
	const list = useAsync(() => api.listAdminPlans(), [api]);
	const [draft, setDraft] = useState<Draft | undefined>(undefined);
	const [note, setNote] = useState<string | undefined>(undefined);
	const [toDelete, setToDelete] = useState<PlanView | undefined>(undefined);
	const del = useAction();

	const confirmDelete = async () => {
		if (!toDelete) return;
		const ok = await del.run(async () => {
			await api.deletePlan(toDelete.id);
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
				{note && <Notice kind="ok">{note}</Notice>}
			</div>
			{draft && (
				<PlanForm
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
						<Empty icon={<Plus className="size-5" />} title={t("empty")} />
					) : (
						<Table label={t("tableLabel")} head={[t("name"), t("period"), t("price"), t("credits"), t("active"), t("actions")]}>
							{rows.map((p) => (
								<tr key={p.id}>
									<Td className="font-medium">{p.name}</Td>
									<Td>{periodLabel(l, p.period)}</Td>
									<Td className="tabular-nums">{p.priceCents === 0 ? l("free") : formatMoney(p.priceCents, p.currency)}</Td>
									<Td className="tabular-nums">{formatCredits(p.monthlyCredits)}</Td>
									<Td>
										<Badge tone={p.active ? "moss" : "muted"}>{p.active ? t("on") : t("off")}</Badge>
									</Td>
									<Td>
										<div className="flex items-center gap-1.5">
											<Button
												variant="ghost"
												aria-label={t("edit", { name: p.name })}
												onClick={() => {
													setNote(undefined);
													setDraft(fromPlan(p));
												}}
											>
												<Pencil className="size-4" aria-hidden />
											</Button>
											{p.id !== "free" && (
												<Button
													variant="danger"
													onClick={() => {
														del.clearError();
														setToDelete(p);
													}}
												>
													{t("delete")}
												</Button>
											)}
										</div>
									</Td>
								</tr>
							))}
						</Table>
					)
				}
			</AsyncView>
			{toDelete && (
				<ConfirmDialog
					title={t("deleteTitle")}
					body={<p>{t("deleteBody", { name: toDelete.name })}</p>}
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
