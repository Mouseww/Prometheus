/**
 * Database seam. Conventions for every caller:
 * - pass jsonb values as `$n::text::jsonb` with `JSON.stringify(value)` (postgres.js would double-encode a string bound to a jsonb parameter);
 * - never call `db.query` from inside a `tx` callback (PGlite has a single connection and would deadlock): use the callback's `q`.
 */
export interface Queryable {
	query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
	/** Runs one or more statements without parameters (migrations). */
	exec(sql: string): Promise<void>;
}

export type DbScope = { system: true } | { userId: string; operator?: boolean };

export interface Db {
	query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
	exec(sql: string): Promise<void>;
	/** Runs fn in a transaction scoped to a user (RLS) or as the system (no user; bypasses org filtering). */
	tx<T>(scope: DbScope, fn: (q: Queryable) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Validates a role name that will be spliced into SQL (roles cannot be bound as parameters). */
export function assertRoleName(name: string): string {
	if (!IDENT.test(name)) throw new Error(`数据库角色名无效: ${name}`);
	return name;
}

/** Statements that open a user-scoped transaction: drop to the app role and publish the session settings RLS policies read. */
export function scopeStatements(scope: { userId: string; operator?: boolean }, role: string): { sql: string; params: unknown[] }[] {
	return [
		{ sql: `SET LOCAL ROLE ${assertRoleName(role)}`, params: [] },
		{ sql: "SELECT set_config('app.user_id', $1, true)", params: [scope.userId] },
		{ sql: "SELECT set_config('app.operator', $1, true)", params: [scope.operator ? "1" : "0"] },
	];
}

export function isUniqueViolation(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

export function toIso(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.toISOString();
	return new Date(String(value)).toISOString();
}
