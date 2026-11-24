// The "also email the link" switch of both invitation forms. Mail needs a configured server; without one the link
// still works, it just has to be passed on by hand, and the operator is pointed at the place to set mail up.
import { type ReactNode, useState } from "react";
import { Button } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { isOperator, useTeam } from "../context.tsx";
import { Checkbox } from "./admin/shared.tsx";

const M = defineMessages({
	zh: {
		send: "同时把邀请链接发到对方邮箱",
		notConfigured: "邮件服务还没有配置，生成后需要把链接复制给对方。",
		notConfiguredOperator: "邮件服务还没有配置，生成后需要把链接复制给对方，或者先配置邮件服务。",
		setup: "去配置",
	},
	en: {
		send: "Also email the invitation link to them",
		notConfigured: "The mail server is not configured yet, so copy the link to them after creating it.",
		notConfiguredOperator: "The mail server is not configured yet. Copy the link to them after creating it, or set mail up first.",
		setup: "Set it up",
	},
});

export interface InviteMail {
	/** What to send as `sendEmail`. Never true while the Hub has no mail server. */
	send: boolean;
	option: ReactNode;
}

export function useInviteMail(): InviteMail {
	const { meta, me, navigate } = useTeam();
	const t = useT(M);
	// The member view has no Hub meta, so it cannot know: offer the switch and let the delivery result say what happened.
	const configured = meta === undefined || meta.mailConfigured === true;
	const [checked, setChecked] = useState(true);
	const operator = isOperator(me);
	const option = configured ? (
		<Checkbox label={t("send")} checked={checked} onChange={setChecked} />
	) : (
		<div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
			<span>{operator ? t("notConfiguredOperator") : t("notConfigured")}</span>
			{operator && (
				<Button variant="outline" onClick={() => navigate({ page: "admin.settings" })}>
					{t("setup")}
				</Button>
			)}
		</div>
	);
	return { send: configured && checked, option };
}
