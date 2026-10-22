import { GATEWAY_FORMATS, type GatewayConfig, type GatewayFormat, type GatewayModel } from "@prometheus/protocol";

/** Structural mirror of PI's ProviderConfig (only the fields Prometheus emits). */
export interface PiProviderConfig {
	name: string;
	baseUrl: string;
	apiKey: string;
	api: GatewayFormat;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models: PiChatModelConfig[];
}

export interface PiChatModelConfig {
	id: string;
	name: string;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	/** Passed through to PI. Adaptive-thinking Claude models need this or the API returns 400. */
	compat?: { forceAdaptiveThinking?: boolean };
	/** `off: null` tells PI to omit `thinking` instead of sending `type: disabled`. */
	thinkingLevelMap?: { off?: string | null; xhigh?: string | null; max?: string | null };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,47}$/;
const HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
// PI needs a non-empty key to treat a provider as authenticated; "none" auth sends nothing meaningful.
const PLACEHOLDER_KEY = "prometheus-no-auth";

export function validateGateway(g: GatewayConfig): string[] {
	const errors: string[] = [];
	if (!ID_PATTERN.test(g.id)) errors.push("id 只能包含小写字母、数字、- 和 _，且不超过 48 个字符");
	if (!g.name?.trim()) errors.push("name 不能为空");
	if (!GATEWAY_FORMATS.includes(g.format)) errors.push(`不支持的 format：${g.format}`);
	try {
		const url = new URL(g.baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") errors.push("baseUrl 必须是 http(s) 地址");
	} catch {
		errors.push("baseUrl 不是合法 URL");
	}
	if (g.auth.type === "header" && !HEADER_PATTERN.test(g.auth.header)) errors.push("自定义鉴权头名不合法");
	if (g.auth.type !== "none" && !g.apiKey) errors.push("该鉴权类型需要提供 API Key / Token");
	for (const name of Object.keys(g.headers ?? {})) {
		if (!HEADER_PATTERN.test(name)) errors.push(`请求头名不合法：${name}`);
	}
	if (!g.models.length) errors.push("至少配置一个模型");
	const seen = new Set<string>();
	for (const m of g.models) {
		if (!m.id.trim()) errors.push("模型 id 不能为空");
		if (seen.has(m.id)) errors.push(`模型 id 重复：${m.id}`);
		seen.add(m.id);
	}
	return errors;
}

/**
 * PI interpolates `$NAME`, `${NAME}` and a leading `!command` inside apiKey/header values.
 * User-entered secrets are literals, so escape them to stop env leaks and command execution.
 */
export function escapePiValue(value: string): string {
	const escaped = value.replaceAll("$", "$$$$");
	return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

/**
 * Claude models that reject budget-based `thinking.type=enabled`.
 * Mirrors PI's Bedrock detector so custom Anthropic gateways send `thinking.type=adaptive`.
 */
export function requiresAdaptiveThinking(id: string, name?: string): boolean {
	const values = name?.trim() ? [id, name] : [id];
	return values.some((value) => {
		const s = value.toLowerCase().replace(/[\s_.:]+/g, "-");
		return (
			s.includes("opus-4-6") ||
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("opus-5") ||
			s.includes("sonnet-4-6") ||
			s.includes("sonnet-5") ||
			s.includes("haiku-5") ||
			s.includes("fable-5")
		);
	});
}

/** Anthropic's SDK always appends `/v1/messages`; a gateway URL that already ends in `/v1` would 404. */
export function normalizeProviderBaseUrl(format: GatewayFormat, baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (format === "anthropic-messages") return trimmed.replace(/\/v1$/i, "");
	return trimmed;
}

function toModel(m: GatewayModel, format: GatewayFormat): PiChatModelConfig {
	const model: PiChatModelConfig = {
		id: m.id,
		name: m.name?.trim() || m.id,
		input: m.vision ? ["text", "image"] : ["text"],
		cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cacheRead ?? 0, cacheWrite: m.cost?.cacheWrite ?? 0 },
		reasoning: m.reasoning ?? false,
		contextWindow: m.contextWindow ?? 128_000,
		maxTokens: m.maxTokens ?? 16_384,
	};
	if (format === "anthropic-messages" && requiresAdaptiveThinking(m.id, m.name)) {
		model.compat = { forceAdaptiveThinking: true };
		// Claude 5.5 rejects `thinking.type=disabled`; omitting the field is the off mode.
		model.thinkingLevelMap = { off: null };
	}
	// PI only offers xhigh/max when the model maps them explicitly, so they are opt-in per model.
	if (model.reasoning && (m.xhigh || m.max)) {
		model.thinkingLevelMap = { ...model.thinkingLevelMap, ...(m.xhigh ? { xhigh: "xhigh" } : {}), ...(m.max ? { max: "max" } : {}) };
	}
	return model;
}

export function toProviderConfig(g: GatewayConfig): PiProviderConfig {
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(g.headers ?? {})) headers[k] = escapePiValue(v);

	const secret = g.apiKey ?? "";
	let piKey = secret ? escapePiValue(secret) : PLACEHOLDER_KEY;
	let authHeader: boolean | undefined;

	switch (g.auth.type) {
		case "native":
			break;
		case "bearer":
			if (g.format === "openai-completions" || g.format === "openai-responses") {
				// OpenAI SDKs already send Authorization: Bearer <apiKey>.
				break;
			}
			authHeader = true;
			break;
		case "header":
			headers[g.auth.header] = escapePiValue(`${g.auth.prefix ?? ""}${secret}`);
			// Native auth still runs; a placeholder keeps the real key out of the protocol's default header.
			piKey = PLACEHOLDER_KEY;
			break;
		case "none":
			piKey = PLACEHOLDER_KEY;
			break;
	}

	return {
		name: g.name,
		baseUrl: normalizeProviderBaseUrl(g.format, g.baseUrl),
		apiKey: piKey,
		api: g.format,
		...(Object.keys(headers).length ? { headers } : {}),
		...(authHeader ? { authHeader } : {}),
		models: g.models.map((m) => toModel(m, g.format)),
	};
}

