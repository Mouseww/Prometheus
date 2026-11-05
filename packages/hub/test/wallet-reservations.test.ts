import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BillingService } from "../src/billing/index.ts";
import { type BHub, startB, startUpstream, type Upstream } from "./b-helpers.ts";
import { sleep } from "./s-helpers.ts";

const reservationRows = (b: BHub): Promise<{ id: string; amount: string | number }[]> => b.t.hub.db.query("SELECT id, amount FROM credit_reservations ORDER BY id");

describe("wallet reservations", () => {
	let b: BHub;
	let wallet: BillingService["wallet"];
	beforeAll(async () => {
		b = await startB({ billing: true });
		wallet = b.t.hub.registry.require<BillingService>("billing").wallet;
		await b.t.api("PUT", "/api/admin/plans/free", { token: b.root.token, body: { monthlyCredits: 0 } });
	});
	afterAll(() => b.stop());

	const subject = (): { type: "user"; id: string } => ({ type: "user", id: b.alice.userId });
	const reset = async (): Promise<void> => {
		await b.t.hub.db.tx({ system: true }, async (q) => {
			await q.query("DELETE FROM credit_reservations");
			await q.query("DELETE FROM credit_grants");
			await q.query("DELETE FROM usage_ledger");
		});
	};
	const outcome = (p: Promise<unknown>): Promise<"ok" | string> =>
		p.then(
			() => "ok",
			(err: { code?: string }) => err.code ?? "error",
		);

	it("lets concurrent reservations take turns: together they never exceed the balance", async () => {
		await reset();
		await b.grant("user", b.alice.userId, 10);
		const results = await Promise.all(Array.from({ length: 6 }, () => outcome(wallet.reserve(subject(), 4))));
		expect(results.filter((r) => r === "ok")).toHaveLength(2);
		expect(results.filter((r) => r === "insufficientCredits")).toHaveLength(4);
		expect((await reservationRows(b)).reduce((sum, r) => sum + Number(r.amount), 0)).toBe(8);
	});

	it("gives capacity back on release, and releasing twice is harmless", async () => {
		await reset();
		await b.grant("user", b.alice.userId, 10);
		const first = await wallet.reserve(subject(), 8);
		expect(await outcome(wallet.reserve(subject(), 8))).toBe("insufficientCredits");
		await wallet.release(first);
		await wallet.release(first);
		expect(await reservationRows(b)).toHaveLength(0);
		expect(await outcome(wallet.reserve(subject(), 8))).toBe("ok");
	});

	it("commit charges the actual cost, books the usage and drops the hold", async () => {
		await reset();
		await b.grant("user", b.alice.userId, 100);
		const hold = await wallet.reserve(subject(), 60);
		const entry = { userId: b.alice.userId, orgId: null, gatewayId: null, model: "gpt-x", inputTokens: 1000, outputTokens: 500, source: "platform" } as never;
		const done = await wallet.commit(hold, subject(), entry, { inputPrice: 10_000, outputPrice: 30_000 });
		expect(done).toEqual({ cost: 25, overdraft: 0 });
		expect(await reservationRows(b)).toHaveLength(0);
		expect(await b.balance("user", b.alice.userId)).toBe(75);
	});

	it("ignores and sweeps reservations that expired without being settled", async () => {
		await reset();
		await b.grant("user", b.alice.userId, 10);
		await wallet.reserve(subject(), 9, -1000);
		// The orphan no longer counts, so the next reservation fits, and the stale row is gone afterwards.
		expect(await outcome(wallet.reserve(subject(), 9))).toBe("ok");
		expect(await reservationRows(b)).toHaveLength(1);
	});

	it("holds nothing for a zero estimate and nothing to others' subjects", async () => {
		await reset();
		expect(await wallet.reserve(subject(), 0)).toBeUndefined();
		await b.grant("user", b.alice.userId, 10);
		await wallet.reserve(subject(), 9);
		// Another subject has its own balance and its own holds.
		expect(await outcome(wallet.reserve({ type: "user", id: b.root.userId }, 1))).toBe("insufficientCredits");
	});
});

describe("LLM proxy reservations", () => {
	let b: BHub;
	let up: Upstream;
	let upstreamCalls = 0;
	let failUpstream = false;

	beforeAll(async () => {
		b = await startB({ billing: true });
		up = await startUpstream(async (_req, res) => {
			upstreamCalls++;
			// Slow enough that concurrent requests overlap.
			await sleep(200);
			res.statusCode = failUpstream ? 500 : 200;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(failUpstream ? { error: "boom" } : { id: "r", usage: { prompt_tokens: 1000, completion_tokens: 500 } }));
		});
		await b.t.api("POST", "/api/admin/gateways", { token: b.root.token, body: { scope: "platform", name: "plat", format: "openai", baseUrl: `${up.url}/v1`, apiKey: "sk-platform-1234", models: ["gpt-x"] } });
		await b.t.api("POST", "/api/admin/prices", { token: b.root.token, body: { model: "gpt-x", inputPrice: 10_000, outputPrice: 30_000 } });
		await b.t.api("PUT", "/api/admin/plans/free", { token: b.root.token, body: { monthlyCredits: 0 } });
	});
	afterAll(async () => {
		await up.stop();
		await b.stop();
	});

	const chat = () => b.llm("openai/v1/chat/completions", { token: b.alice.token, body: { model: "gpt-x", max_tokens: 1000 } });
	const reset = async (): Promise<void> => {
		await b.t.hub.db.tx({ system: true }, async (q) => {
			await q.query("DELETE FROM credit_reservations");
			await q.query("DELETE FROM credit_grants");
			await q.query("DELETE FROM usage_ledger");
		});
		upstreamCalls = 0;
		failUpstream = false;
	};

	it("cannot be overspent by concurrent calls", async () => {
		await reset();
		// One call is estimated at about 31 credits (output cap) and really costs 25: 70 credits cover two calls, never four.
		await b.grant("user", b.alice.userId, 70);
		const responses = await Promise.all(Array.from({ length: 4 }, () => chat()));
		const statuses = responses.map((r) => r.status).sort();
		expect(statuses).toEqual([200, 200, 402, 402]);
		await Promise.all(responses.map((r) => r.text()));
		expect(upstreamCalls).toBe(2);
		// Both completed calls were charged their real cost, nothing went into overdraft, and no hold is left.
		expect(await b.balance("user", b.alice.userId)).toBe(20);
		const overdraft = await b.t.hub.db.query<{ o: string | number }>("SELECT coalesce(sum(overdraft_credits), 0) AS o FROM usage_ledger");
		expect(Number(overdraft[0]?.o)).toBe(0);
		expect(await reservationRows(b)).toHaveLength(0);
	});

	it("releases the hold when the upstream call fails", async () => {
		await reset();
		await b.grant("user", b.alice.userId, 70);
		failUpstream = true;
		const failed = await chat();
		expect(failed.status).toBe(500);
		await failed.text();
		await sleep(50);
		expect(await reservationRows(b)).toHaveLength(0);
		expect(await b.balance("user", b.alice.userId)).toBe(70);
		// The full balance is usable again.
		failUpstream = false;
		const ok = await chat();
		expect(ok.status).toBe(200);
		await ok.text();
	});
});
