import postgres from "postgres";
import { type Db, type DbScope, type Queryable, scopeStatements } from "./db.ts";
import type { OpenOptions } from "./pglite.ts";

export interface PostgresOptions extends OpenOptions {
	/** Pool size (default 10). */
	max?: number;
}

type Runner = Pick<postgres.Sql, "unsafe">;

function queryable(sql: Runner): Queryable {
	return {
		async query<T>(text: string, params?: unknown[]): Promise<T[]> {
			const rows = await sql.unsafe(text, (params ?? []) as postgres.ParameterOrJSON<never>[]);
			return [...rows] as T[];
		},
		async exec(text: string): Promise<void> {
			await sql.unsafe(text);
		},
	};
}

/** Opens a PostgreSQL pool (enterprise mode). */
export function openPostgres(url: string, opts: PostgresOptions = {}): Db {
	const role = opts.appRole ?? "prometheus_app";
	const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
	const root = queryable(sql);

	return {
		query: (text, params) => root.query(text, params),
		exec: (text) => root.exec(text),
		async tx<T>(scope: DbScope, fn: (q: Queryable) => Promise<T>): Promise<T> {
			return (await sql.begin(async (t) => {
				const q = queryable(t);
				if (!("system" in scope)) {
					for (const s of scopeStatements(scope, role)) await q.query(s.sql, s.params);
				}
				return fn(q);
			})) as T;
		},
		async close(): Promise<void> {
			await sql.end({ timeout: 5 });
		},
	};
}
