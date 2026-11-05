// Shared labels of orders, grants and plan periods for the personal billing tab and the operator console.
import { Badge } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { orderStatusTone } from "../../logic/billing.ts";
import type { OrderKind, OrderStatus, PlanPeriod } from "../../types.ts";

const L = defineMessages({
	zh: {
		pending: "待支付",
		paid: "已支付",
		failed: "失败",
		refunded: "已退款",
		canceled: "已取消",
		topup: "充值",
		subscription: "订阅",
		month: "每月",
		year: "每年",
		free: "免费",
		personal: "个人",
		org: "企业",
		srcFree: "免费额度",
		srcPlan: "套餐额度",
		srcTopup: "充值",
		srcRedeem: "兑换码",
		srcAdmin: "运营发放",
		never: "永不过期",
	},
	en: {
		pending: "Pending",
		paid: "Paid",
		failed: "Failed",
		refunded: "Refunded",
		canceled: "Canceled",
		topup: "Top-up",
		subscription: "Subscription",
		month: "Monthly",
		year: "Yearly",
		free: "Free",
		personal: "Personal",
		org: "Organization",
		srcFree: "Free credits",
		srcPlan: "Plan credits",
		srcTopup: "Top-up",
		srcRedeem: "Redeem code",
		srcAdmin: "Operator grant",
		never: "No expiry",
	},
});

export const useBillingLabels = () => useT(L);
export type BillingLabelT = ReturnType<typeof useBillingLabels>;

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
	const t = useBillingLabels();
	return <Badge tone={orderStatusTone(status)}>{t(status)}</Badge>;
}

export const kindLabel = (t: BillingLabelT, kind: OrderKind): string => t(kind);
export const periodLabel = (t: BillingLabelT, period: PlanPeriod): string => t(period);

/** Source of a credit grant; unknown sources show as they come. */
export function grantSourceLabel(t: BillingLabelT, source: string): string {
	switch (source) {
		case "free":
			return t("srcFree");
		case "plan":
		case "subscription":
			return t("srcPlan");
		case "topup":
			return t("srcTopup");
		case "redeem":
			return t("srcRedeem");
		case "admin":
			return t("srcAdmin");
		default:
			return source;
	}
}
