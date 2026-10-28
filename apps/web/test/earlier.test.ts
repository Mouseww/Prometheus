// A long conversation opens with only its latest turns. The window must not change what the server is told:
// message refs count from the start of the whole conversation, and earlier turns are put in front when fetched.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", globalThis);
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0));
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));
vi.stubGlobal("document", { documentElement: { classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined }, style: { setProperty: () => undefined }, dataset: {} }, addEventListener: () => undefined, visibilityState: "visible" });
// The store reads browser globals while loading, so it is imported after they exist.
const { deleteMessage, loadEarlier, openSession, useStore } = await import("../src/lib/store.ts");

const user = (n: number) => ({ role: "user", content: `q${n}`, timestamp: 100 + n });
const reply = (n: number) => ({ role: "assistant", content: [{ type: "text", text: `a${n}` }], timestamp: 200 + n });

function snapshot(messages: unknown[], messageOffset?: number) {
	return {
		id: "s1",
		cwd: "/w",
		workspaceId: "w",
		messages,
		...(messageOffset ? { messageOffset } : {}),
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
		runtime: "pi",
		capabilities: {},
	};
}

describe("a conversation opened with only its latest turns", () => {
	let calls: { method: string; params: Record<string, unknown> }[];
	beforeEach(() => {
		calls = [];
		const client = {
			subscribe: () => undefined,
			unsubscribe: () => undefined,
			rpc: async (method: string, params: Record<string, unknown>) => {
				calls.push({ method, params });
				if (method === "session.open") return snapshot([user(3), reply(3), user(4), reply(4)], 6);
				if (method === "session.messages") return { messages: [user(1), reply(1), user(2), reply(2)], offset: 2 };
				if (method === "model.list" || method === "runtime.models") return [];
				return null;
			},
		};
		useStore.setState({ client: client as never, session: null });
	});

	it("asks for the latest turns only and remembers where they start", async () => {
		await openSession("s1");
		expect(calls.find((c) => c.method === "session.open")?.params.tail).toBeGreaterThan(0);
		expect(useStore.getState().session?.messageOffset).toBe(6);
	});

	it("tells the server the position in the whole conversation, not in the loaded part", async () => {
		await openSession("s1");
		await deleteMessage(2); // third loaded message: q4
		const del = calls.find((c) => c.method === "message.delete");
		expect(del?.params.ref).toEqual({ index: 8, role: "user", timestamp: 104 });
	});

	it("puts earlier turns in front, and positions follow", async () => {
		await openSession("s1");
		await loadEarlier();
		const s = useStore.getState().session!;
		expect(s.messageOffset).toBe(2);
		expect(s.messages).toHaveLength(8);
		expect((s.messages[0] as { content: string }).content).toBe("q1");
		expect(calls.find((c) => c.method === "session.messages")?.params).toMatchObject({ sessionId: "s1", before: 6 });
		await deleteMessage(0);
		expect(calls.find((c) => c.method === "message.delete")?.params.ref).toEqual({ index: 2, role: "user", timestamp: 101 });
	});

	it("does nothing when everything is already loaded", async () => {
		useStore.setState({ session: { ...(snapshot([user(1)]) as object), messageOffset: 0, tools: {}, banner: null, stats: null, pending: null } as never });
		await loadEarlier();
		expect(calls.some((c) => c.method === "session.messages")).toBe(false);
	});
});

describe("prefetching and full tool results", () => {
	it("asks the server to warm a hovered conversation once, after a short pause, and not the open one", async () => {
		vi.useFakeTimers();
		const calls: string[] = [];
		const client = { subscribe: () => undefined, unsubscribe: () => undefined, rpc: async (m: string, p: { sessionId?: string }) => (calls.push(`${m}:${p.sessionId}`), null) };
		useStore.setState({ client: client as never, session: { id: "open" } as never });
		const { prefetchSession } = await import("../src/lib/store.ts");
		prefetchSession("open");
		prefetchSession("a");
		prefetchSession("b"); // sweeping on: only the row the pointer rests on is warmed
		vi.advanceTimersByTime(200);
		expect(calls).toEqual(["session.warm:b"]);
		prefetchSession("b");
		vi.advanceTimersByTime(200);
		expect(calls).toHaveLength(1); // asked recently
		vi.useRealTimers();
	});

	it("fetches the untruncated tool result of the open conversation", async () => {
		const { fetchToolResult } = await import("../src/lib/store.ts");
		const client = { subscribe: () => undefined, unsubscribe: () => undefined, rpc: async (m: string, p: unknown) => (m === "session.toolResult" ? { content: [{ type: "text", text: "all of it" }], p } : null) };
		useStore.setState({ client: client as never, session: { id: "s1" } as never });
		expect(await fetchToolResult("t1")).toEqual([{ type: "text", text: "all of it" }]);
	});
});
