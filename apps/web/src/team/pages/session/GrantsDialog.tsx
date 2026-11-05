// Owner-only: who may act on this session (prompt, answer requests, abort) through the Hub relay.
import { UserMinus, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Dialog, Select } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useTeam } from "../../context.tsx";
import { AsyncView, Notice, useAction, useAsync } from "../../kit.tsx";
import type { SessionDetail } from "../../types.ts";

const M = defineMessages({
	zh: {
		title: "授权",
		intro: "被授权的成员可以向这个会话发消息、处理权限请求并中断它。随时可以撤销。",
		current: "已授权",
		none: "还没有授权给任何人",
		pick: "选择团队成员",
		choose: "选择成员",
		grant: "授权",
		revoke: "撤销 {name}",
		noCandidates: "没有可以授权的其他成员",
		close: "完成",
	},
	en: {
		title: "Grant access",
		intro: "Granted members can send messages to this session, answer permission requests and abort it. You can revoke at any time.",
		current: "Granted",
		none: "Nobody is granted yet",
		pick: "Pick a team member",
		choose: "Choose a member",
		grant: "Grant",
		revoke: "Revoke {name}",
		noCandidates: "There are no other members to grant",
		close: "Done",
	},
});

export function GrantsDialog({ session, onClose, onChanged }: { session: SessionDetail; onClose: () => void; onChanged: () => void }) {
	const { api, me } = useTeam();
	const t = useT(M);
	const [pick, setPick] = useState("");
	const action = useAction();

	const data = useAsync(async () => {
		const ws = await api.getWorkspace(session.workspaceId);
		const [members, grants] = await Promise.all([api.listTeamMembers(ws.teamId), api.listSessionGrants(session.id)]);
		return { members, grants };
	}, [api, session.id, session.workspaceId]);

	const names = useMemo(() => new Map((data.data?.members ?? []).map((m) => [m.userId, m.displayName || m.email])), [data.data?.members]);
	const candidates = (data.data?.members ?? []).filter((m) => m.userId !== session.ownerUserId && m.userId !== me.user.id && !data.data?.grants.includes(m.userId));

	const change = async (fn: () => Promise<unknown>) => {
		const r = await action.run(async () => {
			await fn();
			return true;
		});
		if (r) {
			setPick("");
			data.reload();
			onChanged();
		}
	};

	return (
		<Dialog title={t("title")} onClose={onClose}>
			<p className="text-sm text-ink-300">{t("intro")}</p>
			<AsyncView state={data}>
				{({ grants }) => (
					<div className="space-y-4">
						<section aria-label={t("current")}>
							<h3 className="mb-1.5 text-xs font-medium tracking-wide text-ink-400">{t("current")}</h3>
							{grants.length === 0 ? (
								<p className="text-sm text-ink-500">{t("none")}</p>
							) : (
								<ul className="divide-y divide-ink-800 rounded-lg border border-ink-700">
									{grants.map((id) => (
										<li key={id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
											<span className="min-w-0 truncate">{names.get(id) ?? id}</span>
											<Button variant="ghost" disabled={action.busy} aria-label={t("revoke", { name: names.get(id) ?? id })} onClick={() => void change(() => api.revokeSessionGrant(session.id, id))}>
												<UserMinus className="size-4" aria-hidden />
											</Button>
										</li>
									))}
								</ul>
							)}
						</section>
						{candidates.length === 0 ? (
							<p className="text-sm text-ink-500">{t("noCandidates")}</p>
						) : (
							<div className="flex items-center gap-2">
								<Select aria-label={t("pick")} value={pick} onChange={(e) => setPick(e.target.value)} className="min-w-0 flex-1 py-1.5">
									<option value="">{t("choose")}</option>
									{candidates.map((m) => (
										<option key={m.userId} value={m.userId}>
											{m.displayName || m.email}
										</option>
									))}
								</Select>
								<Button variant="primary" disabled={!pick || action.busy} onClick={() => void change(() => api.grantSession(session.id, pick))}>
									<UserPlus className="size-4" aria-hidden /> {t("grant")}
								</Button>
							</div>
						)}
					</div>
				)}
			</AsyncView>
			{action.error && <Notice kind="error">{action.error}</Notice>}
			<div className="flex justify-end">
				<Button variant="ghost" onClick={onClose}>
					{t("close")}
				</Button>
			</div>
		</Dialog>
	);
}
