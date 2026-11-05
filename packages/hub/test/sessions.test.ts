import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyEvent, deriveStatus, initialStatusState } from "../src/services/session-status.ts";
import { connectWs, type Collab, startCollab } from "./s-helpers.ts";

let c: Collab;
beforeAll(async () => {
	c = await startCollab();
});
afterAll(async () => {
	await c.stop();
});

const ev = (seq: number, kind: string, payload: unknown = {}) => ({ seq, kind, payload });
const gz = (text: string): string => gzipSync(Buffer.from(text)).toString("base64");

describe("status machine (pure)", () => {
	it("derives running, waiting and idle from agent and ui request events", () => {
		let s = initialStatusState;
		expect(deriveStatus(s)).toBe("idle");
		s = applyEvent(s, { kind: "agent_start", payload: {} });
		expect(deriveStatus(s)).toBe("running");
		s = applyEvent(s, { kind: "ui_request", payload: { requestId: "r1", method: "permission" } });
		s = applyEvent(s, { kind: "ui_request", payload: { requestId: "r2" } });
		expect(deriveStatus(s)).toBe("waiting");
		s = applyEvent(s, { kind: "ui_resolved", payload: { requestId: "r1" } });
		expect(deriveStatus(s)).toBe("waiting");
		s = applyEvent(s, { kind: "ui_resolved", payload: { requestId: "r2" } });
		expect(deriveStatus(s)).toBe("running");
		s = applyEvent(s, { kind: "agent_end", payload: {} });
		expect(deriveStatus(s)).toBe("idle");
	});
});

describe("registration and listing", () => {
	it("registers a session for a team member and is idempotent per local session", async () => {
		const first = await c.t.api("POST", `/api/workspaces/${c.workspaceId}/sessions`, {
			token: c.alice.token,
			body: { localSessionId: "L1", serverId: "S1", title: "First", branch: "session/a/1", baseCommit: "b".repeat(40) },
		});
		expect(first.status).toBe(201);
		expect(first.data).toMatchObject({ ownerUserId: c.alice.userId, status: "idle", title: "First", localSessionId: "L1", serverId: "S1", workspaceId: c.workspaceId });

		const again = await c.t.api("POST", `/api/workspaces/${c.workspaceId}/sessions`, {
			token: c.alice.token,
			body: { localSessionId: "L1", serverId: "S1", title: "Renamed", branch: "session/a/1", baseCommit: "b".repeat(40) },
		});
		expect(again.status).toBe(200);
		expect(again.data.id).toBe(first.data.id);
		expect(again.data.title).toBe("Renamed");
	});

	it("rejects non-members with 404 and bad bodies with 400", async () => {
		const outsider = await c.t.api("POST", `/api/workspaces/${c.workspaceId}/sessions`, {
			token: c.carol.token,
			body: { localSessionId: "L9", serverId: "S1", branch: "b", baseCommit: "" },
		});
		expect(outsider.status).toBe(404);
		const bad = await c.t.api("POST", `/api/workspaces/${c.workspaceId}/sessions`, { token: c.alice.token, body: { serverId: "S1" } });
		expect(bad.status).toBe(400);
		expect((await c.t.api("GET", `/api/workspaces/${c.workspaceId}/sessions`, { token: c.carol.token })).status).toBe(404);
	});

	it("lists for members and hides the local mapping from non-owners", async () => {
		const s = await c.registerSession();
		const list = await c.t.api("GET", `/api/workspaces/${c.workspaceId}/sessions`, { token: c.bob.token });
		const row = list.data.find((x: any) => x.id === s.id);
		expect(row).toMatchObject({ ownerUserId: c.alice.userId, ownerName: "Alice", localSessionId: null, serverId: null });
		const mine = await c.t.api("GET", `/api/workspaces/${c.workspaceId}/sessions?owner=${c.alice.userId}`, { token: c.alice.token });
		expect(mine.data.find((x: any) => x.id === s.id).localSessionId).toBeTruthy();
		const filtered = await c.t.api("GET", `/api/workspaces/${c.workspaceId}/sessions?owner=${c.bob.userId}`, { token: c.bob.token });
		expect(filtered.data.find((x: any) => x.id === s.id)).toBeUndefined();
	});

	it("get reports ownership and ability to act", async () => {
		const s = await c.registerSession();
		expect((await c.t.api("GET", `/api/sessions/${s.id}`, { token: c.alice.token })).data).toMatchObject({ isOwner: true, canAct: true, grants: [] });
		expect((await c.t.api("GET", `/api/sessions/${s.id}`, { token: c.bob.token })).data).toMatchObject({ isOwner: false, canAct: false, grants: [] });
		expect((await c.t.api("GET", `/api/sessions/${s.id}`, { token: c.carol.token })).status).toBe(404);
	});

	it("patches title, snapshot commit and local mapping (owner only)", async () => {
		const s = await c.registerSession();
		const patched = await c.t.api("PATCH", `/api/sessions/${s.id}`, {
			token: c.alice.token,
			body: { title: "Better title", snapshotCommit: "c".repeat(40), lastActivity: "2026-01-02T03:04:05Z", localSessionId: "relinked", serverId: "S2" },
		});
		expect(patched.data).toMatchObject({ title: "Better title", snapshotCommit: "c".repeat(40), lastActivityAt: "2026-01-02T03:04:05.000Z", localSessionId: "relinked", serverId: "S2" });
		expect((await c.t.api("PATCH", `/api/sessions/${s.id}`, { token: c.bob.token, body: { title: "x" } })).status).toBe(403);
		expect((await c.t.api("PATCH", `/api/sessions/${s.id}`, { token: c.alice.token, body: { lastActivity: "not a date" } })).status).toBe(400);
	});
});

