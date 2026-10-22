import type { ChatMessage } from "@prometheus/protocol";
import { useStore } from "./store.ts";

/**
 * Calls the git plugin without toasting failures: the composer and change list poll it in the background,
 * and "not a repo" or "plugin off" are normal states there. Resolves to undefined on any failure.
 */
export async function gitQuiet<T>(workspace: string | undefined, method: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
	const client = useStore.getState().client;
	if (!client || !workspace) return undefined;
	try {
		return (await client.rpc("plugin.call", { plugin: "git", method, params: { workspace, ...params } })) as T;
	} catch {
		return undefined;
	}
}

const EDIT_TOOLS = new Set(["edit", "write"]);

/** Files the agent wrote or edited in this conversation, as the tool calls named them (absolute or cwd-relative). */
export function editedPaths(messages: ChatMessage[]): string[] {
	const seen = new Set<string>();
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block?.type !== "toolCall" || !EDIT_TOOLS.has(block.name)) continue;
			const p = block.arguments?.path;
			if (typeof p === "string" && p) seen.add(p);
		}
	}
	return [...seen];
}
