import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectWs, type Collab, sleep, startCollab } from "./s-helpers.ts";

let c: Collab;
beforeAll(async () => {
	c = await startCollab();
});
afterAll(async () => {
	await c.stop();
});

describe("WebSocket upgrade", () => {
	it("rejects missing, malformed and disabled-user tokens", async () => {
		await expect(connectWs(c.t.baseUrl, undefined)).rejects.toThrow(/401/);
		await expect(connectWs(c.t.baseUrl, "garbage")).rejects.toThrow(/401/);
		const dave = await c.t.createUser(c.root.token, "dave@corp.test", "Dave");
		await c.t.api("POST", `/api/admin/users/${dave.userId}/disable`, { token: c.root.token });
		await expect(connectWs(c.t.baseUrl, dave.token)).rejects.toThrow(/401/);
	});

	it("closes the open sockets of a user as soon as the account is disabled", async () => {
		const erin = await c.t.createUser(c.root.token, "erin@corp.test", "Erin");
		const sock = await connectWs(c.t.baseUrl, erin.token);
		expect(c.realtime.connectionCount(erin.userId)).toBe(1);
		const closed = new Promise<void>((resolve) => sock.ws.once("close", () => resolve()));
		await c.t.api("POST", `/api/admin/users/${erin.userId}/disable`, { token: c.root.token });
		await closed;
		expect(c.realtime.connectionCount(erin.userId)).toBe(0);
	});

	it("is not handled for other paths", async () => {
		const handled = c.t.hub.handleUpgrade({ url: "/somewhere-else", headers: {} } as never, { on() {}, destroy() {} } as never, Buffer.alloc(0));
		expect(handled).toBe(false);
	});

	it("tracks connections per user and answers ping", async () => {
		expect(c.realtime.connectionCount(c.alice.userId)).toBe(0);
		const a = await connectWs(c.t.baseUrl, c.alice.token);
		const a2 = await connectWs(c.t.baseUrl, c.alice.token);
		expect(c.realtime.connectionCount(c.alice.userId)).toBe(2);
		expect(c.realtime.isOnline(c.alice.userId)).toBe(true);
		a.send({ type: "ping" });
		expect((await a.waitFor((f) => f.type === "pong")).type).toBe("pong");
		a.send({ type: "nonsense" });
		expect((await a.waitFor((f) => f.type === "error")).code).toBe("invalidMessage");
		a.ws.send("not json");
		expect((await a.waitFor((f) => f.type === "error")).code).toBe("invalidMessage");
		await a.close();
		await a2.close();
		await sleep(50);
		expect(c.realtime.isOnline(c.alice.userId)).toBe(false);
	});
});

describe("subscription authorization", () => {
	it("lets team members subscribe to the workspace and its sessions and refuses outsiders", async () => {
		const s = await c.registerSession();
		const bob = await connectWs(c.t.baseUrl, c.bob.token);
		const carol = await connectWs(c.t.baseUrl, c.carol.token);

		expect(await bob.subscribe(`workspace:${c.workspaceId}`)).toMatchObject({ type: "subscribed" });
		expect(await bob.subscribe(`session:${s.id}`)).toMatchObject({ type: "subscribed" });
		expect(await bob.subscribe("user")).toMatchObject({ type: "subscribed" });

		expect(await carol.subscribe(`workspace:${c.workspaceId}`)).toMatchObject({ type: "error", code: "forbidden" });
		expect(await carol.subscribe(`session:${s.id}`)).toMatchObject({ type: "error", code: "forbidden" });
		expect(await carol.subscribe("workspace:does-not-exist")).toMatchObject({ type: "error", code: "forbidden" });
		expect(await carol.subscribe("other-user-topic")).toMatchObject({ type: "error", code: "forbidden" });
		expect(await carol.subscribe("user")).toMatchObject({ type: "subscribed" });

		// Nothing leaks to the refused connection.
		await c.t.api("POST", `/api/sessions/${s.id}/events`, { token: c.alice.token, body: { events: [{ seq: 0, kind: "agent_start", payload: {} }] } });
		await bob.waitFor((f) => f.type === "event" && f.topic === `session:${s.id}`);
		await sleep(50);
		expect(carol.frames.some((f) => f.type === "event")).toBe(false);

		bob.send({ type: "unsubscribe", topic: `session:${s.id}` });
		await sleep(50);
		const before = bob.frames.length;
		await c.t.api("POST", `/api/sessions/${s.id}/events`, { token: c.alice.token, body: { events: [{ seq: 1, kind: "agent_end", payload: {} }] } });
		await bob.waitFor((f) => f.type === "event" && f.topic === `workspace:${c.workspaceId}` && f.data.status === "idle");
		expect(bob.frames.slice(before).some((f) => f.topic === `session:${s.id}`)).toBe(false);
		await bob.close();
		await carol.close();
	});

	it("loses access when removed from the team", async () => {
		const ws2 = await connectWs(c.t.baseUrl, c.carol.token);
		expect(await ws2.subscribe(`workspace:${c.workspaceId}`)).toMatchObject({ type: "error" });
		await c.t.api("POST", `/api/teams/${c.teamId}/members`, { token: c.root.token, body: { userId: c.carol.userId, role: "member" } });
		expect(await ws2.subscribe(`workspace:${c.workspaceId}`)).toMatchObject({ type: "subscribed" });
		await c.t.api("DELETE", `/api/teams/${c.teamId}/members/${c.carol.userId}`, { token: c.root.token });
		const again = await connectWs(c.t.baseUrl, c.carol.token);
		expect(await again.subscribe(`workspace:${c.workspaceId}`)).toMatchObject({ type: "error" });
		await ws2.close();
		await again.close();
	});
});

