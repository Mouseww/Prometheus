// Operator: all orders with a status filter. Manual (offline) orders can be marked paid or refunded after a confirmation.
import { ReceiptText } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Empty, Field, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { useTeam } from "../../context.tsx";
import { AsyncView, Notice, shortDate, Table, Td, useAction, useAsync } from "../../kit.tsx";
import { formatCredits, formatMoney, manualOrderActions } from "../../logic/billing.ts";
import { ORDER_STATUSES, type OrderStatus, type OrderView } from "../../types.ts";
import { kindLabel, OrderStatusBadge, useBillingLabels } from "./labels.tsx";
import { ConfirmDialog } from "./parts.tsx";

const M = defineMessages({
	zh: {
		intro: "线下（manual）支付的订单需要在确认收款后手动标记为已支付，已支付的线下订单可以标记为已退款。其他支付方式由支付平台回调自动处理。",
		status: "状态",
		allStatuses: "全部状态",
		tableLabel: "订单列表",
		colTime: "时间",
		colSubject: "主体",
		colKind: "类型",
		colAmount: "金额",
		colCredits: "额度",
		colProvider: "支付方式",
		colStatus: "状态",
		actions: "操作",
		user: "用户",
		org: "企业",
		empty: "没有符合条件的订单",
		more: "加载更多",
		markPaid: "标记已支付",
		markRefunded: "标记已退款",
		paidTitle: "确认收款",
		paidBody: "确认已收到这笔订单的款项吗？确认后额度会立即到账（{credits} credits，{amount}）。",
		refundTitle: "确认退款",
		refundBody: "标记为已退款会收回这笔订单发放的额度（{credits} credits，{amount}）。此操作不可撤销。",
		done: "订单已更新",
	},
	en: {
		intro: "Offline (manual) orders must be marked paid by hand once payment is received; a paid manual order can be marked refunded. Other providers are handled by their callbacks.",
		status: "Status",
		allStatuses: "All statuses",
		tableLabel: "Orders",
		colTime: "Time",
		colSubject: "Subject",
		colKind: "Type",
		colAmount: "Amount",
		colCredits: "Credits",
		colProvider: "Payment",
		colStatus: "Status",
		actions: "Actions",
		user: "User",
		org: "Org",
		empty: "No orders match",
		more: "Load more",
		markPaid: "Mark paid",
		markRefunded: "Mark refunded",
		paidTitle: "Confirm payment",
		paidBody: "Confirm that payment for this order has been received? The credits arrive immediately ({credits} credits, {amount}).",
		refundTitle: "Confirm refund",
		refundBody: "Marking it refunded takes back the credits this order issued ({credits} credits, {amount}). This cannot be undone.",
		done: "Order updated",
	},
});

type Pending = { order: OrderView; action: "paid" | "refunded" };

