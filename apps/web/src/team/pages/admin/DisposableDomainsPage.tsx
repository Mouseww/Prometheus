// Operator: email domains that cannot register (throwaway mail services). Used by the public-mode registration guard.
import { MailX, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, Empty, Field, Input, PageHeader } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { AsyncView, Body, Card, ConfirmButton, ErrorBox, Notice, shortDate, Table, Td, useAction, useAsync } from "../../kit.tsx";
import { normalizeDomainInput } from "../../logic/publicMode.ts";

const M = defineMessages({
	zh: {
		title: "邮箱黑名单",
		subtitle: "这些域名的邮箱不能注册，用来挡住一次性邮箱",
		add: "添加域名",
		domain: "域名",
		domainHint: "例如 mailinator.com，开头的 @ 会被忽略",
		invalid: "这不像一个有效的域名",
		added: "添加时间",
		none: "黑名单是空的",
		noneHint: "添加后，使用这些域名的邮箱无法注册。",
		remove: "移除",
		removeNamed: "移除 {domain}",
		count: "共 {n} 个",
		operatorOnly: "只有运营者可以管理邮箱黑名单。",
	},
	en: {
		title: "Blocked email domains",
		subtitle: "Emails on these domains cannot register. Use it against throwaway mail services.",
		add: "Add domain",
		domain: "Domain",
		domainHint: "For example mailinator.com. A leading @ is ignored.",
		invalid: "That does not look like a valid domain",
		added: "Added",
		none: "The list is empty",
		noneHint: "Emails on listed domains cannot register.",
		remove: "Remove",
		removeNamed: "Remove {domain}",
		count: "{n} domains",
		operatorOnly: "Only the operator can manage blocked email domains.",
	},
});

export function DisposableDomainsPage() {
	const { api, me } = useTeam();
	const t = useT(M);
	const lang = usePrefs((s) => s.lang);
	const operator = isOperator(me);
	const list = useAsync(() => (operator ? api.listDisposableDomains() : Promise.resolve([])), [api, operator]);
	const [domain, setDomain] = useState("");
	const [invalid, setInvalid] = useState(false);
	const { busy, error, run } = useAction();

	if (!operator) return <ErrorBox message={t("operatorOnly")} />;

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const normalized = normalizeDomainInput(domain);
		setInvalid(normalized === undefined);
		if (!normalized) return;
		if (await run(() => api.addDisposableDomain(normalized))) {
			setDomain("");
			list.reload();
		}
	};

	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body className="space-y-4">
				<Card title={t("add")}>
					<form onSubmit={submit} className="grid gap-3 @xl:grid-cols-[1fr_auto] @xl:items-end">
						<Field label={t("domain")} hint={t("domainHint")}>
							<Input
								value={domain}
								onChange={(e) => {
									setInvalid(false);
									setDomain(e.target.value);
								}}
								required
								maxLength={253}
								autoComplete="off"
								placeholder="mailinator.com"
								aria-invalid={invalid}
								className="font-mono"
							/>
						</Field>
						<Button type="submit" variant="primary" disabled={busy || !domain.trim()}>
							<Plus className="size-4" aria-hidden /> {t("add")}
						</Button>
						{invalid && (
							<div className="@xl:col-span-2">
								<Notice kind="error">{t("invalid")}</Notice>
							</div>
						)}
						{error && (
							<div className="@xl:col-span-2">
								<Notice kind="error">{error}</Notice>
							</div>
						)}
					</form>
				</Card>
				<AsyncView state={list}>
					{(rows) =>
						rows.length === 0 ? (
							<Empty icon={<MailX className="size-5" />} title={t("none")}>
								{t("noneHint")}
							</Empty>
						) : (
							<div className="space-y-2">
								<p className="text-xs text-ink-500">{t("count", { n: rows.length })}</p>
								<Table label={t("title")} head={[t("domain"), t("added"), ""]}>
									{rows.map((d) => (
										<tr key={d.domain}>
											<Td className="font-mono">{d.domain}</Td>
											<Td className="text-xs text-ink-400">{shortDate(d.createdAt, lang)}</Td>
											<Td className="text-right">
												<span role="group" aria-label={t("removeNamed", { domain: d.domain })}>
													<ConfirmButton label={t("remove")} disabled={busy} onConfirm={() => void run(async () => (await api.removeDisposableDomain(d.domain), true)).then((ok) => ok && list.reload())} />
												</span>
											</Td>
										</tr>
									))}
								</Table>
							</div>
						)
					}
				</AsyncView>
			</Body>
		</>
	);
}
