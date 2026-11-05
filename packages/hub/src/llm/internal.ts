import type { HubDeps } from "../deps.ts";
import type { UsageService } from "../services/usage.ts";
import { type SelectedGateway, selectGateway } from "./select.ts";
import { joinUpstreamUrl } from "./url.ts";
import { usageFromObject } from "./usage-extract.ts";

const REQUEST_TIMEOUT_MS = 90_000;

export interface StructuredRequest {
	/** Organization whose gateways are tried first; null for personal workspaces. */
	orgId: string | null;
	system: string;
	prompt: string;
	schemaName: string;
	/** A strict JSON schema: every property required, `additionalProperties: false`. */
	schema: Record<string, unknown>;
}

export interface InternalLlm {
	/** Whether a platform or organization gateway with at least one model exists for this organization. */
	available(orgId: string | null): Promise<boolean>;
	/**
	 * One call through the Hub's own gateways (the same selection the proxy uses) that must return JSON.
	 * Usage is booked to the ledger as user `system`. Throws on any transport, status or parse problem; callers fall back.
	 */
	completeJson(req: StructuredRequest): Promise<unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Gemini's responseSchema rejects `additionalProperties`. */
function withoutAdditionalProperties(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(withoutAdditionalProperties);
	if (!isRecord(schema)) return schema;
	return Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "additionalProperties").map(([k, v]) => [k, withoutAdditionalProperties(v)]));
}

/** Finds a JSON object in model text that may be wrapped in a code fence or prose. */
export function extractJson(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		// fall through to the lenient path
	}
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
	const candidates = [fenced, trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)];
	for (const c of candidates) {
		if (!c) continue;
		try {
			return JSON.parse(c);
		} catch {
			// try the next candidate
		}
	}
	throw new Error("模型输出不是有效的 JSON");
}

function build(gateway: SelectedGateway, model: string, req: StructuredRequest): { url: string; headers: Record<string, string>; body: unknown } {
	const json = { "content-type": "application/json" };
	switch (gateway.format) {
		case "anthropic":
			return {
				url: joinUpstreamUrl(gateway.baseUrl, "v1/messages"),
				headers: { ...json, "x-api-key": gateway.apiKey, "anthropic-version": "2023-06-01" },
				body: { model, max_tokens: 4096, system: `${req.system}\n只输出符合要求的 JSON，不要输出其他文字。`, messages: [{ role: "user", content: req.prompt }] },
			};
		case "gemini":
			return {
				url: joinUpstreamUrl(gateway.baseUrl, `v1beta/models/${encodeURIComponent(model)}:generateContent`),
				headers: { ...json, "x-goog-api-key": gateway.apiKey },
				body: {
					systemInstruction: { parts: [{ text: req.system }] },
					contents: [{ role: "user", parts: [{ text: req.prompt }] }],
					generationConfig: { responseMimeType: "application/json", responseSchema: withoutAdditionalProperties(req.schema) },
				},
			};
		default:
			return {
				url: joinUpstreamUrl(gateway.baseUrl, "chat/completions"),
				headers: { ...json, authorization: `Bearer ${gateway.apiKey}` },
				body: {
					model,
					messages: [
						{ role: "system", content: req.system },
						{ role: "user", content: req.prompt },
					],
					response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
				},
			};
	}
}

function textOf(gateway: SelectedGateway, data: unknown): string {
	if (!isRecord(data)) throw new Error("上游响应不是对象");
	if (gateway.format === "anthropic") {
		const parts = Array.isArray(data.content) ? data.content : [];
		return parts.map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : "")).join("");
	}
	if (gateway.format === "gemini") {
		const first = Array.isArray(data.candidates) ? data.candidates[0] : undefined;
		const parts = isRecord(first) && isRecord(first.content) && Array.isArray(first.content.parts) ? first.content.parts : [];
		return parts.map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : "")).join("");
	}
	const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
	const content = isRecord(choice) && isRecord(choice.message) ? choice.message.content : undefined;
	if (typeof content !== "string") throw new Error("上游响应缺少 message.content");
	return content;
}

export function createInternalLlm(deps: HubDeps, usage: UsageService): InternalLlm {
	const pick = (orgId: string | null): Promise<SelectedGateway | undefined> =>
		selectGateway(deps.db, deps.secretBox, deps.log, { orgIds: orgId ? [orgId] : [], requireModels: true }).then((s) => s.chosen);

	return {
		async available(orgId) {
			return (await pick(orgId)) !== undefined;
		},

		async completeJson(req) {
			const gateway = await pick(req.orgId);
			if (!gateway) throw new Error("没有可用的模型网关");
			const model = gateway.models[0]?.id;
			if (!model) throw new Error("网关没有配置模型");
			const { url, headers, body } = build(gateway, model, req);
			const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "manual" });
			if (!res.ok) throw new Error(`上游返回 ${res.status}`);
			const data: unknown = await res.json();
			const used = usageFromObject(gateway.format, data);
			await usage.record({
				userId: "system",
				orgId: gateway.scope === "org" ? gateway.orgId : req.orgId,
				gatewayId: gateway.id,
				model,
				inputTokens: used.input ?? 0,
				outputTokens: used.output ?? 0,
				source: gateway.scope === "user" ? "byok" : gateway.scope,
			});
			return extractJson(textOf(gateway, data));
		},
	};
}