describe("events", () => {
	it("stores batches idempotently by seq and pages them", async () => {
		const s = await c.registerSession();
		const url = `/api/sessions/${s.id}/events`;
		const batch = [ev(0, "agent_start"), ev(1, "message_end", { message: { role: "user", content: "hi" } }), ev(2, "message_end", { message: { role: "assistant", content: "yo" } })];
		const first = await c.t.api("POST", url, { token: c.alice.token, body: { events: batch } });
		expect(first.data).toEqual({ accepted: 3, duplicates: 0, lastSeq: 2 });

		const resent = await c.t.api("POST", url, { token: c.alice.token, body: { events: [...batch, ev(3, "agent_end")] } });
		expect(resent.data).toEqual({ accepted: 1, duplicates: 3, lastSeq: 3 });
		const dupInBatch = await c.t.api("POST", url, { token: c.alice.token, body: { events: [ev(4, "x"), ev(4, "x")] } });
		expect(dupInBatch.data.accepted).toBe(1);

		const page1 = await c.t.api("GET", `${url}?limit=2`, { token: c.bob.token });
		expect(page1.data.items.map((e: any) => e.seq)).toEqual([0, 1]);
		expect(page1.data).toMatchObject({ hasMore: true, nextAfter: 1 });
		const page2 = await c.t.api("GET", `${url}?after=1&limit=2`, { token: c.bob.token });
		expect(page2.data.items.map((e: any) => e.seq)).toEqual([2, 3]);
		expect(page2.data.hasMore).toBe(true);
		const page3 = await c.t.api("GET", `${url}?after=3`, { token: c.bob.token });
		expect(page3.data).toMatchObject({ hasMore: false, nextAfter: 4 });
		expect(page3.data.items[0].payload).toEqual({});
		const none = await c.t.api("GET", `${url}?after=99`, { token: c.bob.token });
		expect(none.data).toEqual({ items: [], nextAfter: null, hasMore: false });
		expect(page1.data.items[1].payload).toEqual({ message: { role: "user", content: "hi" } });
	});

	it("accepts events out of order but applies status in seq order", async () => {
		const s = await c.registerSession();
		await c.t.api("POST", `/api/sessions/${s.id}/events`, { token: c.alice.token, body: { events: [ev(1, "agent_end"), ev(0, "agent_start")] } });
		expect((await c.t.api("GET", `/api/sessions/${s.id}`, { token: c.alice.token })).data.status).toBe("idle");
	});

	it("only the owner uploads; outsiders cannot read; oversized batches are rejected", async () => {
		const s = await c.registerSession();
		const url = `/api/sessions/${s.id}/events`;
		expect((await c.t.api("POST", url, { token: c.bob.token, body: { events: [ev(0, "agent_start")] } })).status).toBe(403);
		expect((await c.t.api("GET", url, { token: c.carol.token })).status).toBe(404);
		const many = Array.from({ length: 501 }, (_, i) => ev(i, "x"));
		expect((await c.t.api("POST", url, { token: c.alice.token, body: { events: many } })).status).toBe(400);
		expect((await c.t.api("POST", url, { token: c.alice.token, body: { events: [{ seq: -1, kind: "x" }] } })).status).toBe(400);
		expect((await c.t.api("POST", url, { token: c.alice.token, body: { events: [] } })).data).toEqual({ accepted: 0, duplicates: 0, lastSeq: null });
	});
});

