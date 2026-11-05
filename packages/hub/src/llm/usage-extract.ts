import type { GatewayFormat } from "../services/models.ts";

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface UsageExtractor {
	push(chunk: Uint8Array): void;
	/** The usage seen in the response, or undefined when the response carried none. */
	end(): TokenUsage | undefined;
}

interface Partial {
	input?: number;
	output?: number;
}

const MAX_JSON_BYTES = 32 * 1024 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function fromOpenAi(obj: Record<string, unknown>): Partial {
	// Chat Completions carries `usage` on the final chunk (prompt/completion); Responses carries it on `response` (input/output).
	const usage = isRecord(obj.usage) ? obj.usage : isRecord(obj.response) && isRecord(obj.response.usage) ? obj.response.usage : undefined;
	if (!usage) return {};
	return { input: num(usage.prompt_tokens) ?? num(usage.input_tokens), output: num(usage.completion_tokens) ?? num(usage.output_tokens) };
}

function fromAnthropic(obj: Record<string, unknown>): Partial {
	// message_start: message.usage (input and a first output count); message_delta: usage (cumulative output); plain JSON: usage.
	const usage = isRecord(obj.usage) ? obj.usage : isRecord(obj.message) && isRecord(obj.message.usage) ? obj.message.usage : undefined;
	if (!usage) return {};
	const base = num(usage.input_tokens);
	const input = base === undefined ? undefined : base + (num(usage.cache_creation_input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0);
	return { input, output: num(usage.output_tokens) };
}

function fromGemini(obj: Record<string, unknown>): Partial {
	const meta = isRecord(obj.usageMetadata) ? obj.usageMetadata : isRecord(obj.response) && isRecord(obj.response.usageMetadata) ? obj.response.usageMetadata : undefined;
	if (!meta) return {};
	const candidates = num(meta.candidatesTokenCount);
	const thoughts = num(meta.thoughtsTokenCount);
	return { input: num(meta.promptTokenCount), output: candidates === undefined && thoughts === undefined ? undefined : (candidates ?? 0) + (thoughts ?? 0) };
}

/** Usage found in one parsed JSON object (a whole response or one SSE event). */
export function usageFromObject(format: GatewayFormat, obj: unknown): Partial {
	if (!isRecord(obj)) return {};
	return format === "openai" ? fromOpenAi(obj) : format === "anthropic" ? fromAnthropic(obj) : fromGemini(obj);
}

export function createUsageExtractor(format: GatewayFormat, contentType: string | null | undefined): UsageExtractor {
	const sse = (contentType ?? "").toLowerCase().includes("text/event-stream");
	let input: number | undefined;
	let output: number | undefined;

	const absorb = (obj: unknown): void => {
		const p = usageFromObject(format, obj);
		// Later values win (final chunk, last usageMetadata, cumulative message_delta); Anthropic input only ever grows.
		if (p.input !== undefined) input = format === "anthropic" ? Math.max(input ?? 0, p.input) : p.input;
		if (p.output !== undefined) output = p.output;
	};

	if (sse) {
		const decoder = new TextDecoder();
		let buffer = "";
		const line = (raw: string): void => {
			const text = raw.replace(/\r$/, "");
			if (!text.startsWith("data:")) return;
			const data = text.slice(5).trim();
			if (!data || data === "[DONE]") return;
			try {
				absorb(JSON.parse(data));
			} catch {
				// A partial or non-JSON data line carries no usage.
			}
		};
		return {
			push(chunk) {
				buffer += decoder.decode(chunk, { stream: true });
				let at = buffer.indexOf("\n");
				while (at >= 0) {
					line(buffer.slice(0, at));
					buffer = buffer.slice(at + 1);
					at = buffer.indexOf("\n");
				}
			},
			end() {
				buffer += decoder.decode();
				if (buffer) line(buffer);
				return input === undefined && output === undefined ? undefined : { inputTokens: input ?? 0, outputTokens: output ?? 0 };
			},
		};
	}

	const chunks: Uint8Array[] = [];
	let size = 0;
	return {
		push(chunk) {
			size += chunk.length;
			if (size <= MAX_JSON_BYTES) chunks.push(chunk);
		},
		end() {
			if (size > MAX_JSON_BYTES || size === 0) return undefined;
			try {
				const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				// Gemini's non-SSE stream is a JSON array of chunks.
				for (const item of Array.isArray(parsed) ? parsed : [parsed]) absorb(item);
			} catch {
				return undefined;
			}
			return input === undefined && output === undefined ? undefined : { inputTokens: input ?? 0, outputTokens: output ?? 0 };
		},
	};
}
