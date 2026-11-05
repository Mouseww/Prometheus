import { Badge } from "../../components/ui.tsx";
import { defineMessages, translate } from "../../lib/i18n.ts";
import { type Lang, usePrefs } from "../../lib/prefs.ts";
import type { MergeRequestStatus } from "../types.ts";

const M = defineMessages({
	zh: { open: "待审核", approved: "已通过", merged: "已合并", rejected: "已拒绝", conflict: "有冲突", closed: "已关闭" },
	en: { open: "Open", approved: "Approved", merged: "Merged", rejected: "Rejected", conflict: "Conflict", closed: "Closed" },
});

export const mrStatusLabel = (lang: Lang, status: MergeRequestStatus): string => translate(M, lang, status);

const TONE: Record<MergeRequestStatus, "muted" | "ember" | "moss" | "rose" | "sky"> = {
	open: "sky",
	approved: "moss",
	merged: "moss",
	rejected: "rose",
	conflict: "ember",
	closed: "muted",
};

export function MergeRequestStatusBadge({ status }: { status: MergeRequestStatus }) {
	const lang = usePrefs((s) => s.lang);
	return <Badge tone={TONE[status]}>{mrStatusLabel(lang, status)}</Badge>;
}