describe("status transitions", () => {
	const status = async (id: string): Promise<string> => (await c.t.api("GET", `/api/sessions/${id}`, { token: c.alice.token })).data.status;
	const push = (id: string, ...events: ReturnType<typeof ev>[]) => c.t.api("POST", `/api/sessions/${id}/events`, { token: c.alice.token, body: { events } });

	it("goes running, waiting (ui_request), running (ui_resolved), idle (agent_end)", async () => {
		const s = await c.registerSession();
		expect(s.status).toBe("idle");
		await push(s.id, ev(0, "agent_start"));
		expect(await status(s.id)).toBe("running");
		await push(s.id, ev(1, "ui_request", { requestId: "q1", method: "permission", summary: "Bash: ls" }));
		expect(await status(s.id)).toBe("waiting");
		await push(s.id, ev(2, "ui_resolved", { requestId: "q1" }));
		expect(await status(s.id)).toBe("running");
		await push(s.id, ev(3, "agent_end"));
		expect(await status(s.id)).toBe("idle");
	});

	it("a resent batch does not change the status twice", async () => {
		const s = await c.registerSession();
		await push(s.id, ev(0, "agent_start"), ev(1, "ui_request", { requestId: "z" }));
		await push(s.id, ev(2, "ui_resolved", { requestId: "z" }));
		await push(s.id, ev(1, "ui_request", { requestId: "z" }));
		expect(await status(s.id)).toBe("running");
	});

	it("becomes offline when the owner presence is lost and recovers to what the events imply", async () => {
		const s = await c.registerSession();
		await push(s.id, ev(0, "agent_start"), ev(1, "ui_request", { requestId: "w" }));
		expect(await c.sessions.markOwnerOffline(c.alice.userId)).toBeGreaterThanOrEqual(1);
		expect(await status(s.id)).toBe("offline");
		await push(s.id, ev(2, "agent_end"));
		expect(await status(s.id)).toBe("offline");
		await c.sessions.markOwnerOnline(c.alice.userId);
		expect(await status(s.id)).toBe("waiting");
		await push(s.id, ev(3, "ui_resolved", { requestId: "w" }));
		expect(await status(s.id)).toBe("idle");
	});

	it("PATCH can set running or idle but offline keeps winning", async () => {
		const s = await c.registerSession();
		await c.t.api("PATCH", `/api/sessions/${s.id}`, { token: c.alice.token, body: { status: "running" } });
		expect(await status(s.id)).toBe("running");
		await c.t.api("PATCH", `/api/sessions/${s.id}`, { token: c.alice.token, body: { status: "waiting" } });
		expect(await status(s.id)).toBe("waiting");
		await c.t.api("PATCH", `/api/sessions/${s.id}`, { token: c.alice.token, body: { status: "idle" } });
		expect(await status(s.id)).toBe("idle");
		expect((await c.t.api("PATCH", `/api/sessions/${s.id}`, { token: c.alice.token, body: { status: "offline" } })).status).toBe(400);
		await c.sessions.markOwnerOffline(c.alice.userId);
		await c.t.api("PATCH", `/api/sessions/${s.id}`, { token: c.alice.token, body: { status: "running" } });
		expect(await status(s.id)).toBe("offline");
		await c.sessions.markOwnerOnline(c.alice.userId);
		expect(await status(s.id)).toBe("running");
	});
});

