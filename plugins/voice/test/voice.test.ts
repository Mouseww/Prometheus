import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayConfig } from "@prometheus/protocol";
import plugin, { checkMime, decodeAudio, MAX_AUDIO_BYTES, pickGateway } from "../src/index.ts";

const b64 = (n: number) => Buffer.alloc(n, 1).toString("base64");

describe("decodeAudio / checkMime", () => {
	it("accepts a plausible recording", () => {
		expect(decodeAudio(b64(2000)).length).toBe(2000);
	});
	it("rejects empty, tiny and oversize audio", () => {
		expect(() => decodeAudio("")).toThrow(/没有收到/);
		expect(() => decodeAudio(undefined)).toThrow(/没有收到/);
		expect(() => decodeAudio(b64(100))).toThrow(/太短/);
		expect(() => decodeAudio(b64(MAX_AUDIO_BYTES + 10))).toThrow(/太长/);
	});
	it("only allows audio mime types, with codec parameters", () => {
		expect(checkMime("audio/webm;codecs=opus")).toBe("audio/webm;codecs=opus");
		expect(checkMime("audio/mp4")).toBe("audio/mp4");
		for (const bad of ["text/html", "audio/evil", "", undefined, 3]) expect(() => checkMime(bad)).toThrow(/不支持/);
	});
});

describe("pickGateway", () => {
	const g = { id: "a", name: "A", enabled: true } as GatewayConfig;
	it("finds enabled gateways only", () => {
		expect(pickGateway([g], "a")).toBe(g);
		expect(() => pickGateway([g], "zzz")).toThrow(/不存在/);
		expect(() => pickGateway([{ ...g, enabled: false }], "a")).toThrow(/已停用/);
	});
});

describe("voice plugin against a stub transcription server", () => {
	let received: { url?: string; auth?: string; type?: string; bytes: number } = { bytes: 0 };
	let reply = { status: 200, body: JSON.stringify({ text: " 你好 " }) };
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			received = { url: req.url, auth: String(req.headers.authorization), type: String(req.headers["content-type"]), bytes: Buffer.concat(chunks).length };
			res.writeHead(reply.status, { "content-type": "application/json" });
			res.end(reply.body);
		});
	});
	afterAll(() => server.close());
	beforeAll(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)));

	async function setup(gatewayOverrides: Partial<GatewayConfig> = {}) {
		const port = (server.address() as AddressInfo).port;
		const gateway = { id: "gw", name: "GW", format: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, auth: { type: "bearer" }, apiKey: "k-test-123456789", models: [], ...gatewayOverrides } as GatewayConfig;
		const rpcs = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
		await plugin.setup({
			dataDir: mkdtempSync(join(tmpdir(), "voice-")),
			gateways: () => [gateway],
			rpc: (m: string, h: never) => rpcs.set(m, h),
		} as never);
		return rpcs;
	}

	it("reports unconfigured, then configured", async () => {
		const rpcs = await setup();
		expect(await rpcs.get("state")!({})).toMatchObject({ configured: false });
		await expect(rpcs.get("transcribe")!({ audio: b64(2000), mimeType: "audio/webm" })).rejects.toThrow(/尚未配置/);
		expect(await rpcs.get("configure")!({ gatewayId: "gw", model: "whisper-1", language: "ZH" })).toMatchObject({ configured: true, language: "zh", model: "whisper-1" });
	});

	it("validates configuration", async () => {
		const rpcs = await setup();
		await expect(rpcs.get("configure")!({ gatewayId: "missing", model: "m" })).rejects.toThrow(/不存在/);
		await expect(rpcs.get("configure")!({ gatewayId: "gw", model: "m", language: "chinese!!" })).rejects.toThrow(/语言/);
	});

	it("sends authenticated multipart audio and returns trimmed text", async () => {
		const rpcs = await setup();
		await rpcs.get("configure")!({ gatewayId: "gw", model: "whisper-1", language: "zh" });
		reply = { status: 200, body: JSON.stringify({ text: " 你好 " }) };
		expect(await rpcs.get("transcribe")!({ audio: b64(3000), mimeType: "audio/webm;codecs=opus" })).toEqual({ text: "你好" });
		expect(received.url).toBe("/v1/audio/transcriptions");
		expect(received.auth).toBe("Bearer k-test-123456789");
		expect(received.type).toMatch(/^multipart\/form-data; boundary=/);
		expect(received.bytes).toBeGreaterThan(3000);
	});

	it("surfaces provider errors and empty transcripts", async () => {
		const rpcs = await setup();
		await rpcs.get("configure")!({ gatewayId: "gw", model: "whisper-1" });
		reply = { status: 401, body: "bad key" };
		await expect(rpcs.get("transcribe")!({ audio: b64(3000), mimeType: "audio/webm" })).rejects.toThrow(/transcribeFailed.*401/);
		reply = { status: 200, body: JSON.stringify({ text: "  " }) };
		await expect(rpcs.get("transcribe")!({ audio: b64(3000), mimeType: "audio/webm" })).rejects.toThrow(/没有识别到/);
	});
});
