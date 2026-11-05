// "额度与账单": balance, period usage, subscription, plans, top-up, redeem code and recent orders for a personal or org wallet.
import { CreditCard, Gift, ReceiptText } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, Button, Empty, Field, Input, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { managedOrgs, useTeam } from "../../context.tsx";
import { AsyncView, Card, Notice, shortDate, Table, Td, useAction, useAsync } from "../../kit.tsx";
import { checkoutRedirect, formatCredits, formatCreditsShort, formatMoney, MAX_TOPUP_CREDITS, MIN_TOPUP_CREDITS, parseCreditsInput, percentOf, TOPUP_PRESETS } from "../../logic/billing.ts";
import type { BillingSummary, CheckoutInput, CheckoutResult, PlanView } from "../../types.ts";
import { grantSourceLabel, kindLabel, OrderStatusBadge, periodLabel, useBillingLabels } from "./labels.tsx";
import { Meter, Stat } from "./parts.tsx";

const M = defineMessages({
	zh: {
		subject: "计费主体",
		personal: "个人",
		balance: "可用额度",
		balanceHint: "单位：credits",
		usage: "本月用量",
		usageHint: "{requests} 次请求，输入 {input} / 输出 {output} tokens",
		overdraft: "透支 {n} credits",
		plan: "当前套餐",
		planHint: "{credits} credits / 月",
		renews: "当前周期至 {date}",
		grants: "额度明细",
		grantsEmpty: "当前没有可用的额度",
		grantRemaining: "{remaining} / {amount}",
		plans: "套餐",
		plansEmpty: "暂时没有可订阅的套餐",
		subscribe: "订阅",
		currentPlan: "当前套餐",
		subscribing: "处理中",
		provider: "支付方式",
		providerDefault: "默认",
		topup: "充值",
		topupHint: "选择额度或输入自定义数量（{min} 到 {max}）。应付金额由 Hub 按当前汇率计算。",
		custom: "自定义额度",
		topupBtn: "充值 {credits} credits",
		topupInvalid: "额度需要是 {min} 到 {max} 之间的整数",
		redeem: "兑换码",
		redeemPlaceholder: "输入兑换码",
		redeemBtn: "兑换",
		redeemed: "兑换成功，到账 {credits} credits，当前余额 {balance}",
		orders: "最近订单",
		ordersEmpty: "还没有订单",
		colSource: "来源",
		colRemaining: "剩余 / 总额",
		colExpiry: "到期",
		colTime: "时间",
		colKind: "类型",
		colAmount: "金额",
		colCredits: "额度",
		colStatus: "状态",
		colProvider: "支付方式",
		orderPending: "订单已创建（{amount}，{credits} credits），等待运营方确认收款后到账。",
		redirecting: "正在前往支付页面",
		tableLabelOrders: "最近订单",
		tableLabelGrants: "额度明细",
		meter: "剩余比例",
	},
	en: {
		subject: "Billing for",
		personal: "Personal",
		balance: "Available credits",
		balanceHint: "Unit: credits",
		usage: "Usage this month",
		usageHint: "{requests} requests, {input} in / {output} out tokens",
		overdraft: "Overdraft {n} credits",
		plan: "Current plan",
		planHint: "{credits} credits / month",
		renews: "Current period ends {date}",
		grants: "Credit breakdown",
		grantsEmpty: "No credits available right now",
		grantRemaining: "{remaining} / {amount}",
		plans: "Plans",
		plansEmpty: "No plans to subscribe to yet",
		subscribe: "Subscribe",
		currentPlan: "Current plan",
		subscribing: "Working",
		provider: "Payment method",
		providerDefault: "Default",
		topup: "Top up",
		topupHint: "Pick an amount or type your own ({min} to {max}). The Hub works out the price at the current rate.",
		custom: "Custom credits",
		topupBtn: "Top up {credits} credits",
		topupInvalid: "Credits must be a whole number from {min} to {max}",
		redeem: "Redeem code",
		redeemPlaceholder: "Enter a redeem code",
		redeemBtn: "Redeem",
		redeemed: "Redeemed. {credits} credits added, balance {balance}",
		orders: "Recent orders",
		ordersEmpty: "No orders yet",
		colSource: "Source",
		colRemaining: "Remaining / total",
		colExpiry: "Expires",
		colTime: "Time",
		colKind: "Type",
		colAmount: "Amount",
		colCredits: "Credits",
		colStatus: "Status",
		colProvider: "Payment",
		orderPending: "Order created ({amount}, {credits} credits). Credits arrive once the operator confirms payment.",
		redirecting: "Going to the payment page",
		tableLabelOrders: "Recent orders",
		tableLabelGrants: "Credit breakdown",
		meter: "Remaining share",
	},
});

