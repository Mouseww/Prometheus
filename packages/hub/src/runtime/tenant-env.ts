import { randomBytes } from "node:crypto";
import type { GatewayFormat, VisibleModel } from "../services/models.ts";
import { CONTAINER_LAYOUT, CONTAINER_PORT, type TenantLayout } from "./driver.ts";
import type { PolicyGateway } from "./policy.ts";

/** Audience the tenant's own server checks (`PROMETHEUS_TRUST_AUDIENCE`). */
export const TENANT_AUDIENCE = "prometheus";
/** Audience of the long-lived credential the tenant's team plugin presents to the Hub; tokens for the LLM proxy use `LLM_AUDIENCE`. */
export { LLM_AUDIENCE, TENANT_TOKEN_AUDIENCE } from "../auth/tenant-credentials.ts";
export const TENANT_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
export const GATEWAY_TOKEN_TTL_SEC = 7 * 24 * 60 * 60;

export interface TenantEnvInput {
	userId: string;
	layout: TenantLayout;
	containerized: boolean;
	hubUrl: string;
	issuer: string;
	tenantToken: string;
	/** Random per start; only the Hub knows it. */
	serverToken: string;
}

/** Environment of a tenant server (spec 3.1). A process driver adds `PROMETHEUS_PORT` itself once it has allocated a port. */
export function buildTenantEnv(i: TenantEnvInput): Record<string, string> {
	return {
		PROMETHEUS_HOME: i.layout.data,
		PROMETHEUS_CWD: i.layout.work,
		PROMETHEUS_HOST: i.containerized ? "0.0.0.0" : "127.0.0.1",
		...(i.containerized ? { PROMETHEUS_PORT: String(CONTAINER_PORT) } : {}),
		PROMETHEUS_TOKEN: i.serverToken,
		// The server reads `@<path>` as a key file: a multi-line PEM survives every launcher (docker, cmd.exe set) that way.
		PROMETHEUS_TRUST_KEY: `@${i.layout.keyFile}`,
		PROMETHEUS_TRUST_ISSUER: i.issuer,
		PROMETHEUS_TRUST_AUDIENCE: TENANT_AUDIENCE,
		PROMETHEUS_POLICY: i.layout.policyFile,
		TEAM_HUB_URL: i.hubUrl,
		TEAM_TENANT_TOKEN: i.tenantToken,
	};
}

export const newServerToken = (): string => randomBytes(24).toString("hex");

export const layoutFor = (containerized: boolean, host: TenantLayout): TenantLayout => (containerized ? CONTAINER_LAYOUT : host);

const FORMAT_MAP: Record<GatewayFormat, { id: string; format: PolicyGateway["format"]; auth: PolicyGateway["auth"]; name: string }> = {
	openai: { id: "hub-openai", format: "openai-completions", auth: { type: "bearer" }, name: "团队模型 (OpenAI)" },
	anthropic: { id: "hub-anthropic", format: "anthropic-messages", auth: { type: "native" }, name: "团队模型 (Anthropic)" },
	gemini: { id: "hub-gemini", format: "google-generative-ai", auth: { type: "native" }, name: "团队模型 (Gemini)" },
};

/** One policy gateway per wire format, pointing at the Hub's LLM proxy; formats without any visible model are left out. */
export function buildPolicyGateways(models: readonly VisibleModel[], hubUrl: string, gatewayToken: string): PolicyGateway[] {
	const out: PolicyGateway[] = [];
	for (const format of Object.keys(FORMAT_MAP) as GatewayFormat[]) {
		const mine = models.filter((m) => m.format === format);
		if (mine.length === 0) continue;
		const meta = FORMAT_MAP[format];
		const seen = new Set<string>();
		const list = mine.filter((m) => !seen.has(m.id) && seen.add(m.id)).map((m) => ({ id: m.id, name: m.name }));
		out.push({ id: meta.id, name: meta.name, format: meta.format, baseUrl: `${hubUrl}/llm/${format}`, auth: meta.auth, apiKey: gatewayToken, models: list });
	}
	return out;
}