describe("pushed events", () => {
	it("pushes session events, status changes and creation to subscribers with the documented shapes", async () => {
		const bob = await connectWs(c.t.baseUrl, c.bob.token);
		await bob.subscribe(`workspace:${c.workspaceId}`);
		const s = await c.registerSession();
		const created = await bob.waitFor((f) => f.type === "event" && f.data.kind === "session.created");
		expect(created).toMatchObject({ topic: `workspace:${c.workspaceId}`, data: { kind: "session.created", session: { id: s.id, ownerUserId: c.alice.userId, localSessionId: null } } });

		await bob.subscribe(`session:${s.id}`);
		await c.t.api("POST", `/api/sessions/${s.id}/events`, { token: c.alice.token, body: { events: [{ seq: 0, kind: "agent_start", payload: { a: 1 } }] } });
		const events = await bob.waitFor((f) => f.type === "event" && f.data.kind === "events");
		expect(events).toMatchObject({ topic: `session:${s.id}`, data: { sessionId: s.id, events: [{ seq: 0, kind: "agent_start", payload: { a: 1 } }] } });
		const status = await bob.waitFor((f) => f.type === "event" && f.topic === `workspace:${c.workspaceId}` && f.data.kind === "session.status");
		expect(status.data).toMatchObject({ sessionId: s.id, workspaceId: c.workspaceId, status: "running" });

		await c.t.api("PATCH", `/api/sessions/${s.id}`, { token: c.alice.token, body: { title: "Retitled" } });
		expect((await bob.waitFor((f) => f.type === "event" && f.data.kind === "session.updated")).data.session.title).toBe("Retitled");
		await bob.close();
	});

	it("pushes notifications to the user topic of the recipient only", async () => {
		const s = await c.registerSession();
		const bob = await connectWs(c.t.baseUrl, c.bob.token);
		const carol = await connectWs(c.t.baseUrl, c.carol.token);
		await bob.subscribe("user");
		await carol.subscribe("user");
		await c.t.api("POST", `/api/sessions/${s.id}/grants`, { token: c.alice.token, body: { userId: c.bob.userId } });
		const note = await bob.waitFor((f) => f.type === "event" && f.topic === "user" && f.data.kind === "notification");
		expect(note.data.notification).toMatchObject({ kind: "session.granted", payload: { sessionId: s.id }, readAt: null });
		await sleep(50);
		expect(carol.frames.some((f) => f.data?.kind === "notification")).toBe(false);
		await bob.close();
		await carol.close();
	});
});

describe("presence", () => {
	it("marks sessions offline after the grace period without a connection and restores them on reconnect", async () => {
		const s = await c.registerSession();
		const bob = await connectWs(c.t.baseUrl, c.bob.token);
		await bob.subscribe(`workspace:${c.workspaceId}`);
		const a = await connectWs(c.t.baseUrl, c.alice.token);
		await c.t.api("POST", `/api/sessions/${s.id}/events`, { token: c.alice.token, body: { events: [{ seq: 0, kind: "agent_start", payload: {} }] } });
		const statusOf = async (): Promise<string> => (await c.t.api("GET", `/api/sessions/${s.id}`, { token: c.alice.token })).data.status;
		expect(await statusOf()).toBe("running");

		await a.close();
		await sleep(50);
		c.clock.offset += 30_000;
		expect(await c.realtime.sweep()).toBe(0);
		expect(await statusOf()).toBe("running");

		c.clock.offset += 31_000;
		expect(await c.realtime.sweep()).toBeGreaterThanOrEqual(1);
		expect(await statusOf()).toBe("offline");
		const pushed = await bob.waitFor((f) => f.type === "event" && f.data.kind === "session.status" && f.data.status === "offline" && f.data.sessionId === s.id);
		expect(pushed.data.workspaceId).toBe(c.workspaceId);

		const back = await connectWs(c.t.baseUrl, c.alice.token);
		await bob.waitFor((f) => f.type === "event" && f.data.kind === "session.status" && f.data.status === "running" && f.data.sessionId === s.id);
		expect(await statusOf()).toBe("running");
		expect(await c.realtime.sweep()).toBe(0);
		await back.close();
		await bob.close();
	});

	it("does not flag owners that are still connected", async () => {
		const s = await c.registerSession();
		const a = await connectWs(c.t.baseUrl, c.alice.token);
		c.clock.offset += 10 * 60_000;
		await c.realtime.sweep();
		expect((await c.t.api("GET", `/api/sessions/${s.id}`, { token: c.alice.token })).data.status).toBe("idle");
		await a.close();
	});
});
