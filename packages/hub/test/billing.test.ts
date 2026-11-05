import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeCost, consume, estimateCost, issuePeriodGrants, requestedMaxTokens } from "../src/billing/wallet.ts";
import type { BillingService } from "../src/billing/index.ts";
import { type BHub, startB, startUpstream, type Upstream } from "./b-helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const json = (res: import("node:http").ServerResponse, body: unknown, status = 200): void => {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
};

describe("pricing arithmetic", () => {
	const price = { inputPrice: 10_000, outputPrice: 30_000 };
	it("rounds up to whole credits, at least one", () => {
		expect(computeCost(price, 1000, 500)).toBe(25);
		expect(computeCost(price, 1, 1)).toBe(1);
		expect(computeCost(price, 0, 0)).toBe(0);
		expect(computeCost({ inputPrice: 0, outputPrice: 0 }, 1000, 1000)).toBe(0);
		expect(computeCost(price, 100, 33)).toBe(2);
	});
	it("estimates from the output cap, defaulting to 4096 tokens", () => {
		expect(estimateCost(price, 1000)).toBe(30);
		expect(estimateCost(price, undefined)).toBe(123);
		expect(estimateCost({ inputPrice: 5, outputPrice: 0 }, 1000)).toBe(0);
	});
	it("finds the output cap in every request shape", () => {
		expect(requestedMaxTokens({ max_tokens: 10 })).toBe(10);
		expect(requestedMaxTokens({ max_completion_tokens: 20 })).toBe(20);
		expect(requestedMaxTokens({ max_output_tokens: 30 })).toBe(30);
		expect(requestedMaxTokens({ generationConfig: { maxOutputTokens: 40 } })).toBe(40);
		expect(requestedMaxTokens({ max_tokens: -1 })).toBeUndefined();
		expect(requestedMaxTokens("x")).toBeUndefined();
		expect(requestedMaxTokens(undefined)).toBeUndefined();
	});
});

