// Operator console: mail only goes to the Hub log until an SMTP server is configured.
import { MailWarning as MailWarningIcon } from "lucide-react";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { mailWarning } from "../../logic/publicMode.ts";

const M = defineMessages({
	zh: {
		title: "邮件服务未配置",
		body: "验证邮件和重置密码邮件目前只会写入 Hub 日志，用户收不到。请为 Hub 设置 HUB_SMTP_URL 后重启。",
	},
	en: {
		title: "Mail is not configured",
		body: "Verification and password reset mails only go to the Hub log, so users never receive them. Set HUB_SMTP_URL on the Hub and restart it.",
	},
});

/** Renders nothing unless the viewer is the operator and the Hub reports `mailConfigured: false`. */
export function MailWarning() {
	const { me, meta } = useTeam();
	const t = useT(M);
	if (!isOperator(me) || !mailWarning(meta)) return null;
	return (
		<div role="alert" className="mb-4 flex items-start gap-2.5 rounded-lg border border-ember-500/40 bg-ember-500/10 px-3 py-2.5 text-sm text-ember-200">
			<MailWarningIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
			<div>
				<p className="font-medium">{t("title")}</p>
				<p className="text-ember-300">{t("body")}</p>
			</div>
		</div>
	);
}
