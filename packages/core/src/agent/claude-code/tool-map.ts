// Normalizes Claude Code's tools to the names and argument shapes Prometheus already renders (docs §4.4).
import type { CanonicalToolKind } from "../types.ts";

/** Claude Code shows MCP tools as `mcp__<server>__<tool>`. */
export const PROMETHEUS_MCP_SERVER = "prometheus";
const MCP_PREFIX = `mcp__${PROMETHEUS_MCP_SERVER}__`;

export interface CanonicalCall {
	name: string;
	args: Record<string, unknown>;
	kind: CanonicalToolKind;
	/** The tool changes nothing, so it can run without asking. */
	readOnly: boolean;
	/** One of our own tools, served by the tool bus. */
	prometheus: boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const drop = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** `mcp__prometheus__memory_search` -> `memory_search`; other names pass through. */
export function stripPrometheusPrefix(name: string): string | undefined {
	return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : undefined;
}

export function canonicalTool(nativeName: string, rawInput: unknown): CanonicalCall {
	const input = obj(rawInput);
	const ours = stripPrometheusPrefix(nativeName);
	if (ours !== undefined) return { name: ours, args: input, kind: "mcp", readOnly: false, prometheus: true };
	const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(nativeName);
	if (mcp) return { name: nativeName, args: input, kind: "mcp", readOnly: false, prometheus: false };

	switch (nativeName) {
		case "Bash":
			return { name: "bash", args: drop({ command: str(input.command), timeout: input.timeout, description: str(input.description) }), kind: "exec", readOnly: false, prometheus: false };
		case "Read":
			return { name: "read", args: drop({ path: str(input.file_path), offset: input.offset, limit: input.limit }), kind: "read", readOnly: true, prometheus: false };
		case "Edit":
			return {
				name: "edit",
				args: { path: str(input.file_path) ?? "", edits: [{ oldText: str(input.old_string) ?? "", newText: str(input.new_string) ?? "" }], ...(input.replace_all ? { replaceAll: true } : {}) },
				kind: "edit",
				readOnly: false,
				prometheus: false,
			};
		case "MultiEdit": {
			const edits = Array.isArray(input.edits) ? input.edits.map(obj) : [];
			return {
				name: "edit",
				args: { path: str(input.file_path) ?? "", edits: edits.map((e) => ({ oldText: str(e.old_string) ?? "", newText: str(e.new_string) ?? "" })) },
				kind: "edit",
				readOnly: false,
				prometheus: false,
			};
		}
		case "Write":
			return { name: "write", args: { path: str(input.file_path) ?? "", content: str(input.content) ?? "" }, kind: "write", readOnly: false, prometheus: false };
		case "Grep":
			return { name: "grep", args: drop({ pattern: str(input.pattern), path: str(input.path), glob: str(input.glob) }), kind: "search", readOnly: true, prometheus: false };
		case "Glob":
			return { name: "find", args: drop({ pattern: str(input.pattern), path: str(input.path) }), kind: "search", readOnly: true, prometheus: false };
		case "WebFetch":
			return { name: "web_fetch", args: input, kind: "fetch", readOnly: true, prometheus: false };
		case "WebSearch":
			return { name: "web_search", args: input, kind: "fetch", readOnly: true, prometheus: false };
		case "TodoWrite":
			return { name: "todo_write", args: input, kind: "todo", readOnly: false, prometheus: false };
		case "ExitPlanMode":
			return { name: "exit_plan_mode", args: input, kind: "plan_exit", readOnly: false, prometheus: false };
		case "Task":
		case "Agent":
			return { name: "subagent", args: input, kind: "task", readOnly: false, prometheus: false };
		default:
			return { name: nativeName.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(), args: input, kind: "other", readOnly: false, prometheus: false };
	}
}

/** Canonical names -> what Claude Code calls them, for allow/deny lists (docs §4.5). Unknown names pass through. */
export function nativeToolNames(canonical: string): string[] {
	switch (canonical) {
		case "bash":
			return ["Bash"];
		case "read":
			return ["Read"];
		case "edit":
			return ["Edit", "MultiEdit"];
		case "write":
			return ["Write"];
		case "grep":
			return ["Grep"];
		case "find":
			return ["Glob"];
		case "web_fetch":
			return ["WebFetch"];
		case "web_search":
			return ["WebSearch"];
		case "todo_write":
			return ["TodoWrite"];
		default:
			return [canonical];
	}
}
