// Operator: redeem codes. The plaintext codes are in the generate reply only; they are shown once, with copy and .txt download.
import { Copy, Download, Gift } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, Empty, Field, Input, Textarea } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { useTeam } from "../../context.tsx";
import { AsyncView, Card, Notice, shortDate, Table, Td, useAction, useAsync } from "../../kit.tsx";
import { codesToText, formatCredits, localInputToIso, parseCreditsInput } from "../../logic/billing.ts";
import type { GeneratedCodes } from "../../types.ts";
import { ConfirmDialog } from "./parts.tsx";

const M = defineMessages({
	zh: {
		intro: "兑换码可以给个人或企业充入额度。Hub 只保存兑换码的哈希，明文只在生成后显示这一次。",
		formTitle: "生成兑换码",
		credits: "每个码的额度",
		creditsHint: "整数，单位 credits",
		maxUses: "可用次数",
		maxUsesHint: "每个码最多被兑换几次",
		count: "生成数量",
		countHint: "1 到 1000",
		expires: "过期时间",
		expiresHint: "可留空，表示不过期",
		generate: "生成",
		invalid: "请检查输入：额度、可用次数和数量需要是正整数，数量不超过 1000",
		resultTitle: "新生成的兑换码",
		resultWarn: "这些兑换码只显示这一次，离开后无法再次查看。请现在复制或下载保存。",
		copy: "复制",
		copied: "已复制",
		copyFailed: "复制失败，请手动选中文本复制或下载",
		download: "下载 .txt",
		done: "我已保存，关闭",
		closeTitle: "关闭兑换码",
		closeBody: "关闭后无法再次查看这些兑换码明文。确定你已经复制或下载保存了吗？",
		closeConfirm: "确定关闭",
		listTitle: "已生成的兑换码",
		tableLabel: "兑换码列表",
		colHint: "尾号",
		colCredits: "额度",
		colUsed: "已用 / 可用",
		colExpires: "过期时间",
		colCreated: "创建时间",
		empty: "还没有兑换码",
		never: "不过期",
		summary: "已生成 {n} 个兑换码，每个 {credits} credits，可用 {uses} 次",
	},
	en: {
		intro: "Redeem codes add credits to a person or organization. The Hub stores only a hash of each code; the plaintext is shown once, right after generating.",
		formTitle: "Generate redeem codes",
		credits: "Credits per code",
		creditsHint: "Whole number, in credits",
		maxUses: "Uses per code",
		maxUsesHint: "How many times one code can be redeemed",
		count: "How many codes",
		countHint: "1 to 1000",
		expires: "Expires at",
		expiresHint: "Leave empty for no expiry",
		generate: "Generate",
		invalid: "Check the input: credits, uses and count must be positive whole numbers, count at most 1000",
		resultTitle: "New redeem codes",
		resultWarn: "These codes are shown only once and cannot be viewed again after you leave. Copy or download them now.",
		copy: "Copy",
		copied: "Copied",
		copyFailed: "Copy failed. Select the text by hand or download it.",
		download: "Download .txt",
		done: "I saved them, close",
		closeTitle: "Close the codes",
		closeBody: "After closing, the plaintext codes cannot be seen again. Have you copied or downloaded them?",
		closeConfirm: "Close for good",
		listTitle: "Generated codes",
		tableLabel: "Redeem codes",
		colHint: "Ends with",
		colCredits: "Credits",
		colUsed: "Used / allowed",
		colExpires: "Expires",
		colCreated: "Created",
		empty: "No redeem codes yet",
		never: "No expiry",
		summary: "{n} codes generated, {credits} credits each, {uses} uses each",
	},
});

