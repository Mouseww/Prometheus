import { AppError } from "@prometheus/protocol";

export type ServerRole = "server" | "hub";

/** `PROMETHEUS_ROLE=hub` makes this instance a team Hub: it never runs an agent of its own. Anything else is a normal server. */
export function serverRole(env: NodeJS.ProcessEnv = process.env): ServerRole {
	return env.PROMETHEUS_ROLE?.trim().toLowerCase() === "hub" ? "hub" : "server";
}

/**
 * The only RPC methods a Hub answers: reading sessions, the settings and gateway administration its owner needs,
 * health and the workspace list. Everything else (including methods added later) is refused, so a new method that
 * could drive an agent or touch the machine is denied until someone decides a Hub may have it.
 */
const HUB_ALLOWED_METHODS: ReadonlySet<string> = new Set([
	"host.info",
	"session.list", "session.messages", "session.toolResult", "session.stats", "usage.stats",
	"workspace.list",
	"settings.get", "settings.set",
	"gateway.list", "gateway.save", "gateway.delete", "gateway.test", "gateway.models", "gateway.pricing", "gateway.defaults", "gateway.piList", "gateway.piImport",
	"plugin.list", "plugin.call", "panel.link",
]);

/** The one plugin a Hub lets clients call into; the rest are agent tools or reach into other machines. */
const HUB_CALLABLE_PLUGIN = "team";

/** Plugins a Hub does not load unless the policy names them in `pluginAllowlist`. */
const HUB_DEFAULT_EXCLUDED: ReadonlySet<string> = new Set(["terminal", "ssh", "computer-use", "browser", "workbench", "folder"]);

/** Plugins a Hub never loads: its scheduled jobs belong to the team plugin. */
const HUB_NEVER: ReadonlySet<string> = new Set(["automations", "flows"]);

/** Throws `agentDisabled` when a Hub is asked for anything outside its allowlist (see `HUB_ALLOWED_METHODS`). */
export function assertAgentAllowed(role: ServerRole, method: string, params: unknown): void {
	if (role !== "hub") return;
	if (!HUB_ALLOWED_METHODS.has(method)) throw new AppError("agentDisabled");
	if (method === "plugin.call") {
		const plugin = (params as { plugin?: unknown } | null | undefined)?.plugin;
		if (plugin !== HUB_CALLABLE_PLUGIN) throw new AppError("agentDisabled");
	}
}

/** Whether a plugin may load under this role and the administrator's allowlist (if any). */
export function pluginAllowed(role: ServerRole, allowlist: readonly string[] | undefined, name: string): boolean {
	if (role === "hub" && HUB_NEVER.has(name)) return false;
	if (allowlist) return allowlist.includes(name);
	return !(role === "hub" && HUB_DEFAULT_EXCLUDED.has(name));
}
