// Operator console: mail only goes to the Hub log until a mail server is configured.
import { MailWarning as MailWarningIcon } from "lucide-react";
import { Button } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { mailWarning } from "../../logic/publicMode.ts";

const M = defineMessages({
	zh: {
		title: "邮件服务未配置",
		body: "邀请、验证邮件和重置密码邮件目前只会写入 Hub 日志，收件人收不到。",
		action: "去配置",
	},
	en: {
		title: "Mail is not configured",
		body: "Invitations, verification and password reset mails only go to the Hub log, so recipients never get them.",
		action: "Set it up",
	},
});

/** Renders nothing unless the viewer is the operator and the Hub reports `mailConfigured: false`. */
export function MailWarning() {
	const { me, meta, navigate } = useTeam();
	const t = useT(M);
	if (!isOperator(me) || !mailWarning(meta)) return null;
	return (
		<div role="alert" className="mb-4 flex items-start gap-2.5 rounded-lg border border-ember-500/40 bg-ember-500/10 px-3 py-2.5 text-sm text-ember-200">
			<MailWarningIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
			<div className="flex-1">
				<p className="font-medium">{t("title")}</p>
				<p className="text-ember-300">{t("body")}</p>
			</div>
			<Button variant="outline" onClick={() => navigate({ page: "admin.settings" })}>
				{t("action")}
			</Button>
		</div>
	);
}