/** Saves text as a .txt file through a temporary object URL. */
function downloadText(filename: string, text: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function OneTimeCodes({ result, onClose }: { result: GeneratedCodes; onClose: () => void }) {
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const text = codesToText(result.codes);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setCopyError(false);
		} catch {
			setCopyError(true);
		}
	};

	return (
		<Card title={t("resultTitle")} className="border-ember-500/50">
			<div className="space-y-3">
				<Notice kind="error">{t("resultWarn")}</Notice>
				<p className="text-sm text-ink-300">{t("summary", { n: result.codes.length, credits: formatCredits(result.credits, lang), uses: result.maxUses })}</p>
				<Textarea readOnly value={text} rows={Math.min(12, result.codes.length + 1)} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" aria-label={t("resultTitle")} />
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="outline" onClick={() => void copy()}>
						<Copy className="size-4" aria-hidden /> {copied ? t("copied") : t("copy")}
					</Button>
					<Button variant="outline" onClick={() => downloadText(`redeem-codes-${new Date().toISOString().slice(0, 10)}.txt`, text)}>
						<Download className="size-4" aria-hidden /> {t("download")}
					</Button>
					<Button variant="primary" onClick={() => setConfirming(true)}>
						{t("done")}
					</Button>
					{copyError && <span className="text-xs text-rose-400">{t("copyFailed")}</span>}
				</div>
			</div>
			{confirming && <ConfirmDialog title={t("closeTitle")} body={<p>{t("closeBody")}</p>} confirmLabel={t("closeConfirm")} onConfirm={onClose} onClose={() => setConfirming(false)} />}
		</Card>
	);
}

export function CodesPanel() {
	const { api } = useTeam();
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const list = useAsync(() => api.listRedeemCodes(), [api]);
	const gen = useAction();
	const [credits, setCredits] = useState("");
	const [maxUses, setMaxUses] = useState("1");
	const [count, setCount] = useState("10");
	const [expires, setExpires] = useState("");
	const [formError, setFormError] = useState<string | undefined>(undefined);
	const [result, setResult] = useState<GeneratedCodes | undefined>(undefined);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const creditsN = parseCreditsInput(credits);
		const usesN = parseCreditsInput(maxUses, 1, 1_000_000);
		const countN = parseCreditsInput(count, 1, 1000);
		if (creditsN === undefined || usesN === undefined || countN === undefined) return setFormError(t("invalid"));
		setFormError(undefined);
		const r = await gen.run(() => api.generateRedeemCodes({ count: countN, credits: creditsN, maxUses: usesN, expiresAt: localInputToIso(expires) }));
		if (r) {
			setResult(r);
			list.reload();
		}
	};

	return (
		<div className="space-y-4">
			<p className="max-w-3xl text-sm text-ink-400">{t("intro")}</p>
			{result && <OneTimeCodes result={result} onClose={() => setResult(undefined)} />}
			<Card title={t("formTitle")}>
				<form onSubmit={(e) => void submit(e)} className="space-y-3">
					<div className="grid gap-3 @2xl:grid-cols-4">
						<Field label={t("credits")} hint={t("creditsHint")}>
							<Input inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value)} required />
						</Field>
						<Field label={t("maxUses")} hint={t("maxUsesHint")}>
							<Input inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} required />
						</Field>
						<Field label={t("count")} hint={t("countHint")}>
							<Input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} required />
						</Field>
						<Field label={t("expires")} hint={t("expiresHint")}>
							<Input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
						</Field>
					</div>
					{(formError ?? gen.error) && <Notice kind="error">{formError ?? gen.error}</Notice>}
					<Button type="submit" variant="primary" disabled={gen.busy}>
						{t("generate")}
					</Button>
				</form>
			</Card>
			<h2 className="font-display text-sm font-semibold tracking-wide text-ink-200">{t("listTitle")}</h2>
			<AsyncView state={list}>
				{(rows) =>
					rows.length === 0 ? (
						<Empty icon={<Gift className="size-5" />} title={t("empty")} />
					) : (
						<Table label={t("tableLabel")} head={[t("colHint"), t("colCredits"), t("colUsed"), t("colExpires"), t("colCreated")]}>
							{rows.map((r) => (
								<tr key={r.id}>
									<Td className="font-mono text-xs">…{r.hint}</Td>
									<Td className="tabular-nums">{formatCredits(r.credits, lang)}</Td>
									<Td className="tabular-nums">
										{r.usedCount} / {r.maxUses}
									</Td>
									<Td className="text-xs text-ink-400">{r.expiresAt ? shortDate(r.expiresAt, lang) : t("never")}</Td>
									<Td className="text-xs text-ink-400">{shortDate(r.createdAt, lang)}</Td>
								</tr>
							))}
						</Table>
					)
				}
			</AsyncView>
		</div>
	);
}
