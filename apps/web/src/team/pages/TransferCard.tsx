// On a personal team's page: ask to move the team into an organization, or see and withdraw the pending request.
import { ArrowRightLeft } from "lucide-react";
import { useState } from "react";
import { Button, Field, Select } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { useTeam } from "../context.tsx";
import { AsyncView, Card, ConfirmButton, Notice, useAction, useAsync } from "../kit.tsx";
import { pendingTransferFor, transferTargets } from "../logic/publicMode.ts";
import type { TeamView } from "../types.ts";

const M = defineMessages({
	zh: {
		title: "转入企业",
		body: "把这个个人团队转入你所在的企业。企业管理员接受后，团队、工作区和历史记录都归企业所有；不在企业里的团队成员会作为成员加入。",
		org: "目标企业",
		request: "发起转入",
		confirm: "确认发起",
		pending: "已向 {org} 发起转入请求，等待企业管理员处理。",
		withdraw: "撤回请求",
		sent: "转入请求已发送，等待企业管理员处理。",
	},
	en: {
		title: "Move into an organization",
		body: "Move this personal team into an organization you belong to. Once an organization admin accepts, the team, its workspaces and history belong to the organization, and team members who are not in it are added as members.",
		org: "Target organization",
		request: "Request transfer",
		confirm: "Confirm request",
		pending: "A transfer request to {org} is waiting for an organization admin.",
		withdraw: "Withdraw request",
		sent: "Transfer request sent. It waits for an organization admin.",
	},
});

export function TransferCard({ team }: { team: TeamView }) {
	const { api, me } = useTeam();
	const t = useT(M);
	const transfers = useAsync(() => api.listTransfers(), [api]);
	const targets = transferTargets(me);
	const [picked, setPicked] = useState("");
	const orgId = targets.some((o) => o.id === picked) ? picked : (targets[0]?.id ?? "");
	const [sent, setSent] = useState(false);
	const { busy, error, run } = useAction();

	return (
		<Card title={t("title")} className="mb-4">
			<AsyncView state={transfers}>
				{(list) => {
					const pending = pendingTransferFor(list, team.id);
					return (
						<div className="space-y-3">
							<p className="flex items-start gap-2 text-sm text-ink-400">
								<ArrowRightLeft className="mt-0.5 size-4 shrink-0 text-ember-400" aria-hidden />
								{t("body")}
							</p>
							{pending ? (
								<div className="flex flex-wrap items-center gap-3">
									<Notice kind="ok">{t("pending", { org: pending.toOrgName })}</Notice>
									{pending.fromUserId === me.user.id && (
										<Button variant="outline" disabled={busy} onClick={() => void run(() => api.cancelTransfer(pending.id)).then((v) => v && transfers.reload())}>
											{t("withdraw")}
										</Button>
									)}
								</div>
							) : (
								<div className="flex flex-wrap items-end gap-3">
									<Field label={t("org")}>
										<Select value={orgId} onChange={(e) => setPicked(e.target.value)} className="w-56">
											{targets.map((o) => (
												<option key={o.id} value={o.id}>
													{o.name}
												</option>
											))}
										</Select>
									</Field>
									<ConfirmButton
										label={t("request")}
										confirmLabel={t("confirm")}
										variant="danger"
										disabled={busy || !orgId}
										onConfirm={() =>
											void run(() => api.requestTeamTransfer(team.id, orgId)).then((v) => {
												if (!v) return;
												setSent(true);
												transfers.reload();
											})
										}
									/>
								</div>
							)}
							{sent && !pending && <Notice kind="ok">{t("sent")}</Notice>}
							{error && <Notice kind="error">{error}</Notice>}
						</div>
					);
				}}
			</AsyncView>
		</Card>
	);
}
