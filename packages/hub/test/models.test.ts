import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulid } from "../src/ids.ts";
import { type Collab, startCollab } from "./s-helpers.ts";

let c: Collab;
beforeAll(async () => {
	c = await startCollab();
	// Carol becomes an organization admin; Alice and Bob stay plain members.
	const r = await c.t.api("PUT", `/api/orgs/${c.root.orgId}/members/${c.carol.userId}`, { token: c.root.token, body: { role: "admin" } });
	if (r.status !== 200) throw new Error(`提升 Carol 失败: ${JSON.stringify(r.body)}`);
});
afterAll(async () => {
	await c.stop();
});

const KEY = "sk-super-secret-key-9876";
const gw = (over: Record<string, unknown> = {}) => ({ scope: "platform", name: "Main", format: "openai", baseUrl: "https://api.example.com/v1/", apiKey: KEY, models: [{ id: "gpt-a", name: "GPT A" }, "gpt-b"], ...over });

describe("gateway admin", () => {
	let id: string;

	it("creates a platform gateway, masks the key everywhere and seals it at rest", async () => {
		const r = await c.t.api("POST", "/api/admin/gateways", { token: c.root.token, body: gw() });
		expect(r.status).toBe(201);
		id = r.data.id;
		expect(r.data).toMatchObject({
			scope: "platform",
			scopeId: "platform",
			name: "Main",
			format: "openai",
			baseUrl: "https://api.example.com/v1",
			apiKeyMasked: "****9876",
			models: [{ id: "gpt-a", name: "GPT A" }, { id: "gpt-b" }],
			enabled: true,
		});
		expect(JSON.stringify(r.body)).not.toContain(KEY);
		const list = await c.t.api("GET", "/api/admin/gateways", { token: c.root.token });
		expect(list.data.map((g: any) => g.id)).toContain(id);
		expect(JSON.stringify(list.body)).not.toContain(KEY);
		expect(JSON.stringify(list.body)).not.toContain("api_key_enc");

		const stored = await c.t.hub.db.query<{ api_key_enc: string }>("SELECT api_key_enc FROM model_gateways WHERE id = $1", [id]);
		expect(stored[0]?.api_key_enc.startsWith("v1:")).toBe(true);
		expect(stored[0]?.api_key_enc).not.toContain(KEY);
		expect(c.t.hub.deps.secretBox.open(stored[0]!.api_key_enc)).toBe(KEY);
	});

	it("updates fields, rotates the key only when given, and validates the base URL", async () => {
		const keep = await c.t.api("PUT", `/api/admin/gateways/${id}`, { token: c.root.token, body: { name: "Renamed", models: ["only-one"], enabled: false } });
		expect(keep.data).toMatchObject({ name: "Renamed", models: [{ id: "only-one" }], enabled: false, apiKeyMasked: "****9876" });
		const rotated = await c.t.api("PUT", `/api/admin/gateways/${id}`, { token: c.root.token, body: { apiKey: "sk-new-key-with-1111", format: "anthropic", baseUrl: "http://gateway.internal:8080/" } });
		expect(rotated.data).toMatchObject({ apiKeyMasked: "****1111", format: "anthropic", baseUrl: "http://gateway.internal:8080" });
		const row = await c.t.hub.db.query<{ api_key_enc: string }>("SELECT api_key_enc FROM model_gateways WHERE id = $1", [id]);
		expect(c.t.hub.deps.secretBox.open(row[0]!.api_key_enc)).toBe("sk-new-key-with-1111");

		for (const baseUrl of ["ftp://x.example.com", "not a url", "https://user:pw@x.example.com"]) {
			expect((await c.t.api("PUT", `/api/admin/gateways/${id}`, { token: c.root.token, body: { baseUrl } })).status).toBe(400);
		}
		expect((await c.t.api("PUT", `/api/admin/gateways/missing`, { token: c.root.token, body: { name: "x" } })).status).toBe(404);
	});

	it("validates create bodies", async () => {
		const bad = [{ ...gw(), format: "cohere" }, { ...gw(), apiKey: "" }, { ...gw(), name: "" }, { ...gw(), scope: "user" }, gw({ scope: "org" }), { ...gw(), models: [{ nope: 1 }] }, { ...gw(), baseUrl: "ftp://x" }];
		for (const body of bad) expect((await c.t.api("POST", "/api/admin/gateways", { token: c.root.token, body })).status).toBe(400);
		expect((await c.t.api("POST", "/api/admin/gateways", { token: c.root.token, body: gw({ scope: "org", scopeId: "no-such-org" }) })).status).toBe(404);
	});

	it("deletes a gateway and audits the changes", async () => {
		expect((await c.t.api("DELETE", `/api/admin/gateways/${id}`, { token: c.root.token })).status).toBe(200);
		expect((await c.t.api("DELETE", `/api/admin/gateways/${id}`, { token: c.root.token })).status).toBe(404);
		const audit = await c.t.api("GET", "/api/admin/audit?action=gateway.update", { token: c.root.token });
		expect(audit.data.items.some((a: any) => a.targetId === id && a.detail.keyChanged === true)).toBe(true);
		const del = await c.t.api("GET", "/api/admin/audit?action=gateway.delete", { token: c.root.token });
		expect(del.data.items.some((a: any) => a.targetId === id)).toBe(true);
		// The audit trail never contains the key.
		expect(JSON.stringify(audit.body)).not.toContain("sk-new-key");
	});
});