function OrdersTable({ status }: { status: OrderStatus | "" }) {
	const { api } = useTeam();
	const t = useT(M);
	const l = useBillingLabels();
	const lang = usePrefs((p) => p.lang);
	const first = useAsync(() => api.listOrders({ ...(status ? { status } : {}), limit: 50 }), [api, status]);
	const [extra, setExtra] = useState<OrderView[]>([]);
	const [cursor, setCursor] = useState<string | null | undefined>(undefined);
	const more = useAction();
	const [pending, setPending] = useState<Pending | undefined>(undefined);
	const [note, setNote] = useState<string | undefined>(undefined);
	const act = useAction();

	const next = cursor === undefined ? (first.data?.nextBefore ?? null) : cursor;

	const loadMore = async () => {
		if (!next) return;
		const page = await more.run(() => api.listOrders({ ...(status ? { status } : {}), before: next, limit: 50 }));
		if (page) {
			setExtra((cur) => [...cur, ...page.items]);
			setCursor(page.nextBefore);
		}
	};

	const confirm = async () => {
		if (!pending) return;
		const { order, action } = pending;
		const ok = await act.run(async () => {
			if (action === "paid") await api.markOrderPaid(order.id);
			else await api.markOrderRefunded(order.id);
			return true;
		});
		if (ok) {
			setPending(undefined);
			setNote(t("done"));
			setExtra([]);
			setCursor(undefined);
			first.reload();
		}
	};

	return (
		<>
			{note && <Notice kind="ok">{note}</Notice>}
			<AsyncView state={first}>
				{(page) => {
					const rows = [...page.items, ...extra];
					if (rows.length === 0) return <Empty icon={<ReceiptText className="size-5" />} title={t("empty")} />;
					return (
						<div className="space-y-3">
							<Table label={t("tableLabel")} head={[t("colTime"), t("colSubject"), t("colKind"), t("colAmount"), t("colCredits"), t("colProvider"), t("colStatus"), t("actions")]}>
								{rows.map((o) => {
									const can = manualOrderActions(o);
									return (
										<tr key={o.id}>
											<Td className="whitespace-nowrap text-xs text-ink-400">{shortDate(o.createdAt, lang)}</Td>
											<Td className="max-w-40 truncate text-xs">
												<Badge tone={o.subjectType === "org" ? "sky" : "muted"}>{o.subjectType === "org" ? t("org") : t("user")}</Badge> <span className="font-mono text-ink-400">{o.subjectId}</span>
											</Td>
											<Td>{kindLabel(l, o.kind)}</Td>
											<Td className="tabular-nums">{formatMoney(o.amountCents, o.currency)}</Td>
											<Td className="tabular-nums">{formatCredits(o.credits, lang)}</Td>
											<Td className="text-xs text-ink-400">{o.provider}</Td>
											<Td>
												<OrderStatusBadge status={o.status} />
											</Td>
											<Td>
												<div className="flex flex-wrap items-center gap-1.5">
													{can.markPaid && (
														<Button
															variant="outline"
															onClick={() => {
																act.clearError();
																setPending({ order: o, action: "paid" });
															}}
														>
															{t("markPaid")}
														</Button>
													)}
													{can.markRefunded && (
														<Button
															variant="danger"
															onClick={() => {
																act.clearError();
																setPending({ order: o, action: "refunded" });
															}}
														>
															{t("markRefunded")}
														</Button>
													)}
												</div>
											</Td>
										</tr>
									);
								})}
							</Table>
							{more.error && <Notice kind="error">{more.error}</Notice>}
							{next && (
								<Button variant="ghost" onClick={() => void loadMore()} disabled={more.busy}>
									{t("more")}
								</Button>
							)}
						</div>
					);
				}}
			</AsyncView>
			{pending && (
				<ConfirmDialog
					title={pending.action === "paid" ? t("paidTitle") : t("refundTitle")}
					body={<p>{t(pending.action === "paid" ? "paidBody" : "refundBody", { credits: formatCredits(pending.order.credits, lang), amount: formatMoney(pending.order.amountCents, pending.order.currency) })}</p>}
					confirmLabel={pending.action === "paid" ? t("markPaid") : t("markRefunded")}
					busy={act.busy}
					error={act.error}
					onConfirm={() => void confirm()}
					onClose={() => setPending(undefined)}
				/>
			)}
		</>
	);
}

export function OrdersPanel() {
	const t = useT(M);
	const l = useBillingLabels();
	const [status, setStatus] = useState<OrderStatus | "">("");
	return (
		<div className="space-y-4">
			<p className="max-w-3xl text-sm text-ink-400">{t("intro")}</p>
			<div className="max-w-xs">
				<Field label={t("status")}>
					<Select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus | "")}>
						<option value="">{t("allStatuses")}</option>
						{ORDER_STATUSES.map((s) => (
							<option key={s} value={s}>
								{l(s)}
							</option>
						))}
					</Select>
				</Field>
			</div>
			<OrdersTable key={status} status={status} />
		</div>
	);
}
