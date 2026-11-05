import { describe, expect, it, vi } from "vitest";
import { createApiMethods, type Requester } from "../src/team/api.ts";
import { createHubApi, type KeyValueStore, ACCESS_KEY } from "../src/team/hubApi.ts";
import { createMemberApi } from "../src/team/memberApi.ts";

interface Seen {
	method: string;
	path: string;
	body?: unknown;
}

function recorder() {
	const seen: Seen[] = [];
	const requester: Requester = {
		async request<T>(method: string, path: string, body?: unknown): Promise<T> {
			seen.push(body === undefined ? { method, path } : { method, path, body });
			return undefined as T;
		},
	};
	return { seen, api: createApiMethods(requester) };
}

describe("TeamApi collaboration methods (shared request construction)", () => {
	it("builds session requests", async () => {
		const { seen, api } = recorder();
		await api.listSessions("w 1", { status: "running", owner: "u1", limit: 20 });
		await api.getSession("s1");
		await api.listSessionEvents("s1", { after: 41, limit: 200 });
		await api.listSessionEvents("s1", { after: -1 });
		await api.getSessionTranscript("s1");
		await api.browseSessionFiles("s1", "src/a b");
		await api.browseSessionFiles("s1");
		await api.listSessionGrants("s1");
		await api.grantSession("s1", "u2");
		await api.revokeSessionGrant("s1", "u2");
		await api.forkSession("s1");
		await api.forkSession("s1", { title: "mine" });
		expect(seen).toEqual([
			{ method: "GET", path: "/api/workspaces/w%201/sessions?status=running&owner=u1&limit=20" },
			{ method: "GET", path: "/api/sessions/s1" },
			{ method: "GET", path: "/api/sessions/s1/events?after=41&limit=200" },
			{ method: "GET", path: "/api/sessions/s1/events?after=-1" },
			{ method: "GET", path: "/api/sessions/s1/transcript" },
			{ method: "GET", path: "/api/sessions/s1/files?path=src%2Fa%20b" },
			{ method: "GET", path: "/api/sessions/s1/files" },
			{ method: "GET", path: "/api/sessions/s1/grants" },
			{ method: "POST", path: "/api/sessions/s1/grants", body: { userId: "u2" } },
			{ method: "DELETE", path: "/api/sessions/s1/grants/u2" },
			{ method: "POST", path: "/api/sessions/s1/fork", body: {} },
			{ method: "POST", path: "/api/sessions/s1/fork", body: { title: "mine" } },
		]);
	});

	it("builds relay actions", async () => {
		const { seen, api } = recorder();
		await api.sendSessionAction("s1", { type: "prompt", text: "hi" });
		await api.sendSessionAction("s1", { type: "respond", requestId: "r1", response: { value: "allow" } });
		await api.sendSessionAction("s1", { type: "abort" });
		expect(seen).toEqual([
			{ method: "POST", path: "/api/sessions/s1/actions", body: { type: "prompt", text: "hi" } },
			{ method: "POST", path: "/api/sessions/s1/actions", body: { type: "respond", requestId: "r1", response: { value: "allow" } } },
			{ method: "POST", path: "/api/sessions/s1/actions", body: { type: "abort" } },
		]);
	});

	it("builds board, report and notification requests", async () => {
		const { seen, api } = recorder();
		await api.getBoard("w1");
		await api.getReport("w1");
		await api.getReport("w1", "2026-11-04");
		await api.generateReport("w1");
		await api.generateReport("w1", "2026-11-04");
		await api.listNotifications();
		await api.listNotifications({ unread: true, before: "n9", limit: 30 });
		await api.markNotificationsRead({ ids: ["n1", "n2"] });
		await api.markNotificationsRead({ all: true });
		expect(seen).toEqual([
			{ method: "GET", path: "/api/workspaces/w1/board" },
			{ method: "GET", path: "/api/workspaces/w1/reports" },
			{ method: "GET", path: "/api/workspaces/w1/reports?date=2026-11-04" },
			{ method: "POST", path: "/api/workspaces/w1/reports/generate", body: {} },
			{ method: "POST", path: "/api/workspaces/w1/reports/generate", body: { date: "2026-11-04" } },
			{ method: "GET", path: "/api/notifications" },
			{ method: "GET", path: "/api/notifications?unread=1&before=n9&limit=30" },
			{ method: "POST", path: "/api/notifications/read", body: { ids: ["n1", "n2"] } },
			{ method: "POST", path: "/api/notifications/read", body: { all: true } },
		]);
	});

	it("builds gateway, quota, usage and model requests", async () => {
		const { seen, api } = recorder();
		await api.listGateways();
		await api.listGateways({ scope: "org", orgId: "o1" });
		await api.createGateway({ scope: "org", scopeId: "o1", name: "G", format: "openai", baseUrl: "https://x", apiKey: "k", models: [{ id: "m" }], enabled: true });
		await api.updateGateway("g1", { enabled: false });
		await api.deleteGateway("g1");
		await api.listQuotas({ subjectType: "user", subjectId: "u1" });
		await api.setQuota({ subjectType: "org", subjectId: "o1", period: "month", limitTokens: 1000 });
		await api.setQuota({ subjectType: "org", subjectId: "o1", period: "month", limitTokens: null });
		await api.getUsage({ groupBy: "day", from: "2026-11-01", to: "2026-11-05" });
		await api.getUsage({ groupBy: "model" });
		await api.listModels();
		expect(seen).toEqual([
			{ method: "GET", path: "/api/admin/gateways" },
			{ method: "GET", path: "/api/admin/gateways?scope=org&orgId=o1" },
			{ method: "POST", path: "/api/admin/gateways", body: { scope: "org", scopeId: "o1", name: "G", format: "openai", baseUrl: "https://x", apiKey: "k", models: [{ id: "m" }], enabled: true } },
			{ method: "PUT", path: "/api/admin/gateways/g1", body: { enabled: false } },
			{ method: "DELETE", path: "/api/admin/gateways/g1" },
			{ method: "GET", path: "/api/admin/quotas?subjectType=user&subjectId=u1" },
			{ method: "PUT", path: "/api/admin/quotas", body: { subjectType: "org", subjectId: "o1", period: "month", limitTokens: 1000 } },
			{ method: "PUT", path: "/api/admin/quotas", body: { subjectType: "org", subjectId: "o1", period: "month", limitTokens: null } },
			{ method: "GET", path: "/api/admin/usage?groupBy=day&from=2026-11-01&to=2026-11-05" },
			{ method: "GET", path: "/api/admin/usage?groupBy=model" },
			{ method: "GET", path: "/api/models" },
		]);
	});
});

