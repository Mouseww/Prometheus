// 个人设置: my models (BYOK) and credits and billing. The billing tab only exists when the Hub has billing on.
import { useState } from "react";
import { PageHeader } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useTeam } from "../../context.tsx";
import { Body, Tabs } from "../../kit.tsx";
import { BillingTab } from "./BillingTab.tsx";
import { MyModelsTab } from "./MyModelsTab.tsx";

const M = defineMessages({
	zh: { title: "个人设置", subtitle: "管理你自己的模型密钥，查看额度与账单。", models: "我的模型", billing: "额度与账单", tabs: "个人设置分区" },
	en: { title: "My settings", subtitle: "Manage your own model keys, and see credits and billing.", models: "My models", billing: "Credits and billing", tabs: "Settings sections" },
});

type TabId = "models" | "billing";

export function MySettingsPage() {
	const { billingEnabled } = useTeam();
	const t = useT(M);
	const [tab, setTab] = useState<TabId>("models");
	const tabs: { id: TabId; label: string }[] = [{ id: "models", label: t("models") }, ...(billingEnabled ? [{ id: "billing" as const, label: t("billing") }] : [])];
	const active: TabId = tab === "billing" && !billingEnabled ? "models" : tab;

	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body>
				<Tabs tabs={tabs} value={active} onChange={setTab} label={t("tabs")} />
				{active === "models" ? <MyModelsTab /> : <BillingTab />}
			</Body>
		</>
	);
}