describe("wallet and grants", () => {
	let b: BHub;
	beforeAll(async () => {
		b = await startB({ billing: true });
	});
	afterAll(() => b.stop());
	const db = () => b.t.hub.db;
	const reset = () => db().tx({ system: true }, (q) => q.query("DELETE FROM credit_grants"));
	const insert = (id: string, subject: string, credits: number, expiresInMs: number | null, remaining = credits, source = "admin") =>
		db().tx({ system: true }, (q) =>
			q.query("INSERT INTO credit_grants (id, subject_type, subject_id, source, amount, remaining, expires_at, created_at) VALUES ($1,'user',$2,$3,$4,$5,$6::timestamptz, now())", [
				id,
				subject,
				source,
				credits,
				remaining,
				expiresInMs === null ? null : new Date(Date.now() + expiresInMs).toISOString(),
			]),
		);
	const remainingOf = async (id: string): Promise<number> => Number((await db().query<{ remaining: string }>("SELECT remaining FROM credit_grants WHERE id = $1", [id]))[0]?.remaining);
	const subject = (): { type: "user"; id: string } => ({ type: "user", id: b.alice.userId });
	const nowIso = (): string => new Date().toISOString();

	it("consumes the earliest expiring grant first and never touches expired ones", async () => {
		await reset();
		await insert("late", b.alice.userId, 100, 2 * DAY);
		await insert("soon", b.alice.userId, 50, DAY);
		await insert("never", b.alice.userId, 200, null);
		await insert("expired", b.alice.userId, 999, -DAY);
		expect(await b.balance("user", b.alice.userId)).toBe(350);

		const first = await db().tx({ system: true }, (q) => consume(q, subject(), 120, nowIso()));
		expect(first).toEqual({ charged: 120, overdraft: 0 });
		expect(await remainingOf("soon")).toBe(0);
		expect(await remainingOf("late")).toBe(30);
		expect(await remainingOf("never")).toBe(200);
		expect(await remainingOf("expired")).toBe(999);

		const second = await db().tx({ system: true }, (q) => consume(q, subject(), 300, nowIso()));
		expect(second).toEqual({ charged: 230, overdraft: 70 });
		expect(await b.balance("user", b.alice.userId)).toBe(0);
		expect(await remainingOf("expired")).toBe(999);
	});

	it("does nothing for a zero charge and ignores other subjects' grants", async () => {
		await reset();
		await insert("bobs", b.bob.userId, 100, null);
		expect(await db().tx({ system: true }, (q) => consume(q, subject(), 0, nowIso()))).toEqual({ charged: 0, overdraft: 0 });
		expect(await db().tx({ system: true }, (q) => consume(q, subject(), 10, nowIso()))).toEqual({ charged: 0, overdraft: 10 });
		expect(await remainingOf("bobs")).toBe(100);
	});

	it("parallel charges never drive the balance negative and account for every credit", async () => {
		await reset();
		await insert("a", b.alice.userId, 60, DAY);
		await insert("b", b.alice.userId, 40, null);
		const results = await Promise.all(Array.from({ length: 8 }, () => db().tx({ system: true }, (q) => consume(q, subject(), 30, nowIso()))));
		const charged = results.reduce((n, r) => n + r.charged, 0);
		const overdraft = results.reduce((n, r) => n + r.overdraft, 0);
		expect(charged).toBe(100);
		expect(overdraft).toBe(140);
		expect(await remainingOf("a")).toBe(0);
		expect(await remainingOf("b")).toBe(0);
		const negative = await db().query("SELECT 1 FROM credit_grants WHERE remaining < 0");
		expect(negative).toHaveLength(0);
	});

	it("the database refuses a negative remaining outright", async () => {
		await reset();
		await insert("c", b.alice.userId, 10, null);
		await expect(db().tx({ system: true }, (q) => q.query("UPDATE credit_grants SET remaining = -1 WHERE id = 'c'"))).rejects.toBeTruthy();
	});

	it("issues the free plan's credits once per user and organization per month", async () => {
		await reset();
		const now = Date.now();
		const first = await db().tx({ system: true }, (q) => issuePeriodGrants(q, now));
		const users = Number((await db().query<{ n: string }>("SELECT count(*) AS n FROM users WHERE status = 'active'"))[0]?.n);
		const orgs = Number((await db().query<{ n: string }>("SELECT count(*) AS n FROM organizations WHERE status = 'active'"))[0]?.n);
		expect(first).toBe(users + orgs);
		const again = await db().tx({ system: true }, (q) => issuePeriodGrants(q, now));
		expect(again).toBe(0);
		expect(await b.balance("user", b.alice.userId)).toBe(10_000);
		expect(await b.balance("org", b.root.orgId)).toBe(10_000);

		// Hourly scheduler entry point, same idempotency.
		const billing = b.t.hub.registry.require<BillingService>("billing");
		expect(await billing.wallet.issueAll()).toBe(0);

		// Next month: fresh grants, and last month's have expired and no longer count.
		const nextMonth = new Date(now);
		nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
		const later = await db().tx({ system: true }, (q) => issuePeriodGrants(q, nextMonth.getTime()));
		expect(later).toBe(users + orgs);
		const rows = await db().query<{ b: string }>(
			"SELECT coalesce(sum(remaining), 0) AS b FROM credit_grants WHERE subject_type = 'user' AND subject_id = $1 AND (expires_at IS NULL OR expires_at > $2::timestamptz)",
			[b.alice.userId, nextMonth.toISOString()],
		);
		expect(Number(rows[0]?.b)).toBe(10_000);
	});

	it("does not issue free credits to disabled users", async () => {
		await reset();
		await b.t.api("POST", `/api/admin/users/${b.bob.userId}/disable`, { token: b.root.token });
		await db().tx({ system: true }, (q) => issuePeriodGrants(q, Date.now()));
		expect(await b.balance("user", b.bob.userId)).toBe(0);
		expect(await b.balance("user", b.alice.userId)).toBe(10_000);
	});

	it("issues subscription credits per month window of an active subscription, idempotently, until it ends", async () => {
		await reset();
		const plan = await b.t.api("POST", "/api/admin/plans", { token: b.root.token, body: { name: "Pro", period: "month", priceCents: 2000, currency: "cny", monthlyCredits: 5000 } });
		const start = Date.now() - DAY;
		await db().tx({ system: true }, (q) =>
			q.query("INSERT INTO subscriptions (id, subject_type, subject_id, plan_id, status, current_period_start, current_period_end, provider) VALUES ('s1','user',$1,$2,'active',$3::timestamptz,$4::timestamptz,'manual')", [
				b.alice.userId,
				plan.data.id,
				new Date(start).toISOString(),
				new Date(start + 70 * DAY).toISOString(),
			]),
		);
		const planGrants = async (): Promise<number> => Number((await db().query<{ n: string }>("SELECT count(*) AS n FROM credit_grants WHERE source = 'plan'"))[0]?.n);
		await db().tx({ system: true }, (q) => issuePeriodGrants(q, Date.now(), { type: "user", id: b.alice.userId }));
		expect(await planGrants()).toBe(1);
		await db().tx({ system: true }, (q) => issuePeriodGrants(q, Date.now()));
		expect(await planGrants()).toBe(1);
		// Second window starts one month after the subscription started; a third would overrun the 70 day period only partly.
		await db().tx({ system: true }, (q) => issuePeriodGrants(q, start + 33 * DAY));
		expect(await planGrants()).toBe(2);
		await db().tx({ system: true }, (q) => issuePeriodGrants(q, start + 33 * DAY));
		expect(await planGrants()).toBe(2);
		await db().tx({ system: true }, (q) => issuePeriodGrants(q, start + 80 * DAY));
		expect(await planGrants()).toBe(2);
		await db().query("DELETE FROM subscriptions");
	});
});

