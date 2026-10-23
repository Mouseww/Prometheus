import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { embed } from "@prometheus/gateway";
import type { KnowledgeStore, KnowledgeStoreFactory } from "@prometheus/plugin-sdk";
import { AppError, type GatewayConfig, type KnowledgeBaseInfo, type KnowledgeDocumentInfo, type KnowledgeHit } from "@prometheus/protocol";
import { chunkText } from "./chunker.ts";

interface BaseRecord {
	id: string;
	name: string;
	description?: string;
	store: string;
	embedding: { gatewayId: string; model: string };
	dimensions?: number;
	documents: KnowledgeDocumentInfo[];
}

export interface KnowledgeServiceOptions {
	dataDir: string;
	stores: () => Map<string, KnowledgeStoreFactory>;
	gateways: () => GatewayConfig[];
	embedFn?: typeof embed;
}

const EMBED_BATCH = 64;
const MAX_DOCUMENT_CHARS = 2_000_000;

/** Owns knowledge base metadata and coordinates chunking, embedding and storage. */
export class KnowledgeService {
	private bases = new Map<string, BaseRecord>();
	private open = new Map<string, Promise<KnowledgeStore>>();
	private readonly indexPath: string;
	private readonly embedFn: typeof embed;
	private readonly options: KnowledgeServiceOptions;

	constructor(options: KnowledgeServiceOptions) {
		this.options = options;
		this.indexPath = join(options.dataDir, "bases.json");
		this.embedFn = options.embedFn ?? embed;
	}

