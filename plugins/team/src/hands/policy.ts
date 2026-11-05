import { readFile } from "node:fs/promises";

/** Shell tools of the agent runtime; a tenant policy that disables one of them also disables `team_exec`. */
const SHELL_TOOLS = ["bash", "powershell", "team_exec"];

/** Tools the administrator disabled for this server (`disabledTools` of `PROMETHEUS_POLICY`); empty when there is no readable policy. */
export async function readDisabledTools(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	const file = env.PROMETHEUS_POLICY?.trim();
	if (!file) return [];
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as { disabledTools?: unknown };
		return Array.isArray(parsed.disabledTools) ? parsed.disabledTools.filter((t): t is string => typeof t === "string") : [];
	} catch {
		return [];
	}
}

export async function shellDisabled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	const disabled = await readDisabledTools(env);
	return SHELL_TOOLS.some((t) => disabled.includes(t));
}
