import { PGlite } from "@electric-sql/pglite";
import { type Db, type DbScope, type Queryable, scopeStatements } from "./db.ts";

export interface OpenOptions {
	/** Application role for user scoped transactions (default prometheus_app). */
	appRole?: string;
}

/** Opens PGlite in a data directory, or in memory for the literal `"memory"` (tests). Small-team mode and tests only. */
export async function openPglite(dirOrMemory: string, opts: OpenOptions = {}): Promise<Db> {
	const role = opts.appRole ?? "prometheus_app";
	const pg = dirOrMemory === "memory" ? new PGlite() : new PGlite(dirOrMemory);
	await pg.waitReady;

	return {
		async query<T>(text: string, params?: unknown[]): Promise<T[]> {
			const res = await pg.query<T>(text, params);
			return res.rows;
		},
		async exec(sql: string): Promise<void> {
			await pg.exec(sql);
		},
		async tx<T>(scope: DbScope, fn: (q: Queryable) => Promise<T>): Promise<T> {
			return pg.transaction(async (t) => {
				const q: Queryable = {
					async query<R>(text: string, params?: unknown[]): Promise<R[]> {
						return (await t.query<R>(text, params)).rows;
					},
					async exec(sql: string): Promise<void> {
						await t.exec(sql);
					},
				};
				if (!("system" in scope)) {
					for (const s of scopeStatements(scope, role)) await q.query(s.sql, s.params);
				}
				return fn(q);
			});
		},
		async close(): Promise<void> {
			await pg.close();
		},
	};
}
