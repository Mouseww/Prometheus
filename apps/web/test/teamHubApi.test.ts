import { describe, expect, it, vi } from "vitest";
import { TeamApiError, withQuery } from "../src/team/api.ts";
import { ACCESS_KEY, createHubApi, jwtExpiry, type KeyValueStore, REFRESH_KEY, type SocketLike } from "../src/team/hubApi.ts";

function memStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => void data.set(k, v),
		removeItem: (k) => void data.delete(k),
	};
}

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, code: string, message = code) => new Response(JSON.stringify({ ok: false, error: { code, message } }), { status });
const pair = (n: number) => ({ accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresIn: 900, user: { id: "u1" } });

interface Call {
	url: string;
	method: string;
	auth: string | null;
	body: unknown;
}

function setup(handler: (call: Call) => Response | Promise<Response>, tokens: Record<string, string> = {}, local: Record<string, string> = {}) {
	const session = memStore(tokens);
	const localStore = memStore(local);
	const calls: Call[] = [];
	const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const call: Call = { url: String(url), method: init?.method ?? "GET", auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined };
		calls.push(call);
		return handler(call);
	});
	const api = createHubApi({ fetch: fetchMock as unknown as typeof fetch, session, local: localStore });
	return { api, calls, session, local: localStore };
}

describe("withQuery", () => {
	it("keeps only defined values and encodes them", () => {
		expect(withQuery("/api/x", { a: "1 2", b: undefined, c: "", d: 0, e: false })).toBe("/api/x?a=1%202&d=0&e=false");
		expect(withQuery("/api/x", {})).toBe("/api/x");
	});
});

describe("createHubApi request construction", () => {
	it("sends bearer token, JSON body and unwraps the envelope", async () => {
		const { api, calls } = setup(() => ok({ id: "t1" }, 201), { [ACCESS_KEY]: "tok" });
		const team = await api.createTeam({ name: "Core", orgId: null });
		expect(team).toEqual({ id: "t1" });
		expect(calls[0]).toMatchObject({ url: "/plugins/team/api/teams", method: "POST", auth: "Bearer tok", body: { name: "Core", orgId: null } });
	});

	it("builds paths and queries for the main endpoints", async () => {
		const { api, calls } = setup(() => ok([]), { [ACCESS_KEY]: "tok" });
		await api.listMergeRequests("w 1", { status: "open" });
		await api.listUsers({ status: "pending", q: "ann", limit: 50 });
		await api.listAudit({ orgId: "o1", before: "a9" });
		await api.setTeamMemberRole("t1", "u/2", "reviewer");
		await api.updateWorkspace("w1", { dailyReportEnabled: false, upstreamToken: null });
		await api.rejectMergeRequest("m1");
		await api.rejectMergeRequest("m1", "no");
		await api.removeOrgMember("o1", "u1");
		const seen = calls.map((c) => `${c.method} ${c.url.replace("/plugins/team", "")}`);
		expect(seen).toEqual([
			"GET /api/workspaces/w%201/merge-requests?status=open",
			"GET /api/admin/users?status=pending&q=ann&limit=50",
			"GET /api/admin/audit?orgId=o1&before=a9",
			"PUT /api/teams/t1/members/u%2F2",
			"PATCH /api/workspaces/w1",
			"POST /api/merge-requests/m1/reject",
			"POST /api/merge-requests/m1/reject",
			"DELETE /api/orgs/o1/members/u1",
		]);
		expect(calls[3]?.body).toEqual({ role: "reviewer" });
		expect(calls[4]?.body).toEqual({ dailyReportEnabled: false, upstreamToken: null });
		expect(calls[5]?.body).toEqual({});
		expect(calls[6]?.body).toEqual({ reason: "no" });
	});

	it("does not send a token for public endpoints", async () => {
		const { api, calls } = setup(() => ok({ needsSetup: true }), { [ACCESS_KEY]: "tok" });
		await api.meta();
		await api.lookupInvitation("abc/def");
		expect(calls.every((c) => c.auth === null)).toBe(true);
		expect(calls[1]?.url).toBe("/plugins/team/api/invitations/abc%2Fdef");
	});

	it("turns an error envelope into TeamApiError with the Hub code", async () => {
		const { api } = setup(() => fail(403, "forbidden", "nope"), { [ACCESS_KEY]: "tok" });
		await expect(api.listTeams()).rejects.toMatchObject({ name: "TeamApiError", status: 403, code: "forbidden", message: "nope" });
	});

	it("maps network failures and non-JSON replies", async () => {
		const net = createHubApi({
			fetch: (async () => {
				throw new TypeError("offline");
			}) as unknown as typeof fetch,
			session: memStore(),
			local: memStore(),
		});
		await expect(net.listTeams()).rejects.toMatchObject({ code: "network", status: 0 });
		const html = setup(() => new Response("<html>", { status: 502 }));
		await expect(html.api.listTeams()).rejects.toMatchObject({ code: "badResponse", status: 502 });
	});
});

