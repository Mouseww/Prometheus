// PiRuntimeSession over a stub AgentSession: only the adapter logic is exercised, no PI, model or network.
import { type AgentSession, type AgentSessionEvent, type ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { MessageRef, SessionEvent } from "@prometheus/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingForks } from "../src/agent/pi/forks.ts";
import { PiRuntime } from "../src/agent/pi/pi-runtime.ts";
import { PI_CAPABILITIES, PiRuntimeSession, type PiSessionOptions } from "../src/agent/pi/pi-session.ts";
import type { SessionHooks } from "../src/agent/types.ts";
import { PermissionGate } from "../src/permission-gate.ts";
import { EXIT_PLAN_MODE } from "../src/permissions.ts";

function make(stub: Record<string, unknown>, hooks?: SessionHooks, extra?: Partial<PiSessionOptions>) {
	let push: ((e: AgentSessionEvent) => void) | undefined;
	// Same object as `stub`, so tests can change it after construction.
	const session = Object.assign(stub, { sessionId: "s1", subscribe: (fn: (e: AgentSessionEvent) => void) => ((push = fn), () => void (push = undefined)) });
	const notifyError = vi.fn();
	const adapter = new PiRuntimeSession({
		session: session as unknown as AgentSession,
		modelRuntime: {} as ModelRuntime,
		gate: new PermissionGate(),
		hooks,
		notifyError,
		keepFork: () => {},
		...extra,
	});
	return { adapter, notifyError, fire: (e: unknown) => push?.(e as AgentSessionEvent), subscribed: () => push !== undefined };
}

describe("PiRuntimeSession", () => {
	it("reports PI's full capability set", () => {
		const { adapter } = make({});
		expect(adapter.capabilities).toBe(PI_CAPABILITIES);
		expect(adapter.capabilities).toMatchObject({ steering: true, followUpQueue: true, fork: true, treeNavigation: true, compaction: "manual+auto", contextBreakdown: true });
		expect(adapter.capabilities.permissionModes).toContain("plan");
		expect(adapter.id).toBe("s1");
		expect(adapter.nativeId).toBe("s1");
	});

	it("tools() hides exit_plan_mode and flags the active tools", () => {
		const { adapter } = make({
			getActiveToolNames: () => ["read"],
			getAllTools: () => [{ name: "read", description: "Read" }, { name: "bash" }, { name: EXIT_PLAN_MODE, description: "plan" }],
		});
		expect(adapter.tools()).toEqual([
			{ name: "read", description: "Read", active: true },
			{ name: "bash", description: "", active: false },
		]);
	});

	it("onPermissionMode toggles exit_plan_mode and emits permission_mode_changed", () => {
		let active = ["read"];
		const events: SessionEvent[] = [];
		const { adapter } = make({ getActiveToolNames: () => active, setActiveToolsByName: (names: string[]) => void (active = names) }, { event: (e) => void events.push(e) });
		adapter.onPermissionMode("plan");
		expect(active).toEqual(["read", EXIT_PLAN_MODE]);
		adapter.onPermissionMode("default");
		expect(active).toEqual(["read"]);
		expect(events).toEqual([
			{ type: "permission_mode_changed", mode: "plan" },
			{ type: "permission_mode_changed", mode: "default" },
		]);
	});

	it("maps PI events to slim events and host hooks, in order", () => {
		const calls: string[] = [];
		const { adapter, fire } = make(
			{},
			{
				event: (e) => void calls.push(`event:${e.type}`),
				sessionsChanged: () => void calls.push("sessionsChanged"),
				contextReplaced: () => void calls.push("contextReplaced"),
				settled: () => void calls.push("settled"),
			},
		);
		const seen: string[] = [];
		adapter.subscribe((e) => void seen.push(e.type));
		fire({ type: "agent_start" });
		fire({ type: "compaction_end", reason: "manual", aborted: false, result: {} });
		fire({ type: "compaction_end", reason: "manual", aborted: true });
		fire({ type: "agent_settled", aborted: false });
		expect(calls).toEqual([
			"event:agent_start",
			"sessionsChanged",
			"event:compaction_end",
			"contextReplaced",
			"event:compaction_end",
			"event:agent_settled",
			"sessionsChanged",
			"settled",
		]);
		expect(seen).toEqual(["agent_start", "compaction_end", "compaction_end", "agent_settled"]);
	});

	it("prompt delivers as a new turn when idle and as follow-up by default while streaming", async () => {
		const prompt = vi.fn(async (_text: string, opts: { preflightResult: (d: string) => void }) => opts.preflightResult("queued"));
		const stub = { isStreaming: false, prompt };
		const { adapter } = make(stub);
		expect(await adapter.prompt({ text: "hi" }, "send")).toBe("queued");
		expect(prompt.mock.calls[0]?.[1]).toMatchObject({ streamingBehavior: undefined });
		stub.isStreaming = true;
		await adapter.prompt({ text: "again" }, "send");
		await adapter.prompt({ text: "steer" }, "steer");
		expect(prompt.mock.calls[1]?.[1]).toMatchObject({ streamingBehavior: "followUp" });
		expect(prompt.mock.calls[2]?.[1]).toMatchObject({ streamingBehavior: "steer" });
	});

	it("prompt reports a late failure to the user even after it was accepted", async () => {
		const error = new Error("boom");
		const { adapter, notifyError } = make({ isStreaming: false, prompt: async (_t: string, o: { preflightResult: (d: string) => void }) => (o.preflightResult("started"), Promise.reject(error)) });
		expect(await adapter.prompt({ text: "x" }, "send")).toBe("started");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(notifyError).toHaveBeenCalledWith("boom");
	});

	it("unqueue removes the label and the real message together, guarding against a stale index", () => {
		const emit = vi.fn();
		const image = { type: "image", data: "d", mimeType: "image/png" };
		const stub = {
			_steeringMessages: ["a", "b"],
			_followUpMessages: [],
			_emitQueueUpdate: emit,
			agent: { steeringQueue: { messages: [{ content: [{ type: "text", text: "a" }] }, { content: [image] }] }, followUpQueue: { messages: [] } },
		};
		const { adapter } = make(stub);
		expect(() => adapter.unqueue("steer", 1, "zzz")).toThrowError(/messageAlreadySent/);
		expect(adapter.unqueue("steer", 1, "b")).toEqual({ text: "b", images: [image] });
		expect(stub._steeringMessages).toEqual(["a"]);
		expect(stub.agent.steeringQueue.messages).toHaveLength(1);
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it("dispose detaches from PI", async () => {
		const dispose = vi.fn();
		const { adapter, subscribed } = make({ dispose });
		expect(subscribed()).toBe(true);
		await adapter.dispose();
		expect(subscribed()).toBe(false);
		expect(dispose).toHaveBeenCalled();
	});
});

describe("PiRuntimeSession.compact", () => {
	/** A chat of `tokens` estimated tokens (4 chars each) and a settings stub that records the overrides. */
	function compacting(tokens: number, configured: number, compact: () => Promise<unknown>) {
		const overrides: { compaction: { keepRecentTokens: number; modelOverrides?: Record<string, { keepRecentTokens: number }> } }[] = [];
		const stub = {
			model: { provider: "p", id: "m" },
			messages: [{ role: "user", content: "x".repeat(tokens * 4) }],
			settingsManager: { getCompactionKeepRecentTokens: () => configured, applyOverrides: (o: (typeof overrides)[number]) => void overrides.push(o) },
			compact: vi.fn(compact),
		};
		return { ...make(stub), stub, overrides };
	}

	it("caps keepRecentTokens at a third of a short chat while compacting, then restores the configured value", async () => {
		let finish!: () => void;
		const { adapter, stub, overrides } = compacting(3000, 20000, () => new Promise<void>((resolve) => (finish = resolve)));
		const done = adapter.compact("focus");
		expect(stub.compact).toHaveBeenCalledWith("focus");
		expect(overrides).toEqual([{ compaction: { keepRecentTokens: 1000, modelOverrides: { "p/m": { keepRecentTokens: 1000 } } } }]);
		finish();
		await done;
		expect(overrides).toHaveLength(2);
		expect(overrides[1]).toEqual({ compaction: { keepRecentTokens: 20000, modelOverrides: { "p/m": { keepRecentTokens: 20000 } } } });
	});

	it("restores the configured value and resolves when compaction fails", async () => {
		const { adapter, overrides } = compacting(3000, 20000, () => Promise.reject(new Error("nope")));
		await expect(adapter.compact()).resolves.toBeUndefined();
		expect(overrides.map((o) => o.compaction.keepRecentTokens)).toEqual([1000, 20000]);
	});

	it("leaves the setting alone when the configured value is within the cap", async () => {
		const { adapter, overrides } = compacting(90000, 20000, async () => {});
		await adapter.compact();
		expect(overrides).toEqual([]);
	});

	it("never rejects when restoring the setting throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { adapter, stub } = compacting(3000, 20000, async () => {});
			let calls = 0;
			stub.settingsManager.applyOverrides = () => {
				if (++calls > 1) throw new Error("disk full");
			};
			await expect(adapter.compact()).resolves.toBeUndefined();
			expect(calls).toBe(2);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});

describe("PiRuntimeSession message operations", () => {
	const user = { role: "user", content: "hello", timestamp: 1 };
	const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "toolCall", id: "c1", name: "read", arguments: {} }], timestamp: 2 };
	const result = { role: "toolResult", toolCallId: "c1", content: [], timestamp: 3 };
	const other = { role: "toolResult", toolCallId: "zz", content: [], timestamp: 4 };
	const refOf = (index: number, m: { role: string; timestamp: number }) => ({ index, role: m.role, timestamp: m.timestamp }) as MessageRef;

	function chat(overrides: Record<string, unknown> = {}, entries: object[] = [user, assistant, result, other]) {
		const edits: [string, null][] = [];
		const stub = {
			isStreaming: false,
			sessionFile: "/tmp/s.jsonl",
			refreshContext: vi.fn(),
			navigateTree: vi.fn(async (_id: string) => ({ cancelled: false })),
			sessionManager: {
				getCwd: () => "/work",
				buildSessionProjection: () => ({ entries: entries.map((m, i) => ({ sourceEntry: { id: `e${i}` }, messages: [m] })) }),
				appendContextEdit: (id: string, v: null) => void edits.push([id, v]),
			},
			...overrides,
		};
		return { ...make(stub), stub, edits };
	}

	it("refuses to locate a message while a reply is streaming", async () => {
		const { adapter } = chat({ isStreaming: true });
		await expect(adapter.deleteMessages(refOf(0, user))).rejects.toMatchObject({ code: "waitForReply" });
		await expect(adapter.rewind(refOf(0, user))).rejects.toMatchObject({ code: "waitForReply" });
		await expect(adapter.fork(refOf(0, user))).rejects.toMatchObject({ code: "waitForReply" });
	});

	it("reports messageChanged for a missing index or a mismatched role or timestamp", async () => {
		const { adapter, edits } = chat();
		await expect(adapter.deleteMessages(refOf(9, user))).rejects.toMatchObject({ code: "messageChanged" });
		await expect(adapter.deleteMessages({ ...refOf(0, user), role: "assistant" })).rejects.toMatchObject({ code: "messageChanged" });
		await expect(adapter.rewind({ ...refOf(0, user), timestamp: 99 })).rejects.toMatchObject({ code: "messageChanged" });
		expect(edits).toEqual([]);
	});

	it("deleting an assistant message also drops its tool results, and refreshes the context", async () => {
		const { adapter, edits, stub } = chat();
		await adapter.deleteMessages(refOf(1, assistant));
		expect(edits.map(([id]) => id).sort()).toEqual(["e1", "e2"]);
		expect(edits.every(([, v]) => v === null)).toBe(true);
		expect(stub.refreshContext).toHaveBeenCalledTimes(1);
	});

	it("deleting a user message drops only that entry", async () => {
		const { adapter, edits, stub } = chat();
		await adapter.deleteMessages(refOf(0, user));
		expect(edits).toEqual([["e0", null]]);
		expect(stub.refreshContext).toHaveBeenCalledTimes(1);
	});

	it("rewind navigates to the user message at or before the ref and returns its text, or the edit", async () => {
		const { adapter, stub } = chat();
		expect(await adapter.rewind(refOf(1, assistant))).toEqual({ text: "hello" });
		expect(stub.navigateTree).toHaveBeenLastCalledWith("e0");
		expect(await adapter.rewind(refOf(0, user), "changed")).toEqual({ text: "changed" });
	});

	it("rewind returns the pictures of the user message", async () => {
		const image = { type: "image", data: "d", mimeType: "image/png" };
		const withImage = { role: "user", content: [{ type: "text", text: "see" }, image], timestamp: 5 };
		const { adapter } = chat({}, [withImage]);
		expect(await adapter.rewind(refOf(0, withImage))).toEqual({ text: "see", images: [image] });
	});

	it("rewind rejects an empty edit without navigating, and a cancelled navigation as aborted", async () => {
		const { adapter, stub } = chat();
		await expect(adapter.rewind(refOf(0, user), "   ")).rejects.toMatchObject({ code: "messageEmpty" });
		expect(stub.navigateTree).not.toHaveBeenCalled();
		stub.navigateTree.mockResolvedValueOnce({ cancelled: true });
		await expect(adapter.rewind(refOf(0, user))).rejects.toMatchObject({ code: "aborted" });
	});

	it("rewind without a preceding user message reports messageNotFound", async () => {
		const { adapter } = chat({}, [assistant]);
		await expect(adapter.rewind(refOf(0, assistant))).rejects.toMatchObject({ code: "messageNotFound" });
	});
});

describe("PiRuntimeSession.fork", () => {
	const user = { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: " part" }], timestamp: 1 };
	const assistant = { role: "assistant", content: [], timestamp: 2 };
	const user2 = { role: "user", content: "second", timestamp: 3 };
	const refOf = (index: number, m: { role: string; timestamp: number }) => ({ index, role: m.role, timestamp: m.timestamp }) as MessageRef;
	afterEach(() => void vi.restoreAllMocks());

	function forking(sessionFile: string | undefined) {
		const stub = {
			isStreaming: false,
			sessionFile,
			sessionManager: {
				getCwd: () => "/work",
				getEntry: (id: string) => ({ id, parentId: id === "e0" ? null : `e${Number(id.slice(1)) - 1}` }),
				buildSessionProjection: () => ({ entries: [user, assistant, user2].map((m, i) => ({ sourceEntry: { id: `e${i}` }, messages: [m] })) }),
			},
		};
		const kept: unknown[] = [];
		const made = make(stub, undefined, { keepFork: (m) => void kept.push(m) });
		const next = { createBranchedSession: vi.fn(), getSessionId: () => "fork-id", getSessionFile: () => "/tmp/fork.jsonl" };
		const open = vi.spyOn(SessionManager, "open").mockReturnValue(next as unknown as SessionManager);
		const create = vi.spyOn(SessionManager, "create").mockReturnValue(next as unknown as SessionManager);
		return { ...made, kept, next, open, create };
	}

	it("branches the stored file at the message when forking at an assistant message", async () => {
		const { adapter, kept, next, open, create } = forking("/tmp/s.jsonl");
		const out = await adapter.fork(refOf(1, assistant));
		expect(open).toHaveBeenCalledWith("/tmp/s.jsonl");
		expect(next.createBranchedSession).toHaveBeenCalledWith("e1");
		expect(create).not.toHaveBeenCalled();
		expect(out).toEqual({ runtime: "pi", id: "fork-id", nativeId: "fork-id", path: "/tmp/fork.jsonl", editorText: undefined });
		expect(kept).toEqual([next]);
	});

	it("forking at a user message branches just before it and returns its text for the editor", async () => {
		const { adapter, next } = forking("/tmp/s.jsonl");
		const out = await adapter.fork(refOf(2, user2));
		expect(next.createBranchedSession).toHaveBeenCalledWith("e1");
		expect(out.editorText).toBe("second");
		expect((await adapter.fork(refOf(0, user))).editorText).toBe("first part");
	});

	it("forking at the first user message starts an empty session that records its parent", async () => {
		const { adapter, next, open, create, kept } = forking("/tmp/s.jsonl");
		const out = await adapter.fork(refOf(0, user));
		expect(open).not.toHaveBeenCalled();
		expect(next.createBranchedSession).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledWith("/work", undefined, { parentSession: "/tmp/s.jsonl" });
		expect(out.id).toBe("fork-id");
		expect(kept).toEqual([next]);
	});

	it("a session without a file forks into a fresh session with no parent", async () => {
		const { adapter, create } = forking(undefined);
		await adapter.fork(refOf(1, assistant));
		expect(create).toHaveBeenCalledWith("/work", undefined, undefined);
	});
});

