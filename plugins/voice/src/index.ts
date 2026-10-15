import { join } from "node:path";
import { transcribe } from "@prometheus/gateway";
import { createJsonStore, definePlugin } from "@prometheus/plugin-sdk";
import type { GatewayConfig, VoiceSettings, VoiceState } from "@prometheus/protocol";

/** Longest recording accepted: about two minutes of compressed speech, well under the WebSocket frame cap. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MIN_AUDIO_BYTES = 800;
const EMPTY: VoiceSettings = { gatewayId: "", model: "", language: "" };
const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|flac)$/;

export function decodeAudio(base64: unknown): Uint8Array {
	if (typeof base64 !== "string" || !base64) throw new Error("没有收到录音");
	// Reject before decoding: base64 inflates by a third.
	if (base64.length > Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 8) throw new Error("录音太长，请分段说话（单次上限约 2 分钟）");
	const bytes = Buffer.from(base64, "base64");
	if (bytes.length < MIN_AUDIO_BYTES) throw new Error("录音太短，没有识别到内容");
	return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

export function checkMime(mime: unknown): string {
	const base = typeof mime === "string" ? (mime.split(";")[0] ?? "").trim().toLowerCase() : "";
	if (!AUDIO_TYPES.test(base)) throw new Error(`不支持的音频格式：${String(mime)}`);
	return typeof mime === "string" ? mime : base;
}

export function pickGateway(gateways: GatewayConfig[], id: string): GatewayConfig {
	const g = gateways.find((x) => x.id === id);
	if (!g) throw new Error("语音识别使用的网关不存在，请在 设置 → 语音 中重新选择");
	if (g.enabled === false) throw new Error(`网关「${g.name}」已停用`);
	return g;
}

export default definePlugin({
	name: "voice",
	version: "0.1.0",
	optional: true,
	setup(ctx) {
		const store = createJsonStore<VoiceSettings>(join(ctx.dataDir, "voice.json"), () => ({ ...EMPTY }));
		const read = async (): Promise<VoiceSettings> => ({ ...EMPTY, ...(await store.read()) });
		const state = async (): Promise<VoiceState> => {
			const s = await read();
			return { ...s, configured: Boolean(s.gatewayId && s.model && ctx.gateways().some((g) => g.id === s.gatewayId && g.enabled !== false)) };
		};

		ctx.rpc("state", state);

		ctx.rpc("configure", async (p): Promise<VoiceState> => {
			const gatewayId = typeof p.gatewayId === "string" ? p.gatewayId : "";
			const model = typeof p.model === "string" ? p.model.trim() : "";
			const language = typeof p.language === "string" ? p.language.trim().toLowerCase() : "";
			if (gatewayId) pickGateway(ctx.gateways(), gatewayId);
			if (language && !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(language)) throw new Error("语言应为 zh、en 这样的代码，或留空自动识别");
			await store.update(() => ({ gatewayId, model, language }));
			return state();
		});

		ctx.rpc("transcribe", async (p): Promise<{ text: string }> => {
			const s = await read();
			if (!s.gatewayId || !s.model) throw new Error("尚未配置语音识别，请先到 设置 → 语音 选择网关和模型");
			const gateway = pickGateway(ctx.gateways(), s.gatewayId);
			const audio = decodeAudio(p.audio);
			const mime = checkMime(p.mimeType);
			const text = await transcribe(gateway, s.model, audio, mime, { language: s.language || undefined, signal: AbortSignal.timeout(60_000) });
			if (!text) throw new Error("没有识别到语音内容");
			return { text };
		});
	},
});
