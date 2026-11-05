import { describe, expect, it } from "vitest";
import { localSessionIdOf } from "../src/team/logic/pluginResult.ts";
import { notificationRoute } from "../src/team/logic/notifyRoute.ts";

describe("notificationRoute", () => {
	it("opens the session for grant and fork notices", () => {
		expect(notificationRoute({ kind: "session.granted", payload: { sessionId: "s1", workspaceId: "w1" } })).toEqual({ page: "session", params: { sessionId: "s1" } });
		expect(notificationRoute({ kind: "session.forked", payload: { sessionId: "s1", newSessionId: "s2", workspaceId: "w1" } })).toEqual({ page: "session", params: { sessionId: "s1" } });
	});

	it("opens the merge request with the ids the payload carries", () => {
		expect(notificationRoute({ kind: "mr.created", payload: { mergeRequestId: "m1", workspaceId: "w1" } })).toEqual({ page: "mergeRequest", params: { mergeRequestId: "m1", workspaceId: "w1" } });
		expect(notificationRoute({ kind: "mr.merged", payload: { mergeRequestId: "m1", workspaceId: "w1", teamId: "t1" } })).toEqual({ page: "mergeRequest", params: { mergeRequestId: "m1", workspaceId: "w1", teamId: "t1" } });
	});

	it("falls back to the workspace or team, and to nothing", () => {
		expect(notificationRoute({ kind: "upstream.diverged", payload: { workspaceId: "w1" } })).toEqual({ page: "workspace", params: { workspaceId: "w1" } });
		expect(notificationRoute({ kind: "x", payload: { teamId: "t1" } })).toEqual({ page: "team", params: { teamId: "t1" } });
		expect(notificationRoute({ kind: "tenant.failed", payload: { reason: "boom" } })).toBeUndefined();
		expect(notificationRoute({ kind: "x", payload: { sessionId: 5 } })).toBeUndefined();
	});

	it("sends report notices to the report tab", () => {
		expect(notificationRoute({ kind: "report.generated", payload: { workspaceId: "w1" } })).toEqual({ page: "teamHome", params: { workspaceId: "w1", tab: "report" } });
	});
});

describe("localSessionIdOf", () => {
	it("reads the id from a bare string, an object or an envelope", () => {
		expect(localSessionIdOf("abc")).toBe("abc");
		expect(localSessionIdOf({ localSessionId: "l1", hubSessionId: "h1" })).toBe("l1");
		expect(localSessionIdOf({ ok: true, data: { sessionId: "l2" } })).toBe("l2");
		expect(localSessionIdOf({ other: 1 })).toBeUndefined();
		expect(localSessionIdOf(undefined)).toBeUndefined();
	});
});
