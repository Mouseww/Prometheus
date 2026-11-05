import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { LOG_PREFIX } from "../log.ts";
import type { Queryable } from "./db.ts";

/** Set to 1 to start on a pgdata directory whose bookkeeping is gone (deliberate reset). Orphaned data files are then ignored. */
export const ALLOW_RESET_ENV = "HUB_ALLOW_DB_RESET";

/** PostgreSQL gives user relations a file number from 16384 up; below that are the catalogs of a fresh cluster. */
const FIRST_USER_RELFILENODE = 16384;

const heldInProcess = new Set<string>();

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface DirLock {
	release(): void;
}

/**
 * PGlite has no postmaster to stop a second process from opening the same data directory, and two writers silently overwrite each
 * other's WAL. This lock file (next to the directory, holding the owner pid) turns that into a startup error. A lock left by a
 * dead process (hard kill) is taken over.
 */
export function acquireDirLock(dir: string): DirLock {
	const lockPath = `${dir}.lock`;
	if (heldInProcess.has(lockPath)) throw new Error(`${LOG_PREFIX} 数据库目录 ${dir} 已被本进程中的另一个 Hub 打开，拒绝重复打开以免损坏数据。`);
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = openSync(lockPath, "wx");
			writeSync(fd, String(process.pid));
			closeSync(fd);
			heldInProcess.add(lockPath);
			return {
				release() {
					heldInProcess.delete(lockPath);
					try {
						unlinkSync(lockPath);
					} catch {
						// already gone
					}
				},
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		const owner = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
		if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && pidAlive(owner)) {
			throw new Error(
				`${LOG_PREFIX} 数据库目录 ${dir} 正被进程 ${owner} 使用。PGlite 不支持多个进程同时打开同一目录，否则会丢失数据。请先停止该进程；确认它已不存在时，删除 ${lockPath} 后重试。`,
			);
		}
		try {
			unlinkSync(lockPath);
		} catch {
			// raced with another starter; the next attempt decides
		}
	}
	throw new Error(`${LOG_PREFIX} 无法获取数据库目录锁 ${lockPath}`);
}

/** Number of non-empty user relation files under base/*, i.e. evidence that tables once existed in this cluster. */
export function countUserRelationFiles(dir: string): number {
	const base = join(dir, "base");
	if (!existsSync(base)) return 0;
	let n = 0;
	for (const dbDir of readdirSync(base)) {
		const full = join(base, dbDir);
		for (const f of readdirSync(full)) {
			if (!/^\d+$/.test(f) || Number(f) < FIRST_USER_RELFILENODE) continue;
			if (statSync(join(full, f)).size > 0) n++;
		}
	}
	return n;
}

/**
 * Refuses to continue when a data directory that was initialised before has lost its migration bookkeeping while its table files
 * are still on disk. Migrating then would re-create every table on top of the old files and the old rows would be unreachable,
 * which looks like a fresh install ("no accounts yet") and is silent data loss. An empty-but-initialised directory (nothing was
 * ever created in it) is fine.
 */
export async function assertBookkeepingIntact(db: Queryable, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
	const reg = await db.query<{ ok: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok");
	let applied = 0;
	if (reg[0]?.ok) {
		const rows = await db.query<{ n: string | number }>("SELECT count(*) AS n FROM schema_migrations");
		applied = Number(rows[0]?.n ?? 0);
	}
	if (applied > 0) return;
	const orphans = countUserRelationFiles(dir);
	if (orphans === 0) return;
	if (["1", "true", "on"].includes((env[ALLOW_RESET_ENV] ?? "").toLowerCase())) return;
	throw new Error(
		`${LOG_PREFIX} 数据库目录 ${dir} 已初始化，磁盘上有 ${orphans} 个数据文件，但迁移记录表缺失或为空。` +
			`这通常说明上次异常退出后数据库没有恢复出之前的表。为避免在旧数据之上静默创建空库，Hub 拒绝启动。` +
			`请先备份整个目录并检查；确认要丢弃旧数据重新开始时，设置环境变量 ${ALLOW_RESET_ENV}=1 后重启。`,
	);
}
