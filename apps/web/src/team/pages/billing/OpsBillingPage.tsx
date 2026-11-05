// 运营: the operator console for plans, prices, orders, redeem codes, billing settings, credit grants and the BYOK switch.
// These routes work whether or not user billing is on, so they are not gated by the billing probe.
import { useState } from "react";
import { PageHeader } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { Body, ErrorBox, Tabs } from "../../kit.tsx";
import { ByokPanel } from "./ByokPanel.tsx";
import { CodesPanel } from "./CodesPanel.tsx";
import { GrantPanel } from "./GrantPanel.tsx";
import { OrdersPanel } from "./OrdersPanel.tsx";
import { PlansPanel } from "./PlansPanel.tsx";
import { PricesPanel } from "./PricesPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";

const M = defineMessages({
	zh: {
		title: "运营",
		subtitle: "套餐、价目、订单、兑换码、计费设置、额度发放和自带模型开关。",
		plans: "套餐",
		prices: "价目",
		orders: "订单",
		codes: "兑换码",
		settings: "计费设置",
		grant: "发放额度",
		byok: "自带模型开关",
		tabs: "运营分区",
		operatorOnly: "只有平台运营者可以使用此页面",
	},
	en: {
		title: "Operations",
		subtitle: "Plans, prices, orders, redeem codes, billing settings, credit grants and the bring-your-own-model switch.",
		plans: "Plans",
		prices: "Prices",
		orders: "Orders",
		codes: "Redeem codes",
		settings: "Billing settings",
		grant: "Grant credits",
		byok: "Own-model switch",
		tabs: "Operations sections",
		operatorOnly: "Only platform operators can use this page",
	},
});

type TabId = "plans" | "prices" | "orders" | "codes" | "settings" | "grant" | "byok";

export function OpsBillingPage() {
	const { me } = useTeam();
	const t = useT(M);
	const [tab, setTab] = useState<TabId>("plans");
	if (!isOperator(me)) return <ErrorBox message={t("operatorOnly")} />;
	const tabs: { id: TabId; label: string }[] = [
		{ id: "plans", label: t("plans") },
		{ id: "prices", label: t("prices") },
		{ id: "orders", label: t("orders") },
		{ id: "codes", label: t("codes") },
		{ id: "settings", label: t("settings") },
		{ id: "grant", label: t("grant") },
		{ id: "byok", label: t("byok") },
	];
	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body>
				<Tabs tabs={tabs} value={tab} onChange={setTab} label={t("tabs")} />
				{tab === "plans" && <PlansPanel />}
				{tab === "prices" && <PricesPanel />}
				{tab === "orders" && <OrdersPanel />}
				{tab === "codes" && <CodesPanel />}
				{tab === "settings" && <SettingsPanel />}
				{tab === "grant" && <GrantPanel />}
				{tab === "byok" && <ByokPanel />}
			</Body>
		</>
	);
}
