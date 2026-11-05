import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TeamApi } from "../../api.ts";
import { errorText } from "../../i18n.ts";
import { buildTranscript, lastSeq, mergeEvents, type TranscriptItem } from "../../logic/transcript.ts";
import type { SessionEvent } from "../../types.ts";

const PAGE = 200;

export interface SessionEventsState {
	items: TranscriptItem[];
	loading: boolean;
	hasMore: boolean;
	error: string | undefined;
	/** Fetches the next page (a no-op while one is in flight or when everything is loaded). */
	loadMore: () => void;
	reload: () => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Live `events` frames of a `session:<id>` topic as SessionEvents; empty for other frames. */
export function liveEvents(frame: unknown): SessionEvent[] {
	if (!isRecord(frame) || frame.kind !== "events" || !Array.isArray(frame.events)) return [];
	return frame.events.flatMap((e): SessionEvent[] => (isRecord(e) && typeof e.seq === "number" && typeof e.kind === "string" ? [{ seq: e.seq, kind: e.kind, payload: e.payload, createdAt: "" }] : []));
}

/**
 * Pages through a session's mirrored events with `after`, then follows live pushes. While older pages are still being
 * fetched, pushes are ignored (the paging will reach them); once caught up they are appended.
 */
export function useSessionEvents(api: TeamApi, sessionId: string): SessionEventsState {
	const [events, setEvents] = useState<SessionEvent[]>([]);
	const [loading, setLoading] = useState(false);
	const [hasMore, setHasMore] = useState(true);
	const [error, setError] = useState<string | undefined>(undefined);
	const cursor = useRef(-1);
	const busy = useRef(false);
	const more = useRef(true);
	const epoch = useRef(0);

	const fetchPage = useCallback(async () => {
		if (busy.current || !more.current) return;
		busy.current = true;
		const mine = epoch.current;
		setLoading(true);
		try {
			const page = await api.listSessionEvents(sessionId, { after: cursor.current, limit: PAGE });
			if (mine !== epoch.current) return;
			cursor.current = Math.max(cursor.current, page.nextAfter, lastSeq(page.items));
			more.current = page.hasMore;
			setHasMore(page.hasMore);
			setEvents((cur) => mergeEvents(cur, page.items));
			setError(undefined);
		} catch (e) {
			if (mine === epoch.current) setError(errorText(e));
		} finally {
			if (mine === epoch.current) {
				busy.current = false;
				setLoading(false);
			}
		}
	}, [api, sessionId]);

	const reset = useCallback(() => {
		epoch.current += 1;
		cursor.current = -1;
		busy.current = false;
		more.current = true;
		setEvents([]);
		setHasMore(true);
		setError(undefined);
		void fetchPage();
	}, [fetchPage]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset already depends on api and sessionId
	useEffect(() => {
		reset();
		return () => {
			epoch.current += 1;
		};
	}, [reset]);

	useEffect(
		() =>
			api.subscribe(`session:${sessionId}`, (frame) => {
				const fresh = liveEvents(frame);
				if (fresh.length === 0 || more.current) return;
				cursor.current = Math.max(cursor.current, lastSeq(fresh));
				setEvents((cur) => mergeEvents(cur, fresh));
			}),
		[api, sessionId],
	);

	const items = useMemo(() => buildTranscript(events), [events]);
	const loadMore = useCallback(() => void fetchPage(), [fetchPage]);
	return { items, loading, hasMore, error, loadMore, reload: reset };
}