describe("gateway permissions", () => {
	it("members cannot manage gateways", async () => {
		expect((await c.t.api("GET", "/api/admin/gateways", { token: c.bob.token })).status).toBe(403);
		expect((await c.t.api("POST", "/api/admin/gateways", { token: c.bob.token, body: gw({ scope: "org", scopeId: c.root.orgId }) })).status).toBe(403);
		expect((await c.t.api("GET", "/api/admin/gateways")).status).toBe(401);
	});

	it("org admins manage organization gateways only and see only those", async () => {
		const platform = await c.t.api("POST", "/api/admin/gateways", { token: c.root.token, body: gw({ name: "Platform one" }) });
		expect((await c.t.api("POST", "/api/admin/gateways", { token: c.carol.token, body: gw() })).status).toBe(403);
		const mine = await c.t.api("POST", "/api/admin/gateways", { token: c.carol.token, body: gw({ scope: "org", scopeId: c.root.orgId, name: "Org one", apiKey: "sk-org-key-4242" }) });
		expect(mine.status).toBe(201);
		expect(mine.data).toMatchObject({ scope: "org", scopeId: c.root.orgId, apiKeyMasked: "****4242" });

		const list = await c.t.api("GET", "/api/admin/gateways", { token: c.carol.token });
		expect(list.data.map((g: any) => g.name)).toEqual(["Org one"]);
		expect((await c.t.api("GET", "/api/admin/gateways?scope=platform", { token: c.carol.token })).status).toBe(403);
		expect((await c.t.api("PUT", `/api/admin/gateways/${platform.data.id}`, { token: c.carol.token, body: { name: "hijack" } })).status).toBe(403);
		expect((await c.t.api("DELETE", `/api/admin/gateways/${platform.data.id}`, { token: c.carol.token })).status).toBe(403);
		expect((await c.t.api("PUT", `/api/admin/gateways/${mine.data.id}`, { token: c.carol.token, body: { name: "Org renamed" } })).data.name).toBe("Org renamed");

		const all = await c.t.api("GET", "/api/admin/gateways", { token: c.root.token });
		expect(all.data.map((g: any) => g.name)).toEqual(expect.arrayContaining(["Platform one", "Org renamed"]));
		const onlyOrg = await c.t.api("GET", `/api/admin/gateways?scope=org&orgId=${c.root.orgId}`, { token: c.root.token });
		expect(onlyOrg.data.map((g: any) => g.name)).toEqual(["Org renamed"]);

		await c.t.api("DELETE", `/api/admin/gateways/${mine.data.id}`, { token: c.carol.token });
		await c.t.api("DELETE", `/api/admin/gateways/${platform.data.id}`, { token: c.root.token });
	});
});

