// Operator landing: the few things a new Hub needs before people can be invited and start working.
import { Check, Circle, X } from "lucide-react";
import { Button } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { Card, useAsync } from "../../kit.tsx";
import { onboardingProgress, showOnboarding } from "../../logic/onboarding.ts";
import { SLOT } from "../../slots.tsx";
import type { OnboardingStepId } from "../../types.ts";

const M = defineMessages({
	zh: {
		title: "开始使用团队 Hub",
		progress: "已完成 {done} / {total}",
		allDone: "都准备好了。现在可以去邀请成员，让他们加入并开始协作。",
		close: "关闭引导",
		closeLabel: "关闭首次使用引导",
		publicUrl: "设置对外地址",
		publicUrlBody: "邀请链接和邮件里的链接都以它开头。启动 Hub 时设置环境变量 HUB_PUBLIC_URL，例如 https://hub.example.com，然后重启 Hub。",
		mail: "配置邮件服务",
		mailBody: "没有邮件服务，邀请只能复制链接发给对方，验证和重置密码的邮件也发不出去。",
		mailAction: "去配置",
		gateway: "配置模型网关",
		gatewayBody: "团队成员通过网关使用模型。没有网关，成员在团队会话里用不了模型。",
		gatewayAction: "去配置",
		team: "创建第一个团队",
		teamBody: "点右上角的「新建团队」。团队是协作的基本单位，成员、工作区和合并请求都属于团队。",
		workspace: "创建工作区",
		workspaceBody: "进入团队，创建工作区：它是团队共用的 Git 仓库，成员的会话都在它的分支里运行。",
		invite: "邀请第一位成员",
		inviteBody: "填写对方邮箱，Hub 会把邀请链接发过去，也可以复制链接自己发。",
		inviteAction: "去邀请",
		done: "已完成",
		todo: "待完成",
	},
	en: {
		title: "Get your team Hub going",
		progress: "{done} of {total} done",
		allDone: "Everything is ready. Invite people so they can join and start working together.",
		close: "Close the guide",
		closeLabel: "Close the first-run guide",
		publicUrl: "Set the public address",
		publicUrlBody: "Invitation links and the links in mails start with it. Set the HUB_PUBLIC_URL environment variable, for example https://hub.example.com, and restart the Hub.",
		mail: "Set up the mail server",
		mailBody: "Without mail, invitations have to be copied to people by hand, and verification and password reset mails are never delivered.",
		mailAction: "Set it up",
		gateway: "Add a model gateway",
		gatewayBody: "Members use models through a gateway. Without one, nobody can use a model in a team session.",
		gatewayAction: "Set it up",
		team: "Create the first team",
		teamBody: "Use New team at the top right. A team is the unit of collaboration: members, workspaces and merge requests belong to it.",
		workspace: "Create a workspace",
		workspaceBody: "Open the team and create a workspace: the Git repository the team shares, where every member's session runs on its own branch.",
		invite: "Invite the first member",
		inviteBody: "Enter their email and the Hub mails the invitation link. You can also copy the link and send it yourself.",
		inviteAction: "Invite",
		done: "Done",
		todo: "To do",
	},
});

/** Where a step is done, when the Hub UI has a page for it. The others are done outside this page. */
const TARGET: Partial<Record<OnboardingStepId, { page: string; action: "mailAction" | "gatewayAction" | "inviteAction" }>> = {
	mail: { page: "admin.settings", action: "mailAction" },
	gateway: { page: SLOT.gateways, action: "gatewayAction" },
	invite: { page: "admin.invitations", action: "inviteAction" },
};

export function OnboardingChecklist() {
	const { api, me, meta, navigate } = useTeam();
	const t = useT(M);
	const operator = isOperator(me);
	const status = useAsync(() => (operator && meta !== undefined ? api.getOnboarding() : Promise.resolve(undefined)), [api, operator, meta !== undefined]);
	const current = status.data;
	if (!current || !showOnboarding(current, operator, meta !== undefined)) return null;
	const progress = onboardingProgress(current);
	const close = async () => {
		const next = await api.dismissOnboarding(true).catch(() => undefined);
		if (next) status.setData(next);
	};

	return (
		<Card
			title={t("title")}
			className="mb-4 border-ember-500/30"
			actions={
				<Button variant="ghost" onClick={() => void close()} aria-label={t("closeLabel")}>
					<X className="size-4" aria-hidden /> {t("close")}
				</Button>
			}
		>
			<p className="mb-3 text-xs text-ink-400" role="status">
				{progress.complete ? t("allDone") : t("progress", { done: progress.done, total: progress.total })}
			</p>
			<ol className="space-y-2.5">
				{current.steps.map((step) => {
					const target = TARGET[step.id];
					const isNext = step.id === progress.next;
					return (
						<li key={step.id} className="flex items-start gap-3" aria-current={isNext ? "step" : undefined}>
							<span className={step.done ? "mt-0.5 text-moss-400" : isNext ? "mt-0.5 text-ember-300" : "mt-0.5 text-ink-500"}>
								{step.done ? <Check className="size-4" aria-label={t("done")} /> : <Circle className="size-4" aria-label={t("todo")} />}
							</span>
							<div className="min-w-0 flex-1">
								<p className={step.done ? "text-sm text-ink-400 line-through" : "text-sm font-medium"}>{t(step.id)}</p>
								{!step.done && <p className="mt-0.5 text-xs text-ink-400">{t(`${step.id}Body`)}</p>}
							</div>
							{!step.done && target && (
								<Button variant={isNext ? "primary" : "outline"} onClick={() => navigate({ page: target.page })}>
									{t(target.action)}
								</Button>
							)}
						</li>
					);
				})}
			</ol>
		</Card>
	);
}
