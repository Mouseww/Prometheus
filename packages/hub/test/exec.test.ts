import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantCredentials } from "../src/auth/tenant-credentials.ts";
import { createExecService, type ExecService } from "../src/services/exec.ts";
import { silentLog } from "../src/log.ts";
import type { WsGateway } from "../src/ws.ts";
import { type Collab, connectWs, sleep, startCollab, type WsClient } from "./s-helpers.ts";

let c: Collab;
let gateway: WsGateway;
beforeAll(async () => {
	c = await startCollab();
	gateway = c.t.hub.registry.require<WsGateway>("realtime");
});
afterAll(async () => {
	await c.stop();
});

/** A live, revocable tenant credential, issued the way the runtime manager issues it. */
const tenantToken = async (userId: string): Promise<string> => (await c.t.hub.registry.require<TenantCredentials>("tenantCredentials").issue(userId, "tenant", 3600)).token;

type Answer = { ok: true; data?: unknown } | { ok: false; error?: string; code?: string };
interface Side {
	client: WsClient;
	cmds: { cmd: string; params: any }[];
}

/** Answers every `cmd` frame with the handler registered for it (a missing handler answers ok with no data). */
function side(client: WsClient, handlers: Record<string, (params: any) => Answer>): Side {
	const s: Side = { client, cmds: [] };
	client.ws.on("message", (raw) => {
		const f = JSON.parse(raw.toString());
		if (f.type !== "cmd") return;
		s.cmds.push({ cmd: f.cmd, params: f.params });
		const answer = handlers[f.cmd]?.(f.params) ?? { ok: true };
		client.send({ type: "cmdResult", cmdId: f.cmdId, ...answer });
	});
	return s;
}

const connectSides = async (
	userId: string,
	token: string,
	local: Record<string, (p: any) => Answer>,
	team: Record<string, (p: any) => Answer>,
): Promise<{ local: Side; team: Side; close(): Promise<void> }> => {
	const lc = await connectWs(c.t.baseUrl, token);
	const tc = await connectWs(c.t.baseUrl, await tenantToken(userId));
	return { local: side(lc, local), team: side(tc, team), close: async () => void (await lc.close(), await tc.close()) };
};

const rowOf = async (id: string): Promise<{ exec_location: string; exec_mode: string; tenant_session_id: string | null; local_session_id: string; server_id: string }> =>
	(await c.t.hub.db.query<any>("SELECT exec_location, exec_mode, tenant_session_id, local_session_id, server_id FROM sessions WHERE id = $1", [id]))[0];

const setLocation = (id: string, location: string, tenantSessionId: string | null): Promise<unknown> =>
	c.t.hub.db.query("UPDATE sessions SET exec_location = $2, tenant_session_id = $3 WHERE id = $1", [id, location, tenantSessionId]);

describe("exec mode", () => {
	it("defaults to local-first/local and lets only the owner change the mode", async () => {
		const s = await c.registerSession();
		expect(await rowOf(s.id)).toMatchObject({ exec_location: "local", exec_mode: "local-first", tenant_session_id: null });
		const detail = await c.t.api("GET", `/api/sessions/${s.id}`, { token: c.alice.token });
		expect(detail.data).toMatchObject({ execLocation: "local", execMode: "local-first", tenantSessionId: null });

		const patched = await c.t.api("PATCH", `/api/sessions/${s.id}/exec`, { token: c.alice.token, body: { mode: "team-first" } });
		expect(patched.status).toBe(200);
		expect(patched.data).toMatchObject({ sessionId: s.id, location: "local", mode: "team-first" });
		expect((await c.t.api("GET", `/api/sessions/${s.id}/exec`, { token: c.alice.token })).data.mode).toBe("team-first");

		expect((await c.t.api("PATCH", `/api/sessions/${s.id}/exec`, { token: c.alice.token, body: { mode: "elsewhere" } })).status).toBe(400);
		expect((await c.t.api("PATCH", `/api/sessions/${s.id}/exec`, { token: c.bob.token, body: { mode: "local-first" } })).status).toBe(403);
		expect((await c.t.api("PATCH", `/api/sessions/${s.id}/exec`, { token: c.carol.token, body: { mode: "local-first" } })).status).toBe(404);
		expect((await c.t.api("POST", `/api/sessions/${s.id}/handoff`, { token: c.bob.token, body: { to: "team" } })).status).toBe(403);
		expect((await c.t.api("POST", `/api/sessions/${s.id}/handoff`, { token: c.alice.token, body: { to: "mars" } })).status).toBe(400);
		// Others still see the location but not the owner-only fields.
		const bobView = await c.t.api("GET", `/api/sessions/${s.id}`, { token: c.bob.token });
		expect(bobView.data.execLocation).toBe("local");
		expect(bobView.data.execMode).toBeUndefined();
	});

	it("announces a mode change on the session topic", async () => {
		const s = await c.registerSession();
		const bob = await connectWs(c.t.baseUrl, c.bob.token);
		await bob.subscribe(`session:${s.id}`);
		await c.t.api("PATCH", `/api/sessions/${s.id}/exec`, { token: c.alice.token, body: { mode: "team-first" } });
		expect((await bob.waitFor((f) => f.type === "event" && f.data.kind === "session.exec")).data).toMatchObject({ sessionId: s.id, mode: "team-first", location: "local" });
		await bob.close();
	});
});