/** Opens the payment page: a new tab inside the host app (member mode), the same tab on the Hub's own site. */
function openPayment(url: string, mode: "hub" | "member"): void {
	if (mode === "member") window.open(url, "_blank", "noopener,noreferrer");
	else window.location.assign(url);
}

function useCheckout(orgId: string | undefined, provider: string) {
	const { api, mode } = useTeam();
	const t = useT(M);
	const act = useAction();
	const [pendingNote, setPendingNote] = useState<string | undefined>(undefined);
	const [redirecting, setRedirecting] = useState(false);

	const start = async (input: Omit<CheckoutInput, "orgId" | "provider" | "successUrl" | "cancelUrl">): Promise<CheckoutResult | undefined> => {
		setPendingNote(undefined);
		const here = window.location.href;
		const result = await act.run(() => api.checkout({ ...input, ...(orgId ? { orgId } : {}), ...(provider ? { provider } : {}), successUrl: here, cancelUrl: here }));
		if (!result) return undefined;
		const url = checkoutRedirect(result.redirectUrl);
		if (url) {
			setRedirecting(true);
			openPayment(url, mode);
			if (mode === "member") setRedirecting(false);
		} else {
			setPendingNote(t("orderPending", { amount: formatMoney(result.amountCents, result.currency), credits: formatCredits(result.credits) }));
		}
		return result;
	};
	return { ...act, start, pendingNote, redirecting };
}

function SummaryCards({ s }: { s: BillingSummary }) {
	const t = useT(M);
	const l = useBillingLabels();
	const lang = usePrefs((p) => p.lang);
	const u = s.periodUsage;
	return (
		<div className="grid gap-4 @2xl:grid-cols-3">
			<Card>
				<Stat label={t("balance")} value={formatCredits(s.balance, lang)} hint={t("balanceHint")} />
			</Card>
			<Card>
				<Stat
					label={t("usage")}
					value={formatCredits(u.credits, lang)}
					hint={
						<>
							{t("usageHint", { requests: formatCredits(u.requests, lang), input: formatCreditsShort(u.inputTokens), output: formatCreditsShort(u.outputTokens) })}
							{u.overdraftCredits > 0 && <span className="ml-1.5 text-rose-400">{t("overdraft", { n: formatCredits(u.overdraftCredits, lang) })}</span>}
						</>
					}
				/>
			</Card>
			<Card>
				<Stat
					label={t("plan")}
					value={s.plan.name}
					hint={
						<>
							{t("planHint", { credits: formatCredits(s.plan.monthlyCredits, lang) })}
							{s.subscription && <span className="block">{t("renews", { date: shortDate(s.subscription.currentPeriodEnd, lang) })}</span>}
						</>
					}
				/>
				{s.plan.priceCents === 0 && <Badge tone="muted">{l("free")}</Badge>}
			</Card>
		</div>
	);
}

function GrantsCard({ s }: { s: BillingSummary }) {
	const t = useT(M);
	const l = useBillingLabels();
	const lang = usePrefs((p) => p.lang);
	return (
		<Card title={t("grants")}>
			{s.grants.length === 0 ? (
				<p className="text-sm text-ink-500">{t("grantsEmpty")}</p>
			) : (
				<Table label={t("tableLabelGrants")} head={[t("colSource"), t("colRemaining"), t("meter"), t("colExpiry")]}>
					{s.grants.map((g) => (
						<tr key={g.id}>
							<Td>{grantSourceLabel(l, g.source)}</Td>
							<Td className="tabular-nums">{t("grantRemaining", { remaining: formatCredits(g.remaining, lang), amount: formatCredits(g.amount, lang) })}</Td>
							<Td className="w-40">
								<Meter percent={percentOf(g.remaining, g.amount)} label={t("meter")} />
							</Td>
							<Td className="text-xs text-ink-400">{g.expiresAt ? shortDate(g.expiresAt, lang) : l("never")}</Td>
						</tr>
					))}
				</Table>
			)}
		</Card>
	);
}