describe("LLM proxy billing", () => {
	let b: BHub;
	let up: Upstream;
	let upstreamCalls = 0;
	let usageReply = { prompt_tokens: 1000, completion_tokens: 500 };
	let platformGw: string;

	beforeAll(async () => {
		b = await startB({ billing: true });
		up = await startUpstream((_req, res) => {
			upstreamCalls++;
			json(res, { id: "r", usage: usageReply });
		});
		const gw = await b.t.api("POST", "/api/admin/gateways", { token: b.root.token, body: { scope: "platform", name: "plat", format: "openai", baseUrl: `${up.url}/v1`, apiKey: "sk-platform-1234", models: ["gpt-x"] } });
		platformGw = gw.data.id;
		await b.t.api("POST", "/api/admin/prices", { token: b.root.token, body: { model: "gpt-x", inputPrice: 10_000, outputPrice: 30_000 } });
		// No free credits: every balance in these tests is set explicitly.
		await b.t.api("PUT", "/api/admin/plans/free", { token: b.root.token, body: { monthlyCredits: 0 } });
	});
	afterAll(async () => {
		await up.stop();
		await b.stop();
	});

	const chat = (token: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
		b.llm("openai/v1/chat/completions", { token, body: { model: "gpt-x", ...extra }, headers });
	const clean = async (): Promise<void> => {
		await b.t.hub.db.tx({ system: true }, async (q) => {
			await q.query("DELETE FROM credit_grants");
			await q.query("DELETE FROM usage_ledger");
		});
		upstreamCalls = 0;
	};

	it("rejects with 402 insufficientCredits before calling upstream when there is nothing to spend", async () => {
		await clean();
		const r = await chat(b.alice.token);
		expect(r.status).toBe(402);
		expect(((await r.json()) as any).error.code).toBe("insufficientCredits");
		expect(upstreamCalls).toBe(0);
	});

	it("pre-checks against max_tokens, then charges the actual usage and records subject and cost", async () => {
		await clean();
		await b.grant("user", b.alice.userId, 29);
		// max_tokens 1000 -> estimate 30 credits > 29
		expect((await chat(b.alice.token, { max_tokens: 1000 })).status).toBe(402);
		expect(upstreamCalls).toBe(0);
		await b.grant("user", b.alice.userId, 1000);
		const ok = await chat(b.alice.token, { max_tokens: 1000 });
		expect(ok.status).toBe(200);
		const rows = await b.ledger(1);
		expect(rows[0]).toMatchObject({ user_id: b.alice.userId, source: "platform", subject_type: "user", subject_id: b.alice.userId, model: "gpt-x" });
		expect(Number(rows[0].cost_credits)).toBe(25);
		expect(Number(rows[0].overdraft_credits)).toBe(0);
		expect(await b.balance("user", b.alice.userId)).toBe(29 + 1000 - 25);
		// The default estimate (4096 output tokens) is 123 credits.
		await clean();
		await b.grant("user", b.alice.userId, 122);
		expect((await chat(b.alice.token)).status).toBe(402);
		await b.grant("user", b.alice.userId, 1);
		expect((await chat(b.alice.token)).status).toBe(200);
	});

	it("clamps the balance at zero when the actual cost exceeds it, records the overdraft, and rejects the next call", async () => {
		await clean();
		await b.grant("user", b.alice.userId, 20);
		const r = await chat(b.alice.token, { max_tokens: 500 });
		expect(r.status).toBe(200);
		const rows = await b.ledger(1);
		expect(Number(rows[0].cost_credits)).toBe(25);
		expect(Number(rows[0].overdraft_credits)).toBe(5);
		expect(await b.balance("user", b.alice.userId)).toBe(0);
		expect((await chat(b.alice.token, { max_tokens: 500 })).status).toBe(402);
	});

	it("bills the organization when X-Prometheus-Org names one the user belongs to", async () => {
		await clean();
		await b.grant("org", b.root.orgId, 500);
		const r = await chat(b.alice.token, {}, { "x-prometheus-org": b.root.orgId });
		expect(r.status).toBe(200);
		const rows = await b.ledger(1);
		expect(rows[0]).toMatchObject({ user_id: b.alice.userId, org_id: b.root.orgId, subject_type: "org", subject_id: b.root.orgId });
		expect(await b.balance("org", b.root.orgId)).toBe(475);
		expect(await b.balance("user", b.alice.userId)).toBe(0);
		// The user's own wallet is not consulted in org context, and the org wallet is not used without the header.
		expect((await chat(b.alice.token)).status).toBe(402);
	});

	it("refuses an organization the user is not a member of, whether it exists or not", async () => {
		await clean();
		const other = await b.t.api("POST", "/api/orgs", { token: b.root.token, body: { name: "Other Org" } });
		expect(other.status).toBe(201);
		await b.grant("org", other.data.id, 500);
		const r = await chat(b.alice.token, {}, { "x-prometheus-org": other.data.id });
		expect(r.status).toBe(403);
		expect((await chat(b.alice.token, {}, { "x-prometheus-org": "no-such-org" })).status).toBe(403);
		expect(upstreamCalls).toBe(0);
		expect(await b.balance("org", other.data.id)).toBe(500);
	});

	it("applies per-member quotas first with 429 quotaExceeded, and charges nothing", async () => {
		await clean();
		await b.grant("org", b.root.orgId, 500);
		await b.t.api("PUT", "/api/admin/quotas", { token: b.root.token, body: { subjectType: "user", subjectId: b.alice.userId, period: "day", limitTokens: 0 } });
		const r = await chat(b.alice.token, {}, { "x-prometheus-org": b.root.orgId });
		expect(r.status).toBe(429);
		expect(((await r.json()) as any).error.code).toBe("quotaExceeded");
		expect(upstreamCalls).toBe(0);
		expect(await b.balance("org", b.root.orgId)).toBe(500);
		await b.t.api("PUT", "/api/admin/quotas", { token: b.root.token, body: { subjectType: "user", subjectId: b.alice.userId, period: "day", limitTokens: null } });
	});

	it("does not charge failed upstream calls", async () => {
		await clean();
		await b.grant("user", b.alice.userId, 500);
		await b.t.api("PUT", `/api/admin/gateways/${platformGw}`, { token: b.root.token, body: { baseUrl: "http://127.0.0.1:9/v1" } });
		expect((await chat(b.alice.token)).status).toBe(502);
		await b.t.api("PUT", `/api/admin/gateways/${platformGw}`, { token: b.root.token, body: { baseUrl: `${up.url}/v1` } });
		expect(await b.balance("user", b.alice.userId)).toBe(500);
	});

	it("does not bill BYOK or organization gateways: no pre-check, no credits, cost zero", async () => {
		await clean();
		const mine = await b.t.api("POST", "/api/me/gateways", { token: b.alice.token, body: { name: "mine", format: "openai", baseUrl: `${up.url}/v1`, apiKey: "sk-mine-0000", models: ["my-model"] } });
		expect(mine.status).toBe(201);
		const r = await b.llm("openai/v1/chat/completions", { token: b.alice.token, body: { model: "my-model" } });
		expect(r.status).toBe(200);
		let rows = await b.ledger(1);
		expect(rows[0]).toMatchObject({ source: "byok", subject_type: null });
		expect(Number(rows[0].cost_credits)).toBe(0);
		await b.t.api("DELETE", `/api/me/gateways/${mine.data.id}`, { token: b.alice.token });

		const org = await b.t.api("POST", "/api/admin/gateways", { token: b.root.token, body: { scope: "org", scopeId: b.root.orgId, name: "orgw", format: "openai", baseUrl: `${up.url}/v1`, apiKey: "sk-org-1111", models: ["org-model"] } });
		const o = await b.llm("openai/v1/chat/completions", { token: b.alice.token, body: { model: "org-model" } });
		expect(o.status).toBe(200);
		rows = await b.ledger(2);
		expect(rows[1]).toMatchObject({ source: "org" });
		expect(Number(rows[1].cost_credits)).toBe(0);
		await b.t.api("DELETE", `/api/admin/gateways/${org.data.id}`, { token: b.root.token });
	});

	it("looks prices up by gateway, then model, then the * fallback, and refuses unpriced models on platform gateways", async () => {
		const billing = b.t.hub.registry.require<BillingService>("billing");
		const price = (model: string, gw: string | null) => billing.wallet.priceFor(model, gw);
		expect(await price("gpt-x", platformGw)).toEqual({ inputPrice: 10_000, outputPrice: 30_000 });
		expect(await price("other-model", platformGw)).toBeUndefined();
		await b.t.api("POST", "/api/admin/prices", { token: b.root.token, body: { model: "*", inputPrice: 1, outputPrice: 2 } });
		expect(await price("other-model", platformGw)).toEqual({ inputPrice: 1, outputPrice: 2 });
		await b.t.api("POST", "/api/admin/prices", { token: b.root.token, body: { model: "gpt-x", gatewayId: platformGw, inputPrice: 7, outputPrice: 9 } });
		expect(await price("gpt-x", platformGw)).toEqual({ inputPrice: 7, outputPrice: 9 });
		expect(await price("gpt-x", null)).toEqual({ inputPrice: 10_000, outputPrice: 30_000 });
		const prices = (await b.t.api("GET", "/api/admin/prices", { token: b.root.token })).data;
		for (const p of prices.filter((x: any) => x.model === "*" || x.gatewayId)) await b.t.api("DELETE", `/api/admin/prices/${p.id}`, { token: b.root.token });
		expect(await price("other-model", platformGw)).toBeUndefined();

		await clean();
		const r = await b.llm("openai/v1/chat/completions", { token: b.alice.token, body: { model: "gpt-x" } });
		expect(r.status).toBe(402);
		// A model without any price is refused on the operator's gateway (it would be free for everyone), even with a full wallet.
		await b.grant("user", b.alice.userId, 1000);
		await b.t.api("PUT", `/api/admin/gateways/${platformGw}`, { token: b.root.token, body: { models: ["gpt-x", "free-model"] } });
		const free = await b.llm("openai/v1/chat/completions", { token: b.alice.token, body: { model: "free-model" } });
		expect(free.status).toBe(403);
		expect(((await free.json()) as any).error.code).toBe("modelNotPriced");
		expect(upstreamCalls).toBe(0);
		expect(await b.t.hub.db.query("SELECT 1 FROM usage_ledger")).toHaveLength(0);
	});

	it("counts the prompt in the pre-check, not only the output cap", async () => {
		await clean();
		// 40000 characters is about 10000 input tokens = 100 credits at 10000/1M, plus 1 for max_tokens 10: far above 50.
		await b.grant("user", b.alice.userId, 50);
		const big = "a".repeat(40_000);
		const refused = await chat(b.alice.token, { max_tokens: 10, messages: [{ role: "user", content: big }] });
		expect(refused.status).toBe(402);
		expect(((await refused.json()) as any).error.code).toBe("insufficientCredits");
		expect(upstreamCalls).toBe(0);
		// A short prompt with the same cap is fine, and an inline image counts as a flat amount rather than its base64 length.
		expect((await chat(b.alice.token, { max_tokens: 10, messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
		const image = `data:image/png;base64,${"A".repeat(2_000_000)}`;
		expect((await chat(b.alice.token, { max_tokens: 10, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: image } }] }] })).status).toBe(200);
	});

	it("summarizes balance, grants, plan and the month's usage for a user and for an organization admin only", async () => {
		await clean();
		await b.grant("user", b.alice.userId, 1000);
		expect((await chat(b.alice.token)).status).toBe(200);
		await b.ledger(1);
		const s = await b.t.api("GET", "/api/billing/summary", { token: b.alice.token });
		expect(s.data).toMatchObject({
			subject: { type: "user", id: b.alice.userId },
			balance: 975,
			plan: { id: "free" },
			subscription: null,
			periodUsage: { credits: 25, inputTokens: 1000, outputTokens: 500, requests: 1, overdraftCredits: 0 },
			providers: ["manual"],
		});
		expect(s.data.grants).toEqual([expect.objectContaining({ source: "admin", amount: 1000, remaining: 975 })]);
		expect((await b.t.api("GET", `/api/billing/summary?orgId=${b.root.orgId}`, { token: b.alice.token })).status).toBe(403);
		const org = await b.t.api("GET", `/api/billing/summary?orgId=${b.root.orgId}`, { token: b.root.token });
		expect(org.data.subject).toEqual({ type: "org", id: b.root.orgId });
		expect((await b.t.api("GET", "/api/billing/summary")).status).toBe(401);
	});
});