describe("handoff", () => {
	const service = (over: Partial<Parameters<typeof createExecService>[0]> = {}): ExecService =>
		createExecService({ db: c.t.hub.db, log: silentLog, now: Date.now, gateway, realtime: c.realtime, commandTimeoutMs: 2000, tenantWaitMs: 300, ...over });
	const actorOf = (userId: string) => c.t.hub.services.actors.load(userId);

	it("moves a session from the local server to the tenant: export, import, record, mark the source read-only", async () => {
		const s = await c.registerSession();
		const sides = await connectSides(
			c.alice.userId,
			c.alice.token,
			{ "handoff.export": () => ({ ok: true, data: { snapshotCommit: "c".repeat(40), nextSeq: 7 } }) },
			{ "handoff.import": () => ({ ok: true, data: { sessionId: "tenant-sess-1" } }) },
		);
		// The commands go to the newest local connection, so the event listener must be that same connection.
		const events = sides.local.client;
		await events.subscribe("user");
		let ensured = 0;
		const state = await service({ ensureTenant: async () => void ensured++ }).handoff(await actorOf(c.alice.userId), s.id, "team");
		expect(state).toEqual({ sessionId: s.id, location: "team", mode: "local-first", tenantSessionId: "tenant-sess-1" });
		expect(ensured).toBe(1);
		expect(await rowOf(s.id)).toMatchObject({ exec_location: "team", tenant_session_id: "tenant-sess-1" });
		expect(sides.local.cmds[0]).toMatchObject({ cmd: "handoff.export", params: { hubSessionId: s.id, sessionId: s.localSessionId, from: "local", to: "team", force: false } });
		expect(sides.team.cmds[0]).toMatchObject({ cmd: "handoff.import", params: { hubSessionId: s.id, branch: s.branch, snapshotCommit: "c".repeat(40), nextSeq: 7 } });
		await sleep(80);
		expect(sides.local.cmds.map((x) => x.cmd)).toEqual(["handoff.export", "handoff.finish"]);
		expect(sides.local.cmds[1]?.params).toMatchObject({ activeSessionId: "tenant-sess-1", to: "team" });
		expect((await events.waitFor((f) => f.type === "event" && f.data.kind === "session.exec")).data).toMatchObject({ location: "team", tenantSessionId: "tenant-sess-1" });
		await sides.close();
	});

	it("moves it back through the HTTP endpoint and points the Hub at the new local session", async () => {
		const s = await c.registerSession();
		await setLocation(s.id, "team", "tenant-sess-2");
		const sides = await connectSides(
			c.alice.userId,
			c.alice.token,
			{ "handoff.import": () => ({ ok: true, data: { sessionId: "local-new-9", serverId: "srv-back" } }) },
			{ "handoff.export": () => ({ ok: true, data: { snapshotCommit: "d".repeat(40) } }) },
		);
		const r = await c.t.api("POST", `/api/sessions/${s.id}/handoff`, { token: c.alice.token, body: { to: "local", force: true } });
		expect(r.status).toBe(200);
		expect(r.data).toMatchObject({ location: "local", tenantSessionId: "tenant-sess-2" });
		expect(await rowOf(s.id)).toMatchObject({ exec_location: "local", local_session_id: "local-new-9", server_id: "srv-back" });
		expect(sides.team.cmds[0]).toMatchObject({ cmd: "handoff.export", params: { sessionId: "tenant-sess-2", from: "team", to: "local", force: true } });
		await sleep(80);
		expect(sides.team.cmds.map((x) => x.cmd)).toEqual(["handoff.export", "handoff.finish"]);
		await sides.close();
	});

	it("refuses when already there, while busy, and without a runtime", async () => {
		const s = await c.registerSession();
		const alice = await actorOf(c.alice.userId);
		await expect(service().handoff(alice, s.id, "local")).rejects.toMatchObject({ status: 409, code: "alreadyThere" });
		await expect(service().handoff(alice, s.id, "team")).rejects.toMatchObject({ status: 503, code: "runtimeUnavailable" });
		await expect(service({ ensureTenant: async () => {} }).handoff(alice, s.id, "team")).rejects.toMatchObject({ status: 503, code: "targetOffline" });
		await expect(service().handoff(await actorOf(c.bob.userId), s.id, "team")).rejects.toMatchObject({ status: 403 });
		await expect(service().handoff(alice, "nope", "team")).rejects.toMatchObject({ status: 404 });
	});

	it("reports an offline source and leaves the session where it was", async () => {
		const s = await c.registerSession();
		const tenant = side(await connectWs(c.t.baseUrl, await tenantToken(c.alice.userId)), {});
		await expect(service({ ensureTenant: async () => {} }).handoff(await actorOf(c.alice.userId), s.id, "team")).rejects.toMatchObject({ status: 409, code: "sourceOffline" });
		expect((await rowOf(s.id)).exec_location).toBe("local");
		await tenant.client.close();
	});

	it("maps agentBusy to 409, other failures to 502 and a silent side to 504, never changing the location", async () => {
		const s = await c.registerSession();
		const alice = await actorOf(c.alice.userId);
		const ensure = { ensureTenant: async () => {} };

		let sides = await connectSides(c.alice.userId, c.alice.token, { "handoff.export": () => ({ ok: false, error: "Agent 仍在运行", code: "agentBusy" }) }, {});
		await expect(service(ensure).handoff(alice, s.id, "team")).rejects.toMatchObject({ status: 409, code: "agentBusy" });
		await sides.close();

		sides = await connectSides(c.alice.userId, c.alice.token, {}, { "handoff.import": () => ({ ok: false, error: "clone 失败" }) });
		await expect(service(ensure).handoff(alice, s.id, "team")).rejects.toMatchObject({ status: 502, code: "handoffFailed" });
		expect(sides.local.cmds.map((x) => x.cmd)).toEqual(["handoff.export"]);
		await sides.close();

		const lc = await connectWs(c.t.baseUrl, c.alice.token);
		const tc = await connectWs(c.t.baseUrl, await tenantToken(c.alice.userId));
		await expect(service({ ...ensure, commandTimeoutMs: 100 }).handoff(alice, s.id, "team")).rejects.toMatchObject({ status: 504, code: "handoffTimeout" });
		await lc.close();
		await tc.close();
		expect((await rowOf(s.id)).exec_location).toBe("local");
	});

	it("rejects an overlapping handoff of the same session", async () => {
		const s = await c.registerSession();
		const alice = await actorOf(c.alice.userId);
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const sides = await connectSides(c.alice.userId, c.alice.token, { "handoff.export": () => ({ ok: true, data: { snapshotCommit: "e".repeat(40) } }) }, { "handoff.import": () => ({ ok: true, data: { sessionId: "t-x" } }) });
		const svc = service({ ensureTenant: async () => void (await gate) });
		const first = svc.handoff(alice, s.id, "team");
		await sleep(30);
		await expect(svc.handoff(alice, s.id, "team")).rejects.toMatchObject({ status: 409, code: "handoffInProgress" });
		release();
		expect((await first).location).toBe("team");
		await sides.close();
	});
});

