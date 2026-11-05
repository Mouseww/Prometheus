// Top bar bell: unread badge and a dropdown with the latest notifications.
import clsx from "clsx";
import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { ErrorBox } from "../../kit.tsx";
import { NotificationList } from "./NotificationList.tsx";
import { useNotifications } from "./useNotifications.ts";

const M = defineMessages({
	zh: { unreadCount: "{n} 条未读通知", list: "最新通知", allRead: "全部标为已读", viewAll: "查看全部", empty: "没有通知" },
	en: { unreadCount: "{n} unread notifications", list: "Latest notifications", allRead: "Mark all read", viewAll: "View all", empty: "No notifications" },
});

export function NotificationsBell() {
	const { navigate } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const n = useNotifications();
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setOpen(false);
				button.current?.focus();
			}
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const latest = n.items.slice(0, 8);
	return (
		<div ref={root} className="relative" data-team-slot="notifications">
			<button
				ref={button}
				type="button"
				aria-label={n.unread > 0 ? `${c("notifications")}, ${t("unreadCount", { n: n.unread })}` : c("notifications")}
				aria-haspopup="true"
				aria-expanded={open}
				onClick={() => {
					if (!open) n.reload();
					setOpen((o) => !o);
				}}
				className={clsx("relative rounded-lg p-2 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-ember-400", open && "bg-ink-800 text-ink-100")}
			>
				<Bell className="size-4" aria-hidden />
				{n.unread > 0 && (
					<span className="absolute top-0.5 right-0.5 grid min-w-4 place-items-center rounded-full bg-ember-500 px-1 text-[10px] leading-4 font-semibold text-white" aria-hidden>
						{n.unread > 99 ? "99+" : n.unread}
					</span>
				)}
			</button>
			{open && (
				<div role="region" aria-label={t("list")} className="absolute right-0 z-40 mt-1 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl shadow-black/50">
					<div className="flex items-center justify-between gap-2 border-b hairline px-3 py-2">
						<h2 className="font-display text-sm font-semibold">{c("notifications")}</h2>
						<button
							type="button"
							disabled={n.unread === 0}
							onClick={() => void n.markAllRead().catch(() => n.reload())}
							className="rounded px-1.5 text-xs text-ink-300 underline underline-offset-2 hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-ember-400 disabled:no-underline disabled:opacity-40"
						>
							{t("allRead")}
						</button>
					</div>
					{n.error && <ErrorBox message={n.error} onRetry={n.reload} compact />}
					{latest.length === 0 ? (
						<p className="px-3 py-6 text-center text-sm text-ink-500">{n.loading ? c("loading") : t("empty")}</p>
					) : (
						<NotificationList
							items={latest}
							className="max-h-96 overflow-y-auto"
							onOpen={(item) => {
								setOpen(false);
								void n.open(item);
							}}
						/>
					)}
					<button
						type="button"
						onClick={() => {
							setOpen(false);
							navigate({ page: "notifications" });
						}}
						className="w-full border-t hairline px-3 py-2 text-center text-xs text-ink-300 hover:bg-ink-850 hover:text-ink-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ember-400"
					>
						{t("viewAll")}
					</button>
				</div>
			)}
		</div>
	);
}