describe("GET /api/models", () => {
	it("lists models of enabled organization gateways first, then platform ones", async () => {
		expect((await c.t.api("GET", "/api/models", { token: c.bob.token })).data).toEqual([]);
		const p = await c.t.api("POST", "/api/admin/gateways", { token: c.root.token, body: gw({ name: "Plat", models: [{ id: "p1", name: "Platform 1" }] }) });
		const o = await c.t.api("POST", "/api/admin/gateways", { token: c.root.token, body: gw({ scope: "org", scopeId: c.root.orgId, name: "Org", format: "anthropic", models: ["o1", "o2"] }) });
		const off = await c.t.api("POST", "/api/admin/gateways", { token: c.root.token, body: gw({ name: "Off", enabled: false, models: ["hidden"] }) });
		const r = await c.t.api("GET", "/api/models", { token: c.bob.token });
		expect(r.data).toEqual([
			{ id: "o1", name: "o1", format: "anthropic", gatewayId: o.data.id, gatewayName: "Org", source: "org" },
			{ id: "o2", name: "o2", format: "anthropic", gatewayId: o.data.id, gatewayName: "Org", source: "org" },
			{ id: "p1", name: "Platform 1", format: "openai", gatewayId: p.data.id, gatewayName: "Plat", source: "platform" },
		]);
		expect(JSON.stringify(r.body)).not.toContain(KEY);
		for (const g of [p, o, off]) await c.t.api("DELETE", `/api/admin/gateways/${g.data.id}`, { token: c.root.token });
	});
});

describe("quotas", () => {
	it("operators and org admins set user quotas; members cannot; org quotas are operator only", async () => {
		const set = (token: string, body: unknown) => c.t.api("PUT", "/api/admin/quotas", { token, body });
		const q = await set(c.root.token, { subjectType: "user", subjectId: c.bob.userId, period: "day", limitTokens: 1000 });
		expect(q.data).toMatchObject({ subjectType: "user", subjectId: c.bob.userId, period: "day", limitTokens: 1000, orgId: c.root.orgId });
		const updated = await set(c.carol.token, { subjectType: "user", subjectId: c.bob.userId, period: "day", limitTokens: 2000 });
		expect(updated.data.limitTokens).toBe(2000);
		expect(updated.data.id).toBe(q.data.id);
		await set(c.carol.token, { subjectType: "user", subjectId: c.bob.userId, period: "month", limitTokens: 50000 });

		expect((await set(c.bob.token, { subjectType: "user", subjectId: c.bob.userId, period: "day", limitTokens: 9 })).status).toBe(403);
		expect((await set(c.carol.token, { subjectType: "org", subjectId: c.root.orgId, period: "month", limitTokens: 9 })).status).toBe(403);
		const org = await set(c.root.token, { subjectType: "org", subjectId: c.root.orgId, period: "month", limitTokens: 1_000_000 });
		expect(org.data).toMatchObject({ subjectType: "org", limitTokens: 1_000_000, orgId: c.root.orgId });

		expect((await set(c.root.token, { subjectType: "team", subjectId: "x", period: "day", limitTokens: 1 })).status).toBe(400);
		expect((await set(c.root.token, { subjectType: "user", subjectId: c.bob.userId, period: "week", limitTokens: 1 })).status).toBe(400);
		expect((await set(c.root.token, { subjectType: "user", subjectId: c.bob.userId, period: "day", limitTokens: -1 })).status).toBe(400);
		expect((await set(c.root.token, { subjectType: "user", subjectId: "ghost", period: "day", limitTokens: 1 })).status).toBe(404);
		expect((await set(c.root.token, { subjectType: "org", subjectId: "ghost", period: "day", limitTokens: 1 })).status).toBe(404);

		const mine = await c.t.api("GET", `/api/admin/quotas?subjectType=user&subjectId=${c.bob.userId}`, { token: c.carol.token });
		expect(mine.data.map((x: any) => `${x.period}:${x.limitTokens}`)).toEqual(["day:2000", "month:50000"]);
		const all = await c.t.api("GET", "/api/admin/quotas", { token: c.root.token });
		expect(all.data).toHaveLength(3);
		expect((await c.t.api("GET", "/api/admin/quotas", { token: c.bob.token })).status).toBe(403);

		expect((await set(c.root.token, { subjectType: "user", subjectId: c.bob.userId, period: "month", limitTokens: null })).data).toBeNull();
		expect((await c.t.api("GET", `/api/admin/quotas?subjectType=user&subjectId=${c.bob.userId}`, { token: c.root.token })).data).toHaveLength(1);
		const audit = await c.t.api("GET", "/api/admin/audit?action=quota.set", { token: c.root.token });
		expect(audit.data.items.length).toBeGreaterThanOrEqual(3);
	});
});