describe("transcript", () => {
	it("stores a gzip+base64 transcript for the owner and serves it to the team", async () => {
		const s = await c.registerSession();
		const content = gz('{"type":"session"}\n{"type":"message"}\n');
		const put = await c.t.api("PUT", `/api/sessions/${s.id}/transcript`, { token: c.alice.token, body: { content } });
		expect(put.data.bytes).toBe(content.length);
		const got = await c.t.api("GET", `/api/sessions/${s.id}/transcript`, { token: c.bob.token });
		expect(got.data).toMatchObject({ format: "pi-jsonl", content });
		const newer = gz("replaced");
		await c.t.api("PUT", `/api/sessions/${s.id}/transcript`, { token: c.alice.token, body: { content: newer } });
		expect((await c.t.api("GET", `/api/sessions/${s.id}/transcript`, { token: c.alice.token })).data.content).toBe(newer);
		expect((await c.t.api("PUT", `/api/sessions/${s.id}/transcript`, { token: c.bob.token, body: { content } })).status).toBe(403);
		expect((await c.t.api("GET", `/api/sessions/${s.id}/transcript`, { token: c.carol.token })).status).toBe(404);
	});

	it("returns null when nothing was uploaded and rejects malformed content", async () => {
		const s = await c.registerSession();
		expect((await c.t.api("GET", `/api/sessions/${s.id}/transcript`, { token: c.alice.token })).data).toBeNull();
		expect((await c.t.api("PUT", `/api/sessions/${s.id}/transcript`, { token: c.alice.token, body: { content: "not base64!!" } })).code).toBe("invalidTranscript");
		expect((await c.t.api("PUT", `/api/sessions/${s.id}/transcript`, { token: c.alice.token, body: { content: Buffer.from("plain text").toString("base64") } })).code).toBe("invalidTranscript");
		expect((await c.t.api("PUT", `/api/sessions/${s.id}/transcript`, { token: c.alice.token, body: {} })).status).toBe(400);
	});

	it("enforces the 20MB cap", async () => {
		const s = await c.registerSession();
		const big = "A".repeat(20 * 1024 * 1024 + 4);
		const r = await c.t.api("PUT", `/api/sessions/${s.id}/transcript`, { token: c.alice.token, body: { content: big } });
		expect(r.status).toBe(413);
		expect(r.code).toBe("payloadTooLarge");
	});
});