describe("billing switch", () => {
	it("leaves the proxy exactly as it was when billing is off: no checks, no charges, no wallet rows", async () => {
		const b = await startB();
		const up = await startUpstream((_req, res) => json(res, { usage: { prompt_tokens: 1000, completion_tokens: 500 } }));
		try {
			await b.t.api("POST", "/api/admin/gateways", { token: b.root.token, body: { scope: "platform", name: "plat", format: "openai", baseUrl: `${up.url}/v1`, apiKey: "sk-platform-1234", models: ["gpt-x"] } });
			await b.t.api("POST", "/api/admin/prices", { token: b.root.token, body: { model: "gpt-x", inputPrice: 10_000, outputPrice: 30_000 } });
			// A bogus org header is ignored, and a user with no credits at all is not refused.
			const r = await b.llm("openai/v1/chat/completions", { token: b.alice.token, body: { model: "gpt-x" }, headers: { "x-prometheus-org": "bogus" } });
			expect(r.status).toBe(200);
			const rows = await b.ledger(1);
			expect(rows[0]).toMatchObject({ source: "platform", subject_type: null, subject_id: null });
			expect(Number(rows[0].cost_credits)).toBe(0);
			expect(await b.t.hub.db.query("SELECT 1 FROM credit_grants")).toHaveLength(0);
			const summary = await b.t.api("GET", "/api/billing/summary", { token: b.alice.token });
			expect(summary.status).toBe(404);
			expect(summary.code).toBe("billingDisabled");
			expect((await b.t.api("POST", "/api/billing/checkout", { token: b.alice.token, body: { kind: "topup", credits: 1000 } })).code).toBe("billingDisabled");
			expect((await b.t.api("POST", "/billing/webhook/manual")).code).toBe("billingDisabled");
			// Operator catalog routes still work, so plans and prices can be prepared before switching on.
			expect((await b.t.api("GET", "/api/admin/plans", { token: b.root.token })).data).toEqual([expect.objectContaining({ id: "free", priceCents: 0 })]);
		} finally {
			await up.stop();
			await b.stop();
		}
	});

	it("is on in public mode and in private mode with HUB_BILLING=on", async () => {
		const pub = await startB({ mode: "public" });
		const env = await startB({ env: { HUB_BILLING: "on" } });
		const off = await startB({ env: { HUB_BILLING: "off" } });
		try {
			expect((await pub.t.api("GET", "/api/billing/plans", { token: pub.alice.token })).status).toBe(200);
			expect((await env.t.api("GET", "/api/billing/plans", { token: env.alice.token })).data).toEqual([expect.objectContaining({ id: "free" })]);
			expect((await off.t.api("GET", "/api/billing/plans", { token: off.alice.token })).status).toBe(404);
			expect(pub.t.hub.config.mode).toBe("public");
		} finally {
			await pub.stop();
			await env.stop();
			await off.stop();
		}
	});

	it("rejects an unknown HUB_MODE", async () => {
		await expect(startB({ env: { HUB_MODE: "hybrid" } })).rejects.toThrow(/HUB_MODE/);
	});
});

