// Team transfers into an organization: what I asked for, and what is waiting for my decision as an organization admin.
import { ArrowRightLeft } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Empty, PageHeader } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { usePrefs } from "../../lib/prefs.ts";
import { useTeam } from "../context.tsx";
import { AsyncView, Body, Notice, shortDate, Table, Td, useAction, useAsync } from "../kit.tsx";
import { pendingDecisions, transferRows, transferTone } from "../logic/publicMode.ts";
import type { TransferStatus, TransferView } from "../types.ts";

const M = defineMessages({
	zh: {
		title: "团队转入",
		subtitle: "把个人团队转入企业的请求，以及等你处理的请求",
		team: "团队",
		org: "目标企业",
		direction: "方向",
		status: "状态",
		created: "发起时间",
		mine: "我发起的",
		incoming: "待我处理",
		other: "其他",
		accept: "接受",
		reject: "拒绝",
		cancel: "撤回",
		actionsFor: "对团队 {name} 转入请求的操作",
		none: "没有转入请求",
		noneHint: "个人团队的管理员可以在团队页把团队转入自己所在的企业。",
		pending: "待处理",
		accepted: "已接受",
		rejected: "已拒绝",
		canceled: "已撤回",
		waiting: "{n} 个请求等你处理",
		added: "已接受。{n} 位团队成员原先不在该企业，已作为成员加入。",
		acceptedPlain: "已接受，团队现在属于该企业。",
	},
	en: {
		title: "Team transfers",
		subtitle: "Requests to move personal teams into an organization, and the ones waiting for you",
		team: "Team",
		org: "Target organization",
		direction: "Direction",
		status: "Status",
		created: "Requested",
		mine: "Requested by me",
		incoming: "Waiting for me",
		other: "Other",
		accept: "Accept",
		reject: "Reject",
		cancel: "Withdraw",
		actionsFor: "Actions for the transfer of team {name}",
		none: "No transfer requests",
		noneHint: "A personal team's admin can move the team into an organization they belong to from the team page.",
		pending: "Pending",
		accepted: "Accepted",
		rejected: "Rejected",
		canceled: "Withdrawn",
		waiting: "{n} requests are waiting for you",
		added: "Accepted. {n} team members were not in the organization and were added as members.",
		acceptedPlain: "Accepted. The team now belongs to the organization.",
	},
});

export function TransferTag({ status }: { status: TransferStatus }) {
	const t = useT(M);
	const label: Record<TransferStatus, string> = { pending: t("pending"), accepted: t("accepted"), rejected: t("rejected"), canceled: t("canceled") };
	return <Badge tone={transferTone(status)}>{label[status]}</Badge>;
}

export function TransfersPage() {
	const { api, me, reloadMe } = useTeam();
	const t = useT(M);
	const lang = usePrefs((s) => s.lang);
	const list = useAsync(() => api.listTransfers(), [api]);
	const { busy, error, run } = useAction();
	const [result, setResult] = useState<string | undefined>(undefined);

	const decide = async (fn: () => Promise<TransferView>, accepted: boolean) => {
		setResult(undefined);
		const view = await run(fn);
		if (!view) return;
		if (accepted) {
			const n = view.addedMembers?.length ?? 0;
			setResult(n > 0 ? t("added", { n }) : t("acceptedPlain"));
			// The team changed owner: the Teams list and the viewer's memberships follow.
			void reloadMe();
		}
		list.reload();
	};

	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body>
				{result && (
					<div className="mb-3">
						<Notice kind="ok">{result}</Notice>
					</div>
				)}
				{error && (
					<div className="mb-3">
						<Notice kind="error">{error}</Notice>
					</div>
				)}
				<AsyncView state={list}>
					{(items) => {
						const rows = transferRows(items, me);
						if (rows.length === 0) {
							return (
								<Empty icon={<ArrowRightLeft className="size-5" />} title={t("none")}>
									{t("noneHint")}
								</Empty>
							);
						}
						const waiting = pendingDecisions(rows);
						return (
							<div className="space-y-3">
								{waiting > 0 && <p className="text-sm text-ember-300">{t("waiting", { n: waiting })}</p>}
								<Table label={t("title")} head={[t("team"), t("org"), t("direction"), t("status"), t("created"), ""]}>
									{rows.map(({ transfer: x, canDecide, canCancel }) => (
										<tr key={x.id}>
											<Td className="font-medium">{x.teamName}</Td>
											<Td>{x.toOrgName}</Td>
											<Td className="text-xs text-ink-400">{x.fromUserId === me.user.id ? t("mine") : canDecide ? t("incoming") : t("other")}</Td>
											<Td>
												<TransferTag status={x.status} />
											</Td>
											<Td className="text-xs text-ink-400">{shortDate(x.createdAt, lang)}</Td>
											<Td className="text-right">
												<div role="group" aria-label={t("actionsFor", { name: x.teamName })} className="flex justify-end gap-1">
													{canDecide && (
														<>
															<Button variant="primary" disabled={busy} onClick={() => void decide(() => api.acceptTransfer(x.id), true)}>
																{t("accept")}
															</Button>
															<Button variant="danger" disabled={busy} onClick={() => void decide(() => api.rejectTransfer(x.id), false)}>
																{t("reject")}
															</Button>
														</>
													)}
													{canCancel && (
														<Button variant="outline" disabled={busy} onClick={() => void decide(() => api.cancelTransfer(x.id), false)}>
															{t("cancel")}
														</Button>
													)}
												</div>
											</Td>
										</tr>
									))}
								</Table>
							</div>
						);
					}}
				</AsyncView>
			</Body>
		</>
	);
}
