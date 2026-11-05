import { AppError } from "@prometheus/protocol";

export type ServerRole = "server" | "hub";

/** `PROMETHEUS_ROLE=hub` makes this instance a team Hub: it never runs an agent of its own. Anything else is a normal server. */
export function serverRole(env: NodeJS.ProcessEnv = process.env): ServerRole {
	return env.PROMETHEUS_ROLE?.trim().toLowerCase() === "hub" ? "hub" : "server";
}

/** RPC methods that create or drive an agent; a Hub refuses them. */
const HUB_BLOCKED_METHODS: ReadonlySet<string> = new Set(["session.create", "chat.prompt", "message.fork", "session.switchRuntime"]);

/** Plugin methods that start a shell or reach into another machine, by plugin name. */
const HUB_BLOCKED_PLUGIN_METHODS: Readonly<Record<string, ReadonlySet<string>>> = {
	terminal: new Set(["open", "run"]),
	ssh: new Set(["test"]),
};

/** Plugins a Hub does not load unless the policy names them in `pluginAllowlist`. */
const HUB_DEFAULT_EXCLUDED: ReadonlySet<string> = new Set(["terminal", "ssh", "computer-use", "browser", "workbench", "folder"]);

/** Plugins a Hub never loads: its scheduled jobs belong to the team plugin. */
const HUB_NEVER: ReadonlySet<string> = new Set(["automations", "flows"]);

/** Throws `agentDisabled` when a Hub is asked to create or drive an agent. */
export function assertAgentAllowed(role: ServerRole, method: string, params: unknown): void {
	if (role !== "hub") return;
	if (HUB_BLOCKED_METHODS.has(method)) throw new AppError("agentDisabled");
	if (method === "plugin.call") {
		const { plugin, method: inner } = (params ?? {}) as { plugin?: unknown; method?: unknown };
		if (typeof plugin === "string" && typeof inner === "string" && HUB_BLOCKED_PLUGIN_METHODS[plugin]?.has(inner)) throw new AppError("agentDisabled");
	}
}

/** Whether a plugin may load under this role and the administrator's allowlist (if any). */
export function pluginAllowed(role: ServerRole, allowlist: readonly string[] | undefined, name: string): boolean {
	if (role === "hub" && HUB_NEVER.has(name)) return false;
	if (allowlist) return allowlist.includes(name);
	return !(role === "hub" && HUB_DEFAULT_EXCLUDED.has(name));
}
