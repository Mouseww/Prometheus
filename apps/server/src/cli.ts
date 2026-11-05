import { homedir } from "node:os";
import { join } from "node:path";

export const HUB_DEFAULT_PORT = 7421;

export interface RoleSettings {
	role: "server" | "hub";
	/** Environment variables to set (only ones the operator left unset). */
	env: Record<string, string>;
}

/** The value of `--role <x>` or `--role=<x>`; undefined when the flag is absent. */
function roleArg(argv: readonly string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--role") return argv[i + 1] ?? "";
		if (arg.startsWith("--role=")) return arg.slice("--role=".length);
	}
	return undefined;
}

/**
 * `--role hub` is the same as PROMETHEUS_ROLE=hub. A Hub listens on 7421 and keeps its data in ~/.prometheus-hub unless
 * the operator chose a port or data directory. Throws on an unknown role so a typo never starts a normal server.
 */
export function resolveRole(argv: readonly string[], env: NodeJS.ProcessEnv, home: string = homedir()): RoleSettings {
	const flag = roleArg(argv)?.trim().toLowerCase();
	if (flag !== undefined && flag !== "hub" && flag !== "server") throw new Error(`不支持的 --role 值：${flag || "(空)"}，可选 hub 或 server`);
	const role = flag ?? (env.PROMETHEUS_ROLE?.trim().toLowerCase() === "hub" ? "hub" : "server");
	const patch: Record<string, string> = {};
	if (flag !== undefined) patch.PROMETHEUS_ROLE = flag;
	if (role === "hub") {
		if (!env.PROMETHEUS_PORT) patch.PROMETHEUS_PORT = String(HUB_DEFAULT_PORT);
		if (!env.PROMETHEUS_HOME) patch.PROMETHEUS_HOME = join(home, ".prometheus-hub");
	}
	return { role, env: patch };
}