function PlansCard({ s, orgId, provider }: { s: BillingSummary; orgId: string | undefined; provider: string }) {
	const { api } = useTeam();
	const t = useT(M);
	const l = useBillingLabels();
	const lang = usePrefs((p) => p.lang);
	const plans = useAsync(() => api.listBillingPlans(), [api]);
	const checkout = useCheckout(orgId, provider);
	const [busyPlan, setBusyPlan] = useState<string | undefined>(undefined);

	const subscribe = async (p: PlanView) => {
		setBusyPlan(p.id);
		await checkout.start({ kind: "subscription", planId: p.id });
		setBusyPlan(undefined);
	};

	return (
		<Card title={t("plans")}>
			{checkout.error && <Notice kind="error">{checkout.error}</Notice>}
			{checkout.pendingNote && <Notice kind="ok">{checkout.pendingNote}</Notice>}
			<AsyncView state={plans}>
				{(rows) =>
					rows.length === 0 ? (
						<p className="text-sm text-ink-500">{t("plansEmpty")}</p>
					) : (
						<ul className="mt-3 grid gap-3 @2xl:grid-cols-3">
							{rows.map((p) => {
								const current = p.id === s.plan.id;
								return (
									<li key={p.id} className={current ? "rounded-xl border border-ember-500/50 bg-ink-850 p-4" : "rounded-xl border border-ink-700 bg-ink-850/60 p-4"}>
										<div className="flex items-center justify-between gap-2">
											<h3 className="font-display text-base font-semibold">{p.name}</h3>
											<Badge>{periodLabel(l, p.period)}</Badge>
										</div>
										<p className="mt-2 font-display text-xl tabular-nums">{p.priceCents === 0 ? l("free") : formatMoney(p.priceCents, p.currency)}</p>
										<p className="mt-1 text-xs text-ink-400">{t("planHint", { credits: formatCredits(p.monthlyCredits, lang) })}</p>
										<div className="mt-3">
											{current ? (
												<Badge tone="ember">{t("currentPlan")}</Badge>
											) : p.priceCents > 0 ? (
												<Button variant="primary" disabled={checkout.busy || checkout.redirecting} onClick={() => void subscribe(p)}>
													{busyPlan === p.id ? t("subscribing") : t("subscribe")}
												</Button>
											) : null}
										</div>
									</li>
								);
							})}
						</ul>
					)
				}
			</AsyncView>
			{checkout.redirecting && <p role="status" className="mt-3 text-sm text-ink-400">{t("redirecting")}</p>}
		</Card>
	);
}

function TopupCard({ orgId, provider }: { orgId: string | undefined; provider: string }) {
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const checkout = useCheckout(orgId, provider);
	const [picked, setPicked] = useState<number | undefined>(TOPUP_PRESETS[1]);
	const [custom, setCustom] = useState("");
	const [invalid, setInvalid] = useState(false);

	const typed = custom.trim() !== "";
	const credits = typed ? parseCreditsInput(custom, MIN_TOPUP_CREDITS, MAX_TOPUP_CREDITS) : picked;
	const bounds = { min: formatCredits(MIN_TOPUP_CREDITS, lang), max: formatCredits(MAX_TOPUP_CREDITS, lang) };

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (credits === undefined) return setInvalid(true);
		setInvalid(false);
		await checkout.start({ kind: "topup", credits });
	};

	return (
		<Card title={t("topup")}>
			<form onSubmit={(e) => void submit(e)} className="space-y-3">
				<p className="text-sm text-ink-400">{t("topupHint", bounds)}</p>
				<div role="group" aria-label={t("topup")} className="flex flex-wrap gap-2">
					{TOPUP_PRESETS.map((n) => (
						<button
							key={n}
							type="button"
							aria-pressed={!typed && picked === n}
							onClick={() => {
								setPicked(n);
								setCustom("");
								setInvalid(false);
							}}
							className={
								!typed && picked === n
									? "rounded-lg border border-ember-500 bg-ember-500/12 px-3 py-1.5 text-sm font-medium tabular-nums text-ember-300 focus-visible:outline-2 focus-visible:outline-ember-400"
									: "rounded-lg border border-ink-700 px-3 py-1.5 text-sm tabular-nums text-ink-300 hover:border-ink-500 focus-visible:outline-2 focus-visible:outline-ember-400"
							}
						>
							{formatCreditsShort(n)}
						</button>
					))}
				</div>
				<div className="max-w-xs">
					<Field label={t("custom")}>
						<Input inputMode="numeric" value={custom} onChange={(e) => {
								setCustom(e.target.value);
								setInvalid(false);
							}} placeholder="50000" aria-invalid={invalid} />
					</Field>
				</div>
				{(invalid || (typed && credits === undefined)) && <Notice kind="error">{t("topupInvalid", bounds)}</Notice>}
				{checkout.error && <Notice kind="error">{checkout.error}</Notice>}
				{checkout.pendingNote && <Notice kind="ok">{checkout.pendingNote}</Notice>}
				{checkout.redirecting && (
					<p role="status" className="text-sm text-ink-400">
						{t("redirecting")}
					</p>
				)}
				<Button type="submit" variant="primary" disabled={checkout.busy || checkout.redirecting || credits === undefined}>
					<CreditCard className="size-4" aria-hidden /> {credits === undefined ? t("topup") : t("topupBtn", { credits: formatCredits(credits, lang) })}
				</Button>
			</form>
		</Card>
	);
}

