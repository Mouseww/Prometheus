import { existsSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { LOG_PREFIX, type HubLog } from "../log.ts";
import { type Db, type DbScope, type Queryable, scopeStatements } from "./db.ts";
import { acquireDirLock, assertBookkeepingIntact } from "./pglite-guard.ts";

export interface OpenOptions {
	/** Application role for user scoped transactions (default prometheus_app). */
	appRole?: string;
	log?: HubLog;
	/** Environment for HUB_ALLOW_DB_RESET (default process.env). */
	env?: NodeJS.ProcessEnv;
	/**
	 * How often a CHECKPOINT flushes dirty pages to the data files (default 30000 ms, 0 disables). PGlite runs PostgreSQL in single
	 * user mode, which has no background checkpointer: without this, everything written since the last clean close lives only in
	 * the write ahead log, and a hard kill leaves the data files at their state from the start of the run.
	 */
	checkpointIntervalMs?: number;
}

const DEFAULT_CHECKPOINT_MS = 30_000;

/**
 * Opens PGlite in a data directory, or in memory for the literal `"memory"` (tests). Small-team mode and tests only.
 * For a directory: takes an exclusive lock so a second process cannot corrupt it, refuses to start when an initialised directory
 * has lost its migration bookkeeping (see assertBookkeepingIntact), and checkpoints periodically.
 */
export async function openPglite(dirOrMemory: string, opts: OpenOptions = {}): Promise<Db> {
	const role = opts.appRole ?? "prometheus_app";
	const inMemory = dirOrMemory === "memory";
	const lock = inMemory ? undefined : acquireDirLock(dirOrMemory);
	const hadCluster = !inMemory && existsSync(join(dirOrMemory, "PG_VERSION"));
	let pg: PGlite;
	try {
		pg = inMemory ? new PGlite() : new PGlite(dirOrMemory, { relaxedDurability: false });
		await pg.waitReady;
		if (hadCluster) {
			const rows: Queryable = {
				async query<R>(text: string, params?: unknown[]): Promise<R[]> {
					return (await pg.query<R>(text, params)).rows;
				},
				async exec(sql: string): Promise<void> {
					await pg.exec(sql);
				},
			};
			await assertBookkeepingIntact(rows, dirOrMemory, opts.env ?? process.env);
		}
	} catch (err) {
		lock?.release();
		throw err;
	}

	let checkpointing = false;
	let timer: NodeJS.Timeout | undefined;
	const checkpoint = async (): Promise<void> => {
		if (checkpointing) return;
		checkpointing = true;
		try {
			await pg.exec("CHECKPOINT");
		} catch (err) {
			opts.log?.warn(`${LOG_PREFIX} 数据库检查点失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			checkpointing = false;
		}
	};
	const interval = opts.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_MS;
	if (!inMemory && interval > 0) {
		timer = setInterval(() => void checkpoint(), interval);
		timer.unref();
	}

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
			if (timer) clearInterval(timer);
			try {
				await pg.close();
			} finally {
				lock?.release();
			}
		},
	};
}
