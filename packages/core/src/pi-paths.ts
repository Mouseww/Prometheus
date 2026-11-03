import { homedir } from "node:os";
import { join } from "node:path";

/** The PI agent's config folder (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`), computed here so it is known without PI installed. */
export function piAgentDir(): string {
	const custom = process.env.PI_CODING_AGENT_DIR?.trim();
	if (custom) return custom === "~" ? homedir() : custom.startsWith("~/") ? join(homedir(), custom.slice(2)) : custom;
	return join(homedir(), ".pi", "agent");
}

/** True when an error only says the PI packages are not installed (as opposed to PI itself failing). */
export function isPiMissing(err: unknown): boolean {
	const e = err as { code?: string; message?: string } | undefined;
	return (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND") && String(e?.message).includes("@earendil-works/");
}
