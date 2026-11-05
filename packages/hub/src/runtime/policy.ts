import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Plugins a tenant keeps: no desktop automation, no ssh keys, no browser. */
export const TENANT_PLUGINS = ["team", "git", "memory", "skills", "todos", "subagents", "modes", "mcp", "knowledge-lancedb", "terminal"] as const;
export const RESTRICTED_TOOLS = ["bash", "powershell"] as const;

/** Mirrors `GatewayConfig` of `@prometheus/protocol` (the Hub does not depend on it). */
export interface PolicyGateway {
	id: string;
	name: string;
	format: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
	baseUrl: string;
	auth: { type: "bearer" } | { type: "native" };
	apiKey: string;
	models: { id: string; name?: string }[];
	alternates?: Record<string, string>;
}

export interface TenantPolicy {
	serverOwner: string;
	forbiddenModes: string[];
	readOutsideProject: "ask";
	pluginAllowlist: string[];
	gateways: PolicyGateway[];
	managedBy: string;
	disabledTools?: string[];
}

export interface PolicyInput {
	userId: string;
	/** Restricted mode for someone other than the Hub owner: no shell, no terminal plugin. */
	restricted: boolean;
	/** Whether the installed core accepts `disabledTools` (it rejects unknown policy keys, so it must not be sent blindly). */
	supportsDisabledTools: boolean;
	gateways: PolicyGateway[];
	managedBy: string;
}

export function buildTenantPolicy(input: PolicyInput): TenantPolicy {
	const plugins = TENANT_PLUGINS.filter((p) => !(input.restricted && p === "terminal"));
	return {
		serverOwner: input.userId,
		forbiddenModes: ["bypassPermissions", "auto"],
		readOutsideProject: "ask",
		pluginAllowlist: [...plugins],
		gateways: input.gateways,
		managedBy: input.managedBy,
		...(input.restricted && input.supportsDisabledTools ? { disabledTools: [...RESTRICTED_TOOLS] } : {}),
	};
}

/**
 * Whether core's policy parser knows `disabledTools`. `HUB_TENANT_DISABLED_TOOLS=0|1` overrides; otherwise the core
 * source is inspected (a Hub next to a core that lacks the key would make every restricted tenant fail to start).
 */
export function detectDisabledToolsSupport(env: NodeJS.ProcessEnv = process.env, read: (path: string) => string = (p) => readFileSync(p, "utf8")): boolean {
	const forced = env.HUB_TENANT_DISABLED_TOOLS?.trim();
	if (forced === "1") return true;
	if (forced === "0") return false;
	try {
		return read(fileURLToPath(new URL("../../../core/src/policy.ts", import.meta.url))).includes('"disabledTools"');
	} catch {
		return false;
	}
}