describe("both implementations carry the new methods", () => {
	it("member mode relays through team / hub.request", async () => {
		const call = vi.fn(async () => ({ ok: true, data: { items: [], nextAfter: 3, hasMore: false } }));
		const api = createMemberApi(call);
		await expect(api.listSessionEvents("s1", { after: 2 })).resolves.toEqual({ items: [], nextAfter: 3, hasMore: false });
		await api.sendSessionAction("s1", { type: "abort" });
		expect(call.mock.calls).toEqual([
			["team", "hub.request", { method: "GET", path: "/api/sessions/s1/events?after=2" }],
			["team", "hub.request", { method: "POST", path: "/api/sessions/s1/actions", body: { type: "abort" } }],
		]);
	});

	it("member mode surfaces relay error codes", async () => {
		const api = createMemberApi(async () => ({ ok: false, error: { code: "ownerOffline", message: "owner offline" } }));
		await expect(api.sendSessionAction("s1", { type: "prompt", text: "x" })).rejects.toMatchObject({ code: "ownerOffline" });
	});

	it("hub mode sends the same paths with the bearer token", async () => {
		const data = new Map<string, string>([[ACCESS_KEY, "tok"]]);
		const store: KeyValueStore = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 }));
		const api = createHubApi({ fetch: fetchMock as unknown as typeof fetch, session: store, local: store });
		await api.getBoard("w1");
		await api.setQuota({ subjectType: "user", subjectId: "u1", period: "day", limitTokens: 5 });
		const [first, second] = fetchMock.mock.calls;
		expect(String(first?.[0])).toBe("/plugins/team/api/workspaces/w1/board");
		expect(String(second?.[0])).toBe("/plugins/team/api/admin/quotas");
		expect(second?.[1]?.method).toBe("PUT");
		expect(JSON.parse(String(second?.[1]?.body))).toEqual({ subjectType: "user", subjectId: "u1", period: "day", limitTokens: 5 });
		expect(new Headers(second?.[1]?.headers).get("authorization")).toBe("Bearer tok");
	});
});