describe("grants", () => {
	it("only the owner grants and revokes; grants are audited and notified", async () => {
		const s = await c.registerSession();
		expect((await c.t.api("POST", `/api/sessions/${s.id}/grants`, { token: c.bob.token, body: { userId: c.bob.userId } })).status).toBe(403);
		expect((await c.t.api("POST", `/api/sessions/${s.id}/grants`, { token: c.root.token, body: { userId: c.bob.userId } })).status).toBe(403);

		const ok = await c.t.api("POST", `/api/sessions/${s.id}/grants`, { token: c.alice.token, body: { userId: c.bob.userId } });
		expect(ok.status).toBe(201);
		expect((await c.t.api("GET", `/api/sessions/${s.id}`, { token: c.bob.token })).data.canAct).toBe(true);
		expect((await c.t.api("GET", `/api/sessions/${s.id}`, { token: c.alice.token })).data.grants).toEqual([c.bob.userId]);
		expect((await c.t.api("GET", `/api/sessions/${s.id}/grants`, { token: c.alice.token })).data.map((g: any) => g.userId)).toEqual([c.bob.userId]);
		expect((await c.t.api("GET", `/api/sessions/${s.id}/grants`, { token: c.bob.token })).status).toBe(403);

		const notes = await c.t.api("GET", "/api/notifications?unread=1", { token: c.bob.token });
		const granted = notes.data.items.find((n: any) => n.kind === "session.granted" && n.payload.sessionId === s.id);
		expect(granted.payload).toMatchObject({ ownerUserId: c.alice.userId, title: s.title });

		const audit = await c.t.api("GET", `/api/admin/audit?orgId=${c.root.orgId}&action=session.grant`, { token: c.root.token });
		expect(audit.data.items.some((a: any) => a.targetId === s.id && a.actorId === c.alice.userId && a.detail.userId === c.bob.userId)).toBe(true);

		const again = await c.t.api("POST", `/api/sessions/${s.id}/grants`, { token: c.alice.token, body: { userId: c.bob.userId } });
		expect(again.status).toBe(201);
		const notes2 = await c.t.api("GET", "/api/notifications", { token: c.bob.token });
		expect(notes2.data.items.filter((n: any) => n.kind === "session.granted" && n.payload.sessionId === s.id)).toHaveLength(1);

		expect((await c.t.api("DELETE", `/api/sessions/${s.id}/grants/${c.bob.userId}`, { token: c.bob.token })).status).toBe(403);
		expect((await c.t.api("DELETE", `/api/sessions/${s.id}/grants/${c.bob.userId}`, { token: c.alice.token })).status).toBe(200);
		expect((await c.t.api("DELETE", `/api/sessions/${s.id}/grants/${c.bob.userId}`, { token: c.alice.token })).status).toBe(404);
		expect((await c.t.api("GET", `/api/sessions/${s.id}`, { token: c.bob.token })).data.canAct).toBe(false);
	});

	it("refuses grants to non-members, to the owner and to unknown users", async () => {
		const s = await c.registerSession();
		expect((await c.t.api("POST", `/api/sessions/${s.id}/grants`, { token: c.alice.token, body: { userId: c.carol.userId } })).code).toBe("notTeamMember");
		expect((await c.t.api("POST", `/api/sessions/${s.id}/grants`, { token: c.alice.token, body: { userId: c.alice.userId } })).code).toBe("selfGrant");
		expect((await c.t.api("POST", `/api/sessions/${s.id}/grants`, { token: c.alice.token, body: { userId: "nope" } })).status).toBe(404);
	});
});

