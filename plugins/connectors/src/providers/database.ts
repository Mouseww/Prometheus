import { Type } from "@earendil-works/pi-ai";
import type { ConnectorProvider, OperationContext } from "../types.ts";

const MAX_ROWS = 200;

/** Replace comments and quoted text with blanks, so keyword checks cannot be fooled by literals. */
export function stripSql(sql: string): string {
	return sql
		.replace(/--[^\n]*/g, " ")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/'(?:[^']|'')*'/g, "''")
		.replace(/"(?:[^"]|"")*"/g, '""')
		.replace(/`[^`]*`/g, "``")
		.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
}

const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|attach|detach|copy|call|merge|replace|vacuum|reindex|into|lock|set|do|exec|execute)\b/i;

/**
 * Conservative: a single statement that starts like a read and mentions no write keyword.
 * It rejects some harmless queries (a column named `set`); the database-level read-only
 * session still backs it up for engines that support it.
 */
export function isReadOnlySql(sql: string): boolean {
	const clean = stripSql(sql).trim().replace(/;+\s*$/, "");
	if (!clean || clean.includes(";")) return false;
	if (!/^(select|with|explain|show|values|pragma|describe|desc)\b/i.test(clean)) return false;
	if (/^pragma\b[^=]*=/i.test(clean)) return false;
	return !WRITE_WORDS.test(clean);
}

export type Dialect = "postgres" | "sqlite";

export function dialectOf(connection: string): Dialect {
	if (/^postgres(ql)?:\/\//i.test(connection)) return "postgres";
	if (/^sqlite:/i.test(connection)) return "sqlite";
	throw new Error("连接串应以 postgres://、postgresql:// 或 sqlite:<文件路径> 开头");
}

interface Rows {
	columns: string[];
	rows: unknown[][];
	truncated: boolean;
	affected?: number;
}

function shape(columns: string[], all: unknown[][], affected?: number): Rows {
	return { columns, rows: all.slice(0, MAX_ROWS), truncated: all.length > MAX_ROWS, affected };
}

async function runSqlite(path: string, sql: string, params: unknown[], readOnly: boolean): Promise<Rows> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(path, { readOnly });
	try {
		const stmt = db.prepare(sql);
		stmt.setReadBigInts(false);
		if (stmt.columns().length === 0) {
			const r = stmt.run(...(params as never[]));
			return { columns: [], rows: [], truncated: false, affected: Number(r.changes) };
		}
		const columns = stmt.columns().map((c) => c.name);
		const objs = stmt.all(...(params as never[])) as Record<string, unknown>[];
		return shape(columns, objs.map((o) => columns.map((k) => o[k])));
	} finally {
		db.close();
	}
}

async function runPostgres(url: string, sql: string, params: unknown[], readOnly: boolean): Promise<Rows> {
	// `pg` is an optional dependency: only users of PostgreSQL need to install it.
	let mod: { Client: new (o: { connectionString: string; statement_timeout?: number }) => PgClient };
	try {
		const name = "pg";
		mod = (await import(name)) as typeof mod;
	} catch {
		throw new Error("使用 PostgreSQL 需要先安装驱动：在 Prometheus 目录执行 `pnpm add pg`");
	}
	const client = new mod.Client({ connectionString: url, statement_timeout: 30_000 });
	await client.connect();
	try {
		await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
		const r = await client.query({ text: sql, values: params, rowMode: "array" });
		await client.query(readOnly ? "ROLLBACK" : "COMMIT");
		return shape(
			r.fields.map((f) => f.name),
			r.rows as unknown[][],
			r.fields.length ? undefined : (r.rowCount ?? 0),
		);
	} catch (err) {
		await client.query("ROLLBACK").catch(() => {});
		throw err;
	} finally {
		await client.end().catch(() => {});
	}
}

interface PgClient {
	connect(): Promise<void>;
	end(): Promise<void>;
	query(q: string | { text: string; values?: unknown[]; rowMode?: string }): Promise<{ fields: { name: string }[]; rows: unknown[]; rowCount: number | null }>;
}

function connectionOf(c: OperationContext): string {
	const v = c.credentials.secrets.connection;
	if (!v) throw new Error("连接串缺失");
	return v;
}

function exec(c: OperationContext, sql: string, params: unknown[], readOnly: boolean): Promise<Rows> {
	const conn = connectionOf(c);
	return dialectOf(conn) === "sqlite" ? runSqlite(conn.replace(/^sqlite:/i, ""), sql, params, readOnly) : runPostgres(conn, sql, params, readOnly);
}

const sqlParam = Type.String({ description: "SQL，使用 $1/$2（Postgres）或 ?（SQLite）占位符传参" });
const paramsParam = Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])));

export const database: ConnectorProvider = {
	id: "database",
	name: "Database (PostgreSQL / SQLite)",
	category: "database",
	description: "查询并（经授权）修改关系型数据库。建议使用只读账号",
	auth: [{ kind: "connection-string", help: "postgres://user:pass@host:5432/db 或 sqlite:/path/to/file.db" }],
	fields: { "connection-string": [{ key: "connection", label: "连接串", secret: true, required: true, placeholder: "postgres://user:pass@host/db" }] },
	async test(c) {
		const conn = connectionOf(c);
		await exec(c, "SELECT 1", [], true);
		return dialectOf(conn);
	},
	operations: [
		{
			name: "schema",
			description: "列出表与列",
			access: "read",
			params: Type.Object({}),
			async run(_p, c) {
				const conn = connectionOf(c);
				const sql =
					dialectOf(conn) === "sqlite"
						? "SELECT m.name AS table_name, p.name AS column_name, p.type AS data_type FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid"
						: "SELECT table_schema || '.' || table_name AS table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1, ordinal_position";
				const r = await exec(c, sql, [], true);
				const tables: Record<string, string[]> = {};
				for (const [t, col, type] of r.rows as string[][]) (tables[String(t)] ??= []).push(`${col} ${type}`);
				return tables;
			},
		},
		{
			name: "query",
			description: `只读查询（单条 SELECT/WITH/EXPLAIN/SHOW），最多返回 ${MAX_ROWS} 行`,
			access: "read",
			params: Type.Object({ sql: sqlParam, params: paramsParam }),
			async run(p, c) {
				const sql = String(p.sql);
				if (!isReadOnlySql(sql)) throw new Error("query 只接受单条只读语句；修改数据请使用 execute");
				return exec(c, sql, (p.params as unknown[]) ?? [], true);
			},
		},
		{
			name: "execute",
			description: "执行会修改数据或结构的语句（INSERT/UPDATE/DELETE/DDL）",
			access: "write",
			params: Type.Object({ sql: sqlParam, params: paramsParam }),
			async run(p, c) {
				return exec(c, String(p.sql), (p.params as unknown[]) ?? [], false);
			},
		},
	],
};
