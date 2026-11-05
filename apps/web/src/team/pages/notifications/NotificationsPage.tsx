import { Bell, CheckCheck } from "lucide-react";
import { Button, Empty, PageHeader } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Body, useAction } from "../../kit.tsx";
import { NotificationList } from "./NotificationList.tsx";
import { useNotifications } from "./useNotifications.ts";

const M = defineMessages({
	zh: { title: "通知", subtitle: "{n} 条未读", allRead: "全部标为已读", empty: "没有通知", emptyHint: "会话授权、合并请求等动态会出现在这里。", more: "加载更多" },
	en: { title: "Notifications", subtitle: "{n} unread", allRead: "Mark all read", empty: "No notifications", emptyHint: "Session grants, merge requests and similar updates show up here.", more: "Load more" },
});

export function NotificationsPage() {
	const t = useT(M);
	const c = useCommonT();
	const n = useNotifications();
	const action = useAction();
	const state = { data: n.loading && n.items.length === 0 && !n.error ? undefined : n.items, error: n.error, loading: n.loading, reload: n.reload, setData: () => undefined };

	return (
		<>
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle", { n: n.unread })}
				actions={
					<div className="flex items-center gap-2">
						<Button variant="ghost" onClick={n.reload}>
							{c("refresh")}
						</Button>
						<Button variant="outline" disabled={n.unread === 0 || action.busy} onClick={() => void action.run(n.markAllRead)}>
							<CheckCheck className="size-4" aria-hidden /> {t("allRead")}
						</Button>
					</div>
				}
			/>
			<Body>
				<AsyncView state={state}>
					{(items) =>
						items.length === 0 ? (
							<Empty icon={<Bell className="size-5" />} title={t("empty")}>
								{t("emptyHint")}
							</Empty>
						) : (
							<div className="space-y-3">
								<NotificationList items={items} onOpen={(item) => void n.open(item)} className="overflow-hidden rounded-xl border border-ink-700 bg-ink-900/60" />
								{n.nextBefore && (
									<Button variant="ghost" onClick={n.loadMore}>
										{t("more")}
									</Button>
								)}
							</div>
						)
					}
				</AsyncView>
			</Body>
		</>
	);
}