describe("actions relay", () => {
	it("is refused without a grant, when the owner is offline, and for malformed actions", async () => {
		const s = await c.registerSession();
		const body = { type: "prompt", text: "hello" };
		expect((await c.t.api("POST", `/api/sessions/${s.id}/actions`, { token: c.bob.token, body })).code).toBe("notGranted");
		expect((await c.t.api("POST", `/api/sessions/${s.id}/actions`, { token: c.carol.token, body })).status).toBe(404);
		await c.t.api("POST", `/api/sessions/${s.id}/grants`, { token: c.alice.token, body: { userId: c.bob.userId } });
		const offline = await c.t.api("POST", `/api/sessions/${s.id}/actions`, { token: c.bob.token, body });
		expect(offline.status).toBe(409);
		expect(offline.code).toBe("ownerOffline");
		expect((await c.t.api("POST", `/api/sessions/${s.id}/actions`, { token: c.bob.token, body: { type: "prompt" } })).status).toBe(400);
		expect((await c.t.api("POST", `/api/sessions/${s.id}/actions`, { token: c.bob.token, body: { type: "respond", requestId: "r" } })).status).toBe(400);
		expect((await c.t.api("POST", `/api/sessions/${s.id}/actions`, { token: c.bob.token, body: { type: "explode" } })).status).toBe(400);
	});

	it("round-trips through the owner's member connection and audits it", async () => {
		const s = await c.registerSession();
		await c.t.api("POST", `/api/sessions/${s.id}/grants`, { token: c.alice.token, body: { userId: c.bob.userId } });
		const aliceWs = await connectWs(c.t.baseUrl, c.alice.token);
		const seen: any[] = [];
		aliceWs.autoRelay((f) => {
			seen.push(f);
			return { ok: true };
		});

		const prompt = await c.t.api("POST", `/api/sessions/${s.id}/actions`, { token: c.bob.token, body: { type: "prompt", text: "please add tests" } });
		expect(prompt.data).toEqual({ relayed: true });
		expect(seen[0]).toMatchObject({
			type: "relay",
			hubSessionId: s.id,
			sessionId: s.localSessionId,
			serverId: s.serverId,
			action: { type: "prompt", text: "please add tests" },
			actor: { userId: c.bob.userId, name: "Bob" },
		});
		expect(typeof seen[0].relayId).toBe("string");

		const respond = await c.t.api("POST", `/api/sessions/${s.id}/actions`, { token: c.bob.token, body: { type: "respond", requestId: "q1", response: { allow: true } } });
		expect(respond.status).toBe(200);
		expect(seen[1].action).toEqual({ type: "respond", requestId: "q1", response: { allow: true } });
		expect((await c.t.api("POST", `/api/sessions/${s.id}/actions`, { token: c.bob.token, body: { type: "abort" } })).status).toBe(200);
		expect(seen[2].action).toEqual({ type: "abort" });

		const audit = await c.t.api("GET", `/api/admin/audit?orgId=${c.root.orgId}&action=session.relay`, { token: c.root.token });
		const mine = audit.data.items.filter((a: any) => a.targetId === s.id);
		expect(mine).toHaveLength(3);
		expect(mine.every((a: any) => a.actorId === c.bob.userId && a.detail.result === "ok")).toBe(true);
		expect(mine.some((a: any) => a.detail.type === "prompt" && a.detail.textPreview === "please add tests")).toBe(true);

		// The owner may also act on their own session through the relay.
		expect((await c.t.api("POST", `/api/sessions/${s.id}/actions`, { token: c.alice.token, body: { type: "abort" } })).status).toBe(200);
		await aliceWs.close();
	});

	it("reports a failed execution as 502 and ignores answers from other connections", async () => {
		const s = await c.registerSession();
		await c.t.api("POST", `/api/sessions/${s.id}/grants`, { token: c.alice.token, body: { userId: c.bob.userId } });
		const aliceWs = await connectWs(c.t.baseUrl, c.alice.token);
		const bobWs = await connectWs(c.t.baseUrl, c.bob.token);
		aliceWs.autoRelay(() => ({ ok: false, error: "session busy" }));
		const failed = await c.t.api("POST", `/api/sessions/${s.id}/actions`, { token: c.bob.token, body: { type: "abort" } });
		expect(failed.status).toBe(502);
		expect(failed.code).toBe("relayFailed");
		expect(failed.body).toMatchObject({ error: { message: "session busy" } });
		await aliceWs.close();

		// Bob's own connection tries to answer a relay addressed to Alice's: it must not count.
		const alice2 = await connectWs(c.t.baseUrl, c.alice.token);
		alice2.autoRelay((f) => {
			bobWs.send({ type: "relayResult", relayId: f.relayId, ok: false, error: "forged" });
			setTimeout(() => alice2.send({ type: "relayResult", relayId: f.relayId, ok: true }), 50);
			return undefined;
		});
		const real = await c.t.api("POST", `/api/sessions/${s.id}/actions`, { token: c.bob.token, body: { type: "abort" } });
		expect(real.status).toBe(200);
		await alice2.close();
		await bobWs.close();
	});

	it("times out when the owner never answers", async () => {
		const aliceWs = await connectWs(c.t.baseUrl, c.alice.token);
		const msg = { hubSessionId: "h", sessionId: "l", serverId: "s", action: { type: "abort" as const }, actor: { userId: "u", name: "U" } };
		expect(await c.realtime.relay(c.alice.userId, msg, 80)).toEqual({ kind: "timeout" });
		expect(await c.realtime.relay("nobody", msg, 80)).toEqual({ kind: "offline" });
		await aliceWs.close();
	});

	it("resolves as offline when the owner disconnects mid-relay", async () => {
		const aliceWs = await connectWs(c.t.baseUrl, c.alice.token);
		const msg = { hubSessionId: "h", sessionId: "l", serverId: "s", action: { type: "abort" as const }, actor: { userId: "u", name: "U" } };
		const pending = c.realtime.relay(c.alice.userId, msg, 5000);
		await aliceWs.waitFor((f) => f.type === "relay");
		await aliceWs.close();
		expect(await pending).toEqual({ kind: "offline" });
	});
});