describe("actions follow the active side", () => {
	const act = (token: string, id: string, body: Record<string, unknown>) => c.t.api("POST", `/api/sessions/${id}/actions`, { token, body });

	it("relays to the tenant instance with its own session id while the team side is active, and back to local afterwards", async () => {
		const s = await c.registerSession();
		await c.t.api("POST", `/api/sessions/${s.id}/grants`, { token: c.alice.token, body: { userId: c.bob.userId } });
		const lc = await connectWs(c.t.baseUrl, c.alice.token);
		const tc = await connectWs(c.t.baseUrl, await tenantToken(c.alice.userId));
		const localSeen: any[] = [];
		const teamSeen: any[] = [];
		lc.autoRelay((f) => (localSeen.push(f), { ok: true }));
		tc.autoRelay((f) => (teamSeen.push(f), { ok: true }));
		try {
			// Local is active: only the local connection hears it.
			expect((await act(c.alice.token, s.id, { type: "prompt", text: "while local" })).data).toEqual({ relayed: true });
			expect(localSeen).toHaveLength(1);
			expect(localSeen[0]).toMatchObject({ sessionId: s.localSessionId, serverId: s.serverId });
			expect(teamSeen).toHaveLength(0);

			// Team is active: prompt, respond and abort reach the tenant session, for the owner and for a grantee alike.
			await setLocation(s.id, "team", "tenant-sess-1");
			expect((await act(c.alice.token, s.id, { type: "prompt", text: "while team" })).status).toBe(200);
			expect((await act(c.bob.token, s.id, { type: "respond", requestId: "q1", response: { allow: true } })).status).toBe(200);
			expect((await act(c.alice.token, s.id, { type: "abort" })).status).toBe(200);
			expect(localSeen).toHaveLength(1);
			expect(teamSeen.map((f) => f.action.type)).toEqual(["prompt", "respond", "abort"]);
			expect(teamSeen[0]).toMatchObject({ type: "relay", hubSessionId: s.id, sessionId: "tenant-sess-1", action: { text: "while team" }, actor: { userId: c.alice.userId } });
			expect(teamSeen[0].serverId).toBeUndefined();
			expect(teamSeen[1]).toMatchObject({ actor: { userId: c.bob.userId } });

			// Handed back: local again.
			await setLocation(s.id, "local", "tenant-sess-1");
			expect((await act(c.alice.token, s.id, { type: "prompt", text: "home again" })).status).toBe(200);
			expect(localSeen).toHaveLength(2);
			expect(teamSeen).toHaveLength(3);
		} finally {
			await lc.close();
			await tc.close();
			await setLocation(s.id, "local", null);
		}
	});

	it("keeps the grant checks and refuses clearly when the active side is not there", async () => {
		const s = await c.registerSession();
		await setLocation(s.id, "team", "tenant-sess-2");
		// No grant, outsiders: same answers as for a local session.
		expect((await act(c.bob.token, s.id, { type: "prompt", text: "x" })).code).toBe("notGranted");
		expect((await act(c.carol.token, s.id, { type: "prompt", text: "x" })).status).toBe(404);

		// The owner's own machine is online but the team side is not: nothing is delivered to the wrong side.
		const lc = await connectWs(c.t.baseUrl, c.alice.token);
		const localSeen: any[] = [];
		lc.autoRelay((f) => (localSeen.push(f), { ok: true }));
		const offline = await act(c.alice.token, s.id, { type: "prompt", text: "x" });
		expect(offline.status).toBe(409);
		expect(offline.code).toBe("ownerOffline");
		expect(localSeen).toHaveLength(0);
		await lc.close();

		// Team side active but never linked to a tenant session.
		await setLocation(s.id, "team", null);
		const tc = await connectWs(c.t.baseUrl, await tenantToken(c.alice.userId));
		expect((await act(c.alice.token, s.id, { type: "prompt", text: "x" })).code).toBe("sessionNotLinked");
		await tc.close();
		await setLocation(s.id, "local", null);
	});
});

describe("tenant token exchange", () => {
	it("trades a tenant credential for a user access token and refuses everything else", async () => {
		const res = await fetch(`${c.t.baseUrl}/api/auth/tenant-token`, { method: "POST", headers: { authorization: `Bearer ${await tenantToken(c.alice.userId)}` } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { accessToken: string; user: { id: string } } };
		expect(body.data.user.id).toBe(c.alice.userId);
		const me = await c.t.api("GET", "/api/me", { token: body.data.accessToken });
		expect(me.status).toBe(200);
		expect(me.data.user.id).toBe(c.alice.userId);

		for (const token of [c.alice.token, "garbage", c.t.hub.deps.signToken({ sub: c.alice.userId, aud: "prometheus-tenant", exp: Math.floor(Date.now() / 1000) + 60 })]) {
			expect((await fetch(`${c.t.baseUrl}/api/auth/tenant-token`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
		}
		expect((await fetch(`${c.t.baseUrl}/api/auth/tenant-token`, { method: "POST" })).status).toBe(401);
	});
});