describe("plans, prices and settings administration", () => {
	let b: BHub;
	beforeAll(async () => {
		b = await startB({ billing: true });
	});
	afterAll(() => b.stop());

	it("is operator only", async () => {
		for (const [method, path, body] of [
			["GET", "/api/admin/plans", undefined],
			["POST", "/api/admin/plans", { name: "x", period: "month", priceCents: 1, currency: "usd", monthlyCredits: 1 }],
			["GET", "/api/admin/prices", undefined],
			["POST", "/api/admin/prices", { model: "m", inputPrice: 1, outputPrice: 1 }],
			["GET", "/api/admin/orders", undefined],
			["GET", "/api/admin/redeem-codes", undefined],
			["POST", "/api/admin/redeem-codes", { count: 1, credits: 1 }],
			["GET", "/api/admin/billing/settings", undefined],
			["POST", "/api/admin/credits", { subjectType: "user", subjectId: "x", credits: 1 }],
		] as const) {
			const r = await b.t.api(method, path, { token: b.alice.token, ...(body ? { body } : {}) });
			expect(r.status, `${method} ${path}`).toBe(403);
		}
	});

	it("manages plans: create, update, deactivate hides it from buyers, free plan is locked, plans in use cannot be deleted", async () => {
		const created = await b.t.api("POST", "/api/admin/plans", { token: b.root.token, body: { name: "Team", period: "year", priceCents: 99900, currency: "CNY", monthlyCredits: 100000, features: { max_runtime_minutes_per_day: 600 } } });
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ name: "Team", period: "year", priceCents: 99900, currency: "cny", monthlyCredits: 100000, active: true, features: { max_runtime_minutes_per_day: 600 } });
		const id = created.data.id as string;
		const upd = await b.t.api("PUT", `/api/admin/plans/${id}`, { token: b.root.token, body: { priceCents: 88800, name: "Team+" } });
		expect(upd.data).toMatchObject({ priceCents: 88800, name: "Team+" });
		const buyers = (await b.t.api("GET", "/api/billing/plans", { token: b.alice.token })).data.map((p: any) => p.id);
		expect(buyers).toContain(id);
		await b.t.api("PUT", `/api/admin/plans/${id}`, { token: b.root.token, body: { active: false } });
		expect((await b.t.api("GET", "/api/billing/plans", { token: b.alice.token })).data.map((p: any) => p.id)).not.toContain(id);
		expect((await b.t.api("GET", "/api/admin/plans", { token: b.root.token })).data.map((p: any) => p.id)).toContain(id);

		expect((await b.t.api("PUT", "/api/admin/plans/free", { token: b.root.token, body: { active: false } })).code).toBe("freePlanLocked");
		expect((await b.t.api("PUT", "/api/admin/plans/free", { token: b.root.token, body: { priceCents: 5 } })).code).toBe("freePlanLocked");
		expect((await b.t.api("DELETE", "/api/admin/plans/free", { token: b.root.token })).code).toBe("freePlanLocked");
		expect((await b.t.api("PUT", "/api/admin/plans/free", { token: b.root.token, body: { monthlyCredits: 20000 } })).data.monthlyCredits).toBe(20000);

		await b.t.hub.db.tx({ system: true }, (q) => q.query("INSERT INTO orders (id, subject_type, subject_id, kind, amount_cents, currency, plan_id, status, provider) VALUES ('o1','user','u','subscription',1,'cny',$1,'pending','manual')", [id]));
		expect((await b.t.api("DELETE", `/api/admin/plans/${id}`, { token: b.root.token })).code).toBe("planInUse");
		await b.t.hub.db.query("DELETE FROM orders");
		expect((await b.t.api("DELETE", `/api/admin/plans/${id}`, { token: b.root.token })).status).toBe(200);
		expect((await b.t.api("DELETE", `/api/admin/plans/${id}`, { token: b.root.token })).status).toBe(404);
		expect((await b.t.api("POST", "/api/admin/plans", { token: b.root.token, body: { name: "bad", period: "week", priceCents: 1, currency: "cny", monthlyCredits: 1 } })).status).toBe(400);
		expect((await b.t.api("POST", "/api/admin/plans", { token: b.root.token, body: { name: "bad", period: "month", priceCents: -1, currency: "cny", monthlyCredits: 1 } })).status).toBe(400);
	});

	it("manages prices: upsert replaces the same model and gateway, update and delete work", async () => {
		const a = await b.t.api("POST", "/api/admin/prices", { token: b.root.token, body: { model: "m1", inputPrice: 1.5, outputPrice: 3, currencyNote: "per 1M" } });
		expect(a.status).toBe(201);
		expect(a.data).toMatchObject({ model: "m1", gatewayId: null, inputPrice: 1.5, outputPrice: 3, currencyNote: "per 1M" });
		const again = await b.t.api("POST", "/api/admin/prices", { token: b.root.token, body: { model: "m1", inputPrice: 2, outputPrice: 4 } });
		expect(again.data.id).toBe(a.data.id);
		expect(again.data).toMatchObject({ inputPrice: 2, outputPrice: 4 });
		expect((await b.t.api("GET", "/api/admin/prices", { token: b.root.token })).data.filter((p: any) => p.model === "m1")).toHaveLength(1);
		expect((await b.t.api("PUT", `/api/admin/prices/${a.data.id}`, { token: b.root.token, body: { outputPrice: 9 } })).data.outputPrice).toBe(9);
		expect((await b.t.api("POST", "/api/admin/prices", { token: b.root.token, body: { model: "m1", gatewayId: "no-such", inputPrice: 1, outputPrice: 1 } })).status).toBe(404);
		expect((await b.t.api("POST", "/api/admin/prices", { token: b.root.token, body: { model: "m1", inputPrice: -1, outputPrice: 1 } })).status).toBe(400);
		expect((await b.t.api("DELETE", `/api/admin/prices/${a.data.id}`, { token: b.root.token })).status).toBe(200);
		expect((await b.t.api("DELETE", `/api/admin/prices/${a.data.id}`, { token: b.root.token })).status).toBe(404);
	});

	it("reads and updates billing settings and grants admin credits", async () => {
		expect((await b.t.api("GET", "/api/admin/billing/settings", { token: b.root.token })).data).toEqual({ topupCreditsPerCent: 10, currency: "cny", topupExpiryDays: null });
		const upd = await b.t.api("PUT", "/api/admin/billing/settings", { token: b.root.token, body: { topupCreditsPerCent: 20, currency: "USD", topupExpiryDays: 365 } });
		expect(upd.data).toEqual({ topupCreditsPerCent: 20, currency: "usd", topupExpiryDays: 365 });
		await b.t.api("PUT", "/api/admin/billing/settings", { token: b.root.token, body: { topupExpiryDays: null } });
		expect((await b.t.api("GET", "/api/admin/billing/settings", { token: b.root.token })).data.topupExpiryDays).toBeNull();

		const g = await b.t.api("POST", "/api/admin/credits", { token: b.root.token, body: { subjectType: "user", subjectId: b.alice.userId, credits: 777 } });
		expect(g.status).toBe(201);
		expect(await b.balance("user", b.alice.userId)).toBe(777);
		expect((await b.t.api("POST", "/api/admin/credits", { token: b.root.token, body: { subjectType: "org", subjectId: "nope", credits: 5 } })).status).toBe(404);
		expect((await b.t.api("POST", "/api/admin/credits", { token: b.root.token, body: { subjectType: "user", subjectId: b.alice.userId, credits: 5, expiresAt: "not a date" } })).status).toBe(400);
	});
});