describe("fork", () => {
	it("creates a session owned by the forker, returns transcript and snapshot, and notifies the owner", async () => {
		const s = await c.registerSession(c.alice, { title: "Original" });
		const content = gz("transcript-body");
		await c.t.api("PUT", `/api/sessions/${s.id}/transcript`, { token: c.alice.token, body: { content } });
		await c.t.api("PATCH", `/api/sessions/${s.id}`, { token: c.alice.token, body: { snapshotCommit: "d".repeat(40) } });

		const r = await c.t.api("POST", `/api/sessions/${s.id}/fork`, { token: c.bob.token });
		expect(r.status).toBe(201);
		const { session, transcript, snapshotCommit, branch, sourceBranch } = r.data;
		expect(snapshotCommit).toBe("d".repeat(40));
		expect(transcript).toEqual({ format: "pi-jsonl", content });
		expect(session).toMatchObject({ ownerUserId: c.bob.userId, status: "idle", forkedFromSessionId: s.id, baseCommit: "d".repeat(40), title: "Original", workspaceId: c.workspaceId });
		expect(branch).toBe(`session/${c.bob.userId}/${session.id}`);
		expect(session.branch).toBe(branch);
		expect(sourceBranch).toBe(s.branch);

		const notes = await c.t.api("GET", "/api/notifications", { token: c.alice.token });
		const n = notes.data.items.find((x: any) => x.kind === "session.forked" && x.payload.sessionId === s.id);
		expect(n.payload).toMatchObject({ newSessionId: session.id, forkedBy: c.bob.userId, forkedByName: "Bob", title: "Original" });

		// The forker backfills the local mapping afterwards.
		const linked = await c.t.api("PATCH", `/api/sessions/${session.id}`, { token: c.bob.token, body: { localSessionId: "bob-local", serverId: "bob-srv", title: "My fork" } });
		expect(linked.data).toMatchObject({ localSessionId: "bob-local", title: "My fork" });
		expect((await c.t.api("PATCH", `/api/sessions/${session.id}`, { token: c.alice.token, body: { title: "hijack" } })).status).toBe(403);
	});

	it("falls back to the base commit without a snapshot, forks with no transcript, and refuses outsiders", async () => {
		const s = await c.registerSession(c.alice, { baseCommit: "e".repeat(40) });
		const r = await c.t.api("POST", `/api/sessions/${s.id}/fork`, { token: c.bob.token, body: { title: "Mine" } });
		expect(r.data.transcript).toBeNull();
		expect(r.data.snapshotCommit).toBeNull();
		expect(r.data.session).toMatchObject({ baseCommit: "e".repeat(40), title: "Mine" });
		expect((await c.t.api("POST", `/api/sessions/${s.id}/fork`, { token: c.carol.token })).status).toBe(404);
	});

	it("does not notify when forking one's own session", async () => {
		const s = await c.registerSession(c.bob);
		const before = (await c.t.api("GET", "/api/notifications", { token: c.bob.token })).data.items.length;
		await c.t.api("POST", `/api/sessions/${s.id}/fork`, { token: c.bob.token });
		expect((await c.t.api("GET", "/api/notifications", { token: c.bob.token })).data.items.length).toBe(before);
	});
});
