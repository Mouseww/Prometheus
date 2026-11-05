import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BHub, startB, startUpstream, type Upstream } from "./b-helpers.ts";

const KEY = "sk-personal-secret-9876";
const reply = (res: import("node:http").ServerResponse, body: unknown, status = 200): void => {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
};

describe("BYOK in private mode", () => {
	let b: BHub;
	let up: Upstream;
	let upstreamHandler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

	beforeAll(async () => {
		b = await startB();
		up = await startUpstream((req, res) => upstreamHandler(req, res));
	});
	afterAll(async () => {
		await up.stop();
		await b.stop();
	});

	const create = (token: string, body: Record<string, unknown> = {}) =>
		b.t.api("POST", "/api/me/gateways", { token, body: { name: "mine", format: "openai", baseUrl: `${up.url}/v1`, apiKey: KEY, models: ["my-model"], ...body } });

	it("creates, lists and masks a personal gateway; the key is stored sealed and never returned", async () => {
		const r = await create(b.alice.token);
		expect(r.status).toBe(201);
		expect(r.data).toMatchObject({ name: "mine", format: "openai", apiKeyMasked: "****9876", models: [{ id: "my-model" }], enabled: true });
		expect(JSON.stringify(r.body)).not.toContain(KEY);
		const list = await b.t.api("GET", "/api/me/gateways", { token: b.alice.token });
		expect(list.data).toHaveLength(1);
		expect(JSON.stringify(list.body)).not.toContain(KEY);
		const row = await b.t.hub.db.query<{ api_key_enc: string; scope: string; scope_id: string; org_id: string | null }>("SELECT api_key_enc, scope, scope_id, org_id FROM model_gateways WHERE id = $1", [r.data.id]);
		expect(row[0]?.api_key_enc).not.toContain(KEY);
		expect(row[0]).toMatchObject({ scope: "user", scope_id: b.alice.userId, org_id: null });
	});

	it("is private to its owner: others see nothing and cannot change it, and it is not in the admin gateway list", async () => {
		const mine = (await b.t.api("GET", "/api/me/gateways", { token: b.alice.token })).data[0];
		expect((await b.t.api("GET", "/api/me/gateways", { token: b.bob.token })).data).toEqual([]);
		expect((await b.t.api("PUT", `/api/me/gateways/${mine.id}`, { token: b.bob.token, body: { name: "x" } })).status).toBe(404);
		expect((await b.t.api("DELETE", `/api/me/gateways/${mine.id}`, { token: b.bob.token })).status).toBe(404);
		const admin = await b.t.api("GET", "/api/admin/gateways", { token: b.root.token });
		expect(admin.data.some((g: any) => g.id === mine.id)).toBe(false);
		const models = await b.t.api("GET", "/api/models", { token: b.alice.token });
		expect(models.data).toEqual([expect.objectContaining({ id: "my-model", source: "user", gatewayId: mine.id })]);
		expect((await b.t.api("GET", "/api/models", { token: b.bob.token })).data).toEqual([]);
	});

	it("updates fields and rotates the key without echoing it", async () => {
		const mine = (await b.t.api("GET", "/api/me/gateways", { token: b.alice.token })).data[0];
		const r = await b.t.api("PUT", `/api/me/gateways/${mine.id}`, { token: b.alice.token, body: { name: "renamed", apiKey: "sk-rotated-0000-abcd", enabled: true } });
		expect(r.data).toMatchObject({ name: "renamed", apiKeyMasked: "****abcd" });
		await b.t.api("PUT", `/api/me/gateways/${mine.id}`, { token: b.alice.token, body: { apiKey: KEY } });
	});

	it("rejects addresses the SSRF policy forbids even in private mode, and validates input", async () => {
		const meta = await create(b.alice.token, { name: "meta", baseUrl: "http://169.254.169.254/v1" });
		expect(meta.status).toBe(400);
		expect(meta.code).toBe("unsafeUrl");
		expect((await create(b.alice.token, { baseUrl: "ftp://example.com" })).status).toBe(400);
		expect((await create(b.alice.token, { baseUrl: "https://user:pw@example.com" })).status).toBe(400);
		expect((await create(b.alice.token, { name: "" })).status).toBe(400);
		expect((await b.t.api("POST", "/api/me/gateways", { token: b.alice.token, body: { name: "x" } })).status).toBe(400);
		expect((await b.t.api("POST", "/api/me/gateways")).status).toBe(401);
	});

	it("limits the number of personal gateways", async () => {
		const made: string[] = [];
		for (let i = 0; i < 20; i++) {
			const r = await create(b.bob.token, { name: `g${i}` });
			if (r.status !== 201) {
				expect(r.code).toBe("limitReached");
				break;
			}
			made.push(r.data.id);
		}
		expect(made).toHaveLength(10);
		for (const id of made) await b.t.api("DELETE", `/api/me/gateways/${id}`, { token: b.bob.token });
	});

	it("routes the owner's requests through the personal gateway, books source byok with zero cost, and others cannot use it", async () => {
		await b.resetLedger();
		upstreamHandler = (_req, res) => reply(res, { id: "r", usage: { prompt_tokens: 12, completion_tokens: 5 } });
		const r = await b.llm("openai/v1/chat/completions", { token: b.alice.token, body: { model: "my-model" } });
		expect(r.status).toBe(200);
		const seen = up.requests.at(-1)!;
		expect(seen.url).toBe("/v1/chat/completions");
		expect(seen.headers.authorization).toBe(`Bearer ${KEY}`);
		const rows = await b.ledger(1);
		expect(rows[0]).toMatchObject({ user_id: b.alice.userId, source: "byok", model: "my-model" });
		expect(Number(rows[0].cost_credits)).toBe(0);
		const other = await b.llm("openai/v1/chat/completions", { token: b.bob.token, body: { model: "my-model" } });
		expect(other.status).toBe(404);
		expect(((await other.json()) as any).error.code).toBe("noGateway");
	});

	it("refuses a personal gateway that now points at a forbidden address, and any redirect", async () => {
		const meta = await b.t.hub.db.tx({ system: true }, async (q) => {
			const rows = await q.query<{ id: string }>("SELECT id FROM model_gateways WHERE scope = 'user' AND scope_id = $1", [b.alice.userId]);
			const id = rows[0]!.id;
			await q.query("UPDATE model_gateways SET base_url = 'http://169.254.169.254/v1' WHERE id = $1", [id]);
			return id;
		});
		const blocked = await b.llm("openai/v1/chat/completions", { token: b.alice.token, body: { model: "my-model" } });
		expect(blocked.status).toBe(502);
		expect(((await blocked.json()) as any).error.code).toBe("unsafeUpstream");

		await b.t.hub.db.tx({ system: true }, (q) => q.query("UPDATE model_gateways SET base_url = $2 WHERE id = $1", [meta, `${up.url}/v1`]));
		upstreamHandler = (_req, res) => {
			res.writeHead(302, { location: "http://127.0.0.1:1/steal" });
			res.end();
		};
		const redirected = await b.llm("openai/v1/chat/completions", { token: b.alice.token, body: { model: "my-model" } });
		expect(redirected.status).toBe(502);
		expect(((await redirected.json()) as any).error.code).toBe("upstreamRedirect");
	});

	describe("disable switch", () => {
		it("a platform-wide disable blocks creation and use, but the owner can still list and delete", async () => {
			upstreamHandler = (_req, res) => reply(res, { usage: { prompt_tokens: 1, completion_tokens: 1 } });
			expect((await b.t.api("GET", "/api/me/byok", { token: b.alice.token })).data).toEqual({ allowed: true });
			expect((await b.t.api("PUT", "/api/admin/byok", { token: b.alice.token, body: { scope: "platform", allowed: false } })).status).toBe(403);
			const off = await b.t.api("PUT", "/api/admin/byok", { token: b.root.token, body: { scope: "platform", allowed: false } });
			expect(off.data).toEqual({ platform: false, org: null });

			expect((await b.t.api("GET", "/api/me/byok", { token: b.alice.token })).data).toEqual({ allowed: false });
			const denied = await create(b.alice.token, { name: "second" });
			expect(denied.status).toBe(403);
			expect(denied.code).toBe("byokDisabled");
			const blocked = await b.llm("openai/v1/chat/completions", { token: b.alice.token, body: { model: "my-model" } });
			expect(blocked.status).toBe(404);
			expect((await b.t.api("GET", "/api/models", { token: b.alice.token })).data).toEqual([]);
			const list = (await b.t.api("GET", "/api/me/gateways", { token: b.alice.token })).data;
			expect(list).toHaveLength(1);

			await b.t.api("PUT", "/api/admin/byok", { token: b.root.token, body: { scope: "platform", allowed: null } });
			expect((await b.llm("openai/v1/chat/completions", { token: b.alice.token, body: { model: "my-model" } })).status).toBe(200);
		});

		it("an organization override beats the platform setting: false wins over true, operators may re-enable", async () => {
			const { orgId } = b.root;
			// Organization admins may restrict their own organization but not lift a platform restriction.
			const orgAdmin = await b.t.createUser(b.root.token, "oa@corp.test", "OrgAdmin", orgId);
			await b.t.api("PUT", `/api/orgs/${orgId}/members/${orgAdmin.userId}`, { token: b.root.token, body: { role: "admin" } });
			const lift = await b.t.api("PUT", "/api/admin/byok", { token: orgAdmin.token, body: { scope: "org", orgId, allowed: true } });
			expect(lift.status).toBe(403);

			const restrict = await b.t.api("PUT", "/api/admin/byok", { token: orgAdmin.token, body: { scope: "org", orgId, allowed: false } });
			expect(restrict.status).toBe(200);
			expect(restrict.data).toEqual({ platform: true, org: false });
			expect((await b.t.api("GET", "/api/admin/byok", { token: orgAdmin.token, headers: {} })).status).toBe(403);
			expect((await b.t.api("GET", `/api/admin/byok?orgId=${orgId}`, { token: orgAdmin.token })).data).toEqual({ platform: true, org: false });
			expect((await b.t.api("GET", "/api/me/byok", { token: b.alice.token })).data).toEqual({ allowed: false });
			expect((await create(b.alice.token, { name: "third" })).status).toBe(403);

			await b.t.api("PUT", "/api/admin/byok", { token: b.root.token, body: { scope: "platform", allowed: false } });
			const lifted = await b.t.api("PUT", "/api/admin/byok", { token: b.root.token, body: { scope: "org", orgId, allowed: true } });
			expect(lifted.data).toEqual({ platform: false, org: true });
			expect((await b.t.api("GET", "/api/me/byok", { token: b.alice.token })).data).toEqual({ allowed: true });

			await b.t.api("PUT", "/api/admin/byok", { token: b.root.token, body: { scope: "org", orgId, allowed: null } });
			await b.t.api("PUT", "/api/admin/byok", { token: b.root.token, body: { scope: "platform", allowed: null } });
			expect((await b.t.api("GET", "/api/me/byok", { token: b.alice.token })).data).toEqual({ allowed: true });
		});
	});
});

