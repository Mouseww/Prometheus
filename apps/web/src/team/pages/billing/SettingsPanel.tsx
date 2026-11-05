// Operator: top-up rate, currency and top-up credit expiry.
import { type FormEvent, useState } from "react";
import { Button, Field, Input } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Card, Notice, useAction, useAsync } from "../../kit.tsx";
import { formatCredits, parseCreditsInput } from "../../logic/billing.ts";
import type { BillingSettings } from "../../types.ts";

const M = defineMessages({
	zh: {
		intro: "决定用户充值时 1 个货币单位能换多少 credits，以及充值额度的有效期。",
		rate: "每分兑换额度",
		rateHint: "1 分钱可换多少 credits。默认 10，即 1 元 = 1000 credits。",
		perUnit: "即 1 {currency} = {n} credits",
		currency: "币种",
		currencyHint: "三位字母，例如 cny、usd",
		expiry: "充值额度有效天数",
		expiryHint: "留空表示永不过期，否则为 1 到 3650 的整数",
		saved: "已保存",
		invalid: "请检查输入：兑换比例为大于 0 的数字，币种为三位字母，有效天数为 1 到 3650 的整数或留空",
	},
	en: {
		intro: "How many credits one currency unit buys on top-up, and how long top-up credits last.",
		rate: "Credits per cent",
		rateHint: "Credits one cent buys. Default 10, so 1 unit = 1000 credits.",
		perUnit: "So 1 {currency} = {n} credits",
		currency: "Currency",
		currencyHint: "Three letters, e.g. cny, usd",
		expiry: "Top-up validity in days",
		expiryHint: "Empty means never expires; otherwise a whole number from 1 to 3650",
		saved: "Saved",
		invalid: "Check the input: a rate above 0, a three-letter currency, validity of 1 to 3650 days or empty",
	},
});

function SettingsForm({ initial, onSaved }: { initial: BillingSettings; onSaved: (s: BillingSettings) => void }) {
	const { api } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const lang = usePrefs((p) => p.lang);
	const [rate, setRate] = useState(String(initial.topupCreditsPerCent));
	const [currency, setCurrency] = useState(initial.currency);
	const [expiry, setExpiry] = useState(initial.topupExpiryDays === null ? "" : String(initial.topupExpiryDays));
	const [formError, setFormError] = useState<string | undefined>(undefined);
	const [note, setNote] = useState<string | undefined>(undefined);
	const { busy, error, run } = useAction();

	const rateN = /^\d+(\.\d+)?$/.test(rate.trim()) ? Number(rate.trim()) : Number.NaN;
	const rateOk = Number.isFinite(rateN) && rateN >= 0.001 && rateN <= 1_000_000;

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setNote(undefined);
		const cur = currency.trim().toLowerCase();
		const days = expiry.trim() === "" ? null : parseCreditsInput(expiry, 1, 3650);
		if (!rateOk || !/^[a-z]{3}$/.test(cur) || days === undefined) return setFormError(t("invalid"));
		setFormError(undefined);
		const saved = await run(() => api.putBillingSettings({ topupCreditsPerCent: rateN, currency: cur, topupExpiryDays: days }));
		if (saved) {
			setNote(t("saved"));
			onSaved(saved);
		}
	};

	return (
		<Card>
			<form onSubmit={(e) => void submit(e)} className="space-y-3">
				<div className="grid gap-3 @2xl:grid-cols-3">
					<Field label={t("rate")} hint={t("rateHint")}>
						<Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required />
					</Field>
					<Field label={t("currency")} hint={t("currencyHint")}>
						<Input value={currency} onChange={(e) => setCurrency(e.target.value)} required maxLength={3} className="uppercase" />
					</Field>
					<Field label={t("expiry")} hint={t("expiryHint")}>
						<Input inputMode="numeric" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
					</Field>
				</div>
				{rateOk && <p className="text-sm text-ink-400">{t("perUnit", { currency: currency.trim().toUpperCase() || "-", n: formatCredits(rateN * 100, lang) })}</p>}
				{(formError ?? error) && <Notice kind="error">{formError ?? error}</Notice>}
				{note && <Notice kind="ok">{note}</Notice>}
				<Button type="submit" variant="primary" disabled={busy}>
					{c("save")}
				</Button>
			</form>
		</Card>
	);
}

export function SettingsPanel() {
	const { api } = useTeam();
	const t = useT(M);
	const settings = useAsync(() => api.getBillingSettings(), [api]);
	return (
		<div className="space-y-4">
			<p className="max-w-3xl text-sm text-ink-400">{t("intro")}</p>
			<AsyncView state={settings}>{(s) => <SettingsForm initial={s} onSaved={settings.setData} />}</AsyncView>
		</div>
	);
}