	async load(): Promise<void> {
		await mkdir(this.options.dataDir, { recursive: true });
		try {
			const list = JSON.parse(await readFile(this.indexPath, "utf8")) as BaseRecord[];
			this.bases = new Map(list.map((b) => [b.id, b]));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}

	list(): KnowledgeBaseInfo[] {
		return [...this.bases.values()].map((b) => this.info(b));
	}

	get(id: string): KnowledgeBaseInfo | undefined {
		const b = this.bases.get(id);
		return b && this.info(b);
	}

	async create(input: { name: string; description?: string; store?: string; embedding: { gatewayId: string; model: string } }): Promise<KnowledgeBaseInfo> {
		const store = input.store ?? "lancedb";
		if (!this.options.stores().has(store)) throw new AppError("kbStoreUnknown", { store });
		if (!input.name.trim()) throw new AppError("kbNameEmpty");
		this.gateway(input.embedding.gatewayId);
		const record: BaseRecord = {
			id: `kb_${randomUUID().slice(0, 8)}`,
			name: input.name.trim(),
			description: input.description?.trim() || undefined,
			store,
			embedding: input.embedding,
			documents: [],
		};
		this.bases.set(record.id, record);
		await this.persist();
		return this.info(record);
	}

	async update(id: string, patch: { name?: string; description?: string; embedding?: { gatewayId: string; model: string } }): Promise<KnowledgeBaseInfo> {
		const record = this.require(id);
		if (patch.embedding) {
			const { gatewayId, model } = patch.embedding;
			const changed = gatewayId !== record.embedding.gatewayId || model !== record.embedding.model;
			// Vectors from different models are not comparable, so the model is locked once documents exist.
			if (changed && record.documents.length > 0) throw new AppError("kbEmbeddingLocked");
			if (!model.trim()) throw new AppError("kbModelEmpty");
			this.gateway(gatewayId);
			if (changed && record.dimensions) {
				// Emptied base: discard the old-dimension table so the next ingest recreates it.
				await (await this.store(record)).drop();
				this.open.delete(id);
				await rm(join(this.options.dataDir, "stores", id), { recursive: true, force: true });
			}
			if (changed) record.dimensions = undefined;
			record.embedding = { gatewayId, model: model.trim() };
		}
		if (patch.name !== undefined) {
			if (!patch.name.trim()) throw new AppError("kbNameEmpty");
			record.name = patch.name.trim();
		}
		if (patch.description !== undefined) record.description = patch.description.trim() || undefined;
		await this.persist();
		return this.info(record);
	}

	async delete(id: string): Promise<void> {
		const record = this.require(id);
		if (record.dimensions) await (await this.store(record)).drop();
		this.open.delete(id);
		this.bases.delete(id);
		await rm(join(this.options.dataDir, "stores", id), { recursive: true, force: true });
		await this.persist();
	}

	documents(id: string): KnowledgeDocumentInfo[] {
		return this.require(id).documents;
	}

	async ingest(id: string, title: string, text: string): Promise<KnowledgeDocumentInfo> {
		const record = this.require(id);
		if (text.length > MAX_DOCUMENT_CHARS) throw new AppError("kbDocumentTooLarge", { max: MAX_DOCUMENT_CHARS });
		const chunks = chunkText(text);
		if (!chunks.length) throw new AppError("kbDocumentEmpty");

		const vectors = await this.embedAll(record, chunks);
		if (!record.dimensions) record.dimensions = vectors[0]?.length;
		const documentId = randomUUID();
		const store = await this.store(record);
		await store.upsert(
			chunks.map((chunk, i) => ({ id: `${documentId}:${i}`, documentId, title, text: chunk, vector: vectors[i] ?? [] })),
		);
		const doc: KnowledgeDocumentInfo = { id: documentId, title, chunks: chunks.length, addedAt: new Date().toISOString() };
		record.documents.push(doc);
		await this.persist();
		return doc;
	}

	async removeDocument(id: string, documentId: string): Promise<void> {
		const record = this.require(id);
		if (record.dimensions) await (await this.store(record)).deleteDocument(documentId);
		record.documents = record.documents.filter((d) => d.id !== documentId);
		await this.persist();
	}

	async search(id: string, query: string, topK = 5): Promise<KnowledgeHit[]> {
		const record = this.require(id);
		if (!record.dimensions || !query.trim()) return [];
		const [vector] = await this.embedAll(record, [query]);
		const hits = await (await this.store(record)).search(vector ?? [], Math.min(Math.max(topK, 1), 20));
		return hits.map((h) => ({ documentId: h.documentId, title: h.title, text: h.text, score: h.score }));
	}

	private async embedAll(record: BaseRecord, texts: string[]): Promise<number[][]> {
		const gateway = this.gateway(record.embedding.gatewayId);
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += EMBED_BATCH) {
			out.push(...(await this.embedFn(gateway, record.embedding.model, texts.slice(i, i + EMBED_BATCH))));
		}
		return out;
	}

	private store(record: BaseRecord): Promise<KnowledgeStore> {
		let pending = this.open.get(record.id);
		if (!pending) {
			const factory = this.options.stores().get(record.store);
			if (!factory) throw new AppError("kbStoreMissing", { store: record.store });
			pending = factory({
				baseId: record.id,
				dataDir: join(this.options.dataDir, "stores", record.id),
				dimensions: record.dimensions ?? 0,
				settings: {},
			});
			pending.catch(() => this.open.delete(record.id));
			this.open.set(record.id, pending);
		}
		return pending;
	}

	private gateway(id: string): GatewayConfig {
		const g = this.options.gateways().find((x) => x.id === id);
		if (!g) throw new AppError("embeddingGatewayMissing", { id });
		return g;
	}

	private require(id: string): BaseRecord {
		const b = this.bases.get(id);
		if (!b) throw new AppError("kbNotFound", { id });
		return b;
	}

	private info(b: BaseRecord): KnowledgeBaseInfo {
		return {
			id: b.id,
			name: b.name,
			description: b.description,
			store: b.store,
			embedding: b.embedding,
			documentCount: b.documents.length,
			chunkCount: b.documents.reduce((n, d) => n + d.chunks, 0),
		};
	}

	private async persist(): Promise<void> {
		const tmp = `${this.indexPath}.tmp`;
		await writeFile(tmp, JSON.stringify([...this.bases.values()], null, 2));
		await rename(tmp, this.indexPath);
	}
}
