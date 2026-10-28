// Choosing an agent on the new-chat page after a workspace is picked: the empty session that picking created belongs to
// the previous agent and must be replaced, or the first message still goes to PI.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", globalThis);
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));
vi.stubGlobal("document", { documentElement: { classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined }, style: { setProperty: () => undefined }, dataset: {} }, addEventListener: () => undefined, visibilityState: "visible" });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0));
// The store reads browser globals while loading, so it is imported after they exist.
const { setDraftAgent, useStore } = await import("../src/lib/store.ts");

function snapshot(id: string, runtime: string, over: Record<string, unknown> = {}) {
	return {
		id,
		name: "",
		cwd: "/work/a",
		workspaceId: "w",
		messages: [],
		model: null,
		thinkingLevel: "off",
		availableThinkingLevels: [],
		permissionMode: "default",
		isStreaming: false,
		queue: { steering: [], followUp: [] },
		pendingUI: [],
		statuses: {},
		widgets: {},
		subagents: [],
		runtime,
		capabilities: {},
		...over,
	};
}

const cc = { id: "claude-code", name: "Claude Code", kind: "claude-code", health: { available: true }, capabilities: {} } as never;
const pi = { id: "pi", name: "PI", kind: "pi", health: { available: true }, capabilities: {} } as never;

describe("setDraftAgent", () => {
	let calls: { method: string; params: Record<string, unknown> }[];
	beforeEach(() => {
		calls = [];
		const client = {
			subscribe: () => undefined,
			unsubscribe: () => undefined,
			rpc: async (method: string, params: Record<string, unknown>) => {
				calls.push({ method, params });
				if (method === "session.create") return snapshot("new", String(params.runtime ?? "pi"));
				if (method === "runtime.models" || method === "model.list") return [];
				if (method === "session.stats") return null;
				if (method === "command.list" || method === "commands.list") return [];
				return null;
			},
		};
		useStore.setState({ client: client as never, draftRuntime: "pi", draftAgentId: "pi", draftModel: null, session: null });
	});

	it("replaces the empty session of the workspace just chosen with one of the chosen agent, in the same folder", async () => {
		useStore.setState({ session: { ...(snapshot("old", "pi") as object), tools: {}, banner: null, stats: null, pending: null } as never });
		await setDraftAgent(cc);
		const create = calls.find((c) => c.method === "session.create");
		expect(create?.params).toMatchObject({ cwd: "/work/a", runtime: "claude-code" });
		expect(useStore.getState().session?.id).toBe("new");
		expect(useStore.getState().session?.runtime).toBe("claude-code");
	});

	it("only changes the draft when there is no session yet", async () => {
		await setDraftAgent(cc);
		expect(calls.some((c) => c.method === "session.create")).toBe(false);
		expect(useStore.getState().draftRuntime).toBe("claude-code");
	});

	it("never replaces a conversation that already has messages", async () => {
		const withMessages = { ...(snapshot("old", "pi") as object), messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: {}, banner: null, stats: null, pending: null };
		useStore.setState({ session: withMessages as never });
		await setDraftAgent(pi);
		expect(calls.some((c) => c.method === "session.create")).toBe(false);
	});
});
