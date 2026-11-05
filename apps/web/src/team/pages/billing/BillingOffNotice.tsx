// Shown where billing UI would be when the Hub has billing off (private mode without HUB_BILLING=on).
import { Info } from "lucide-react";
import { defineMessages, useT } from "../../../lib/i18n.ts";

const M = defineMessages({
	zh: {
		title: "这个 Hub 没有启用计费",
		body: "设置 HUB_MODE=public 或 HUB_BILLING=on 后重启 Hub 即可启用。",
		bodyUser: "额度与账单在这个 Hub 上不可用。",
		bodyOps: "下面的套餐、价目和兑换码可以先配置，启用计费后才会生效。设置 HUB_MODE=public 或 HUB_BILLING=on 后重启 Hub 即可启用。",
	},
	en: {
		title: "Billing is not enabled on this Hub",
		body: "Set HUB_MODE=public or HUB_BILLING=on and restart the Hub to turn it on.",
		bodyUser: "Credits and billing are not available on this Hub.",
		bodyOps: "You can prepare plans, prices and redeem codes below; they only take effect once billing is on. Set HUB_MODE=public or HUB_BILLING=on and restart the Hub to turn it on.",
	},
});

export function BillingOffNotice({ audience }: { audience: "user" | "operator" }) {
	const t = useT(M);
	return (
		<div role="status" className="mb-4 flex items-start gap-2.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 text-sm text-ink-300">
			<Info className="mt-0.5 size-4 shrink-0 text-ember-400" aria-hidden />
			<div>
				<p className="font-medium text-ink-100">{t("title")}</p>
				<p className="text-ink-400">{audience === "operator" ? t("bodyOps") : t("bodyUser")}</p>
			</div>
		</div>
	);
}