function RedeemCard({ orgId, onRedeemed }: { orgId: string | undefined; onRedeemed: () => void }) {
	const { api } = useTeam();
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const act = useAction();
	const [code, setCode] = useState("");
	const [note, setNote] = useState<string | undefined>(undefined);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setNote(undefined);
		const r = await act.run(() => api.redeemCode({ code: code.trim(), ...(orgId ? { orgId } : {}) }));
		if (r) {
			setNote(t("redeemed", { credits: formatCredits(r.credits, lang), balance: formatCredits(r.balance, lang) }));
			setCode("");
			onRedeemed();
		}
	};

	return (
		<Card title={t("redeem")}>
			<form onSubmit={(e) => void submit(e)} className="space-y-3">
				<div className="flex flex-wrap items-end gap-2">
					<div className="min-w-0 flex-1 @2xl:max-w-sm">
						<Field label={t("redeem")}>
							<Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("redeemPlaceholder")} autoComplete="off" spellCheck={false} maxLength={100} className="font-mono" />
						</Field>
					</div>
					<Button type="submit" variant="primary" disabled={act.busy || code.trim() === ""}>
						<Gift className="size-4" aria-hidden /> {t("redeemBtn")}
					</Button>
				</div>
				{note && <Notice kind="ok">{note}</Notice>}
				{act.error && <Notice kind="error">{act.error}</Notice>}
			</form>
		</Card>
	);
}

function OrdersCard({ s }: { s: BillingSummary }) {
	const t = useT(M);
	const l = useBillingLabels();
	const lang = usePrefs((p) => p.lang);
	return (
		<Card title={t("orders")}>
			{s.recentOrders.length === 0 ? (
				<Empty icon={<ReceiptText className="size-5" />} title={t("ordersEmpty")} />
			) : (
				<Table label={t("tableLabelOrders")} head={[t("colTime"), t("colKind"), t("colAmount"), t("colCredits"), t("colProvider"), t("colStatus")]}>
					{s.recentOrders.map((o) => (
						<tr key={o.id}>
							<Td className="whitespace-nowrap text-xs text-ink-400">{shortDate(o.createdAt, lang)}</Td>
							<Td>{kindLabel(l, o.kind)}</Td>
							<Td className="tabular-nums">{formatMoney(o.amountCents, o.currency)}</Td>
							<Td className="tabular-nums">{formatCredits(o.credits, lang)}</Td>
							<Td className="text-xs text-ink-400">{o.provider}</Td>
							<Td>
								<OrderStatusBadge status={o.status} />
							</Td>
						</tr>
					))}
				</Table>
			)}
		</Card>
	);
}

export function BillingTab() {
	const { api, me } = useTeam();
	const t = useT(M);
	const orgs = managedOrgs(me);
	const [subject, setSubject] = useState("");
	const orgId = orgs.some((o) => o.id === subject) ? subject : undefined;
	const [provider, setProvider] = useState("");
	const summary = useAsync(() => api.getBillingSummary(orgId), [api, orgId]);

	return (
		<div className="space-y-4">
			{orgs.length > 0 && (
				<div className="max-w-xs">
					<Field label={t("subject")}>
						<Select
							value={orgId ?? ""}
							onChange={(e) => {
								setSubject(e.target.value);
								setProvider("");
							}}
						>
							<option value="">{t("personal")}</option>
							{orgs.map((o) => (
								<option key={o.id} value={o.id}>
									{o.name}
								</option>
							))}
						</Select>
					</Field>
				</div>
			)}
			<AsyncView state={summary}>
				{(s) => (
					<div className="space-y-4" key={s.subject.id}>
						<SummaryCards s={s} />
						{s.providers.length > 1 && (
							<div className="max-w-xs">
								<Field label={t("provider")}>
									<Select value={provider} onChange={(e) => setProvider(e.target.value)}>
										<option value="">{t("providerDefault")}</option>
										{s.providers.map((p) => (
											<option key={p} value={p}>
												{p}
											</option>
										))}
									</Select>
								</Field>
							</div>
						)}
						<GrantsCard s={s} />
						<PlansCard s={s} orgId={orgId} provider={provider} />
						<div className="grid gap-4 @3xl:grid-cols-2">
							<TopupCard orgId={orgId} provider={provider} />
							<RedeemCard orgId={orgId} onRedeemed={summary.reload} />
						</div>
						<OrdersCard s={s} />
					</div>
				)}
			</AsyncView>
		</div>
	);
}
