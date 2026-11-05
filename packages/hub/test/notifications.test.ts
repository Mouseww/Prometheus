import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NotificationsService } from "../src/services/notifications.ts";
import { type Collab, startCollab } from "./s-helpers.ts";

let c: Collab;
let notifications: NotificationsService;
beforeAll(async () => {
	c = await startCollab();
	notifications = c.t.hub.registry.require<NotificationsService>("notifications");
});
afterAll(async () => {
	await c.stop();
});

describe("notifications service (registry)", () => {
	it("is registered for other blocks as notify(userId, kind, payload)", async () => {
		expect(typeof notifications.notify).toBe("function");
		await notifications.notify(c.bob.userId, "mr.merged", { mergeRequestId: "mr1", title: "Add login" }, c.root.orgId);
		const r = await c.t.api("GET", "/api/notifications", { token: c.bob.token });
		expect(r.data.items[0]).toMatchObject({ kind: "mr.merged", payload: { mergeRequestId: "mr1", title: "Add login" }, readAt: null });
		expect(r.data.unread).toBeGreaterThanOrEqual(1);
	});

	it("never throws for unknown users", async () => {
		await expect(notifications.notify("ghost", "x", {})).resolves.toBeUndefined();
	});

	it("notifyMany sends once per distinct user", async () => {
		await notifications.notifyMany([c.alice.userId, c.alice.userId, c.bob.userId], "team.note", { n: 1 });
		const a = await c.t.api("GET", "/api/notifications", { token: c.alice.token });
		expect(a.data.items.filter((n: any) => n.kind === "team.note")).toHaveLength(1);
	});
});

describe("GET /api/notifications and POST /api/notifications/read", () => {
	it("lists newest first, filters unread, pages and counts", async () => {
		for (let i = 0; i < 5; i++) await notifications.notify(c.carol.userId, "k", { i });
		const all = await c.t.api("GET", "/api/notifications?limit=2", { token: c.carol.token });
		expect(all.data.items.map((n: any) => n.payload.i)).toEqual([4, 3]);
		expect(all.data).toMatchObject({ unread: 5 });
		expect(all.data.nextBefore).toBe(all.data.items[1].id);
		const next = await c.t.api("GET", `/api/notifications?limit=10&before=${all.data.nextBefore}`, { token: c.carol.token });
		expect(next.data.items.map((n: any) => n.payload.i)).toEqual([2, 1, 0]);
		expect(next.data.nextBefore).toBeNull();

		await c.t.api("POST", "/api/notifications/read", { token: c.carol.token, body: { ids: [all.data.items[0].id] } });
		const unread = await c.t.api("GET", "/api/notifications?unread=1", { token: c.carol.token });
		expect(unread.data.items).toHaveLength(4);
		expect(unread.data.unread).toBe(4);
	});

	it("marks read by ids or all, only for the caller", async () => {
		await notifications.notify(c.alice.userId, "solo", {});
		const aliceList = await c.t.api("GET", "/api/notifications?unread=1", { token: c.alice.token });
		const mine = aliceList.data.items[0].id;
		// Bob cannot mark Alice's notification.
		expect((await c.t.api("POST", "/api/notifications/read", { token: c.bob.token, body: { ids: [mine] } })).data).toEqual({ updated: 0 });
		expect((await c.t.api("POST", "/api/notifications/read", { token: c.alice.token, body: { ids: [mine] } })).data).toEqual({ updated: 1 });
		expect((await c.t.api("POST", "/api/notifications/read", { token: c.alice.token, body: { ids: [mine] } })).data).toEqual({ updated: 0 });
		const all = await c.t.api("POST", "/api/notifications/read", { token: c.alice.token, body: { all: true } });
		expect(all.data.updated).toBeGreaterThanOrEqual(1);
		expect((await c.t.api("GET", "/api/notifications?unread=1", { token: c.alice.token })).data.items).toEqual([]);
		expect((await c.t.api("POST", "/api/notifications/read", { token: c.alice.token, body: { ids: "x" } })).status).toBe(400);
		expect((await c.t.api("GET", "/api/notifications")).status).toBe(401);
	});
});