export function maskSecret(secret: string | undefined): string {
	if (!secret) return "";
	if (secret.length <= 8) return "••••";
	return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}

/** Gateway as returned to clients: secret masked. */
export function redactGateway(g: GatewayConfig): GatewayConfig {
	const masked = maskSecret(g.apiKey);
	return { ...g, apiKey: masked };
}

/** Merge an update from a client; a masked or empty apiKey keeps the stored secret. */
export function mergeGatewayUpdate(incoming: GatewayConfig, existing: GatewayConfig | undefined): GatewayConfig {
	const keepSecret = !incoming.apiKey || (existing && incoming.apiKey === maskSecret(existing.apiKey));
	const previous = existing?.apiKey;
	const next = incoming.apiKey;
	const stored = keepSecret ? previous : next;
	return { ...incoming, apiKey: stored, enabled: incoming.enabled ?? true };
}

// ---------- Embeddings (used by the knowledge base) ----------

export interface EmbedOptions {
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

function authHeaders(g: GatewayConfig): Record<string, string> {
	const h: Record<string, string> = { ...(g.headers ?? {}) };
	const key = g.apiKey ?? "";
	switch (g.auth.type) {
		case "none":
			break;
		case "header":
			h[g.auth.header] = `${g.auth.prefix ?? ""}${key}`;
			break;
		case "bearer":
			h.Authorization = `Bearer ${key}`;
			break;
		case "native":
			if (g.format === "google-generative-ai") h["x-goog-api-key"] = key;
			else h.Authorization = `Bearer ${key}`;
			break;
	}
	return h;
}

export async function embed(g: GatewayConfig, model: string, inputs: string[], options: EmbedOptions = {}): Promise<number[][]> {
	if (!inputs.length) return [];
	const doFetch = options.fetchImpl ?? fetch;
	const base = g.baseUrl.replace(/\/+$/, "");

	if (g.format === "anthropic-messages") {
		throw new Error("Anthropic 协议不提供 Embedding 接口，请为知识库选择 OpenAI 或 Gemini 格式的网关");
	}

	if (g.format === "google-generative-ai") {
		const modelPath = model.startsWith("models/") ? model : `models/${model}`;
		const res = await doFetch(`${base}/${modelPath}:batchEmbedContents`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders(g) },
			body: JSON.stringify({ requests: inputs.map((text) => ({ model: modelPath, content: { parts: [{ text }] } })) }),
			signal: options.signal,
		});
		if (!res.ok) throw new Error(`Embedding 请求失败：HTTP ${res.status} ${await safeText(res)}`);
		const json = (await res.json()) as { embeddings: { values: number[] }[] };
		return json.embeddings.map((e) => e.values);
	}

	const res = await doFetch(`${base}/embeddings`, {
		method: "POST",
		headers: { "content-type": "application/json", ...authHeaders(g) },
		body: JSON.stringify({ model, input: inputs }),
		signal: options.signal,
	});
	if (!res.ok) throw new Error(`Embedding 请求失败：HTTP ${res.status} ${await safeText(res)}`);
	const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
	return [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// ---------- Speech to text ----------

export interface TranscribeOptions extends EmbedOptions {
	/** ISO-639-1 hint such as "zh"; omitted lets the model detect the language. */
	language?: string;
}

const AUDIO_EXTENSIONS: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac" };

/** Strips codec parameters: "audio/webm;codecs=opus" -> "audio/webm". */
export function baseMime(mime: string): string {
	return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * Turns recorded audio into text through a gateway. OpenAI-compatible endpoints use
 * `/audio/transcriptions` (Whisper and friends); Gemini transcribes through `generateContent`.
 * Anthropic has no audio input.
 */
export async function transcribe(g: GatewayConfig, model: string, audio: Uint8Array, mimeType: string, options: TranscribeOptions = {}): Promise<string> {
	const doFetch = options.fetchImpl ?? fetch;
	const base = g.baseUrl.replace(/\/+$/, "");
	const mime = baseMime(mimeType) || "audio/webm";

	if (g.format === "anthropic-messages") {
		throw new Error("Anthropic 协议不支持语音转文字，请选择 OpenAI 或 Gemini 格式的网关");
	}

	if (g.format === "google-generative-ai") {
		const modelPath = model.startsWith("models/") ? model : `models/${model}`;
		const hint = options.language ? ` The language is ${options.language}.` : "";
		const res = await doFetch(`${base}/${modelPath}:generateContent`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders(g) },
			body: JSON.stringify({
				contents: [{ parts: [{ text: `Transcribe this audio verbatim.${hint} Reply with the transcript only, no commentary.` }, { inlineData: { mimeType: mime, data: Buffer.from(audio).toString("base64") } }] }],
			}),
			signal: options.signal,
		});
		if (!res.ok) throw new Error(`语音转写失败：HTTP ${res.status} ${await safeText(res)}`);
		const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
		return (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
	}

	const form = new FormData();
	form.set("model", model);
	form.set("response_format", "json");
	if (options.language) form.set("language", options.language);
	form.set("file", new Blob([Buffer.from(audio)], { type: mime }), `speech.${AUDIO_EXTENSIONS[mime] ?? "webm"}`);
	// No content-type header: fetch adds the multipart boundary itself.
	const { "content-type": _ignored, ...headers } = authHeaders(g);
	const res = await doFetch(`${base}/audio/transcriptions`, { method: "POST", headers, body: form, signal: options.signal });
	if (!res.ok) throw new Error(`语音转写失败：HTTP ${res.status} ${await safeText(res)}`);
	const json = (await res.json()) as { text?: string };
	return (json.text ?? "").trim();
}

// ---------- Model catalogue ----------

function catalogueHeaders(g: GatewayConfig): Record<string, string> {
	if (g.format === "anthropic-messages") {
		const h: Record<string, string> = { ...(g.headers ?? {}), "anthropic-version": "2023-06-01" };
		const key = g.apiKey ?? "";
		if (g.auth.type === "native") h["x-api-key"] = key;
		else if (g.auth.type === "bearer") h.Authorization = `Bearer ${key}`;
		else if (g.auth.type === "header") h[g.auth.header] = `${g.auth.prefix ?? ""}${key}`;
		return h;
	}
	return authHeaders(g);
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** OpenRouter-style `pricing` (USD per token, as strings) -> USD per 1M tokens; undefined when absent or all zero. */
function parsePricing(raw: unknown): GatewayModel["cost"] {
	if (!raw || typeof raw !== "object") return undefined;
	const p = raw as Record<string, unknown>;
	const per = (v: unknown) => {
		const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
		return Number.isFinite(n) && n > 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : 0;
	};
	const cost = { input: per(p.prompt), output: per(p.completion), cacheRead: per(p.input_cache_read), cacheWrite: per(p.input_cache_write) };
	return cost.input || cost.output ? cost : undefined;
}

/** Fetch the provider's model list (`/models`); fields the provider doesn't report are left undefined. */
export async function listModels(g: GatewayConfig, options: EmbedOptions = {}): Promise<GatewayModel[]> {
	const doFetch = options.fetchImpl ?? fetch;
	const base = g.baseUrl.replace(/\/+$/, "");
	const headers = catalogueHeaders(g);
	const get = async (url: string) => {
		const res = await doFetch(url, { headers, signal: options.signal });
		if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status} ${await safeText(res)}`);
		return (await res.json()) as Record<string, unknown>;
	};

	let models: GatewayModel[] = [];
	if (g.format === "google-generative-ai") {
		const json = await get(`${base}/models?pageSize=1000`);
		const list = Array.isArray(json.models) ? (json.models as Record<string, unknown>[]) : [];
		models = list
			.filter((m) => !Array.isArray(m.supportedGenerationMethods) || (m.supportedGenerationMethods as string[]).includes("generateContent"))
			.map((m) => ({
				id: String(m.name ?? "").replace(/^models\//, ""),
				name: typeof m.displayName === "string" ? m.displayName : undefined,
				contextWindow: num(m.inputTokenLimit),
				maxTokens: num(m.outputTokenLimit),
				reasoning: m.thinking === true ? true : undefined,
			}));
	} else {
		const url = g.format === "anthropic-messages" && !/\/v1$/.test(base) ? `${base}/v1/models?limit=1000` : `${base}/models`;
		const json = await get(url);
		const list = Array.isArray(json.data) ? (json.data as Record<string, unknown>[]) : [];
		models = list.map((m) => {
			const top = (m.top_provider ?? {}) as Record<string, unknown>;
			const arch = (m.architecture ?? {}) as Record<string, unknown>;
			const modalities = Array.isArray(arch.input_modalities) ? (arch.input_modalities as string[]) : undefined;
			const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]) : undefined;
			return {
				id: String(m.id ?? ""),
				name: typeof m.display_name === "string" ? m.display_name : typeof m.name === "string" ? m.name : undefined,
				contextWindow: num(m.context_length) ?? num(m.context_window) ?? num(m.max_input_tokens),
				maxTokens: num(top.max_completion_tokens) ?? num(m.max_tokens),
				vision: modalities ? modalities.includes("image") : undefined,
				reasoning: params ? params.includes("reasoning") : undefined,
				cost: parsePricing(m.pricing),
			};
		});
	}
	const seen = new Set<string>();
	return models
		.filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
		.sort((a, b) => a.id.localeCompare(b.id));
}

async function safeText(res: Response): Promise<string> {
	try {
		return (await res.text()).slice(0, 300);
	} catch {
		return "";
	}
}
export * from "./external.ts";