describe("PiRuntimeSession lifecycle", () => {
	it("dispose is idempotent: PI is disposed and the hook runs once", async () => {
		const dispose = vi.fn();
		const onDispose = vi.fn();
		const { adapter } = make({ dispose }, undefined, { onDispose });
		await Promise.all([adapter.dispose(), adapter.dispose()]);
		await adapter.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(onDispose).toHaveBeenCalledTimes(1);
	});

	it("exposes the working directory without building a snapshot", () => {
		const { adapter } = make({ sessionManager: { getCwd: () => "/work" } });
		expect(adapter.cwd).toBe("/work");
	});
});

describe("pending forks", () => {
	const manager = (id: string) => ({ getSessionId: () => id }) as unknown as SessionManager;

	it("take hands a fork out once", () => {
		const forks = new PendingForks();
		const m = manager("f1");
		forks.keep("origin", m);
		expect(forks.take("f1")).toBe(m);
		expect(forks.take("f1")).toBeUndefined();
		expect(forks.size).toBe(0);
	});

	it("dropFrom forgets only the forks of that session", () => {
		const forks = new PendingForks();
		forks.keep("a", manager("f1"));
		forks.keep("a", manager("f2"));
		const kept = manager("f3");
		forks.keep("b", kept);
		forks.dropFrom("a");
		expect(forks.size).toBe(1);
		expect(forks.take("f1")).toBeUndefined();
		expect(forks.take("f3")).toBe(kept);
	});

	it("PiRuntime.resume resumes a fork from its stored manager, not from disk, and only once", async () => {
		const forks = new PendingForks();
		const m = manager("f1");
		forks.keep("origin", m);
		const attach = vi.fn(async (_m: SessionManager, _init: unknown) => ({ id: "f1" }));
		const runtime = Object.assign(Object.create(PiRuntime.prototype) as object, { forks, attach }) as unknown as PiRuntime;
		const init = {} as never;
		const ref = { runtime: "pi", id: "f1", nativeId: "f1", path: "/tmp/fork.jsonl" } as const;
		const open = vi.spyOn(SessionManager, "open").mockReturnValue(manager("from-disk"));
		try {
			await runtime.resume(ref, init);
			expect(attach).toHaveBeenLastCalledWith(m, init);
			expect(open).not.toHaveBeenCalled();
			await runtime.resume(ref, init);
			expect(open).toHaveBeenCalledWith("/tmp/fork.jsonl");
		} finally {
			open.mockRestore();
		}
	});
});
