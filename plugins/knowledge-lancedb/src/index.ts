import type { Connection, Table } from "@lancedb/lancedb";
import { definePlugin, type KnowledgeChunk, type KnowledgeSearchResult, type KnowledgeStore, type KnowledgeStoreOptions } from "@prometheus/plugin-sdk";

const TABLE = "chunks";

interface Row {
	id: string;
	document_id: string;
	title: string;
	text: string;
	vector: number[];
	[key: string]: unknown;
}

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

export class LanceStore implements KnowledgeStore {
	private table: Table | undefined;
	private readonly db: Connection;

	private constructor(db: Connection, table: Table | undefined) {
		this.db = db;
		this.table = table;
	}

	static async open(options: KnowledgeStoreOptions): Promise<LanceStore> {
		// Loaded on first use: platforms without a native binding (Android) must still be able to start the server.
		const { connect } = await import("@lancedb/lancedb").catch((err: unknown) => {
			throw new Error(`当前平台不支持 LanceDB 向量库：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
		});
		const db = await connect(options.dataDir);
		const names = await db.tableNames();
		return new LanceStore(db, names.includes(TABLE) ? await db.openTable(TABLE) : undefined);
	}

	async upsert(chunks: KnowledgeChunk[]): Promise<void> {
		if (!chunks.length) return;
		const rows: Row[] = chunks.map((c) => ({ id: c.id, document_id: c.documentId, title: c.title, text: c.text, vector: c.vector }));
		if (!this.table) {
			this.table = await this.db.createTable(TABLE, rows);
			return;
		}
		await this.table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
	}

	async search(vector: number[], topK: number): Promise<KnowledgeSearchResult[]> {
		if (!this.table) return [];
		const rows = (await this.table.vectorSearch(vector).distanceType("cosine").limit(topK).toArray()) as (Row & { _distance: number })[];
		return rows.map((r) => ({ documentId: r.document_id, title: r.title, text: r.text, score: 1 - r._distance }));
	}

	async deleteDocument(documentId: string): Promise<void> {
		await this.table?.delete(`document_id = ${sqlString(documentId)}`);
	}

	async count(): Promise<number> {
		return this.table ? this.table.countRows() : 0;
	}

	async drop(): Promise<void> {
		if (!this.table) return;
		this.table.close();
		this.table = undefined;
		await this.db.dropTable(TABLE);
	}
}

export default definePlugin({
	name: "knowledge-lancedb",
	version: "0.1.0",
	setup(ctx) {
		ctx.knowledgeStore("lancedb", (options) => LanceStore.open(options));
	},
});
