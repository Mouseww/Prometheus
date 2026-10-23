import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";

/**
 * Tools a mode can name, listed statically.
 *
 * PI exposes its built-in tools as factories, so the catalog is derived here instead of from a live
 * session: a settings page has no session of its own, and reading one would tie the editor to
 * whichever chat happened to be open. Tools contributed by plugins are added by name below, since
 * they are registered per session and cannot be enumerated without one.
 */
const PLUGIN_TOOLS = [
	// PI registers it on Windows, but neither factory below returns it.
	"powershell",
	"todo_write",
	"open_file",
	"knowledge_search",
	"memory_search",
	"memory_save",
	"memory_forget",
	"subagent",
	"prompt_agent",
	"web_search",
	"web_fetch",
	"mcp_call",
	"codemode",
	"tool_search",
	"prometheus_plugin_install",
	"exit_plan_mode",
];

let cache: string[] | undefined;

/** Every tool name a mode may restrict to, sorted and de-duplicated. */
export function knownTools(): string[] {
	if (cache) return cache;
	const names = new Set<string>(PLUGIN_TOOLS);
	try {
		for (const t of createCodingTools(process.cwd())) names.add(t.name);
	} catch {
		// The platform has no bash (or a factory needs a real cwd); the static list still stands.
	}
	try {
		for (const t of createReadOnlyTools(process.cwd())) names.add(t.name);
	} catch {
		// same
	}
	cache = [...names].sort();
	return cache;
}
