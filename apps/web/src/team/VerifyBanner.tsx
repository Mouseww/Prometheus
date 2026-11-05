// Public mode: a signed-in user whose email is not verified yet gets a banner with a resend action.
import { MailWarning } from "lucide-react";
import { useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { useTeam } from "./context.tsx";
import { errorText } from "./i18n.ts";
import { needsVerificationBanner } from "./logic/publicMode.ts";

const M = defineMessages({
	zh: {
		text: "邮箱 {email} 还没有验证。验证后才能创建企业等操作。",
		resend: "重新发送验证邮件",
		sending: "发送中",
		sent: "验证邮件已发送，请查收。",
	},
	en: {
		text: "Your email {email} is not verified yet. Some actions, such as creating an organization, need it.",
		resend: "Resend verification email",
		sending: "Sending",
		sent: "Verification mail sent. Check your inbox.",
	},
});

export function VerifyBanner() {
	const { me, meta, resendVerification } = useTeam();
	const t = useT(M);
	const [state, setState] = useState<{ phase: "idle" | "busy" | "sent" } | { phase: "error"; message: string }>({ phase: "idle" });
	if (!needsVerificationBanner(me, meta)) return null;

	const resend = async () => {
		if (!resendVerification) return;
		setState({ phase: "busy" });
		try {
			await resendVerification(me.user.email);
			setState({ phase: "sent" });
		} catch (err) {
			setState({ phase: "error", message: errorText(err) });
		}
	};

	return (
		<div role="region" aria-label={t("resend")} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ember-500/30 bg-ember-500/10 px-4 py-2 text-sm text-ember-200">
			<MailWarning className="size-4 shrink-0" aria-hidden />
			<span className="min-w-0 flex-1">{t("text", { email: me.user.email })}</span>
			{state.phase === "sent" && <span role="status">{t("sent")}</span>}
			{state.phase === "error" && <span role="alert" className="text-rose-400">{state.message}</span>}
			{resendVerification && state.phase !== "sent" && (
				<button type="button" onClick={() => void resend()} disabled={state.phase === "busy"} className="shrink-0 font-medium underline underline-offset-2 hover:text-ember-100 disabled:opacity-60">
					{state.phase === "busy" ? t("sending") : t("resend")}
				</button>
			)}
		</div>
	);
}