describe("login and token storage", () => {
	it("stores the refresh token in localStorage only with remember me", async () => {
		const a = setup(() => ok(pair(1)));
		await a.api.login("a@b.co", "pw", true);
		expect(a.session.data.get(ACCESS_KEY)).toBe("access-1");
		expect(a.local.data.get(REFRESH_KEY)).toBe("refresh-1");
		expect(a.session.data.has(REFRESH_KEY)).toBe(false);

		const b = setup(() => ok(pair(1)));
		await b.api.login("a@b.co", "pw", false);
		expect(b.local.data.has(REFRESH_KEY)).toBe(false);
		expect(b.session.data.get(REFRESH_KEY)).toBe("refresh-1");
		expect(b.api.hasSession()).toBe(true);
	});

	it("logout calls the Hub, clears tokens and notifies", async () => {
		const { api, calls, session, local } = setup(() => ok({}), { [ACCESS_KEY]: "a", [REFRESH_KEY]: "r" }, {});
		const ended = vi.fn();
		api.onSessionEnd(ended);
		await api.logout();
		expect(calls[0]).toMatchObject({ url: "/plugins/team/api/auth/logout", body: { refreshToken: "r" } });
		expect(session.data.size + local.data.size).toBe(0);
		expect(ended).toHaveBeenCalledTimes(1);
		expect(api.hasSession()).toBe(false);
	});
});

describe("refresh on 401", () => {
	it("refreshes once, retries the request with the new token and keeps remember-me storage", async () => {
		let n = 0;
		const { api, calls, session, local } = setup(
			(c) => {
				if (c.url.endsWith("/auth/refresh")) return ok(pair(2));
				n += 1;
				return n === 1 ? fail(401, "invalidToken") : ok([{ id: "t" }]);
			},
			{ [ACCESS_KEY]: "stale" },
			{ [REFRESH_KEY]: "refresh-1" },
		);
		await expect(api.listTeams()).resolves.toEqual([{ id: "t" }]);
		expect(calls.map((c) => c.url.split("/api").pop())).toEqual(["/teams", "/auth/refresh", "/teams"]);
		expect(calls[1]?.body).toEqual({ refreshToken: "refresh-1" });
		expect(calls[1]?.auth).toBeNull();
		expect(calls[2]?.auth).toBe("Bearer access-2");
		expect(session.data.get(ACCESS_KEY)).toBe("access-2");
		expect(local.data.get(REFRESH_KEY)).toBe("refresh-2");
	});

	it("shares one refresh between concurrent 401s", async () => {
		const seen = new Set<string>();
		const { api, calls } = setup(
			async (c) => {
				if (c.url.endsWith("/auth/refresh")) {
					await new Promise((r) => setTimeout(r, 5));
					return ok(pair(2));
				}
				if (c.auth === "Bearer access-2") return ok([]);
				seen.add(c.url);
				return fail(401, "invalidToken");
			},
			{ [ACCESS_KEY]: "stale", [REFRESH_KEY]: "refresh-1" },
		);
		await Promise.all([api.listTeams(), api.listOrgs(), api.listUsers()]);
		expect(calls.filter((c) => c.url.endsWith("/auth/refresh"))).toHaveLength(1);
	});

	it("does not retry more than once and ends the session when refresh is rejected", async () => {
		const { api, calls, session } = setup(
			(c) => (c.url.endsWith("/auth/refresh") ? fail(401, "invalidToken") : fail(401, "invalidToken")),
			{ [ACCESS_KEY]: "stale", [REFRESH_KEY]: "dead" },
		);
		const ended = vi.fn();
		api.onSessionEnd(ended);
		await expect(api.listTeams()).rejects.toBeInstanceOf(TeamApiError);
		expect(calls).toHaveLength(2);
		expect(ended).toHaveBeenCalledTimes(1);
		expect(session.data.size).toBe(0);
	});

	it("keeps the session when the refresh call itself fails with a server error", async () => {
		const { api, session } = setup((c) => (c.url.endsWith("/auth/refresh") ? fail(503, "internalError") : fail(401, "invalidToken")), {
			[ACCESS_KEY]: "stale",
			[REFRESH_KEY]: "r",
		});
		const ended = vi.fn();
		api.onSessionEnd(ended);
		await expect(api.listTeams()).rejects.toMatchObject({ status: 401 });
		expect(ended).not.toHaveBeenCalled();
		expect(session.data.get(REFRESH_KEY)).toBe("r");
	});

	it("ends the session on 401 when there is no refresh token at all", async () => {
		const { api } = setup(() => fail(401, "unauthorized"), { [ACCESS_KEY]: "x" });
		const ended = vi.fn();
		api.onSessionEnd(ended);
		await expect(api.me()).rejects.toMatchObject({ status: 401 });
		expect(ended).toHaveBeenCalledTimes(1);
	});
});

