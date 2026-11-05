import type { HubOptions } from "../src/config.ts";
import { sleep } from "./s-helpers.ts";
import { startHub, type TestHub } from "./hub-helpers.ts";

export { sleep, sse, startUpstream, type Upstream } from "./s-helpers.ts";

export interface Person {
	token: string;
	userId: string;
}

export interface BHub {
	t: TestHub;
	clock: { offset: number };
	root: Person & { orgId: string };
	alice: Person;
	bob: Person;
	stop(): Promise<void>;
	/** Calls the LLM proxy as `token` (Bearer). */
	llm(path: string, init: { token: string; body?: unknown; headers?: Record<string, string>; method?: string }): Promise<Response>;
	/** Usage ledger rows of real users, oldest first; waits until at least `n` exist. */
	ledger(n: number): Promise<any[]>;
	resetLedger(): Promise<unknown>;
	/** Credits a billing subject with an admin grant, directly in the database. */
	grant(subjectType: "user" | "org", subjectId: string, credits: number, opts?: { source?: string; expiresAt?: Date | null }): Promise<void>;
	balance(subjectType: "user" | "org", subjectId: string): Promise<number>;
}

/** A hub with an operator (root), and Alice and Bob as members of root's organization. */
export async function startB(options: Partial<HubOptions> = {}): Promise<BHub> {
	const clock = { offset: 0 };
	const t = await startHub({ now: () => Date.now() + clock.offset, ...options });
	const root = await t.bootstrap();
	const alice = await t.createUser(root.token, "alice@corp.test", "Alice");
	const bob = await t.createUser(root.token, "bob@corp.test", "Bob");
	let n = 0;
	const ledger = async (count: number): Promise<any[]> => {
		for (let i = 0; i < 100; i++) {
			const rows = await t.hub.db.query<any>("SELECT * FROM usage_ledger WHERE user_id <> 'system' ORDER BY id");
			if (rows.length >= count) return rows;
			await sleep(20);
		}
		return t.hub.db.query<any>("SELECT * FROM usage_ledger WHERE user_id <> 'system' ORDER BY id");
	};
	return {
		t,
		clock,
		root,
		alice,
		bob,
		ledger,
		stop() {
			t.server.closeAllConnections();
			return t.stop();
		},
		llm(path, init) {
			const headers: Record<string, string> = { authorization: `Bearer ${init.token}`, ...init.headers };
			if (init.body !== undefined) headers["content-type"] = "application/json";
			return fetch(`${t.baseUrl}/llm/${path}`, { method: init.method ?? "POST", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
		},
		resetLedger: () => t.hub.db.tx({ system: true }, (q) => q.query("DELETE FROM usage_ledger")),
		async grant(subjectType, subjectId, credits, opts = {}) {
			n++;
			await t.hub.db.tx({ system: true }, (q) =>
				q.query("INSERT INTO credit_grants (id, subject_type, subject_id, source, amount, remaining, expires_at) VALUES ($1,$2,$3,$4,$5,$5,$6)", [
					`bg${Date.now()}${n}`,
					subjectType,
					subjectId,
					opts.source ?? "admin",
					credits,
					opts.expiresAt === undefined ? null : opts.expiresAt,
				]),
			);
		},
		async balance(subjectType, subjectId) {
			const rows = await t.hub.db.query<{ b: string | number | null }>(
				"SELECT coalesce(sum(remaining), 0) AS b FROM credit_grants WHERE subject_type = $1 AND subject_id = $2 AND (expires_at IS NULL OR expires_at > $3::timestamptz)",
				[subjectType, subjectId, new Date(Date.now() + clock.offset).toISOString()],
			);
			return Number(rows[0]?.b ?? 0);
		},
	};
}
