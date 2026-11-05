// Client state for hybrid execution in the personal app: which local sessions are team sessions, the hand confirmation
// queue and the sync status. Fed by the local team plugin's stream topics; the reducers live in ./logic/exec.ts.
import { create } from "zustand";
import type { PrometheusClient } from "../lib/client.ts";
import {
	addHand,
	applyExecChanged,
	applyExecState,
	applySessionLink,
	applySnapshot,
	dismissConflict,
	dropHand,
	type HandItem,
	linkFromStartResult,
	linkSession,
	mergeHands,
	parseExecChanged,
	parseHandRequest,
	parseConflictList,
	parseHandResolved,
	parsePendingHands,
	parseSessionLink,
	parseSnapshotApplied,
	parseSyncConflict,
	resolveHand,
	seedConflict,
	type SessionLink,
	type SessionLinkInfo,
	type SessionLinks,
	setConflict,
	type SyncConflict,
	type SyncInfo,
} from "./logic/exec.ts";
import type { ExecState } from "./types.ts";

const PLUGIN = "team";
const LINKS_KEY = "prometheus.team.sessionLinks";
const LINKS_MAX = 300;
/** How long the "timed out" note stays on screen. */
export const TIMEOUT_NOTE_MS = 6000;

export interface TeamExecState {
	links: SessionLinks;
	hands: HandItem[];
	/** Requests that just timed out, shown for a few seconds. */
	timedOut: HandItem[];
	sync: Record<string, SyncInfo>;
	conflicts: Record<string, SyncConflict>;
	/** The conflict ref the user dismissed per Hub session (memory only), so a reload of the list does not bring it back in the same run. */
	dismissed: Record<string, string>;
	link(localSessionId: string, hubSessionId: string): void;
	/** Sets the link from `session.link`'s answer. */
	seedLink(localSessionId: string, info: SessionLinkInfo): void;
	setExecState(localSessionId: string, state: Pick<ExecState, "location" | "mode">): void;
	dismissConflict(hubSessionId: string): void;
	dropTimedOut(callId: string): void;
	/** Drops a request that turned out to be answered already. */
	dropHand(callId: string): void;
}

function loadLinks(): SessionLinks {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(LINKS_KEY) ?? "{}");
		if (typeof raw !== "object" || raw === null) return {};
		const out: Record<string, SessionLinks[string]> = {};
		for (const [id, v] of Object.entries(raw)) {
			if (typeof v === "object" && v !== null && typeof (v as { hubSessionId?: unknown }).hubSessionId === "string") out[id] = v as SessionLinks[string];
		}
		return out;
	} catch {
		return {};
	}
}

function saveLinks(links: SessionLinks): void {
	try {
		const entries = Object.entries(links);
		const kept = entries.length > LINKS_MAX ? entries.slice(entries.length - LINKS_MAX) : entries;
		localStorage.setItem(LINKS_KEY, JSON.stringify(Object.fromEntries(kept)));
	} catch {
		/* storage blocked: links are rebuilt from the next events */
	}
}

export const useTeamExec = create<TeamExecState>((set, get) => {
	const setLinks = (links: SessionLinks): void => {
		if (links === get().links) return;
		saveLinks(links);
		set({ links });
	};
	return {
		links: loadLinks(),
		hands: [],
		timedOut: [],
		sync: {},
		conflicts: {},
		dismissed: {},
		link: (localSessionId, hubSessionId) => setLinks(linkSession(get().links, localSessionId, hubSessionId)),
		seedLink: (localSessionId, info) => setLinks(applySessionLink(get().links, localSessionId, info)),
		setExecState: (localSessionId, state) => setLinks(applyExecState(get().links, localSessionId, state)),
		dismissConflict: (hubSessionId) => {
			const shown = get().conflicts[hubSessionId];
			set({ conflicts: dismissConflict(get().conflicts, hubSessionId), ...(shown ? { dismissed: { ...get().dismissed, [hubSessionId]: shown.conflictRef } } : {}) });
		},
		dropTimedOut: (callId) => set({ timedOut: get().timedOut.filter((h) => h.callId !== callId) }),
		dropHand: (callId) => set({ hands: dropHand(get().hands, callId) }),
	};
});

/** The read-only marker of a local session (undefined while it takes prompts or is not a team session). */
export const useReadOnlyCopy = (localSessionId: string | undefined): SessionLink["readOnly"] => useTeamExec((s) => (localSessionId ? s.links[localSessionId]?.readOnly : undefined));

