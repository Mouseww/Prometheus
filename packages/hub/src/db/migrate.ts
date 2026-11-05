import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LOG_PREFIX, type HubLog } from "../log.ts";
import { assertRoleName, type Db } from "./db.ts";

const MIGRATION_FILE = /^(\d{3}_[a-z0-9_]+)\.sql$/;
const ROLE_PLACEHOLDER = "{{APP_ROLE}}";
/** Arbitrary constant for pg_advisory_xact_lock so concurrent Hub instances do not migrate at once. */
const MIGRATION_LOCK_KEY = 7_421_001;

export const defaultMigrationsDir = (): string => fileURLToPath(new URL("./migrations/", import.meta.url));

export interface MigrateOptions {
	appRole: string;
	log?: HubLog;
	/** Directory with `NNN_name.sql` files; defaults to the bundled migrations. */
	dir?: string;
}

/** The SQL a DBA must run when the Hub's database user may not create or grant the app role. */
export function dbaSetupSql(role: string): string {
	assertRoleName(role);
	return [`CREATE ROLE ${role} NOLOGIN;`, `GRANT ${role} TO <hub 连接使用的数据库用户>;`].join("\n");
}

/** Creates the app role (when missing) and makes the connecting user a member so `SET LOCAL ROLE` works. Never silently skips RLS. */
export async function ensureAppRole(db: Db, role: string): Promise<void> {
	assertRoleName(role);
	try {
		const existing = await db.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
		if (existing.length === 0) await db.query(`CREATE ROLE ${role} NOLOGIN`);
		const member = await db.query<{ ok: boolean }>("SELECT pg_has_role(current_user, $1, 'member') AS ok", [role]);
		if (!member[0]?.ok) await db.query(`GRANT ${role} TO CURRENT_USER`);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`${LOG_PREFIX} 无法创建或授予数据库应用角色 ${role}（${reason}）。行级安全需要该角色，请让数据库管理员预先执行:\n${dbaSetupSql(role)}\n然后重新启动。`,
		);
	}
}

/** Applies pending migrations in name order, then (re)grants the app role on every table so later migrations need no GRANT of their own. */
export async function migrate(db: Db, opts: MigrateOptions): Promise<string[]> {
	const dir = opts.dir ?? defaultMigrationsDir();
	await ensureAppRole(db, opts.appRole);
	await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");

	const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
	const applied: string[] = [];
	for (const file of files) {
		const version = MIGRATION_FILE.exec(file)?.[1] as string;
		const sql = (await readFile(`${dir}/${file}`, "utf8")).replaceAll(ROLE_PLACEHOLDER, opts.appRole);
		const ran = await db.tx({ system: true }, async (q) => {
			await q.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
			const done = await q.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
			if (done.length > 0) return false;
			await q.exec(sql);
			await q.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
			return true;
		});
		if (ran) {
			applied.push(version);
			opts.log?.info(`${LOG_PREFIX} 已应用数据库迁移 ${version}`);
		}
	}

	await db.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${opts.appRole}`);
	await db.exec(`REVOKE ALL ON schema_migrations FROM ${opts.appRole}`);
	return applied;
}
