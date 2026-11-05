import { defineMessages, translate } from "../../../lib/i18n.ts";
import type { Lang } from "../../../lib/prefs.ts";
import type { NotificationView } from "../../types.ts";

const T = defineMessages({
	zh: {
		"session.granted": "你被授权操作会话「{title}」",
		"session.forked": "{who} Fork 了你的会话「{title}」",
		"mr.created": "新的合并请求待审核：{title}",
		"mr.merged": "合并请求已合并：{title}",
		"mr.rejected": "合并请求被拒绝：{title}",
		"upstream.pushFailed": "推送到上游仓库失败",
		"upstream.diverged": "上游仓库已分叉，需要手动处理",
		"tenant.failed": "你的托管运行时启动失败",
		unknown: "新通知：{kind}",
		untitled: "未命名",
		someone: "有人",
	},
	en: {
		"session.granted": "You were granted access to session \"{title}\"",
		"session.forked": "{who} forked your session \"{title}\"",
		"mr.created": "New merge request to review: {title}",
		"mr.merged": "Merge request merged: {title}",
		"mr.rejected": "Merge request rejected: {title}",
		"upstream.pushFailed": "Pushing to the upstream repository failed",
		"upstream.diverged": "The upstream repository diverged and needs manual attention",
		"tenant.failed": "Your hosted runtime failed to start",
		unknown: "New notification: {kind}",
		untitled: "Untitled",
		someone: "Someone",
	},
});

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** One-line description of a notification in the viewer's language. */
export function notificationText(n: Pick<NotificationView, "kind" | "payload">, lang: Lang): string {
	const p = n.payload ?? {};
	const title = str(p.title) ?? translate(T, lang, "untitled");
	const who = str(p.forkedByName) ?? translate(T, lang, "someone");
	switch (n.kind) {
		case "session.granted":
		case "session.forked":
		case "mr.created":
		case "mr.merged":
		case "mr.rejected":
			return translate(T, lang, n.kind, { title, who });
		case "upstream.pushFailed":
		case "upstream.diverged":
		case "tenant.failed":
			return translate(T, lang, n.kind);
		default:
			return translate(T, lang, "unknown", { kind: n.kind });
	}
}