describe("usage report", () => {
	async function ledger(userId: string, model: string, input: number, output: number, at: string, orgId: string | null = c.root.orgId): Promise<void> {
		await c.t.hub.db.tx({ system: true }, (q) =>
			q.query("INSERT INTO usage_ledger (id, user_id, org_id, model, input_tokens, output_tokens, source, at) VALUES ($1,$2,$3,$4,$5,$6,'platform',$7::timestamptz)", [ulid(), userId, orgId, model, input, output, at]),
		);
	}

	beforeAll(async () => {
		await c.t.hub.db.tx({ system: true }, (q) => q.query("DELETE FROM usage_ledger"));
		await ledger(c.alice.userId, "gpt-a", 100, 50, "2026-03-01T10:00:00Z");
		await ledger(c.alice.userId, "gpt-b", 10, 5, "2026-03-02T23:30:00Z");
		await ledger(c.bob.userId, "gpt-a", 1, 2, "2026-03-02T01:00:00Z");
		await ledger("system", "gpt-a", 7, 3, "2026-03-02T02:00:00Z");
		await ledger(c.bob.userId, "other-org-model", 1000, 1000, "2026-03-02T03:00:00Z", null);
	});

	it("groups by user, org, day and model", async () => {
		const get = async (qs: string, token = c.root.token) => (await c.t.api("GET", `/api/admin/usage?${qs}`, { token })).data as any[];

		const byUser = await get("groupBy=user");
		expect(byUser.find((r) => r.key === c.alice.userId)).toEqual({ key: c.alice.userId, label: "Alice", inputTokens: 110, outputTokens: 55, requests: 2 });
		expect(byUser.find((r) => r.key === "system")).toMatchObject({ inputTokens: 7, outputTokens: 3, requests: 1, label: "system" });
		expect(byUser[0]?.key).toBe(c.bob.userId);

		const byOrg = await get("groupBy=org");
		expect(byOrg.find((r) => r.key === c.root.orgId)).toMatchObject({ label: expect.any(String), inputTokens: 118, outputTokens: 60, requests: 4 });
		expect(byOrg.find((r) => r.key === "")).toMatchObject({ inputTokens: 1000, requests: 1 });

		const byDay = await get("groupBy=day");
		expect(byDay.map((r) => r.key)).toEqual(["2026-03-02", "2026-03-01"]);
		expect(byDay[1]).toMatchObject({ inputTokens: 100, outputTokens: 50, requests: 1 });

		const byModel = await get("groupBy=model");
		expect(byModel.find((r) => r.key === "gpt-a")).toMatchObject({ inputTokens: 108, outputTokens: 55, requests: 3 });
	});

	it("filters by range with an inclusive date-only upper bound", async () => {
		const get = async (qs: string) => (await c.t.api("GET", `/api/admin/usage?groupBy=day&${qs}`, { token: c.root.token })).data as any[];
		expect((await get("from=2026-03-02")).map((r) => r.key)).toEqual(["2026-03-02"]);
		expect((await get("to=2026-03-01")).map((r) => r.key)).toEqual(["2026-03-01"]);
		expect((await get("from=2026-03-01&to=2026-03-02")).map((r) => r.key)).toEqual(["2026-03-02", "2026-03-01"]);
		expect((await get("from=2026-03-02T02:30:00Z&to=2026-03-02T05:00:00Z"))[0]).toMatchObject({ requests: 1, inputTokens: 1000 });
		expect(await get("from=2030-01-01")).toEqual([]);
	});

	it("restricts org admins to their organization and refuses members", async () => {
		const rows = (await c.t.api("GET", "/api/admin/usage?groupBy=user", { token: c.carol.token })).data as any[];
		expect(rows.every((r) => r.key !== "other-org-model")).toBe(true);
		expect(rows.reduce((n, r) => n + r.requests, 0)).toBe(4);
		expect((await c.t.api("GET", "/api/admin/usage?groupBy=user", { token: c.bob.token })).status).toBe(403);
		expect((await c.t.api("GET", "/api/admin/usage?groupBy=team", { token: c.root.token })).status).toBe(400);
		expect((await c.t.api("GET", "/api/admin/usage", { token: c.root.token })).status).toBe(400);
		expect((await c.t.api("GET", "/api/admin/usage?groupBy=day&from=garbage", { token: c.root.token })).status).toBe(400);
	});
});
