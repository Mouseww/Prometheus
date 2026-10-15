import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeStore } from "@prometheus/plugin-sdk";
import type { GatewayConfig } from "@prometheus/protocol";
import { describe, expect, it } from "vitest";
import { KnowledgeService } from "../src/service.ts";

const gateway = (id: string): GatewayConfig => ({ id, name: id, format: "openai-completions", baseUrl: "https://x.test/v1", auth: { type: "bearer" }, models: [] });

async function setup() {
	const dropped: string[] = [];
	const store: KnowledgeStore = {
		upsert: async () => {},
		search: async () => [],
		deleteDocument: async () => {},
		count: async () => 0,
		drop: async () => void dropped.push("drop"),
	};
	const service = new KnowledgeService({
		dataDir: await mkdtemp(join(tmpdir(), "kb-")),
		stores: () => new Map([["mem", async () => store]]),
		gateways: () => [gateway("a"), gateway("b")],
		embedFn: async (_g, _m, inputs) => inputs.map(() => [1, 2, 3]),
	});
	await service.load();
	const base = await service.create({ name: "kb", store: "mem", embedding: { gatewayId: "a", model: "m1" } });
	return { service, base, dropped };
}

describe("KnowledgeService.update", () => {
	it("changes the embedding model of an empty base", async () => {
		const { service, base } = await setup();
		const out = await service.update(base.id, { embedding: { gatewayId: "b", model: " m2 " }, name: "renamed" });
		expect(out).toMatchObject({ name: "renamed", embedding: { gatewayId: "b", model: "m2" } });
	});

	it("refuses to swap the model once documents exist, but still allows renaming", async () => {
		const { service, base } = await setup();
		await service.ingest(base.id, "doc", "hello world");
		await expect(service.update(base.id, { embedding: { gatewayId: "a", model: "m2" } })).rejects.toThrow("无法更换向量模型");
		expect(await service.update(base.id, { embedding: { gatewayId: "a", model: "m1" }, description: "d" })).toMatchObject({ description: "d" });
	});

	it("drops the old vector table when the model changes after documents were removed", async () => {
		const { service, base, dropped } = await setup();
		const doc = await service.ingest(base.id, "doc", "hello world");
		await service.removeDocument(base.id, doc.id);
		await service.update(base.id, { embedding: { gatewayId: "a", model: "m2" } });
		expect(dropped).toEqual(["drop"]);
	});

	it("rejects unknown gateways", async () => {
		const { service, base } = await setup();
		await expect(service.update(base.id, { embedding: { gatewayId: "zzz", model: "m" } })).rejects.toThrow("Embedding 网关不存在");
	});
});