describe("BYOK address policy by mode", () => {
	it("public mode only accepts https gateways on public addresses", async () => {
		const b = await startB({ mode: "public" });
		try {
			for (const baseUrl of ["http://127.0.0.1:8080/v1", "https://127.0.0.1/v1", "https://10.0.0.5/v1", "https://[::1]/v1", "http://8.8.8.8/v1", "https://8.8.8.8:8443/v1"]) {
				const r = await b.t.api("POST", "/api/me/gateways", { token: b.alice.token, body: { name: "x", format: "openai", baseUrl, apiKey: "k-1234567890" } });
				expect(r.status, baseUrl).toBe(400);
				expect(r.code, baseUrl).toBe("unsafeUrl");
			}
			const ok = await b.t.api("POST", "/api/me/gateways", { token: b.alice.token, body: { name: "ok", format: "openai", baseUrl: "https://8.8.8.8/v1", apiKey: "k-1234567890" } });
			expect(ok.status).toBe(201);
		} finally {
			await b.stop();
		}
	});

	it("HUB_BYOK_ALLOWED_PORTS opens extra ports, HUB_BYOK_BLOCK_PRIVATE closes intranet addresses in private mode", async () => {
		const ports = await startB({ mode: "public", env: { HUB_BYOK_ALLOWED_PORTS: "8443, 9443" } });
		const strict = await startB({ env: { HUB_BYOK_BLOCK_PRIVATE: "1" } });
		try {
			const body = (baseUrl: string) => ({ name: "x", format: "openai", baseUrl, apiKey: "k-1234567890" });
			expect((await ports.t.api("POST", "/api/me/gateways", { token: ports.alice.token, body: body("https://8.8.8.8:8443/v1") })).status).toBe(201);
			expect((await ports.t.api("POST", "/api/me/gateways", { token: ports.alice.token, body: body("https://8.8.8.8:8444/v1") })).status).toBe(400);
			expect((await strict.t.api("POST", "/api/me/gateways", { token: strict.alice.token, body: body("http://127.0.0.1:11434/v1") })).status).toBe(400);
			expect((await strict.t.api("POST", "/api/me/gateways", { token: strict.alice.token, body: body("http://8.8.8.8:11434/v1") })).status).toBe(201);
		} finally {
			await ports.stop();
			await strict.stop();
		}
	});
});
