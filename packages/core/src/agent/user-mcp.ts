// The MCP servers the user configured (Settings -> MCP) as other agent runtimes can use them. PI connects its own servers
// natively; the others are handed the same list when a session starts. `${VAR}` references are resolved from the environment.
import type { PluginHost } from "../plugin-host.ts";

export type UserMcpServer =
	| { name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
	| { name: string; type: "http"; url: string; headers: Record<string, string> };

const expand = (v: string) => v.replace(/\$\{([A-Za-z_]\w*)\}/g, (_, n: string) => process.env[n] ?? "");
const record = (v: unknown): Record<string, string> =>
	v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string").map(([k, x]) => [k, expand(x as string)])) : {};

/** Enabled servers, minus names the tool bus already uses. */
export async function userMcpServers(plugins: PluginHost, reserved: readonly string[] = ["prometheus"]): Promise<UserMcpServer[]> {
	const out: UserMcpServer[] = [];
	for (const { name, config } of (await plugins.externalView()).mcpServers ?? []) {
		const c = config as unknown as Record<string, unknown>;
		if (!c || c.enabled === false || reserved.includes(name) || !/^[\w-]{1,64}$/.test(name)) continue;
		if (c.type === "http" && typeof c.url === "string") out.push({ name, type: "http", url: expand(c.url), headers: record(c.headers) });
		else if (typeof c.command === "string" && c.command) {
			out.push({ name, type: "stdio", command: expand(c.command), args: Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === "string").map(expand) : [], env: record(c.env), ...(typeof c.cwd === "string" ? { cwd: c.cwd } : {}) });
		}
	}
	return out;
}