/** Applies one plugin stream event to the store. Exported for tests of the wiring; unknown topics and bad payloads are ignored. */
export function handleTeamEvent(topic: string, data: unknown, now: number = Date.now()): void {
	const s = useTeamExec.getState();
	switch (topic) {
		case "handRequest": {
			const item = parseHandRequest(data);
			if (item) useTeamExec.setState({ hands: addHand(s.hands, item) });
			return;
		}
		case "handResolved": {
			const ev = parseHandResolved(data);
			if (!ev) return;
			const r = resolveHand(s.hands, ev);
			useTeamExec.setState({ hands: r.hands, ...(r.timedOut ? { timedOut: [...s.timedOut, r.timedOut] } : {}) });
			return;
		}
		case "execChanged": {
			const ev = parseExecChanged(data);
			if (!ev) return;
			const links = applyExecChanged(s.links, ev);
			saveLinks(links);
			useTeamExec.setState({ links });
			return;
		}
		case "snapshotApplied": {
			const ev = parseSnapshotApplied(data);
			if (ev) useTeamExec.setState({ sync: applySnapshot(s.sync, ev, now) });
			return;
		}
		case "syncConflict": {
			const ev = parseSyncConflict(data);
			if (ev) useTeamExec.setState({ conflicts: setConflict(s.conflicts, ev) });
			return;
		}
		default:
	}
}

/** Remembers the link a `session.start` / `session.fork` result carries, so the opened chat shows the team session bar. */
export function rememberTeamSession(result: unknown): void {
	const l = linkFromStartResult(result);
	if (l) useTeamExec.getState().link(l.localSessionId, l.hubSessionId);
}

/** Calls a method of the member's team plugin (`memberPlugin().call` in the app). */
export type TeamPluginCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const noLinkAsked = new Set<string>();

/**
 * Asks the plugin which Hub session a local session belongs to and seeds the store with it. Does nothing when a link is already known
 * (events keep it current) or when the session was already found not to be a team session. Never rejects.
 */
export async function loadSessionLink(call: TeamPluginCall, localSessionId: string): Promise<void> {
	if (useTeamExec.getState().links[localSessionId] || noLinkAsked.has(localSessionId)) return;
	try {
		const info = parseSessionLink(await call("session.link", { sessionId: localSessionId }));
		if (info) useTeamExec.getState().seedLink(localSessionId, info);
		else if (info === null) noLinkAsked.add(localSessionId);
	} catch {
		/* the plugin is not running or not logged in: the bar stays hidden until an event or a start result links the session */
	}
}

/** Loads the sync conflicts this machine saved for a Hub session and shows the newest, so the notice survives a reload. Never rejects. */
export async function loadConflicts(call: TeamPluginCall, hubSessionId: string): Promise<void> {
	try {
		const loaded = parseConflictList(await call("sync.conflicts", { hubSessionId }), hubSessionId);
		const { conflicts, dismissed } = useTeamExec.getState();
		const next = seedConflict(conflicts, dismissed, loaded);
		if (next !== conflicts) useTeamExec.setState({ conflicts: next });
	} catch {
		/* no worktree of the session on this machine, or the plugin is off: nothing to show */
	}
}

/** Test hook: forget which sessions were found not to be team sessions. */
export const resetLinkLookups = (): void => noLinkAsked.clear();

export const TEAM_EVENT_TOPICS = ["handRequest", "handResolved", "execChanged", "snapshotApplied", "syncConflict"] as const;

/** Watches the team plugin's topics on this connection and recovers open hand questions after a (re)connect. Returns the cleanup. */
export function watchTeamEvents(client: Pick<PrometheusClient, "watch" | "onFrame" | "onState" | "rpc" | "state">): () => void {
	const offs = TEAM_EVENT_TOPICS.map((t) => client.watch(PLUGIN, t));
	const offFrame = client.onFrame((frame) => {
		if (frame.type !== "plugin.event" || frame.plugin !== PLUGIN) return;
		if ((TEAM_EVENT_TOPICS as readonly string[]).includes(frame.topic)) handleTeamEvent(frame.topic, frame.data);
	});
	let live = true;
	const recover = (): void => {
		client
			.rpc("plugin.call", { plugin: PLUGIN, method: "hand.pending", params: {} })
			.then((result) => {
				if (live) useTeamExec.setState({ hands: mergeHands(useTeamExec.getState().hands, parsePendingHands(result)) });
			})
			.catch(() => {
				/* the team plugin is not running here: there is nothing to recover */
			});
	};
	const offState = client.onState((state) => {
		if (state === "open") recover();
	});
	if (client.state === "open") recover();
	return () => {
		live = false;
		offState();
		offFrame();
		for (const off of offs) off();
	};
}
