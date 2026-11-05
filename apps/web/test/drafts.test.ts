import { beforeEach, describe, expect, it, vi } from "vitest";

// The composer keeps its unsent text per conversation: switching must neither carry it along nor lose it.
const ls = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (k: string) => ls.get(k) ?? null,
	setItem: (k: string, v: string) => void ls.set(k, v),
	removeItem: (k: string) => void ls.delete(k),
});

/** A fresh module, so the in-memory map starts empty the way a reload does; localStorage stays as it was. */
async function reload() {
	vi.resetModules();
	return await import("../src/lib/drafts.ts");
}

const noFiles = { images: [], docs: [] } as const;
const typed = (text: string) => ({ text, ...noFiles });

describe("drafts", () => {
	beforeEach(() => ls.clear());

	it("keeps each conversation's text apart", async () => {
		const { loadDraft, saveDraft } = await reload();
		saveDraft("a", typed("hello a"));
		saveDraft("b", typed("hello b"));
		expect(loadDraft("a").text).toBe("hello a");
		expect(loadDraft("b").text).toBe("hello b");
		expect(loadDraft("c").text).toBe("");
	});

	it("survives a reload through localStorage", async () => {
		(await reload()).saveDraft("a", typed("kept"));
		expect((await reload()).loadDraft("a").text).toBe("kept");
	});

	it("clears the entry when the text is emptied", async () => {
		const { loadDraft, saveDraft } = await reload();
		saveDraft("a", typed("x"));
		saveDraft("a", typed(""));
		expect(loadDraft("a").text).toBe("");
		expect(JSON.parse(ls.get("prometheus.drafts") ?? "{}")).toEqual({});
	});

	it("scopes the new-chat page to the workspace it is set up in", async () => {
		const { newChatDraft, NEW_CHAT_DRAFT } = await reload();
		expect(newChatDraft()).toBe(NEW_CHAT_DRAFT);
		expect(newChatDraft("ws1")).not.toBe(newChatDraft("ws2"));
	});

	it("does not carry a new-chat draft from one workspace to another", async () => {
		const { loadDraft, newChatDraft, saveDraft } = await reload();
		saveDraft(newChatDraft("wsA"), typed("typed in A"));
		expect(loadDraft(newChatDraft("wsB")).text).toBe("");
	});

	it("opens another workspace's new chat empty and keeps the first one's text", async () => {
		const { loadDraft, newChatDraft, switchDraft } = await reload();
		const a = newChatDraft("wsA");
		const b = newChatDraft("wsB");
		// Typing in A's new chat, then switching to B's.
		const inB = switchDraft(a, b, typed("typed in A"));
		expect(inB.text).toBe("");
		expect(loadDraft(a).text).toBe("typed in A");
		// And back: A's text is still there, B's is what was left in it.
		expect(switchDraft(b, a, typed("")).text).toBe("typed in A");
	});

	it("opens another conversation empty rather than with the message just sent", async () => {
		const { switchDraft } = await reload();
		// `submit` clears the draft it sent from; the next conversation must not inherit anything.
		expect(switchDraft("s1", "s2", typed("")).text).toBe("");
	});

	it("hands the workspace-less draft over when a workspace is picked, once", async () => {
		const { loadDraft, NEW_CHAT_DRAFT, newChatDraft, switchDraft } = await reload();
		const taken = switchDraft(NEW_CHAT_DRAFT, newChatDraft("wsA"), typed("typed before picking"));
		expect(taken.text).toBe("typed before picking");
		expect(loadDraft(newChatDraft("wsA")).text).toBe("typed before picking");
		// The plain page is empty again, so the next workspace starts blank.
		expect(loadDraft(NEW_CHAT_DRAFT).text).toBe("");
		expect(loadDraft(newChatDraft("wsB")).text).toBe("");
	});

	it("keeps what the picked workspace already had instead of overwriting it", async () => {
		const { loadDraft, NEW_CHAT_DRAFT, newChatDraft, saveDraft, switchDraft } = await reload();
		saveDraft(NEW_CHAT_DRAFT, typed("older plain text"));
		saveDraft(newChatDraft("wsA"), typed("already in A"));
		expect(switchDraft(NEW_CHAT_DRAFT, newChatDraft("wsA"), typed("older plain text")).text).toBe("already in A");
		expect(loadDraft(NEW_CHAT_DRAFT).text).toBe("older plain text");
	});

	it("does not hand a workspace's draft back to the plain page", async () => {
		const { loadDraft, NEW_CHAT_DRAFT, newChatDraft, switchDraft } = await reload();
		expect(switchDraft(newChatDraft("wsA"), NEW_CHAT_DRAFT, typed("in A")).text).toBe("");
		expect(loadDraft(newChatDraft("wsA")).text).toBe("in A");
	});
});
