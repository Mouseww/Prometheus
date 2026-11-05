/** What the session services need from the WebSocket gateway (`src/ws.ts`). Kept as an interface so services stay testable and free of cycles. */
export interface RelayAction {
	type: "prompt" | "respond" | "abort";
	text?: string;
	requestId?: string;
	response?: unknown;
}

export interface RelayMessage {
	/** Hub session id. */
	hubSessionId: string;
	/** The session's id on the side that runs it: the owner's machine, or the owner's tenant instance after a handoff to the team side. */
	sessionId: string;
	/** Set for the owner's machine; omitted for the tenant instance (its server id is not tracked by the Hub). */
	serverId?: string;
	action: RelayAction;
	actor: { userId: string; name: string };
}

export type RelayOutcome = { kind: "ok" } | { kind: "offline" } | { kind: "timeout" } | { kind: "failed"; error?: string };

export const RELAY_TIMEOUT_MS = 30_000;

/** Which of the owner's connections a relay goes to: their own machine (`local`) or their tenant instance on the team side. */
export type RelayTarget = "local" | "tenant";

export interface Realtime {
	/** Pushes `{type:"event", topic, data}` to every connection subscribed to the topic. */
	publish(topic: string, data: unknown): void;
	/** Pushes to the connections of one user that subscribed to the `user` topic. */
	publishUser(userId: string, data: unknown): void;
	/** Whether the user has any connection, or (with `target`) a connection of that kind. */
	isOnline(userId: string, target?: RelayTarget): boolean;
	/** Sends a relay frame to the owner's newest connection of `target` (default `local`) and waits for the matching `relayResult`. */
	relay(userId: string, msg: RelayMessage, timeoutMs?: number, target?: RelayTarget): Promise<RelayOutcome>;
}

/** Inert implementation for code paths without a gateway (unit tests of services). */
export const noRealtime: Realtime = {
	publish: () => {},
	publishUser: () => {},
	isOnline: () => false,
	relay: async () => ({ kind: "offline" }),
};