class FakeSocket implements SocketLike {
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onclose: ((ev: unknown) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	sent: string[] = [];
	closed = false;
	constructor(readonly token: string) {}
	send(d: string) {
		this.sent.push(d);
	}
	close() {
		this.closed = true;
	}
}

describe("subscribe (WebSocket)", () => {
	it("connects with the access token, subscribes, dispatches events and reconnects with backoff", async () => {
		vi.useFakeTimers();
		try {
			const sockets: FakeSocket[] = [];
			const api = createHubApi({
				fetch: (async () => ok({})) as unknown as typeof fetch,
				session: memStore({ [ACCESS_KEY]: "tok" }),
				local: memStore(),
				openSocket: (token) => {
					const s = new FakeSocket(token);
					sockets.push(s);
					return s;
				},
			});
			const got: unknown[] = [];
			const off = api.subscribe("workspace:w1", (e) => got.push(e));
			await vi.advanceTimersByTimeAsync(0);
			expect(sockets).toHaveLength(1);
			expect(sockets[0]?.token).toBe("tok");
			sockets[0]?.onopen?.({});
			expect(sockets[0]?.sent).toContain(JSON.stringify({ type: "subscribe", topic: "workspace:w1" }));

			sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "event", topic: "workspace:w1", data: { n: 1 } }) });
			sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "event", topic: "other", data: 2 }) });
			sockets[0]?.onmessage?.({ data: "not json" });
			expect(got).toEqual([{ n: 1 }]);

			// First drop: reconnect after 1 s; the next drop waits 2 s.
			sockets[0]?.onclose?.({});
			await vi.advanceTimersByTimeAsync(999);
			expect(sockets).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(sockets).toHaveLength(2);
			sockets[1]?.onclose?.({});
			await vi.advanceTimersByTimeAsync(1999);
			expect(sockets).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(sockets).toHaveLength(3);

			off();
			expect(sockets[2]?.closed).toBe(true);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(sockets).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("caps the backoff at the configured maximum", async () => {
		vi.useFakeTimers();
		try {
			const sockets: FakeSocket[] = [];
			const api = createHubApi({
				fetch: (async () => ok({})) as unknown as typeof fetch,
				session: memStore({ [ACCESS_KEY]: "tok" }),
				local: memStore(),
				maxBackoffMs: 3000,
				openSocket: (token) => {
					const s = new FakeSocket(token);
					sockets.push(s);
					return s;
				},
			});
			api.subscribe("user", () => undefined);
			await vi.advanceTimersByTimeAsync(0);
			for (let i = 0; i < 5; i++) {
				sockets[i]?.onclose?.({});
				await vi.advanceTimersByTimeAsync(3000);
			}
			expect(sockets.length).toBe(6);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("jwtExpiry", () => {
	it("reads exp from a JWT payload and tolerates junk", () => {
		const payload = btoa(JSON.stringify({ exp: 1234 })).replace(/=+$/, "");
		expect(jwtExpiry(`h.${payload}.s`)).toBe(1234);
		expect(jwtExpiry("junk")).toBeUndefined();
		expect(jwtExpiry("a.!!!.c")).toBeUndefined();
	});
});
