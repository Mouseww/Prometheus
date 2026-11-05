import { useCallback, useEffect, useState } from "react";
import { useTeam } from "../../context.tsx";
import { notificationRoute } from "../../logic/notifyRoute.ts";
import type { NotificationView } from "../../types.ts";
import { errorText } from "../../i18n.ts";

export interface NotificationsState {
	items: NotificationView[];
	unread: number;
	loading: boolean;
	error: string | undefined;
	nextBefore: string | null;
	reload: () => void;
	loadMore: () => void;
	markRead: (ids: string[]) => Promise<void>;
	markAllRead: () => Promise<void>;
	/** Marks the notification read and navigates to what it points at (when it points at anything). Resolves true when it navigated. */
	open: (n: NotificationView) => Promise<boolean>;
}

const PAGE = 30;

/** Notification list with the unread count, kept live through the `user` topic. */
export function useNotifications(): NotificationsState {
	const { api, navigate } = useTeam();
	const [items, setItems] = useState<NotificationView[]>([]);
	const [unread, setUnread] = useState(0);
	const [nextBefore, setNextBefore] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>(undefined);
	const [tick, setTick] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: tick is the reload trigger
	useEffect(() => {
		let stale = false;
		setLoading(true);
		api
			.listNotifications({ limit: PAGE })
			.then((page) => {
				if (stale) return;
				setItems(page.items);
				setUnread(page.unread);
				setNextBefore(page.nextBefore);
				setError(undefined);
			})
			.catch((e: unknown) => {
				if (!stale) setError(errorText(e));
			})
			.finally(() => {
				if (!stale) setLoading(false);
			});
		return () => {
			stale = true;
		};
	}, [api, tick]);

	const reload = useCallback(() => setTick((n) => n + 1), []);

	useEffect(
		() =>
			api.subscribe("user", (ev) => {
				if (typeof ev === "object" && ev !== null && (ev as { kind?: unknown }).kind === "notification") reload();
			}),
		[api, reload],
	);

	const loadMore = useCallback(() => {
		if (!nextBefore) return;
		api
			.listNotifications({ limit: PAGE, before: nextBefore })
			.then((page) => {
				setItems((cur) => [...cur, ...page.items.filter((n) => !cur.some((c) => c.id === n.id))]);
				setUnread(page.unread);
				setNextBefore(page.nextBefore);
			})
			.catch((e: unknown) => setError(errorText(e)));
	}, [api, nextBefore]);

	const markRead = useCallback(
		async (ids: string[]) => {
			const fresh = ids.filter((id) => items.some((n) => n.id === id && n.readAt === null));
			if (fresh.length === 0) return;
			await api.markNotificationsRead({ ids: fresh });
			const now = new Date().toISOString();
			setItems((cur) => cur.map((n) => (fresh.includes(n.id) ? { ...n, readAt: now } : n)));
			setUnread((u) => Math.max(0, u - fresh.length));
		},
		[api, items],
	);

	const markAllRead = useCallback(async () => {
		await api.markNotificationsRead({ all: true });
		const now = new Date().toISOString();
		setItems((cur) => cur.map((n) => (n.readAt === null ? { ...n, readAt: now } : n)));
		setUnread(0);
	}, [api]);

	const open = useCallback(
		async (n: NotificationView): Promise<boolean> => {
			try {
				await markRead([n.id]);
			} catch (e) {
				setError(errorText(e));
			}
			const route = notificationRoute(n);
			if (!route) return false;
			// Merge request and workspace pages want the team id to find the viewer's role; look it up when the payload lacks it.
			if ((route.page === "mergeRequest" || route.page === "workspace") && !route.params?.teamId && route.params?.workspaceId) {
				try {
					const ws = await api.getWorkspace(route.params.workspaceId);
					navigate({ ...route, params: { ...route.params, teamId: ws.teamId } });
					return true;
				} catch {
					/* fall through: open the page without the team id */
				}
			}
			navigate(route);
			return true;
		},
		[api, markRead, navigate],
	);

	return { items, unread, loading, error, nextBefore, reload, loadMore, markRead, markAllRead, open };
}
