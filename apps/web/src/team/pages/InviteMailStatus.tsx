// What became of the invitation mail, shown under the link. The link is always there, so a failed mail is a warning
// with the next step, never a dead end.
import { defineMessages, useT } from "../../lib/i18n.ts";
import type { CreatedInvitation } from "../types.ts";

const M = defineMessages({
	zh: {
		sent: "邀请邮件已发到 {email}。链接也可以复制后直接发给对方。",
		mailNotConfigured: "没有发邮件：Hub 还没有配置邮件服务。请把上面的链接复制给对方。",
		publicUrlMissing: "没有发邮件：Hub 没有设置对外地址（HUB_PUBLIC_URL），邮件里放不了链接。请把上面的链接复制给对方。",
		sendFailed: "邮件没有发出去，请把上面的链接复制给对方，并请运营者检查邮件服务设置。",
	},
	en: {
		sent: "The invitation mail was sent to {email}. You can still copy the link and send it yourself.",
		mailNotConfigured: "No mail was sent: the Hub has no mail server configured. Copy the link above to them.",
		publicUrlMissing: "No mail was sent: the Hub has no public address (HUB_PUBLIC_URL), so a mail cannot carry the link. Copy the link above to them.",
		sendFailed: "The mail could not be sent. Copy the link above to them, and ask the operator to check the mail server settings.",
	},
});

export function InviteMailStatus({ created }: { created: CreatedInvitation }) {
	const t = useT(M);
	if (created.mail === undefined || created.mail === "skipped") return null;
	if (created.mail === "sent") {
		return (
			<p role="status" className="mt-2 text-xs text-moss-400">
				{t("sent", { email: created.invitation.email })}
			</p>
		);
	}
	const reason = created.mailError === "mailNotConfigured" || created.mailError === "publicUrlMissing" ? created.mailError : "sendFailed";
	return (
		<p role="alert" className="mt-2 text-xs text-ember-300">
			{t(reason)}
		</p>
	);
}
